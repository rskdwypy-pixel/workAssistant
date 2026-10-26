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
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync, copyFileSync } from 'fs';
import { config, updateEnvFile } from '../config.js';
import * as savedAccounts from './savedAccounts.js';

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

// ==================== 本地数据属于哪个禅道 ====================
// 本地任务 / Bug 里存的是禅道里的编号。换了禅道地址（哪怕账号没变），新旧两个禅道的编号会重叠
// （都有 944 号任务，却不是同一个），留着旧数据既显示不对，还可能把新禅道里别的对象当成同一个。
// 所以记下「本地数据来自哪个禅道地址 + 账号」，变了就清掉重新同步。

const scopeFile = () => join(config.paths.data, 'data-scope.json');

function readScope() {
  try {
    const v = existsSync(scopeFile()) ? JSON.parse(readFileSync(scopeFile(), 'utf-8')) : null;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 记下本地数据属于哪个禅道 + 账号。verified=true 表示这个归属是确切的（登录、切换、保存设置时知道数据是从哪来的，
 * 或者已经抽查核对过）；1.8.0 及以前写的记录没有这个标记，下次还会再抽查核对一次。
 */
function writeScope(url, account, { verified = true } = {}) {
  try {
    writeFileSync(scopeFile(), JSON.stringify({ url: normalizeZentaoUrl(url), account: String(account || ''), verified, at: new Date().toISOString() }, null, 2), 'utf-8');
  } catch { /* 写不进去下次再记 */ }
}

const sameUrl = (a, b) => normalizeZentaoUrl(a).toLowerCase() === normalizeZentaoUrl(b).toLowerCase();

/** 本地有没有任务 / Bug 数据（有才需要考虑清） */
async function hasLocalData() {
  const { readTasks } = await import('../utils/storage.js');
  return (((await readTasks()).tasks) || []).length > 0;
}

/**
 * 新的「禅道地址 + 账号」会不会让本地数据对不上。
 * @returns {{changed:boolean, url:boolean, account:boolean, previous:{url:string, account:string}|null}}
 *   没有记录（老版本留下的数据）时 previous 为 null、changed 为 false——是否属于别的禅道要另外逐条核对（见 pruneForeignItems）
 */
function scopeChange(nextUrl, nextAccount) {
  const sc = readScope();
  if (!sc) return { changed: false, url: false, account: false, previous: null };
  const url = !!sc.url && !sameUrl(sc.url, nextUrl);
  const account = !!sc.account && sc.account !== String(nextAccount || '');
  return { changed: url || account, url, account, previous: { url: sc.url || '', account: sc.account || '' } };
}

/**
 * 逐条核对本地任务 / Bug：到当前禅道里查，已不存在、或者编号一样标题却不同的（换禅道前留下的），从本地删掉。
 * 用于没有「来自哪个禅道」确切记录的老数据——换过地址后新旧数据常常混在一起：新禅道若是旧禅道的迁移副本，
 * 大部分编号标题都对得上，只有迁移之后在旧禅道新建的那些对不上，抽查抓不到，必须逐条看。
 * 查不了的（网络、会话）保持不动。删之前先备份 tasks.json。
 * @returns {Promise<{checked:number, removed:number}>}
 */
async function pruneForeignItems() {
  try {
    const z = await import('./zentaoService.js');
    const { readTasks, updateTasks } = await import('../utils/storage.js');
    const { decodeZentaoText } = await import('../utils/text.js');
    const items = (((await readTasks()).tasks) || []).filter(t => t.zentaoId && (t.type === 'bug' || t.type === 'task' || !t.type)).slice(0, 600);
    if (!items.length) return { checked: 0, removed: 0 };
    const CH = (await import('./zentaoService.js')).cookiesToString(await z.getZentaoCookies());
    const norm = (v) => decodeZentaoText(String(v || '')).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const bad = new Set();
    const unknownIds = new Set();
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const t = items[next++];
        const r = await z.lookupZentaoBrief(t.type === 'bug' ? 'bug' : 'task', t.zentaoId, CH);
        if (r.state === 'unknown') unknownIds.add(t.id);
        else if (r.state === 'gone') bad.add(t.id);
        else if (r.state === 'alive' && norm(r.title) !== norm(t.title || t.content || t.name)) bad.add(t.id);
      }
    };
    // 并发太高时新版禅道会对大部分请求返回异常（实测 6 并发时 125/146 查不了），所以最多 3 个并发
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
    // 查不了的再串行补查一遍；还是查不了的保持不动
    for (const t of items.filter(x => unknownIds.has(x.id))) {
      const r = await z.lookupZentaoBrief(t.type === 'bug' ? 'bug' : 'task', t.zentaoId, CH);
      if (r.state === 'gone' || (r.state === 'alive' && norm(r.title) !== norm(t.title || t.content || t.name))) bad.add(t.id);
    }
    if (bad.size) {
      try {
        const tasksFile = join(config.paths.data, 'tasks.json');
        const dir = join(config.paths.data, 'backups');
        mkdirSync(dir, { recursive: true });
        copyFileSync(tasksFile, join(dir, `tasks__prune-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
      } catch { /* 备份失败不挡清理 */ }
      await updateTasks((data) => ({ ...data, tasks: (data.tasks || []).filter(t => !bad.has(t.id)) }));
      console.log(`[Account] 本地有 ${bad.size} 条不属于当前禅道的旧数据，已清理（共核对 ${items.length} 条，已备份）`);
    }
    return { checked: items.length, removed: bad.size };
  } catch (err) {
    console.warn('[Account] 核对本地旧数据失败:', err.message);
    return { checked: 0, removed: 0 };
  }
}

/**
 * 切换到新的禅道地址 / 账号：先把 tasks.json 备份一份，再清掉本地数据，并记下新的归属。
 * 备份放在 data/backups，可手动恢复。
 */
async function switchLocalData(nextUrl, nextAccount) {
  try {
    const tasksFile = join(config.paths.data, 'tasks.json');
    if (existsSync(tasksFile)) {
      const dir = join(config.paths.data, 'backups');
      mkdirSync(dir, { recursive: true });
      copyFileSync(tasksFile, join(dir, `tasks__switch-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    }
  } catch { /* 备份失败不挡切换，但下面照常清 */ }
  await clearLocalData();
  writeScope(nextUrl, nextAccount);
}

/**
 * 在改禅道地址 / 账号之前调用（设置页保存、配置导入）：变了且本地有数据就备份 + 清空。
 * 没有「归属」记录的老数据，在这里按「改动前的配置」补记，下次再变才能识别。
 * @returns {Promise<{cleared:boolean, previous:object|null}>}
 */
async function reconcileBeforeChange(nextUrl, nextAccount) {
  const prevUrl = config.zentao.url || '';
  const prevAccount = config.zentao.username || '';
  if (!nextUrl || !nextAccount) return { cleared: false, previous: null }; // 停用 / 清空配置不算换禅道
  await rememberPrevious(nextUrl, nextAccount);   // 换下来的账号先存进列表（密码这时还在配置里）
  let ch = scopeChange(nextUrl, nextAccount);
  if (!readScope() && prevUrl) {
    // 老数据没有记录：把改动前的配置当作归属，再和新的比
    writeScope(prevUrl, dataOwner() || prevAccount, { verified: false });   // 只是按改动前的配置推测，数据到底是不是这个禅道的还没核对
    ch = scopeChange(nextUrl, nextAccount);
  }
  if (ch.changed && await hasLocalData()) {
    await switchLocalData(nextUrl, nextAccount);
    return { cleared: true, previous: ch.previous };
  }
  if (ch.changed || !readScope()) writeScope(nextUrl, nextAccount);
  return { cleared: false, previous: ch.previous };
}

/**
 * 登录状态确认没问题时的兜底：本地数据归属和当前配置对得上才放心。
 *  - 有归属记录但和当前配置不一致（比如手改了 .env）→ 清
 *  - 没有归属记录（老版本留下的数据）→ 抽查，判断是别的禅道的就清；然后记下归属
 */
async function ensureDataScope() {
  try {
    const url = config.zentao.url || '';
    const account = config.zentao.username || '';
    if (!url || !account) return;
    const ch = scopeChange(url, account);
    if (ch.changed) {
      if (await hasLocalData()) await switchLocalData(url, account);
      else writeScope(url, account);
      return;
    }
    const sc = readScope();
    if (sc && sc.verified) return;
    // 没有记录，或者是旧版本（没有核对标记）写下的：数据可能是换地址前留下的，逐条核对一次，只清对不上的
    if (await hasLocalData()) await pruneForeignItems();
    writeScope(url, account);
  } catch (err) {
    console.warn('[Account] 核对本地数据归属失败:', err.message);
  }
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
    await ensureDataScope();
    await rememberCurrent(profile);
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
  for (const f of ['reports.json', 'history.json', 'executions.json', 'projects.json', 'executionLearning.json', 'zentao-users.json', 'tasks.json.backup', 'autofill-log.json', 'data-scope.json', 'notify-state.json', 'notifications.json', 'timer.json']) {
    rmSync(join(dir, f), { force: true });
  }
  // 需求 / 文档 / 工时等缓存（本来按地址隔离，这里一并清掉，免得留着占地方）
  const cacheDir = join(dir, 'cache');
  if (existsSync(cacheDir)) {
    for (const name of readdirSync(cacheDir)) rmSync(join(cacheDir, name), { recursive: true, force: true });
  }
  const att = join(dir, 'attachments');
  if (existsSync(att)) {
    for (const name of readdirSync(att)) rmSync(join(att, name), { recursive: true, force: true });
  }
  config.zentao.users = {};
}

// ==================== 已保存的账号（快速切换）====================

/** 当前正在用的账号在已保存列表里的 id */
const currentSavedId = () => savedAccounts.idOf(normalizeZentaoUrl(config.zentao.url), config.zentao.username);

/**
 * 把当前配置里的账号记进已保存列表（登录成功、以及老用户升级后第一次读到登录状态时调用）。
 * 信息没变且最近刚记过就不重复写盘。
 */
async function rememberCurrent(profile, { touch = false } = {}) {
  try {
    const { url, username, password } = config.zentao;
    if (!url || !username || !password) return;
    const normalized = normalizeZentaoUrl(url);
    const prev = savedAccounts.get(savedAccounts.idOf(normalized, username));
    const realname = (profile && profile.realname) || '';
    const roleLabel = (profile && profile.roleLabel) || '';
    let version = (prev && prev.version) || '';
    if (!version) {
      try { version = await (await import('./zentaoService.js')).getZentaoVersion(); } catch { /* 取不到版本不影响保存 */ }
    }
    const fresh = prev && prev.password === password && (prev.realname || '') === realname && (prev.version || '') === version
      && Date.now() - Date.parse(prev.lastUsedAt || 0) < 10 * 60 * 1000;
    if (fresh && !touch) return;   // 登录 / 切换（touch）一定要更新最近使用时间；定时刷新状态时不必频繁写盘
    savedAccounts.upsert({ url: normalized, username, password, realname, roleLabel, version });
  } catch (err) {
    console.warn('[Account] 记住账号失败:', err.message);
  }
}

/**
 * 要换掉当前账号 / 地址之前，把当前这个先存进已保存的列表（它的密码这时还在配置里，换掉就找不回来了）。
 * 登录、设置里保存、配置导入这几个入口换账号时都会走到这里，所以「换下来的账号」之后总能一点切回去。
 */
async function rememberPrevious(nextUrl, nextAccount) {
  try {
    const { url, username, password } = config.zentao;
    if (!url || !username || !password) return;
    const prevUrl = normalizeZentaoUrl(url);
    const prevId = savedAccounts.idOf(prevUrl, username);
    if (prevId === savedAccounts.idOf(normalizeZentaoUrl(nextUrl), nextAccount)) return;   // 没换
    const saved = readAccount();
    const known = savedAccounts.get(prevId);
    let version = (known && known.version) || '';
    if (!version) {
      try { version = await (await import('./zentaoService.js')).getZentaoVersion(prevUrl); } catch { /* 取不到版本不影响保存 */ }
    }
    savedAccounts.upsert({
      url: prevUrl, username, password,
      realname: (saved && saved.account === username && saved.realname) || (known && known.realname) || '',
      roleLabel: (saved && saved.account === username && saved.roleLabel) || (known && known.roleLabel) || '',
      version
    });
  } catch (err) {
    console.warn('[Account] 记住换下来的账号失败:', err.message);
  }
}

/** 已保存的账号（给界面，不含密码），按最近使用排序，当前账号带 current 标记 */
function listSaved() {
  return savedAccounts.list(config.zentao.url && config.zentao.username ? currentSavedId() : '');
}

/**
 * 移除一个已保存的账号（连同保存的密码）。正在使用的账号不能移除。
 * @returns {{ok:boolean, code?:'NOT_FOUND'|'CURRENT'}}
 */
function removeSaved(id) {
  if (!savedAccounts.get(id)) return { ok: false, code: 'NOT_FOUND' };
  if (config.zentao.url && config.zentao.username && id === currentSavedId()) return { ok: false, code: 'CURRENT' };
  savedAccounts.remove(id);
  return { ok: true };
}

/** 本地只存在本机、还没同步到禅道的任务 / Bug 条数（没有禅道编号的） */
async function countUnsynced() {
  const { readTasks } = await import('../utils/storage.js');
  return (((await readTasks()).tasks) || []).filter(t => !t.zentaoId).length;
}

/**
 * 用保存的凭据切换到另一个账号：先真实登录验证（密码错 / 连不上在动任何数据之前就返回），
 * 本地数据都已同步到禅道时直接切，有未同步的内容才要求确认。
 * @returns 同 login()；账号不在列表里返回 error.kind = 'not_found'
 */
async function switchTo({ id, confirmSwitch = false }) {
  const entry = savedAccounts.get(id);
  if (!entry) return { ok: false, error: { kind: 'not_found', message: '这个账号已不在已保存的列表里' } };
  if (!entry.password) return { ok: false, error: { kind: 'credentials', message: '这个账号没有保存密码，请重新输入' } };
  return login({ url: entry.url, username: entry.username, password: entry.password, confirmSwitch, quick: true });
}

// ==================== 登录 / 退出 ====================

/**
 * 登录：先用填写的信息真实登录一次，成功才保存
 * 换成了另一个账号且本地有上一个账号的数据：不保存，返回 needConfirm，确认后（confirmSwitch）清空本地数据再保存
 * @returns {Promise<{ok:boolean, needConfirm?:boolean, previous?:Object, error?:{kind:string,message:string}, state?:Object}>}
 */
async function login({ url, username, password, confirmSwitch = false, quick = false }) {
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
  const hasData = await hasLocalData();
  // 没有归属记录的老数据：按登录前的配置（地址 + 账号）补记，这样「账号没变、只换地址」也能识别
  if (!readScope() && config.zentao.url) writeScope(config.zentao.url, owner || config.zentao.username, { verified: false });
  const ch = scopeChange(zentaoUrl, account);
  const switching = hasData && (ch.changed || (owner && owner !== account));
  // 快速切换（用保存的账号）：本地内容都已同步到禅道就不打断，清空后重新同步即可（已备份）；有未同步的才确认
  const unsynced = switching && quick ? await countUnsynced() : 0;
  const needAsk = switching && !confirmSwitch && !(quick && unsynced === 0);
  if (needAsk) {
    const saved = readAccount();
    return {
      ok: false,
      needConfirm: true,
      unsynced,
      previous: {
        account: owner || (ch.previous && ch.previous.account) || '',
        realname: (saved && saved.account === owner && saved.realname) || owner,
        url: (ch.previous && ch.previous.url) || '',
        urlChanged: ch.url,
        accountChanged: !!(owner && owner !== account) || ch.account
      }
    };
  }
  if (switching) await switchLocalData(zentaoUrl, account);
  else writeScope(zentaoUrl, account);

  await rememberPrevious(zentaoUrl, account);
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
  if (state.state === 'ok') await rememberCurrent(state.profile, { touch: true });
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
  savedAccounts.clearAll();   // 保存的账号密码也要清掉：重置就是回到第一次使用
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
  clearLocalData, readAccount, RESET_ENV,
  reconcileBeforeChange, ensureDataScope, pruneForeignItems,
  listSaved, removeSaved, switchTo, rememberCurrent
};
