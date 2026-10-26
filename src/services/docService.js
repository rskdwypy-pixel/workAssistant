/**
 * 禅道文档中心（与任务、Bug、报告同级）
 *
 *   listLibs()      汇总各空间（产品 / 项目 / 迭代 / 自定义 / 我的）的文档库
 *   listDocs()      当前账号可见的全部文档（翻页拉 doc-browse 全量，按库分组由前端完成）
 *   getDoc(id)      文档详情：正文（已消毒 + 内联图改写为后端代理）与附件
 *
 * 路由基于真实实例（ZenTao 18+, vision=rnd）抓取冻结，见 docs/DOC-FEATURE-PRD.md。
 * 按库列出不走 doc-browse-{libID}（各版本参数位不同、实测易返回空），统一拉全量再分组。
 * 文件预览/下载复用已有的 GET /api/zentao/files/:fileId/content。
 */
import { getZentaoJson, isConfigured, zentaoFetch, getZentaoCookies, cookiesToString, isModernZentao } from './zentaoService.js';
import { config } from '../config.js';
import { decodeZentaoText } from '../utils/text.js';
import { marked } from 'marked';
import { createCache, diffById, singleFlight, trimDetails } from './zentaoCache.js';
import { randomBytes } from 'crypto';

marked.setOptions({ gfm: true, breaks: true });

/** 各文档库空间：type → 中文标签 */
const SPACE_LABEL = {
  product: '产品库',
  project: '项目库',
  execution: '迭代库',
  custom: '自定义库',
  mine: '我的空间'
};
const LIB_SPACES = ['product', 'project', 'execution', 'custom'];

/** 文档类型 → 展示用图标与标签（text 为正文，其余为文件/外链型） */
const DOC_TYPE_META = {
  text: { icon: '📄', label: '正文' },
  markdown: { icon: '📝', label: 'Markdown' },
  word: { icon: '📘', label: 'Word' },
  ppt: { icon: '📙', label: 'PPT' },
  excel: { icon: '📗', label: 'Excel' },
  attachment: { icon: '📎', label: '附件' },
  url: { icon: '🔗', label: '链接' }
};

function assertReady() {
  if (!isConfigured()) {
    const err = new Error('禅道未启用或未配置');
    err.code = 'ZENTAO_DISABLED';
    throw err;
  }
}

/** 禅道返回的 map/array 统一成数组 */
function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : Object.values(v);
}

/**
 * 文档库列表：合并各空间的 libs。
 * @returns {Promise<Array<{id,name,space,spaceLabel,docCount}>>}
 */
const libCache = createCache('doc-libs');
const LIBS_TTL_MS = 10 * 60 * 1000;

/** 文档库列表（带缓存）。cacheOnly 只读缓存，没有返回 null；force 忽略有效期强制重拉 */
async function listLibs({ cacheOnly = false, force = false } = {}) {
  assertReady();
  const c = libCache.read();
  const has = c && Array.isArray(c.libs);
  if (cacheOnly) return has ? c.libs : null;
  if (!force && has && Date.now() - (c.syncedAt || 0) < LIBS_TTL_MS) return c.libs;
  return singleFlight('doc-libs', async () => {
    const libs = await fetchLibsRemote();
    libCache.write({ libs, syncedAt: Date.now() });
    return libs;
  });
}

// ---- 新版禅道（21+ / IPD，zin 框架）：doc-objectLibs / doc-browse 已不存在，改用 doc-ajaxGetSpaceData ----
// 该接口返回裸 JSON（不是 {data:"…"} 包装），按「空间类型[-空间 ID]」取：返回该空间下的库与文档。
// 不带 ID 时只给第一个空间，所以产品 / 项目要按 spaces 里的 ID 逐个取。

async function ajaxJson(path) {
  const cookies = cookiesToString(await getZentaoCookies());
  const resp = await zentaoFetch(`${ZENTAO_PATH()}/${path}`, {
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Cookie: cookies }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return JSON.parse(await resp.text());
}

const spaceDataPath = (space, id) => `doc-ajaxGetSpaceData-${space}${id ? `-${id}` : ''}.json`;

/** 当前禅道是否是新版文档接口：按禅道版本判断；版本取不到时探测一次（按禅道地址缓存，网络类错误不下结论） */
let modernMemo = null;
async function isModernDocs() {
  const byVersion = await isModernZentao();
  if (byVersion !== null) return byVersion;
  const url = config.zentao.url;
  if (modernMemo && modernMemo.url === url) return modernMemo.value;
  let value = false;
  try {
    const d = await ajaxJson(spaceDataPath('custom'));
    value = !!(d && Array.isArray(d.libs));
  } catch (err) {
    if (!/JSON|Unexpected/.test(err.message)) return false;
  }
  modernMemo = { url, value };
  return value;
}

const MODERN_SPACES = ['mine', 'custom', 'product', 'project'];
const MODERN_TTL_MS = 30 * 1000;
let modernSnapshot = null;

/** 拉全部空间的库和文档（库与文档列表共用，30 秒内同一次同步只请求一遍） */
function fetchModernSpaces() {
  if (modernSnapshot && Date.now() - modernSnapshot.at < MODERN_TTL_MS) return Promise.resolve(modernSnapshot.data);
  return singleFlight('doc-modern-spaces', async () => {
    const libs = new Map();
    const docs = new Map();
    const absorb = (d) => {
      for (const lib of toArray(d && d.libs)) if (lib && lib.id && String(lib.deleted) !== '1') libs.set(String(lib.id), lib);
      for (const doc of toArray(d && d.docs)) if (doc && doc.id && String(doc.deleted) !== '1') docs.set(String(doc.id), doc);
    };
    const queue = [];
    for (const space of MODERN_SPACES) {
      let first;
      try { first = await ajaxJson(spaceDataPath(space)); } catch { continue; }
      absorb(first);
      const ids = toArray(first && first.spaces).map(x => x && x.id).filter(Boolean);
      // 「我的」「自定义」各只有一个空间，第一次已拿到；产品 / 项目要逐个空间取
      if (space === 'product' || space === 'project') ids.forEach(id => queue.push([space, id]));
    }
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const [space, id] = queue[next++];
        try { absorb(await ajaxJson(spaceDataPath(space, id))); } catch { /* 无权限的空间跳过 */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
    const data = { libs: [...libs.values()], docs: [...docs.values()] };
    modernSnapshot = { at: Date.now(), data };
    return data;
  });
}

function slimLibModern(lib) {
  const space = String(lib.type || 'custom');
  const objectID = space === 'product' ? String(lib.product || '0')
    : space === 'project' ? String(lib.project || '0')
    : space === 'execution' ? String(lib.execution || '0')
    : String(lib.parent || '0'); // 我的空间 / 自定义库：新版接口里的 objectID 是所属空间的 ID
  return {
    id: String(lib.id),
    name: decodeZentaoText(lib.name || `文档库 ${lib.id}`),
    space,
    spaceLabel: SPACE_LABEL[space] || space,
    objectType: space,
    objectID,
    acl: String(lib.acl || 'open'),
    docCount: Number(lib.allCount ?? lib.docCount ?? 0) || 0
  };
}

async function fetchLibsRemote() {
  if (await isModernDocs()) {
    const { libs } = await fetchModernSpaces();
    return libs.map(slimLibModern);
  }
  const seen = new Map();
  for (const space of LIB_SPACES) {
    let data;
    try {
      data = await getZentaoJson(`doc-objectLibs-${space}.json`);
    } catch {
      continue; // 某空间无权限或该版本无此 type，跳过
    }
    for (const lib of toArray(data && data.libs)) {
      if (!lib || !lib.id || String(lib.deleted) === '1') continue;
      const id = String(lib.id);
      if (seen.has(id)) continue;
      // 新建文档的接口 URL 需要 objectType/objectID：产品库→产品 id，项目/迭代库同理，自定义库为 0
      const objectID = space === 'product' ? String(lib.product || '0')
        : space === 'project' ? String(lib.project || '0')
        : space === 'execution' ? String(lib.execution || '0')
        : '0';
      seen.set(id, {
        id,
        name: decodeZentaoText(lib.name || `文档库 ${id}`),
        space,
        spaceLabel: SPACE_LABEL[space] || space,
        objectType: space,
        objectID,
        acl: String(lib.acl || 'open'),
        docCount: Number(lib.allCount ?? lib.docCount ?? 0) || 0
      });
    }
  }
  return [...seen.values()];
}

/** 列表项精简字段 */
/** 能反映「这篇文档变没变」的签名：列表项和详情用同一个算法 */
function docSig(d) {
  return [d.title, d.lib, d.module, d.editedDate || d.addedDate].map(v => String(v ?? '')).join('|');
}

const docCache = createCache('docs');
/** 列表缓存刚同步过多久内，信任缓存的详情（签名一致时直接用，不再请求禅道） */
const DETAIL_TRUST_MS = 5 * 60 * 1000;

function slimDoc(d) {
  const type = String(d.type || 'text');
  const meta = DOC_TYPE_META[type] || DOC_TYPE_META.text;
  return {
    sig: docSig(d),
    id: String(d.id),
    lib: String(d.lib || ''),
    module: String(d.module || '0'),
    title: decodeZentaoText(d.title || '(无标题)'),
    type,
    typeIcon: meta.icon,
    typeLabel: meta.label,
    editedBy: d.editedBy || d.addedBy || '',
    addedBy: d.addedBy || '',
    editedDate: d.editedDate || d.addedDate || '',
    draft: String(d.draft || '0') === '1'
  };
}

/** 翻页拉全量（过滤已删除） */
async function fetchDocsRemote() {
  if (await isModernDocs()) {
    const { docs } = await fetchModernSpaces();
    return docs.map(slimDoc);
  }
  const perPage = 200;
  const out = [];
  let page = 1;
  let total = Infinity;
  // 安全上限，防异常分页死循环
  while (out.length < total && page <= 50) {
    const data = await getZentaoJson(`doc-browse-all-0-id_desc-0-${perPage}-${page}.json`);
    const docs = toArray(data && data.docs).filter(d => d && d.id && String(d.deleted) !== '1');
    for (const d of docs) out.push(slimDoc(d));
    total = Number(data && data.pager && data.pager.recTotal) || out.length;
    if (docs.length === 0) break;
    page += 1;
  }
  return out;
}

/** 整拉一次 → 和缓存比对 → 只让变更 / 删除的文档的详情缓存失效 → 写缓存 */
function syncDocs() {
  return singleFlight('docs', async () => {
    const items = await fetchDocsRemote();
    const cache = docCache.read();
    const diff = diffById(cache && cache.items, items, d => d.sig);
    const details = { ...((cache && cache.details) || {}) };
    for (const id of [...diff.changed, ...diff.removed]) delete details[id];
    const syncedAt = Date.now();
    docCache.write({ items, details, syncedAt });
    return { items, syncedAt, diff };
  });
}

/**
 * 文档列表（带缓存信息）。
 * @param {{maxAge?:number, cacheOnly?:boolean}} opts 含义同 storyService.loadStories
 */
async function loadDocs({ maxAge = 0, cacheOnly = false } = {}) {
  assertReady();
  const cache = docCache.read();
  const has = cache && Array.isArray(cache.items);
  if (cacheOnly) return { items: has ? cache.items : null, syncedAt: has ? cache.syncedAt || 0 : 0, fromCache: true };
  if (has && maxAge > 0 && Date.now() - (cache.syncedAt || 0) < maxAge) {
    return { items: cache.items, syncedAt: cache.syncedAt, fromCache: true };
  }
  const r = await syncDocs();
  return { ...r, fromCache: false };
}

/**
 * 当前账号可见的全部文档（数组；兼容旧调用）。
 * @param {{keyword?:string, maxAge?:number}} opts 可选标题关键字（后端兜底过滤）
 */
async function listDocs({ keyword = '', maxAge = 0 } = {}) {
  const { items } = await loadDocs({ maxAge });
  const kw = String(keyword || '').trim().toLowerCase();
  return kw ? items.filter(d => d.title.toLowerCase().includes(kw)) : items;
}

/** 写操作之后让缓存失效：列表下次一定重拉，该文档的详情丢掉，文档库（文档数）也重拉 */
function invalidateDocs(id) {
  modernSnapshot = null; // 新版的空间快照（30 秒内复用）也作废，否则删了 / 改了还读到旧的
  const cache = docCache.read();
  if (cache) {
    const details = { ...(cache.details || {}) };
    if (id) delete details[String(id)];
    docCache.write({ syncedAt: 0, details });
  }
  libCache.write({ syncedAt: 0 });
}

/** 把正文里的禅道内联图片改写为后端代理地址，顺手去掉危险内容 */
function sanitizeDocHtml(html) {
  let s = String(html || '');
  // 去掉脚本 / 样式 / 内嵌框架等危险块
  s = s.replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*(script|iframe|object|embed|link|meta)\b[^>]*>/gi, '');
  // 去掉所有 on* 事件属性（onload/onclick/onerror…）
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 去掉 javascript: 协议
  s = s.replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
  // 内联图片 /zentao/file-read-N.ext（或 file-read-N）→ /api/zentao/files/N/content?ext=
  s = s.replace(/(<img\b[^>]*\bsrc\s*=\s*)("|')([^"']*?)\2/gi, (m, pre, q, url) => {
    const mm = String(url).match(/file-read-(\d+)(?:\.([a-z0-9]+))?/i);
    if (!mm) return m;
    const id = mm[1];
    const ext = mm[2] ? `?ext=${encodeURIComponent(mm[2])}` : '';
    return `${pre}${q}/api/zentao/files/${id}/content${ext}${q}`;
  });
  return s;
}

/**
 * 正文型文档的内容渲染：
 *   - html     → 直接消毒
 *   - markdown → 先渲染成 HTML 再消毒（查看时渲染，不展示源码）
 *   - 其他未知格式 → 当纯文本兜底
 * @returns {{contentHtml:string, contentText:string}}
 */
function renderContent(type, contentType, raw) {
  const ct = String(contentType || '').toLowerCase();
  const isText = type === 'text' || type === 'markdown';
  if (!isText) return { contentHtml: '', contentText: '' };
  if (/^(markdown|md|raw)$/.test(ct) || type === 'markdown') {
    return { contentHtml: sanitizeDocHtml(marked.parse(String(raw || ''))), contentText: '' };
  }
  if (/html/i.test(ct)) return { contentHtml: sanitizeDocHtml(raw), contentText: '' };
  return { contentHtml: '', contentText: decodeZentaoText(String(raw || '')) };
}

/** 生成一次编辑会话 uid（禅道用它把本次上传的文件挂到这篇文档上），仿 PHP uniqid */
function genUid() {
  return Date.now().toString(16) + randomBytes(3).toString('hex');
}

const ZENTAO_PATH = () => `${(config.zentao.url || '').replace(/\/$/, '')}/zentao`;

/**
 * 新建正文文档（markdown 或 html）。
 * 接口（真实抓包）：POST doc-create-{objectType}-{objectID}-{libID}-{module}-{contentType}.html，multipart：
 *   title, uid, type=text, contentType, content(html) / contentMarkdown(md), lib, module, keywords, acl
 * @param {{lib:string, module?:string, title:string, body?:string, contentType?:'markdown'|'html', keywords?:string, acl?:string, uid?:string}} opts
 * @returns {Promise<{id:string|null, message:string}>}
 */
async function createDoc({ lib, module = '0', title, body = '', contentType = 'markdown', keywords = '', acl, uid } = {}) {
  assertReady();
  if (!title || !String(title).trim()) throw new Error('标题不能为空');
  const libInfo = (await listLibs()).find(l => l.id === String(lib));
  if (!libInfo) throw new Error('文档库不存在或无权限');
  const ct = contentType === 'html' ? 'html' : 'markdown';
  const u = uid || genUid();
  const url = `${ZENTAO_PATH()}/doc-create-${libInfo.objectType}-${libInfo.objectID}-${lib}-${module || '0'}-${ct}.html`;
  const fd = new FormData();
  fd.set('title', String(title).trim());
  fd.set('uid', u);
  fd.set('type', 'text');
  fd.set('contentType', ct);
  // 旧版 markdown 正文走 contentMarkdown；新版只认 content
  if (ct === 'markdown' && !(await isModernDocs())) { fd.set('content', ''); fd.set('contentMarkdown', String(body || '')); }
  else { fd.set('content', String(body || '')); }
  fd.set('lib', String(lib));
  fd.set('module', String(module || '0'));
  fd.set('keywords', String(keywords || ''));
  fd.set('acl', acl || libInfo.acl || 'open');
  const resp = await zentaoFetch(url, {
    method: 'POST',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': cookiesToString(await getZentaoCookies())
    },
    body: fd
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('创建失败：禅道没有接受这次提交（表单被退回）'); }
  if (json.result !== 'success') {
    const errs = json.errors && typeof json.errors === 'object' ? Object.values(json.errors).join('；') : '';
    throw new Error(json.message || errs || '创建失败');
  }
  // 新版直接回 id；旧版 locate 形如 /zentao/doc-objectLibs-product-24-75-13.html，末段即新文档 id
  const id = (json.id != null ? String(json.id) : null) || (String(json.locate || '').match(/-(\d+)\.html/) || [])[1] || null;
  invalidateDocs();
  return { id, message: json.message || '保存成功' };
}

/** 从 doc-view 响应里的 lib 对象推出接口 URL 需要的 objectType/objectID（任意库都适用） */
function objectOfLib(lib) {
  const type = String(lib && lib.type || 'custom');
  const objectID = type === 'product' ? String(lib.product || '0')
    : type === 'project' ? String(lib.project || '0')
    : type === 'execution' ? String(lib.execution || '0')
    : '0';
  return { objectType: type, objectID };
}

/**
 * 编辑文档正文 / 标题。
 * 接口（真实抓包）：POST doc-edit-{id}-false-{objectType}-{objectID}-{libID}.html，multipart：
 *   title, content, contentType, type=text, editedDate(并发校验), lib, module, keywords, acl
 * editedDate 必须回传当前值，否则禅道会判为"文档已被他人修改"。
 * @param {{id:string, title?:string, body?:string, keywords?:string, acl?:string}} opts
 */
async function editDoc({ id, title, body, keywords, acl, files } = {}) {
  assertReady();
  if (!/^\d+$/.test(String(id))) throw new Error('非法的文档 ID');
  const modern = await isModernDocs();
  // 新版：文档本体走 doc-ajaxGetDoc，编辑地址去掉了对象 / 库参数
  const data = modern ? { doc: await ajaxJson(`doc-ajaxGetDoc-${id}.json`).catch(() => null), lib: {} } : await getZentaoJson(`doc-view-${id}.json?onlybody=yes`);
  const doc = data && data.doc;
  if (!doc || !doc.id) throw new Error('文档不存在或无权限');
  const { objectType, objectID } = objectOfLib(data.lib || {});
  const lib = String(doc.lib || '');
  const ct = String(doc.contentType || 'markdown').toLowerCase();
  if (modern && ct === 'doc') throw new Error('这篇文档用的是禅道新编辑器，请在禅道里编辑');
  const url = modern ? `${ZENTAO_PATH()}/doc-edit-${id}.json` : `${ZENTAO_PATH()}/doc-edit-${id}-false-${objectType}-${objectID}-${lib}.html`;
  const fd = new FormData();
  fd.set('title', String(title != null ? title : decodeZentaoText(doc.title || '')).trim());
  // 正文：编辑接口 markdown 也放 content 字段（与抓包一致）；html 同理
  fd.set('content', String(body != null ? body : (doc.content || '')));
  fd.set('contentType', /^(markdown|md)$/.test(ct) ? 'markdown' : ct);
  fd.set('type', String(doc.type || 'text'));
  fd.set('editedDate', String(doc.editedDate || ''));
  fd.set('lib', lib);
  fd.set('module', String(doc.module || '0'));
  fd.set('keywords', String(keywords != null ? keywords : decodeZentaoText(doc.keywords || '')));
  fd.set('acl', String(acl || doc.acl || 'open'));
  // 追加附件：与新建任务 / Bug 同款的 files[] + labels[]（标题用去掉扩展名的文件名，禅道下载时自动补回扩展名）
  for (const f of files || []) {
    fd.append('files[]', new Blob([f.buffer], { type: f.mime || 'application/octet-stream' }), f.name);
    fd.append('labels[]', fileLabel(f.name));
  }
  const resp = await zentaoFetch(url, {
    method: 'POST',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': cookiesToString(await getZentaoCookies())
    },
    body: fd
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('保存失败：禅道没有接受这次修改（可能文档已被他人修改，请重新打开）'); }
  if (json.result !== 'success') {
    const errs = json.errors && typeof json.errors === 'object' ? Object.values(json.errors).join('；') : '';
    throw new Error(json.message || errs || '保存失败');
  }
  if (modern && (title != null || body != null)) {
    // 新版对不合规的地址也回「保存成功」却什么都不改：回读确认
    const after = await ajaxJson(`doc-ajaxGetDoc-${id}.json`).catch(() => null);
    const okTitle = title == null || (after && decodeZentaoText(after.title || '') === String(title).trim());
    const okBody = body == null || (after && String(after.content || '') === String(body));
    if (!okTitle || !okBody) throw new Error('保存失败：禅道没有接受这次修改');
  }
  invalidateDocs(id);
  return { id: String(id), message: json.message || '保存成功' };
}

/** 文件名去掉扩展名作为附件标题 */
function fileLabel(name) {
  const n = String(name || '附件');
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(0, i) : n;
}

/**
 * 给文档追加一个附件（走编辑表单的 files[]）。
 * 提交后回读文档确认附件数真的多了——禅道对不允许的类型（可执行文件等）或超大文件会静默不收，不能报成功。
 * 只对正文型文档（text）可用；文件型 / 外链型文档没有编辑表单。
 * @param {{id:string, file:{name:string, mime?:string, buffer:Buffer}}} opts
 * @returns {Promise<{id:string, file:{id:string,name:string,size:number}}>}
 */
async function addDocFile({ id, file } = {}) {
  assertReady();
  if (!file || !file.name || !file.buffer || !file.buffer.length) throw new Error('没有收到文件内容');
  const before = await getDoc(id);
  if (!before.editable) throw new Error('这种类型的文档不能追加附件（只有正文文档可以）');
  const known = new Set(before.files.map(f => f.id));
  invalidateDocs(id);
  await editDoc({ id, files: [file] });
  invalidateDocs(id);
  const after = await getDoc(id);
  const added = after.files.find(f => !known.has(f.id));
  if (!added) throw new Error('禅道没有收下这个文件（可能是类型被禁止，或超过了禅道的上传大小限制）');
  return { id: String(id), file: added };
}

/** 收藏 / 取消收藏文档。禅道：GET doc-collect-{id}-doc.html（再次调用取消）→ {status:'yes'|'no'} */
async function collectDoc(id) {
  assertReady();
  if (!/^\d+$/.test(String(id))) throw new Error('非法的文档 ID');
  const resp = await zentaoFetch(`${ZENTAO_PATH()}/doc-collect-${id}-doc.html`, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': cookiesToString(await getZentaoCookies())
    }
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('操作失败'); }
  // status: 'yes' = 已收藏，'no' = 已取消
  return { collected: json.status === 'yes' };
}

/**
 * 删除文档（放回收站）。禅道删除动作统一是 GET {module}-delete-{id}-yes-.html（-yes- 即确认），
 * 与任务/Bug 一致；成功后回查列表确认已消失。
 */
async function deleteDoc(id) {
  assertReady();
  if (!/^\d+$/.test(String(id))) throw new Error('非法的文档 ID');
  await zentaoFetch(`${ZENTAO_PATH()}/doc-delete-${id}-yes-.${(await isModernDocs()) ? 'json' : 'html'}`, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': cookiesToString(await getZentaoCookies())
    }
  });
  // 回查：禅道删除响应形态多变，以「列表里已不在」为准
  const gone = !(await listDocs({})).some(d => String(d.id) === String(id));
  if (!gone) throw new Error('删除未生效');
  invalidateDocs(id);
  return { success: true };
}

/** 附件数组 → 前端需要的下载信息 */
function slimFiles(files) {
  return toArray(files)
    .filter(f => f && f.id)
    .map(f => {
      const title = decodeZentaoText(f.title || f.pathname || f.realPath || `文件 ${f.id}`);
      const ext = String(f.extension || (String(title).match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
      return {
        id: String(f.id),
        name: ext && !new RegExp(`\\.${ext}$`, 'i').test(title) ? `${title}.${ext}` : title,
        ext,
        size: Number(f.size || 0) || 0
      };
    });
}

/**
 * 文档详情。
 * @returns {Promise<{id,title,type,contentType,contentHtml,files,lib,module,editedBy,editedDate,addedBy,url}>}
 */
async function getDoc(id) {
  assertReady();
  if (!/^\d+$/.test(String(id))) throw new Error('非法的文档 ID');
  id = String(id);
  const cache = docCache.read();
  const hit = cache && cache.details && cache.details[id];
  const listed = cache && Array.isArray(cache.items) && cache.items.find(i => i.id === id);
  if (hit && listed && Date.now() - (cache.syncedAt || 0) < DETAIL_TRUST_MS && hit.sig === listed.sig) return hit.data;
  let data;
  const modern = await isModernDocs();
  try {
    // 新版 doc-view 的 JSON 只剩页面骨架，文档本体走 doc-ajaxGetDoc（直接返回文档对象）
    data = modern ? { doc: await ajaxJson(`doc-ajaxGetDoc-${id}.json`) } : await getZentaoJson(`doc-view-${id}.json?onlybody=yes`);
  } catch (err) {
    // 文档不存在 / 无权限时禅道返回的不是合法 JSON（失败结果后拼着跳转脚本），解析失败即视为不存在
    if (/JSON|Unexpected/.test(err.message)) {
      const e = new Error('文档不存在或已删除');
      e.code = 'DOC_NOT_FOUND';
      throw e;
    }
    throw err;
  }
  const doc = data && data.doc;
  if (!doc || !doc.id || String(doc.deleted) === '1') {
    const err = new Error('文档不存在或已删除');
    err.code = 'DOC_NOT_FOUND';
    throw err;
  }
  const type = String(doc.type || 'text');
  const contentType = String(doc.contentType || 'html').toLowerCase();
  // 新版编辑器（contentType=doc）的 content 是 BlockSuite JSON：展示用禅道渲染好的 html，且不能当文本回填编辑
  const blocksuite = contentType === 'doc';
  const { contentHtml, contentText } = blocksuite && (type === 'text' || type === 'markdown')
    ? { contentHtml: sanitizeDocHtml(doc.html || ''), contentText: '' }
    : renderContent(type, contentType, doc.content || '');
  const isText = (type === 'text' || type === 'markdown') && !blocksuite;
  const result = {
    id: String(doc.id),
    title: decodeZentaoText(doc.title || '(无标题)'),
    type,
    contentType,
    contentHtml,
    contentText,
    // 原始正文（编辑时回填用；仅正文型返回）
    raw: isText ? String(doc.content || '') : '',
    editable: isText,
    keywords: decodeZentaoText(doc.keywords || ''),
    files: slimFiles(doc.files),
    lib: String(doc.lib || ''),
    module: String(doc.module || '0'),
    editedBy: doc.editedBy || '',
    editedDate: doc.editedDate || '',
    addedBy: doc.addedBy || '',
    addedDate: doc.addedDate || '',
    // 外链型文档的目标地址（type=url 时 content 存链接）
    externalUrl: type === 'url' ? String(doc.content || '').trim() : ''
  };
  const fresh = docCache.read();
  const details = { ...((fresh && fresh.details) || {}) };
  details[id] = { sig: docSig(doc), at: Date.now(), data: result };
  docCache.write({ details: trimDetails(details) });
  return result;
}

export { listLibs, listDocs, loadDocs, getDoc, createDoc, editDoc, addDocFile, deleteDoc, collectDoc, genUid, sanitizeDocHtml, slimFiles, renderContent, SPACE_LABEL, DOC_TYPE_META };
