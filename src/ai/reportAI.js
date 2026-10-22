/**
 * 报告页的 AI 总结（禅道数据 → 结构化总结）
 *
 *   summarizeMine：我的日报 / 周报 / 月报
 *   summarizeTeam：全员报告，分「整体 + 按人 + 按项目」三部分
 *
 * 只把统计好的数据交给模型（工时、任务、工作内容），不让模型自己算数；
 * 输入按任务聚合并截断工作内容，避免月报全员数据把上下文撑爆。
 */
import { config, aiModelFor } from '../config.js';
import { createOpenAIClient } from './openai.js';

const KIND_LABEL = { daily: '日报', weekly: '周报', monthly: '月报' };
const PERIOD_WORD = { daily: '当天', weekly: '本周', monthly: '本月' };

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 模型输出 → JSON（容忍 ```json 包裹和前后多余文字） */
function parseJsonLoose(text) {
  let t = String(text || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error('AI 返回的不是 JSON');
  }
}

async function chatJson(system, user, maxTokens) {
  const client = createOpenAIClient();
  if (!client) throw new Error('未配置 AI（设置 → AI 模型），仅显示统计数据');
  const request = {
    model: aiModelFor('report'),
    temperature: 0.3,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  };
  let resp;
  try {
    resp = await client.chat.completions.create({ ...request, response_format: { type: 'json_object' } });
  } catch (err) {
    // 部分模型 / 服务商不支持 JSON mode：去掉约束再试一次，靠提示词约束格式
    if (err && (err.status === 400 || /response_format|json/i.test(err.message || ''))) {
      resp = await client.chat.completions.create(request);
    } else {
      throw err;
    }
  }
  const choice = resp.choices[0];
  try {
    return parseJsonLoose(choice.message.content);
  } catch (err) {
    if (choice.finish_reason === 'length') throw new Error('AI 输出被截断（推理模型思考过长），可换个模型或点「重新生成」重试');
    // 有的中转不执行 JSON mode，模型照样写成一篇文字日报（实测中转上的 deepseek-v4-pro）：
    // 把它自己的回答发回去，要求按格式改成 JSON，重试一次
    const retry = await client.chat.completions.create({
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: String(choice.message.content || '') },
        { role: 'user', content: '上面的回答不是 JSON。请按我最初要求的 JSON 结构（键名不能改）重新输出：只输出一个 JSON 对象，不要任何其他文字、标题或 Markdown。' }
      ]
    });
    try {
      return parseJsonLoose(retry.choices[0].message.content);
    } catch {
      throw new Error(`AI 返回的不是 JSON（模型 ${request.model} 没有按要求的格式输出，可换个报告模型）`);
    }
  }
}

// 输出上限：推理模型（deepseek-v4-pro、hy3 等）的思考也计入 max_tokens，
// 实测中转上的 deepseek-v4-pro 写一份 19 个任务的日报，思考就用了 3400~4200 token，上限给小了正文被截断、JSON 不完整。只是上限，普通模型不受影响
const MINE_MAX_TOKENS = 6000;
const TEAM_MAX_TOKENS = { daily: 8000, weekly: 10000, monthly: 10000 };

// 插件记工时时自动写的备注（「更新进度至 100%」）没有信息量，状态已经说明了进度
const AUTO_NOTE = /^更新进度至\s*\d+\s*%$/;

/** 逾期任务：只给数量和最近到期的几个（几十个陈年逾期任务逐条列出没有意义） */
function describeOverdue(list, total, withOwner) {
  if (!total) return '';
  const recent = list.slice(0, 5).map(t => `${clip(t.name, 40)}（${withOwner ? `${t.assignedToName}，` : ''}截止 ${t.deadline}）`);
  return `【逾期未完成】共 ${total} 个（最近到期的：${recent.join('；')}）`;
}

/**
 * 事实类风险由代码直接给出（逾期、未填工时）：数字准确，不依赖模型
 * （实测 glm-4-flash 会把逾期任务拆成多条、把「12 人中 11 人」写成「12 人」）
 */
function factRisks({ overdue = [], overdueTotal = 0, members = null, missingDays = null, kind }) {
  const out = [];
  if (overdueTotal) {
    const t = overdue[0];
    out.push(`逾期未完成任务 ${overdueTotal} 个${t ? `，最近到期的是「${clip(t.name, 30)}」（${t.assignedToName ? `${t.assignedToName}，` : ''}截止 ${t.deadline}）` : ''}`);
  }
  if (members) {
    const missing = members.filter(p => p.missingDays.length);
    if (missing.length) {
      out.push(kind === 'daily'
        ? `${members.length} 人中 ${missing.length} 人没有工时记录`
        : `${missing.length} 人有未填工时的工作日（合计 ${missing.reduce((n, p) => n + p.missingDays.length, 0)} 人天）`);
    }
  } else if (missingDays && missingDays.length && kind !== 'daily') {
    out.push(`有 ${missingDays.length} 个工作日没有填工时`);
  }
  return out;
}

/** 模型给的风险：去掉逾期 / 未填工时这两类（已由代码给出），以及只是罗列逾期任务名的条目 */
function extraRisks(list, overdue) {
  const names = overdue.map(t => String(t.name).slice(0, 12)).filter(n => n.length >= 4);
  return list.filter(r => !/逾期|未填|没有工时|无工时|工时记录/.test(r) && !names.some(n => r.includes(n)));
}

/** 去掉同一类的重复风险（模型常把「逾期 N 个，最近到期的是 A / B / C」拆成多条） */
function dedupeRisks(list) {
  // 逾期、未填工时这两类最容易被拆开写：按类别只留第一条；其他按开头一段去重
  const categoryOf = (r) => {
    if (/逾期/.test(r)) return 'overdue';
    if (/未填|没有工时|无工时|工时记录/.test(r)) return 'missing';
    return r.split(/[，,：:（(]/)[0].replace(/\s+/g, '');
  };
  const seen = new Set();
  return list.filter((r) => {
    const key = categoryOf(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 一个人的工作 → 给模型看的文本（按任务聚合） */
function describePersonWork(p, { maxTasks = 25, noteLen = 80 } = {}) {
  const lines = (p.tasks || []).slice(0, maxTasks).map(t => {
    const notes = (t.works || []).filter(w => w && !AUTO_NOTE.test(String(w).trim())).map(w => clip(w, noteLen)).join('；');
    return `- [${t.project || '未归属项目'}] ${clip(t.name, 60)}（${t.hours}h${t.status ? `，${t.statusLabel || t.status}` : ''}）${notes ? `：${notes}` : ''}`;
  });
  if ((p.tasks || []).length > maxTasks) lines.push(`- 另有 ${p.tasks.length - maxTasks} 个任务`);
  const finished = (p.finished || []).map(t => clip(t.name, 40));
  return [
    lines.join('\n') || '- 无工时记录',
    finished.length ? `完成任务：${finished.slice(0, 20).join('、')}${finished.length > 20 ? ' 等' : ''}` : ''
  ].filter(Boolean).join('\n');
}

const MINE_SYSTEM = `你是研发工作汇报助手。根据给定的禅道数据（工时记录、完成的任务、Bug）写一份个人工作汇报。
要求：
- 只使用给定数据，不编造工作内容、不自行计算数字（数字已经给出）。
- summary：2~4 句话的总体概述，先说投入工时和主要方向，再说关键成果。
- done：已完成的工作（只来自「完成的任务」），每条一句，合并同一件事。
- progress：推进中的工作及进展（来自有工时但未完成的任务），每条一句。
- next：接下来要做的（来自进行中 / 未开始的任务），每条一句。
- risks：逾期和未填工时以外的风险或需要关注的点（逾期、未填工时系统会自动列出，不要写），没有就返回空数组。
- 每个数组最多 6 条，同一个项目的多件小事合并成一条。
只返回 JSON：{"summary":"","done":[],"progress":[],"next":[],"risks":[]}`;
const MINE_TEMPLATE = '{"summary":"","done":[],"progress":[],"next":[],"risks":[]}';

/**
 * 我的报告
 * @param {Object} mine - reportCenter 统计好的「我的」数据
 * @param {{kind:string, label:string}} period
 * @returns {Promise<{summary:string, done:string[], progress:string[], next:string[], risks:string[]}>}
 */
async function summarizeMine(mine, period) {
  const extra = config.prompts[period.kind] ? `\n用户补充要求：${clip(config.prompts[period.kind], 800)}` : '';
  const user = [
    `报告：${period.label}（${KIND_LABEL[period.kind]}）`,
    `${PERIOD_WORD[period.kind]}工时：${mine.hours}h；有工时记录的任务 ${mine.tasks.length} 个；完成（含关闭）的任务 ${mine.finished.length} 个`,
    mine.missingDays && mine.missingDays.length ? `未填工时的工作日：${mine.missingDays.join('、')}` : '',
    '【工作内容（按任务）】',
    describePersonWork(mine, { maxTasks: 40, noteLen: 120 }),
    mine.finished.length ? '' : '完成的任务：无',
    mine.bugs && (mine.bugs.opened.length || mine.bugs.resolved.length)
      ? `【Bug】提交 ${mine.bugs.opened.length} 个：${mine.bugs.opened.slice(0, 10).map(b => clip(b.title, 40)).join('、') || '无'}；解决 ${mine.bugs.resolved.length} 个：${mine.bugs.resolved.slice(0, 10).map(b => clip(b.title, 40)).join('、') || '无'}`
      : '',
    mine.openTasks.length ? `【进行中 / 未开始】${mine.openTasks.slice(0, 20).map(t => `${clip(t.name, 40)}（${t.statusLabel}${t.deadline ? `，截止 ${t.deadline}` : ''}）`).join('；')}` : '',
    describeOverdue(mine.overdue, mine.overdue.length, false)
  ].filter(Boolean).join('\n') + extra +
    // 格式要求在用户消息末尾再给一次：有的中转 / 模型不重视系统提示，会写成一篇文字日报（实测 deepseek-v4-pro）
    `\n\n按系统提示的要求，只输出一个 JSON 对象，键名固定为：${MINE_TEMPLATE}`;

  const out = await chatJson(MINE_SYSTEM, user, MINE_MAX_TOKENS);
  const arr = (v) => (Array.isArray(v) ? v.map(x => String(x)).filter(Boolean) : []);
  const risks = [
    // 「我的」里不用再写自己的名字
    ...factRisks({ overdue: mine.overdue.map(t => ({ ...t, assignedToName: '' })), overdueTotal: mine.overdue.length, missingDays: mine.missingDays, kind: period.kind }),
    ...extraRisks(arr(out.risks), mine.overdue)
  ].slice(0, 5);
  // 模型不总遵守「最多 6 条」（实测周报把 20 个完成任务逐条列出）：多出的合成一条，完整列表在「完成的任务」里
  const cap = (list, more) => (list.length > 8 ? [...list.slice(0, 7), `等另外 ${list.length - 7} 项${more}`] : list);
  return {
    summary: String(out.summary || ''),
    done: cap(arr(out.done), '（见下方「完成的任务」）'),
    progress: cap(arr(out.progress), ''),
    next: cap(arr(out.next), ''),
    risks
  };
}

const TEAM_SYSTEM = `你是研发团队的工作汇报助手。根据给定的禅道数据写一份团队工作汇报。
用户消息最后给出一个 JSON 模板，把模板里的每个空字符串都填上，键名一个都不能改、不能删：
- overall：团队整体概述，3~5 句话（总投入、主要推进的项目、关键成果、整体风险）。
- byPerson.<账号>：这个人做了什么、成果如何，1~3 句。
- byProject.<项目编号>：这个项目的进展、参与的人和投入，1~3 句。编号只用作键，正文里写项目名，不要出现 P1、P2 这样的编号。
- risks：逾期和未填工时以外的需要关注的问题（这两类系统会自动列出，不要写），最多 3 条，每条都必须对应数据里的具体事实；没有就返回空数组。
注意区分「有工时记录的任务数」和「完成的任务数」，不要混用；只使用给定数据，不编造，不自行计算数字。
只返回填好的 JSON。`;

/**
 * 全员报告
 *
 * 用「填模板」的方式要求输出：按人 / 按项目的键预先给好，模型只填内容，
 * 比让它自己列数组可靠得多（实测 glm-4-flash 自己列时会漏掉一半项目）。
 * 项目用 P1、P2 编号作键，避免模型改写项目名。
 *
 * @param {Object} team - reportCenter 统计好的「全员」数据
 * @param {{kind:string, label:string}} period
 * @returns {Promise<{overall:string, byPerson:Array<{account:string,summary:string}>, byProject:Array<{project:string,summary:string}>, risks:string[]}>}
 */
async function summarizeTeam(team, period) {
  // 月报全员数据量大：每人任务数、工作内容长度随周期收紧
  const budget = period.kind === 'monthly' ? { maxTasks: 12, noteLen: 40 } : period.kind === 'weekly' ? { maxTasks: 15, noteLen: 60 } : { maxTasks: 20, noteLen: 80 };
  // 没有任何记录的人不交给模型（界面上直接显示「无工时记录」），只告诉它有哪些人
  const active = team.members.filter(p => p.hours > 0 || p.finished.length);
  const idle = team.members.filter(p => !(p.hours > 0 || p.finished.length));
  const people = active.map(p => [
    `## ${p.name}（账号 ${p.account}${p.role ? `，${p.role}` : ''}）：${p.hours}h；有工时记录的任务 ${p.tasks.length} 个；完成（含关闭）的任务 ${p.finished.length} 个${p.missingDays.length ? `；未填工时 ${p.missingDays.length} 个工作日` : ''}`,
    describePersonWork(p, budget)
  ].join('\n'));
  const projectKeys = team.projects.map((pr, i) => [`P${i + 1}`, pr]);
  const projects = projectKeys.map(([k, pr]) =>
    `- ${pr.project}（编号 ${k}）：${pr.hours}h，参与 ${pr.members.map(m => `${m.name} ${m.hours}h`).join('、')}，完成任务 ${pr.finished} 个`
  );
  const template = {
    overall: '',
    byPerson: Object.fromEntries(active.map(p => [p.account, ''])),
    byProject: Object.fromEntries(projectKeys.map(([k]) => [k, ''])),
    risks: []
  };
  const user = [
    `报告：${period.label}（全员${KIND_LABEL[period.kind]}）`,
    `团队 ${team.members.length} 人，${PERIOD_WORD[period.kind]}有工时记录 ${team.activeCount} 人，总工时 ${team.totalHours}h`,
    '【项目投入】',
    projects.join('\n') || '- 无',
    '【每个人的工作】',
    people.join('\n\n') || '- 无',
    idle.length ? `【没有任何工时 / 完成记录的人】${idle.map(p => p.name).join('、')}（共 ${idle.length} 人）` : '',
    describeOverdue(team.overdue, team.overdueTotal, true),
    '【请填写的 JSON 模板】',
    JSON.stringify(template)
  ].filter(Boolean).join('\n');

  const out = await chatJson(TEAM_SYSTEM, user, TEAM_MAX_TOKENS[period.kind]);

  // 兼容模型仍按数组返回的情况
  const asMap = (v, keyName) => (Array.isArray(v)
    ? Object.fromEntries(v.filter(x => x && x[keyName]).map(x => [String(x[keyName]), x.summary]))
    : (v && typeof v === 'object' ? v : {}));
  const personMap = asMap(out.byPerson, 'account');
  const projectMap = asMap(out.byProject, 'project');
  // 兜底：模型偶尔仍把编号写进正文（「P1项目由…」），换回项目名
  const names = new Map(projectKeys.map(([k, pr]) => [k, pr.project]));
  // 只换「P1项目」和并列里的「P1、P2」，不碰「P1 优先级」这类写法
  const unkey = (str) => str.replace(/\bP(\d+)(?:\s*项目|(?=\s*(?:[、，,和与及等]|$)))/g, (m, n) => names.get(`P${n}`) || m);
  const text = (v) => (typeof v === 'string' ? unkey(v.trim()) : '');
  return {
    overall: text(out.overall),
    byPerson: active
      .map(p => ({ account: p.account, summary: text(personMap[p.account]) }))
      .filter(x => x.summary),
    byProject: projectKeys
      .map(([k, pr]) => ({ project: pr.project, summary: text(projectMap[k]) || text(projectMap[pr.project]) }))
      .filter(x => x.summary),
    risks: [
      ...factRisks({ overdue: team.overdue, overdueTotal: team.overdueTotal, members: team.members, kind: period.kind }),
      ...dedupeRisks(extraRisks((Array.isArray(out.risks) ? out.risks : []).map(x => text(String(x))).filter(Boolean), team.overdue))
    ].slice(0, 5)
  };
}

export { summarizeMine, summarizeTeam, parseJsonLoose, dedupeRisks };
