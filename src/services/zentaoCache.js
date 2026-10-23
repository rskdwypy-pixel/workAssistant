/**
 * 禅道数据的本地缓存（需求 / 文档的列表、详情）。
 *
 * 存在 data/cache/<name>.json，换禅道地址或账号后自动作废（scope 不一致就当没有缓存）。
 * 内存里留一份镜像，同一个进程里不用反复读盘；写盘用「临时文件 + 改名」，断电不会写出半截文件。
 *
 * 为什么不是「只拉新增」：禅道的列表接口不支持按修改时间排序（实测排序参数被忽略），
 * 没法只取改动的那一段。所以列表每次整拉（1~4 个请求），和缓存比对得到 新增 / 变更 / 删除，
 * 只让变更过的条目的详情缓存失效；详情靠「签名」判断是否还有效，没变就不再请求禅道。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

const scopeKey = () => `${(config.zentao.url || '').replace(/\/$/, '')}|${config.zentao.username || ''}`;
const dir = () => join(config.paths.data, 'cache');

/**
 * @param {string} name 缓存名，如 'stories' / 'doc-libs'
 * @returns {{read:()=>object|null, write:(patch:object)=>object, clear:()=>void}}
 *   read() 返回 {scope, syncedAt, ...自定义字段}；scope 不符或没有缓存时返回 null
 */
function createCache(name) {
  let mem;   // undefined = 还没读过盘
  const file = () => join(dir(), `${name}.json`);

  function read() {
    if (mem === undefined) {
      try { mem = JSON.parse(readFileSync(file(), 'utf-8')); } catch { mem = null; }
    }
    return mem && mem.scope === scopeKey() ? mem : null;
  }

  function write(patch) {
    const next = { ...(read() || {}), ...patch, scope: scopeKey() };
    mem = next;
    try {
      mkdirSync(dir(), { recursive: true });
      const tmp = `${file()}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), 'utf-8');
      renameSync(tmp, file());
    } catch { /* 缓存写不进去不影响功能，下次再拉 */ }
    return next;
  }

  function clear() {
    mem = null;
    try { if (existsSync(file())) rmSync(file()); } catch { /* ignore */ }
  }

  return { read, write, clear };
}

/**
 * 新旧两份列表比对。
 * @param {Array} oldItems 缓存里的
 * @param {Array} newItems 刚从禅道拉的
 * @param {(item)=>string} sigOf 能反映「内容变没变」的签名
 * @returns {{added:string[], changed:string[], removed:string[]}} 各自的 id
 */
function diffById(oldItems, newItems, sigOf) {
  const old = new Map((oldItems || []).map(i => [String(i.id), sigOf(i)]));
  const added = [], changed = [];
  for (const i of newItems) {
    const id = String(i.id);
    if (!old.has(id)) added.push(id);
    else if (old.get(id) !== sigOf(i)) changed.push(id);
    old.delete(id);
  }
  return { added, changed, removed: [...old.keys()] };
}

/** 同一个 key 的并发调用共用一次请求（多个页面同时刷新时只打一次禅道） */
const inflight = new Map();
function singleFlight(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** 详情缓存最多留这么多条（按最近使用），防止文件无限变大 */
const DETAIL_MAX = 120;
function trimDetails(details) {
  const keys = Object.keys(details);
  if (keys.length <= DETAIL_MAX) return details;
  keys.sort((a, b) => (details[b].at || 0) - (details[a].at || 0));
  const out = {};
  for (const k of keys.slice(0, DETAIL_MAX)) out[k] = details[k];
  return out;
}

export { createCache, diffById, singleFlight, trimDetails, scopeKey };
