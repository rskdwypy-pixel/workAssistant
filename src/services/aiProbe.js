/**
 * AI 模型探测：设置页的「测试连接」「测速推荐」
 *
 * 两类用途的要求不同：
 *   task   新建任务 / Bug 解析、执行匹配。用户正看着弹窗，超过 8 秒就降级本地解析，所以要快、要能稳定出 JSON
 *   report 日报 / 周报 / 月报。不赶时间，推理更强的模型总结得更好
 * 模型快慢无法从名字判断（实测 minimax-m3 约 3 秒，kimi-k3-1 要 12~18 秒），所以任务解析的推荐以实测为准；
 * 报告的「好坏」测不出来，在实测可用的模型里按名字里的档位（pro / max …）和是否推理排序。
 */

export const TASK_TIMEOUT_SECONDS = 8;
const TASK_GOOD_SECONDS = 5;
const REPORT_MAX_SECONDS = 60;

// 与任务解析的真实请求同类：结构化 JSON + 从候选执行里选一个
const TASK_PROBE = {
  system: '你是研发任务管理助手。只返回合法JSON。',
  user: '分析工作内容并只返回JSON：{"title":"","status":"todo|in_progress|done","priority":1,"progress":0,"executionId":"候选ID或null"}。候选执行：[167] 工作日志；[149] 阿迪达斯项目交付；[150] 江苏农信看板。用户输入：明天下午3点前紧急修复阿迪达斯小程序登录失败的问题，已经做了一半',
  check: (j) => !!(j && j.title) && String(j.executionId) === '149'
};
const REPORT_PROBE = {
  system: '你是研发工作汇报助手。只返回合法JSON。',
  user: '根据数据写一句话工作总结，只返回JSON：{"summary":""}。数据：今天投入 8 小时，完成「登录失败修复」「接口联调」两个任务。',
  check: (j) => !!(j && j.summary)
};

function parseJsonLoose(text) {
  const t = String(text || '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}

/**
 * 用一条与真实场景同类的请求探测模型
 * @returns {Promise<{model:string, ok:boolean, seconds:number, reasoning:boolean, error:string}>}
 */
export async function probeModel({ base, apiKey, model, purpose = 'task', timeoutMs }) {
  const probe = purpose === 'report' ? REPORT_PROBE : TASK_PROBE;
  const limit = timeoutMs || (purpose === 'report' ? REPORT_MAX_SECONDS * 1000 : 15000);
  const started = Date.now();
  const body = (jsonMode) => JSON.stringify({
    model,
    temperature: 0.1,
    // 只是上限：推理模型要先思考几百 token
    max_tokens: 1500,
    messages: [{ role: 'system', content: probe.system }, { role: 'user', content: probe.user }],
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
  });
  const call = (jsonMode) => fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body(jsonMode),
    signal: AbortSignal.timeout(Math.max(1000, limit - (Date.now() - started)))
  });
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  try {
    let resp = await call(true);
    // 不支持 JSON mode 的服务：去掉约束再试（插件的真实调用也是这样降级的）
    if (resp.status === 400) resp = await call(false);
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = (data && (data.error?.message || data.message)) || '';
      return { model, ok: false, seconds: seconds(), reasoning: false, error: `HTTP ${resp.status}${msg ? `：${String(msg).slice(0, 120)}` : ''}` };
    }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const reasoning = !!(msg && msg.reasoning_content) || Number(data && data.usage && data.usage.completion_tokens_details && data.usage.completion_tokens_details.reasoning_tokens) > 0;
    const json = parseJsonLoose(msg && msg.content);
    if (!probe.check(json)) {
      const finish = data.choices[0].finish_reason;
      return { model, ok: false, seconds: seconds(), reasoning, error: finish === 'length' ? '思考太久，输出被截断' : '没有返回符合要求的 JSON' };
    }
    return { model, ok: true, seconds: seconds(), reasoning, error: '' };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { model, ok: false, seconds: seconds(), reasoning: false, error: timeout ? `超过 ${Math.round(limit / 1000)} 秒没有返回` : err.message };
  }
}

/**
 * 对某类用途的结论
 * @returns {{level:'good'|'slow'|'bad', text:string}}
 */
export function verdictFor(purpose, r) {
  if (!r.ok) return { level: 'bad', text: r.error || '不可用' };
  if (purpose === 'report') {
    return r.seconds <= REPORT_MAX_SECONDS
      ? { level: 'good', text: `${r.seconds} 秒${r.reasoning ? '，推理模型' : ''}，适合生成报告` }
      : { level: 'slow', text: `${r.seconds} 秒，较慢，报告生成时间会比较长` };
  }
  if (r.seconds <= TASK_GOOD_SECONDS) return { level: 'good', text: `${r.seconds} 秒${r.reasoning ? '，推理模型' : ''}，适合任务解析` };
  if (r.seconds <= TASK_TIMEOUT_SECONDS) return { level: 'slow', text: `${r.seconds} 秒，接近 ${TASK_TIMEOUT_SECONDS} 秒上限，网络稍慢就会改用本地解析` };
  return { level: 'bad', text: `${r.seconds} 秒${r.reasoning ? '（推理模型，先思考再回答）' : ''}，超过 ${TASK_TIMEOUT_SECONDS} 秒，新建任务时会改用本地解析；可用于报告` };
}

// 不是对话模型的（向量、语音、图片）不参与测速
const NOT_CHAT = /embed|whisper|tts|speech|audio|dall-?e|image|rerank|moderation/i;

/**
 * 从模型列表里挑出参与测速的候选：去掉非对话模型；`cn:xxx` 与 `xxx` 只测一个
 * @param {string[]} models
 * @param {number} [max=24]
 */
export function pickCandidates(models, max = 24) {
  const list = [...new Set((models || []).map(String))].filter(m => m && !NOT_CHAT.test(m));
  const plain = new Set(list.filter(m => !m.includes(':')));
  const unique = list.filter(m => !(m.includes(':') && plain.has(m.split(':').pop())));
  return { models: unique.slice(0, max), skipped: unique.slice(max) };
}

/** 报告用：名字里的档位（只用于在实测可用的模型之间排序） */
function reportTier(model) {
  const m = model.toLowerCase();
  let score = 0;
  if (/(^|[-_.])(pro|max|plus|ultra|opus|sonnet)([-_.]|$)|-x$|k3/.test(m)) score += 3;
  if (/flash|mini|lite|turbo|air|nano|tiny|instant/.test(m)) score -= 2;
  if (/preview|beta/.test(m)) score -= 1;
  if (/(^|[-_])(\d+)v([-_]|$)|vision|-vl/.test(m)) score -= 2;
  return score;
}

/**
 * 根据测速结果给两类用途各推荐几个
 * @param {Array} results - probeModel 的结果（task 探测）
 * @returns {{task:string[], report:string[]}}
 */
export function recommend(results) {
  const ok = results.filter(r => r.ok);
  const task = ok
    .filter(r => r.seconds <= TASK_GOOD_SECONDS)
    .sort((a, b) => a.seconds - b.seconds)
    .map(r => r.model)
    .slice(0, 3);
  const report = ok
    .filter(r => r.seconds <= REPORT_MAX_SECONDS)
    .sort((a, b) => (reportTier(b.model) + (b.reasoning ? 1 : 0)) - (reportTier(a.model) + (a.reasoning ? 1 : 0)) || a.seconds - b.seconds)
    .map(r => r.model)
    .slice(0, 3);
  return { task, report };
}

/**
 * 并发测速（限制并发，单个最长 25 秒：慢的推理模型不适合任务解析，但可能适合报告）
 *
 * 中转的延迟波动很大（实测同一模型两次 3.6 秒 / 15 秒），只测一次会把偶尔快的慢模型推荐给任务解析。
 * 所以第一轮在 8 秒内返回的再测一轮，按两次里慢的那次（最坏情况）算。
 */
export async function benchmark({ base, apiKey, models, concurrency = 6 }) {
  const run = async (list) => {
    const out = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await probeModel({ base, apiKey, model: list[i], purpose: 'task', timeoutMs: 25000 });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    return out;
  };
  const first = await run(models);
  const again = first.filter(r => r.ok && r.seconds <= TASK_TIMEOUT_SECONDS).map(r => r.model);
  const second = new Map((await run(again)).map(r => [r.model, r]));
  return first.map((r) => {
    const r2 = second.get(r.model);
    if (!r2) return { ...r, samples: [r.seconds] };
    return {
      ...r,
      ok: r.ok && r2.ok,
      seconds: Math.max(r.seconds, r2.seconds),
      reasoning: r.reasoning || r2.reasoning,
      error: r2.ok ? r.error : r2.error,
      samples: [r.seconds, r2.seconds]
    };
  });
}
