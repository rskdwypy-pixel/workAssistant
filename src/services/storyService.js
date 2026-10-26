/**
 * 禅道需求（用户故事 / story，与任务、Bug、文档、报告同级）
 *
 *   listStories()   当前账号相关的需求（我提的 / 指派我的 / 我评审的 / 抄送我的），去重、去已删除
 *   getStory(id)    需求详情：描述(spec) 与验收标准(verify) 已消毒 + 内联图代理；附件列表
 *
 * 需求是只读视图（P0）：浏览、查看、在禅道打开。创建 / 评审 / 变更走禅道网页。
 * 路由基于真实实例（ZenTao 18+）抓取：my-story-{type}、story-view-{id}。
 */
import { fetchMyList, getZentaoJson, isConfigured, zentaoFetch, getZentaoCookies, cookiesToString, isModernZentao } from './zentaoService.js';
import { sanitizeDocHtml, slimFiles } from './docService.js';
import { decodeZentaoText } from '../utils/text.js';
import { config } from '../config.js';
import { createCache, diffById, singleFlight, trimDetails } from './zentaoCache.js';

/** 我与需求的关联方式（对应 my-story-{type}） */
const MY_STORY_LISTS = ['assignedTo', 'openedBy', 'reviewedBy', 'mailto'];

const ZENTAO_PATH = () => `${(config.zentao.url || '').replace(/\/$/, '')}/zentao`;

/** 需求分类（禅道固定枚举，抓包 2026-10-23 核对） */
const STORY_CATEGORY = [
  ['feature', '功能'], ['interface', '接口'], ['performance', '性能'],
  ['safe', '安全'], ['experience', '体验'], ['improve', '改进'], ['other', '其他']
].map(([value, label]) => ({ value, label }));
/** 需求来源（禅道固定枚举） */
const STORY_SOURCE = [
  ['customer', '客户'], ['user', '用户'], ['po', '产品经理'], ['market', '市场'],
  ['service', '客服'], ['operation', '运营'], ['support', '技术支持'],
  ['competitor', '竞争对手'], ['partner', '合作伙伴'], ['dev', '开发人员'],
  ['tester', '测试人员'], ['bug', 'Bug'], ['forum', '论坛'], ['other', '其他']
].map(([value, label]) => ({ value, label }));
/** 优先级 1~4 */
const STORY_PRI = [1, 2, 3, 4].map(n => ({ value: String(n), label: String(n) }));

/** 需求状态 → 中文标签 + 用于卡片底色的语义色 */
const STORY_STATUS = {
  draft: { label: '草稿', tone: 'muted' },
  active: { label: '激活', tone: 'active' },
  reviewing: { label: '评审中', tone: 'review' },
  changing: { label: '变更中', tone: 'review' },
  closed: { label: '已关闭', tone: 'closed' }
};
/** 需求阶段 → 中文标签 */
const STORY_STAGE = {
  wait: '未开始', planned: '已计划', projected: '已立项', developing: '研发中',
  developed: '研发完毕', testing: '测试中', tested: '测试完毕', verified: '已验收',
  released: '已发布', closed: '已关闭'
};

function assertReady() {
  if (!isConfigured()) {
    const err = new Error('禅道未启用或未配置');
    err.code = 'ZENTAO_DISABLED';
    throw err;
  }
}

function statusMeta(s) {
  return STORY_STATUS[String(s || '')] || { label: String(s || '未知'), tone: 'muted' };
}

/** 能反映「这条需求变没变」的签名：列表项和详情用同一个算法，缓存的详情是否还有效靠它判断 */
function storySig(s) {
  return [s.status, s.stage, s.assignedTo, s.lastEditedDate, s.pri, s.title].map(v => String(v ?? '')).join('|');
}

const storyCache = createCache('stories');
/** 列表缓存刚同步过多久内，信任缓存的详情（签名一致时直接用，不再请求禅道） */
const DETAIL_TRUST_MS = 5 * 60 * 1000;

function slimStory(s, users = {}) {
  const st = statusMeta(s.status);
  return {
    sig: storySig(s),
    lastEditedDate: String(s.lastEditedDate || ''),
    openedDate: String(s.openedDate || ''),
    id: String(s.id),
    title: decodeZentaoText(s.title || '(无标题)'),
    status: String(s.status || ''),
    statusLabel: st.label,
    tone: st.tone,
    stage: String(s.stage || ''),
    stageLabel: STORY_STAGE[String(s.stage || '')] || '',
    pri: Number(s.pri) || 0,
    estimate: Number(s.estimate) || 0,
    category: String(s.category || ''),
    product: String(s.product || ''),
    productName: decodeZentaoText(s.productTitle || s.productName || ''),
    openedBy: decodeZentaoText(users[s.openedBy] || s.openedBy || ''),
    assignedTo: decodeZentaoText(users[s.assignedTo] || s.assignedTo || ''),
    openedByAccount: String(s.openedBy || ''),
    assignedToAccount: String(s.assignedTo || '')
  };
}

/** 从禅道拉当前账号相关的需求（四种关联并行拉，去重、去已删除、新的在前） */
async function fetchStoriesRemote() {
  const results = await Promise.all(MY_STORY_LISTS.map(t => fetchMyList('story', t).then(r => ({ r }), error => ({ error }))));
  const ok = results.filter(x => x.r);
  if (!ok.length) throw (results[0] && results[0].error) || new Error('无法从禅道获取需求');
  const picked = new Map();
  let users = {};
  for (const { r } of ok) {
    if (r.users) users = { ...users, ...r.users };
    for (const s of r.items) {
      if (!s || !s.id || String(s.deleted) === '1') continue;
      const id = String(s.id);
      if (!picked.has(id)) picked.set(id, s);
    }
  }
  return [...picked.values()].map(s => slimStory(s, users)).sort((a, b) => Number(b.id) - Number(a.id));
}

/** 整拉一次 → 和缓存比对 → 只让变更 / 删除的需求的详情缓存失效 → 写缓存 */
function syncStories() {
  return singleFlight('stories', async () => {
    const items = await fetchStoriesRemote();
    const cache = storyCache.read();
    const diff = diffById(cache && cache.items, items, s => s.sig);
    const details = { ...((cache && cache.details) || {}) };
    for (const id of [...diff.changed, ...diff.removed]) delete details[id];
    const syncedAt = Date.now();
    storyCache.write({ items, details, syncedAt });
    return { items, syncedAt, diff };
  });
}

/**
 * 需求列表（带缓存信息）。
 * @param {{maxAge?:number, cacheOnly?:boolean}} opts
 *   cacheOnly  只读缓存，没有就返回 items:null（页面先画缓存用）
 *   maxAge     缓存新于这么多毫秒就直接用，不请求禅道（待办页汇总用）；默认 0 = 总是向禅道要最新
 * @returns {Promise<{items:Array|null, syncedAt:number, fromCache:boolean, diff?:object}>}
 */
async function loadStories({ maxAge = 0, cacheOnly = false } = {}) {
  assertReady();
  const cache = storyCache.read();
  const has = cache && Array.isArray(cache.items);
  if (cacheOnly) return { items: has ? cache.items : null, syncedAt: has ? cache.syncedAt || 0 : 0, fromCache: true };
  if (has && maxAge > 0 && Date.now() - (cache.syncedAt || 0) < maxAge) {
    return { items: cache.items, syncedAt: cache.syncedAt, fromCache: true };
  }
  const r = await syncStories();
  return { ...r, fromCache: false };
}

/**
 * 当前账号相关的需求列表（数组；兼容旧调用）。
 * @param {{keyword?:string, maxAge?:number}} opts
 * @returns {Promise<Array>}
 */
async function listStories({ keyword = '', maxAge = 0 } = {}) {
  const { items } = await loadStories({ maxAge });
  const kw = String(keyword || '').trim().toLowerCase();
  return kw ? items.filter(s => s.title.toLowerCase().includes(kw) || s.id.includes(kw)) : items;
}

/** 写操作之后让缓存失效：列表下次一定重拉，该需求的详情丢掉 */
function invalidateStories(id) {
  const cache = storyCache.read();
  if (!cache) return;
  const details = { ...(cache.details || {}) };
  if (id) delete details[String(id)];
  storyCache.write({ syncedAt: 0, details });
}

/**
 * 需求详情。
 * @returns {Promise<{id,title,status,statusLabel,stage,stageLabel,pri,category,product,productName,
 *   specHtml,verifyHtml,files,openedBy,assignedTo,openedDate,lastEditedDate}>}
 */
async function getStory(id) {
  assertReady();
  if (!/^\d+$/.test(String(id))) throw new Error('非法的需求 ID');
  id = String(id);
  const cache = storyCache.read();
  const hit = cache && cache.details && cache.details[id];
  const listed = cache && Array.isArray(cache.items) && cache.items.find(i => i.id === id);
  if (hit && listed && Date.now() - (cache.syncedAt || 0) < DETAIL_TRUST_MS && hit.sig === listed.sig) return hit.data;
  let data;
  try {
    data = await getZentaoJson(`story-view-${id}.json?onlybody=yes`);
  } catch (err) {
    if (/JSON|Unexpected/.test(err.message)) {
      const e = new Error('需求不存在或已删除');
      e.code = 'STORY_NOT_FOUND';
      throw e;
    }
    throw err;
  }
  const s = data && data.story;
  if (!s || !s.id || String(s.deleted) === '1') {
    const e = new Error('需求不存在或已删除');
    e.code = 'STORY_NOT_FOUND';
    throw e;
  }
  const st = statusMeta(s.status);
  const users = data.users || {};
  const result = {
    id: String(s.id),
    title: decodeZentaoText(s.title || '(无标题)'),
    status: String(s.status || ''),
    statusLabel: st.label,
    tone: st.tone,
    stage: String(s.stage || ''),
    stageLabel: STORY_STAGE[String(s.stage || '')] || '',
    pri: Number(s.pri) || 0,
    estimate: Number(s.estimate) || 0,
    category: String(s.category || ''),
    source: String(s.source || ''),
    sourceNote: decodeZentaoText(s.sourceNote || ''),
    module: String(s.module || '0'),
    product: String(s.product || ''),
    productName: decodeZentaoText(s.productTitle || (data.product && data.product.name) || ''),
    // 正文编辑用原始 HTML（spec/verify），只读展示用已消毒的 *Html
    specRaw: String(s.spec || ''),
    verifyRaw: String(s.verify || ''),
    specHtml: sanitizeDocHtml(s.spec || ''),
    verifyHtml: sanitizeDocHtml(s.verify || ''),
    files: slimFiles(s.files || data.files),
    openedBy: decodeZentaoText(users[s.openedBy] || s.openedBy || ''),
    assignedTo: decodeZentaoText(users[s.assignedTo] || s.assignedTo || ''),
    assignedToAccount: String(s.assignedTo || ''),
    openedDate: s.openedDate || '',
    lastEditedDate: s.lastEditedDate || s.changedDate || '',
    // 禅道原样的 lastEditedDate（可能是空串），编辑时回传做并发校验要用原值
    lastEditedRaw: String(s.lastEditedDate ?? '')
  };
  const fresh = storyCache.read();
  const details = { ...((fresh && fresh.details) || {}) };
  details[id] = { sig: storySig(s), at: Date.now(), data: result };
  storyCache.write({ details: trimDetails(details) });
  return result;
}

/* ───────────────────────── 新建 / 编辑（写操作） ─────────────────────────
 * 真实抓包（ZenTao 18.3，docs/zentao-capture-2026-10-23）结论：
 *  - 需求模块没有 Markdown，正文恒为 HTML，落 spec（描述）/ verify（验收标准）。
 *  - 新建：POST story-create-{product}-0-{module}-0-0-0-0-0.html，multipart XHR，返回 JSON；
 *          URL 里只有 product、module 被认，其余值一律放 body；成功响应不含 ID，需按标题回查。
 *  - 评审人 reviewer[] 必填，缺失直接 {"result":"fail","message":{"reviewer":"..."}}。
 *  - 编辑：先看状态——「评审中/变更中」时标题禁用、spec/verify 不在表单，
 *          必须先 story-recall-{id}-view-no-story.html 撤回评审→「草稿」才能改正文；
 *          保存 POST story-edit-{id}-default-story.html，成功返回 HTML 跳转头（非 JSON），
 *          校验失败才返回 JSON。保存后需求又回「评审中」。
 */

/** 从服务端直出的表单 HTML 里抽某个 <select name> 的选项（[{value,label,selected}]） */
function parseSelectOptions(html, name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sel = new RegExp(`<select\\b[^>]*\\bname\\s*=\\s*["']${esc}["'][^>]*>([\\s\\S]*?)</select>`, 'i');
  const block = html.match(sel);
  if (!block) return [];
  const out = [];
  const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = optRe.exec(block[1]))) {
    const attrs = m[1];
    const value = (attrs.match(/\bvalue\s*=\s*["']([^"']*)["']/i) || [, ''])[1];
    const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (value === '' && !label) continue;
    out.push({ value, label: decodeZentaoText(label || value), selected: /\bselected\b/i.test(attrs) });
  }
  return out;
}

/** 团队成员 → [{value:account,label:realname}]（表单解析失败时兜底） */
function teamOptions() {
  const users = config.zentao.users || {};
  return Object.entries(users).map(([account, realname]) => ({ value: account, label: decodeZentaoText(realname || account) }));
}

async function fetchFormHtml(url) {
  const resp = await zentaoFetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Cookie': cookiesToString(await getZentaoCookies())
    }
  });
  return resp.text();
}

/**
 * 新建需求所需的下拉选项。先读建单表单（含该产品的模块/评审人），表单拿不到则兜底。
 * @param {{product?:string}} opts
 */
async function getStoryForm({ product } = {}) {
  assertReady();
  const p = /^\d+$/.test(String(product || '')) ? String(product) : '0';
  let html = '';
  try { html = await fetchFormHtml(`${ZENTAO_PATH()}/story-create-${p}-0-0-0-0-0-0-0.html`); } catch { /* 用兜底 */ }

  let products = parseSelectOptions(html, 'product');
  if (!products.length) {
    // 兜底：用我相关需求里出现过的产品
    const seen = new Map();
    try {
      for (const s of await listStories({})) if (s.product) seen.set(s.product, s.productName || s.product);
    } catch { /* ignore */ }
    products = [...seen].map(([value, label]) => ({ value, label }));
  }
  const resolved = /^\d+$/.test(String(product || '')) ? String(product) : (products[0] && products[0].value) || '';

  // 禅道的人员选项标签带首字母分组前缀（如「L:罗天文」），去掉更好看
  const cleanPeople = list => list.filter(o => o.value).map(o => ({ ...o, label: o.label.replace(/^[A-Za-z]:/, '') }));
  let modules = parseSelectOptions(html, 'module');
  if (!modules.length) modules = [{ value: '0', label: '/' }];
  let reviewers = cleanPeople(parseSelectOptions(html, 'reviewer[]'));
  if (!reviewers.length) reviewers = teamOptions();
  let assignees = cleanPeople(parseSelectOptions(html, 'assignedTo'));
  if (!assignees.length) assignees = teamOptions();
  let plans = parseSelectOptions(html, 'plans[0]').filter(o => o.value);

  return {
    product: resolved,
    products,
    modules,
    reviewers,
    assignees,
    plans,
    categories: STORY_CATEGORY,
    sources: STORY_SOURCE,
    pris: STORY_PRI,
    defaultAssignedTo: config.zentao.username || ''
  };
}

/** 在某产品下按标题回查最新的需求 ID（新建响应不带 ID） */
async function findStoryIdByTitle(product, title, { retries = 3, delayMs = 500 } = {}) {
  // 刚创建的需求偶尔还没出现在列表里（实测新版禅道有这种延迟）：没找到就隔一会儿再找，最多几次
  for (let attempt = 0; attempt <= retries; attempt++) {
    const id = await findStoryIdOnce(product, title);
    if (id) return id;
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

async function findStoryIdOnce(product, title) {
  const want = decodeZentaoText(String(title || '')).trim();
  // product-browse 默认按 ID 倒序、最新的在前，新旧两个版本都有；story-browse 新版已去掉，旧版实测也读不到，仅作兜底
  const paths = [
    `product-browse-${product}.json`,
    `story-browse-${product}-0-all-0-id_desc-0-50-1.json?onlybody=yes`,
    `story-browse-${product}.json?onlybody=yes`
  ];
  for (const path of paths) {
    let data;
    try { data = await getZentaoJson(path); } catch { continue; }
    const list = data && data.stories;
    const arr = Array.isArray(list) ? list : Object.values(list || {});
    const hit = arr
      .filter(s => s && s.id && decodeZentaoText(s.title || '').trim() === want)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (hit) return String(hit.id);
  }
  return null;
}

async function postMultipart(url, fd) {
  const resp = await zentaoFetch(url, {
    method: 'POST',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': cookiesToString(await getZentaoCookies())
    },
    body: fd
  });
  return resp.text();
}

/**
 * 新建需求。正文为 HTML（需求模块无 markdown），落 spec / verify。
 * @param {{product:string, module?:string, title:string, spec?:string, verify?:string,
 *   reviewers:string[], category?:string, pri?:string|number, source?:string, sourceNote?:string,
 *   assignedTo?:string, estimate?:string|number, keywords?:string, plan?:string}} opts
 * @returns {Promise<{id:string|null, message:string}>}
 */
async function createStory(opts = {}) {
  assertReady();
  const product = String(opts.product || '');
  if (!/^\d+$/.test(product)) throw new Error('请选择所属产品');
  const title = String(opts.title || '').trim();
  if (!title) throw new Error('标题不能为空');
  const reviewers = (Array.isArray(opts.reviewers) ? opts.reviewers : [opts.reviewers])
    .map(r => String(r || '').trim()).filter(Boolean);
  if (!reviewers.length) throw new Error('请至少选择一位评审人');
  const module = String(opts.module || '0');

  const url = `${ZENTAO_PATH()}/story-create-${product}-0-${module}-0-0-0-0-0.html`;
  const fd = new FormData();
  fd.set('product', product);
  fd.set('module', module);
  fd.set('modules[0]', module);
  fd.set('plans[0]', String(opts.plan || ''));
  fd.set('plan', String(opts.plan || ''));
  fd.set('assignedTo', String(opts.assignedTo || config.zentao.username || ''));
  fd.set('source', String(opts.source || ''));
  fd.set('sourceNote', String(opts.sourceNote || ''));
  fd.set('feedbackBy', '');
  fd.set('notifyEmail', '');
  for (const r of reviewers) fd.append('reviewer[]', r);
  fd.set('parent', '0');
  fd.set('title', title);
  fd.set('color', '');
  fd.set('category', String(opts.category || 'feature'));
  fd.set('pri', String(opts.pri || '3'));
  fd.set('estimate', String(opts.estimate || ''));
  fd.set('spec', String(opts.spec || ''));
  fd.set('verify', String(opts.verify || ''));
  fd.set('keywords', String(opts.keywords || ''));
  fd.set('type', 'story');
  fd.set('status', 'reviewing');

  const text = await postMultipart(url, fd);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('创建失败：禅道没有接受这次提交（表单被退回）'); }
  if (json.result !== 'success') {
    const msg = json.message;
    const detail = msg && typeof msg === 'object' ? Object.values(msg).join('；') : msg;
    throw new Error(detail || '创建失败');
  }
  const id = await findStoryIdByTitle(product, title);
  invalidateStories();
  return { id, message: (typeof json.message === 'string' && json.message) || '保存成功' };
}

/**
 * 编辑需求（元数据 + 正文 spec/verify + 备注 comment）。
 * 「评审中/变更中」会先自动撤回评审再编辑；保存后需求回到评审中（与禅道网页行为一致）。
 * @param {{id:string, title?:string, spec?:string, verify?:string, comment?:string,
 *   reviewers?:string[], category?:string, pri?:string|number, source?:string, sourceNote?:string,
 *   assignedTo?:string, estimate?:string|number, keywords?:string, stage?:string}} opts
 */
async function editStory(opts = {}) {
  assertReady();
  const id = String(opts.id || '');
  if (!/^\d+$/.test(id)) throw new Error('非法的需求 ID');

  // 1. 读当前需求（要最新的状态，不能用缓存）；评审中/变更中需先撤回评审，正文才可编辑
  invalidateStories(id);
  let cur = await getStory(id);
  if (cur.status === 'reviewing' || cur.status === 'changing') {
    await zentaoFetch(`${ZENTAO_PATH()}/story-recall-${id}-view-no-story.html`, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Cookie': cookiesToString(await getZentaoCookies())
      }
    });
    // 撤回会更新 lastEditedDate，必须绕过缓存重读，否则带着旧的时间提交会被禅道拒绝（「记录可能已经被改动」）
    invalidateStories(id);
    try { cur = await getStory(id); } catch { /* 用撤回前的值兜底 */ }
  }

  // 2. 评审人：调用方传了用传的；否则从编辑表单里取已选，再不行取全部选项
  let reviewers = (Array.isArray(opts.reviewers) ? opts.reviewers : opts.reviewers != null ? [opts.reviewers] : [])
    .map(r => String(r || '').trim()).filter(Boolean);
  let editHtml = '';
  if (!reviewers.length) {
    try { editHtml = await fetchFormHtml(`${ZENTAO_PATH()}/story-edit-${id}-default-story.html`); } catch { /* ignore */ }
    const opt = parseSelectOptions(editHtml, 'reviewer[]').filter(o => o.value);
    reviewers = opt.filter(o => o.selected).map(o => o.value);
    if (!reviewers.length) reviewers = opt.map(o => o.value);
  }
  if (!reviewers.length) throw new Error('缺少评审人：请在新建/编辑时选择评审人');

  const url = `${ZENTAO_PATH()}/story-edit-${id}-default-story.html`;
  const fd = new FormData();
  fd.set('color', '');
  fd.set('title', String(opts.title != null ? opts.title : cur.title).trim());
  for (const r of reviewers) fd.append('reviewer[]', r);
  fd.set('spec', String(opts.spec != null ? opts.spec : cur.specRaw || ''));
  fd.set('verify', String(opts.verify != null ? opts.verify : cur.verifyRaw || ''));
  fd.set('comment', String(opts.comment || ''));
  // 禅道自身传零值哨兵；有真实 lastEditedDate 就带上做并发校验
  // 新版从没编辑过的需求 lastEditedDate 是空串，原样回传才对得上；旧版没有时用零值
  fd.set('lastEditedDate', String((await isModernZentao()) ? cur.lastEditedRaw : (cur.lastEditedDate || '0000-00-00 00:00:00')));
  fd.set('product', String(cur.product || opts.product || ''));
  fd.set('module', String(opts.module != null ? opts.module : '0'));
  fd.set('parent', '0');
  fd.set('plan', String(opts.plan || ''));
  fd.set('source', String(opts.source != null ? opts.source : cur.source || ''));
  fd.set('sourceNote', String(opts.sourceNote || ''));
  fd.set('status', String(cur.status || 'reviewing'));
  fd.set('stage', String(opts.stage != null ? opts.stage : cur.stage || 'wait'));
  fd.set('category', String(opts.category != null ? opts.category : cur.category || 'feature'));
  fd.set('pri', String(opts.pri != null ? opts.pri : cur.pri || '3'));
  fd.set('estimate', String(opts.estimate != null ? opts.estimate : cur.estimate || '0'));
  fd.set('feedbackBy', '');
  fd.set('notifyEmail', '');
  fd.set('keywords', String(opts.keywords || ''));
  fd.set('assignedTo', String(opts.assignedTo != null ? opts.assignedTo : cur.assignedToAccount || config.zentao.username || ''));

  const text = await postMultipart(url, fd);
  // 成功：HTML 跳转头（parent.location='/zentao/story-view-...'）；失败：JSON 或 alert()
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    let json; try { json = JSON.parse(trimmed); } catch { json = null; }
    if (json && json.result === 'fail') {
      const msg = json.message;
      const detail = msg && typeof msg === 'object' ? Object.values(msg).join('；') : msg;
      throw new Error(detail || '保存失败');
    }
    if (json && json.result === 'success') { invalidateStories(id); return { id, message: (typeof json.message === 'string' && json.message) || '保存成功' }; }
  }
  if (/story-view-\d+/.test(text) || /parent\.location/.test(text)) { invalidateStories(id); return { id, message: '保存成功' }; }
  const alertMsg = (text.match(/alert\(['"]([\s\S]*?)['"]\)/) || [])[1];
  throw new Error(alertMsg ? alertMsg.replace(/\\(.)/g, '$1') : '保存失败：禅道没有接受这次修改');
}

/** 删除需求（放回收站）。与任务/Bug/文档一致：GET story-delete-{id}-yes-.html，回查列表确认。 */
async function deleteStory(id) {
  assertReady();
  if (!/^\d+$/.test(String(id))) throw new Error('非法的需求 ID');
  await zentaoFetch(`${ZENTAO_PATH()}/story-delete-${id}-yes-.html`, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': cookiesToString(await getZentaoCookies())
    }
  });
  let gone = false;
  try { gone = !(await listStories({})).some(s => String(s.id) === String(id)); }
  catch { gone = true; }
  if (!gone) throw new Error('删除未生效');
  invalidateStories(id);
  return { success: true };
}

export {
  listStories, loadStories, getStory, getStoryForm, createStory, editStory, deleteStory,
  parseSelectOptions, findStoryIdByTitle,
  STORY_STATUS, STORY_STAGE, STORY_CATEGORY, STORY_SOURCE, STORY_PRI
};
