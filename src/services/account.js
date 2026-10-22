/**
 * 账号：禅道登录状态、当前用户信息、登录 / 退出 / 切换账号、重置为首次使用
 *
 * 登录状态（插件的数据与操作都依赖禅道，「登录」= 禅道账号已配置且能登录）：
 *   unconfigured  没有禅道地址 / 账号 / 密码（第一次使用、退出登录、重置后）→ 前端弹登录卡片
 *   invalid       禅道明确回复账号或密码错误（如在禅道里改了密码）→ 头像红点，弹「只需输入密码」的登录卡片
 *   offline       连不上禅道（没连 VPN 等）→ 头像灰点，不弹登录卡片
 *   ok            已登录
 *
 * 用户信息来自禅道「个人档案」（my-profile），存在 data/account.json；
 * 同一个文件也记录本地数据属于哪个账号：换成别的账号登录时，本地任务 / Bug / 报告要清空重新同步。
 */
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { config, updateEnvFile } from '../config.js';

const ROLE_LABEL = {
  dev: '研发', qa: '测试', pm: '项目经理', po: '产品经理', td: '研发主管', pd: '产品主管',
  qd: '测试主管', top: '高层管理', others: '其他', limited: '受限用户'
};

const accountFile = () => join(config.paths.data, 'account.json');

/** 已保存的用户信息（含本地数据属于哪个账号）；没有返回 null */
function readAccount() {
  try {
    return existsSync(accountFile()) ? JSON.parse(readFileSync(accountFile(), 'utf-8')) : null;
  } catch {
    return null;
  }
}

function writeAccount(data) {
  writeFileSync(accountFile(), JSON.stringify(data, null, 2), 'utf-8');
}

/** 本地数据属于哪个账号：以前的版本没有 account.json，就看配置里的账号 */
function dataOwner() {
  const saved = readAccount();
  return (saved && saved.account) || config.zentao.username || '';
}

/**
 * 地址规整：补 http://，去掉 /zentao/... 页面路径与末尾斜杠
 * 用户常直接粘贴浏览器地址栏里的 http://host:8088/zentao/my.html
 */
function normalizeZentaoUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/\/zentao(\/.*)?$/i, '').replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return '';
  }
}

/**
 * 登录失败分类：账号密码错误 / 地址不是禅道 / 连不上
 * loginZentao 的错误：「登录失败: <禅道返回>」或传输层错误（已翻译成「无法连接禅道…」）
 */
function classifyLoginError(err) {
  const msg = String((err && err.message) || err || '');
  const m = msg.match(/^登录失败:\s*([\s\S]*)$/);
  if (m) {
    try {
      const body = JSON.parse(m[1]);
      if (body && body.result === 'fail') {
        // 连续输错时禅道会锁定账号，原因写在 message 里，原样给用户
        return { kind: 'credentials', message: body.message || '账号或密码错误' };
      }
    } catch { /* 不是 JSON */ }
    if (/"result"\s*:\s*"fail"/.test(m[1])) return { kind: 'credentials', message: '账号或密码错误' };
    return { kind: 'not_zentao', message: '该地址不是禅道（请填禅道首页的地址，如 http://10.0.0.1:8088）' };
  }
  if (/禅道配置不完整|禅道未启用/.test(msg)) return { kind: 'unconfigured', message: msg };
  return { kind: 'offline', message: msg };
}

/** 从禅道读取当前用户的个人档案 */
async function fetchProfile() {
  const z = await import('./zentaoService.js');
  const inner = await z.getZentaoJson('my-profile.json');
  const u = inner && inner.user;
  if (!u || !u.account) throw new Error('禅道没有返回用户信息');
  const dept = Array.isArray(inner.deptPath) && inner.deptPath.length ? inner.deptPath[inner.deptPath.length - 1].name : '';
  return {
    account: String(u.account),
    realname: u.realname || u.account,
    role: u.role || '',
    roleLabel: ROLE_LABEL[u.role] || u.role || '',
    dept: dept || '',
    email: u.email || '',
    join: u.join && !String(u.join).startsWith('0000') ? String(u.join).slice(0, 10) : ''
  };
}

let stateCache = null;
const STATE_TTL_MS = 60 * 1000;

/** 状态变了（登录 / 退出 / 同步时发现密码失效）就作废缓存 */
function invalidateState() {
  stateCache = null;
}

/**
 * 当前登录状态与用户信息
 * 已配置时向禅道读一次个人档案（顺带验证账号密码、刷新姓名等），结果缓存 60 秒
 * @param {{refresh?:boolean}} [options]
 */
async function getAccountState({ refresh = false } = {}) {
  const z = config.zentao;
  const saved = readAccount();
  const base = {
    zentaoUrl: z.url || '',
    username: z.username || '',
    dataOwner: dataOwner(),
    dataOwnerName: (saved && saved.account === dataOwner() && saved.realname) || '',
    aiConfigured: !!(config.ai.apiKey && config.ai.apiKey.trim())
  };
  if (!z.url || !z.username || !z.password) {
    return { ...base, state: 'unconfigured', profile: null, message: '' };
  }
  if (!refresh && stateCache && Date.now() - stateCache.at < STATE_TTL_MS) {
    return { ...base, ...stateCache.value };
  }
  let value;
  try {
    const profile = await fetchProfile();
    writeAccount({ ...profile, zentaoUrl: z.url, updatedAt: new Date().toISOString() });
    value = { state: 'ok', profile, message: '' };
  } catch (err) {
    const c = classifyLoginError(err);
    // 连不上时照样显示上次保存的用户信息
    value = {
      state: c.kind === 'credentials' ? 'invalid' : c.kind === 'unconfigured' ? 'unconfigured' : 'offline',
      profile: saved && saved.account === z.username ? stripAccount(saved) : null,
      message: c.message
    };
  }
  stateCache = { at: Date.now(), value };
  return { ...base, ...value, dataOwnerName: base.dataOwnerName || (value.profile && value.profile.realname) || '' };
}

function stripAccount(saved) {
  const { zentaoUrl, updatedAt, ...profile } = saved;
  return profile;
}

// ==================== 本地数据 ====================

/**
 * 清空本地数据（换账号、或重置时勾选了「同时清空本地数据」）
 * 任务 / Bug / 报告 / 旧版日报 / 执行与项目 / 执行学习记录 / 团队成员缓存 / 附件；
 * data/backups 保留（防误操作的最后一道保险）
 */
async function clearLocalData() {
  const { updateTasks } = await import('../utils/storage.js');
  await updateTasks((data) => ({ ...data, tasks: [] }));
  const dir = config.paths.data;
  for (const f of ['reports.json', 'history.json', 'executions.json', 'projects.json', 'executionLearning.json', 'zentao-users.json', 'tasks.json.backup']) {
    rmSync(join(dir, f), { force: true });
  }
  const att = join(dir, 'attachments');
  if (existsSync(att)) {
    for (const name of readdirSync(att)) rmSync(join(att, name), { recursive: true, force: true });
  }
  config.zentao.users = {};
}

// ==================== 登录 / 退出 ====================

/**
 * 登录：先用填写的信息真实登录一次，成功才保存
 * 换成了另一个账号且本地有上一个账号的数据：不保存，返回 needConfirm，确认后（confirmSwitch）清空本地数据再保存
 * @returns {Promise<{ok:boolean, needConfirm?:boolean, previous?:Object, error?:{kind:string,message:string}, state?:Object}>}
 */
async function login({ url, username, password, confirmSwitch = false }) {
  const z = await import('./zentaoService.js');
  const zentaoUrl = normalizeZentaoUrl(url);
  const account = String(username || '').trim();
  // 「只需输入密码」的重新登录：密码留空时不能用，必须填
  if (!zentaoUrl) return { ok: false, error: { kind: 'input', message: '请填写禅道地址' } };
  if (!account) return { ok: false, error: { kind: 'input', message: '请填写账号' } };
  if (!password) return { ok: false, error: { kind: 'input', message: '请填写密码' } };

  try {
    await z.loginZentao(zentaoUrl, account, String(password));
  } catch (err) {
    return { ok: false, error: classifyLoginError(err) };
  }

  const owner = dataOwner();
  const { readTasks } = await import('../utils/storage.js');
  const hasData = ((await readTasks()).tasks || []).length > 0;
  const switching = owner && owner !== account && hasData;
  if (switching && !confirmSwitch) {
    const saved = readAccount();
    return {
      ok: false,
      needConfirm: true,
      previous: { account: owner, realname: (saved && saved.account === owner && saved.realname) || owner }
    };
  }
  if (switching) await clearLocalData();

  updateEnvFile({
    ZENTAO_ENABLED: 'true',
    ZENTAO_URL: zentaoUrl,
    ZENTAO_USERNAME: account,
    ZENTAO_PASSWORD: String(password),
    // 换账号时默认执行也是上一个人的
    ...(switching ? { ZENTAO_CREATE_TASK_URL: '' } : {})
  });
  Object.assign(config.zentao, { enabled: true, url: zentaoUrl, username: account, password: String(password), ...(switching ? { createTaskUrl: '' } : {}) });
  z.clearCookies();
  invalidateState();
  const state = await getAccountState({ refresh: true });
  return { ok: state.state === 'ok', switched: !!switching, state, ...(state.state === 'ok' ? {} : { error: { kind: state.state, message: state.message } }) };
}

/** 退出登录：清除密码与会话，保留地址与账号（重新登录时预填）；本地数据不动 */
async function logout() {
  const z = await import('./zentaoService.js');
  updateEnvFile({ ZENTAO_PASSWORD: '' });
  config.zentao.password = '';
  z.clearCookies();
  invalidateState();
  return getAccountState();
}

// ==================== 重置为首次使用（调试） ====================

/** 重置后 .env 里的值：全部清空，提醒时间恢复默认；端口等本机项不动 */
const RESET_ENV = {
  ZENTAO_ENABLED: 'false', ZENTAO_URL: '', ZENTAO_USERNAME: '', ZENTAO_PASSWORD: '', ZENTAO_CREATE_TASK_URL: '',
  OPENAI_API_KEY: '', OPENAI_API_KEYS: '', OPENAI_BASE_URL: '', OPENAI_MODEL: '', OPENAI_REPORT_MODEL: '',
  MORNING_HOUR: '9', EVENING_HOUR: '21', WEBHOOK_URL: '', WEBHOOK_TYPE: 'generic',
  PROMPT_ADD_TASK: '', PROMPT_DAILY: '', PROMPT_WEEKLY: '', PROMPT_MONTHLY: '', REPORT_MEMBERS: ''
};

/**
 * 清空全部配置，回到第一次使用的状态
 * @param {{includeData?:boolean}} [options] - 同时清空本地数据
 * @returns {Promise<{cleared:string[]}>}
 */
async function resetAll({ includeData = false } = {}) {
  const z = await import('./zentaoService.js');
  updateEnvFile(RESET_ENV);
  Object.assign(config.zentao, { enabled: false, url: '', username: '', password: '', createTaskUrl: '' });
  Object.assign(config.ai, { apiKey: '', keys: {}, baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', reportModel: '' });
  Object.assign(config.schedule, { morningHour: 9, eveningHour: 21 });
  Object.assign(config.webhook, { url: '', type: 'generic' });
  Object.assign(config.prompts, { addTask: '', daily: '', weekly: '', monthly: '' });
  config.reports.members = [];
  z.clearCookies();

  const cleared = ['禅道配置', 'AI 配置与 Key', '提醒时间与推送', '提示词', '全员报告成员', '收藏的执行', '用户信息'];
  if (includeData) {
    await clearLocalData();
    cleared.push('本地任务 / Bug / 报告 / 附件 / 执行学习记录');
  } else {
    const { setFavoriteExecutions } = await import('./executionManager.js');
    await setFavoriteExecutions([]);
  }
  rmSync(accountFile(), { force: true });
  invalidateState();
  console.log(`[Account] 已重置为首次使用：${cleared.join('、')}`);
  return { cleared };
}

export {
  getAccountState, login, logout, resetAll, invalidateState, classifyLoginError, normalizeZentaoUrl,
  clearLocalData, readAccount, RESET_ENV
};
