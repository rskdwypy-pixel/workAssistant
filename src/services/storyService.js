/**
 * 禅道需求（用户故事 / story，与任务、Bug、文档、报告同级）
 *
 *   listStories()   当前账号相关的需求（我提的 / 指派我的 / 我评审的 / 抄送我的），去重、去已删除
 *   getStory(id)    需求详情：描述(spec) 与验收标准(verify) 已消毒 + 内联图代理；附件列表
 *
 * 需求是只读视图（P0）：浏览、查看、在禅道打开。创建 / 评审 / 变更走禅道网页。
 * 路由基于真实实例（ZenTao 18+）抓取：my-story-{type}、story-view-{id}。
 */
import { fetchMyList, getZentaoJson, isConfigured } from './zentaoService.js';
import { sanitizeDocHtml, slimFiles } from './docService.js';
import { decodeZentaoText } from '../utils/text.js';

/** 我与需求的关联方式（对应 my-story-{type}） */
const MY_STORY_LISTS = ['assignedTo', 'openedBy', 'reviewedBy', 'mailto'];

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

function slimStory(s, users = {}) {
  const st = statusMeta(s.status);
  return {
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

/**
 * 当前账号相关的需求列表。
 * @param {{keyword?:string}} opts
 * @returns {Promise<Array>}
 */
async function listStories({ keyword = '' } = {}) {
  assertReady();
  const picked = new Map();
  let users = {};
  for (const type of MY_STORY_LISTS) {
    let res;
    try { res = await fetchMyList('story', type); } catch { continue; }
    if (res.users) users = { ...users, ...res.users };
    for (const s of res.items) {
      if (!s || !s.id || String(s.deleted) === '1') continue;
      const id = String(s.id);
      if (!picked.has(id)) picked.set(id, s);
    }
  }
  let items = [...picked.values()].map(s => slimStory(s, users));
  // 按 id 倒序（新的在前）
  items.sort((a, b) => Number(b.id) - Number(a.id));
  const kw = String(keyword || '').trim().toLowerCase();
  if (kw) items = items.filter(s => s.title.toLowerCase().includes(kw) || s.id.includes(kw));
  return items;
}

/**
 * 需求详情。
 * @returns {Promise<{id,title,status,statusLabel,stage,stageLabel,pri,category,product,productName,
 *   specHtml,verifyHtml,files,openedBy,assignedTo,openedDate,lastEditedDate}>}
 */
async function getStory(id) {
  assertReady();
  if (!/^\d+$/.test(String(id))) throw new Error('非法的需求 ID');
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
  return {
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
    productName: decodeZentaoText(s.productTitle || (data.product && data.product.name) || ''),
    specHtml: sanitizeDocHtml(s.spec || ''),
    verifyHtml: sanitizeDocHtml(s.verify || ''),
    files: slimFiles(s.files || data.files),
    openedBy: decodeZentaoText(users[s.openedBy] || s.openedBy || ''),
    assignedTo: decodeZentaoText(users[s.assignedTo] || s.assignedTo || ''),
    openedDate: s.openedDate || '',
    lastEditedDate: s.lastEditedDate || s.changedDate || ''
  };
}

export { listStories, getStory, STORY_STATUS, STORY_STAGE };
