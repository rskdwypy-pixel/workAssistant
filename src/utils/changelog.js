/**
 * 更新记录：解析仓库根目录的 CHANGELOG.md（安装包里也带着），给插件在更新后展示「这次更新了什么」。
 *
 * 格式：`## 1.5.2（2026-10-24）` 起一个版本，下面是 `### 新增 / 修复 / 改进` 分组和 `- ` 条目；
 *      `## 未发布` 这类不是版本号的段落不返回。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** 版本号比较：a>b 返回正数 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 解析成 [{version, date, groups:[{title, items:[string]}]}]（文件里的顺序，新的在前） */
export function parseChangelog(text) {
  const out = [];
  let cur = null;
  let group = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(\S+?)\s*(?:[（(]([^）)]*)[）)])?\s*$/);
    if (h2) {
      cur = VERSION_RE.test(h2[1]) ? { version: h2[1], date: h2[2] || '', groups: [] } : null;
      if (cur) out.push(cur);
      group = null;
      continue;
    }
    if (!cur) continue;
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) { group = { title: h3[1], items: [] }; cur.groups.push(group); continue; }
    const item = line.match(/^-\s+(.+)$/);
    if (item) {
      if (!group) { group = { title: '', items: [] }; cur.groups.push(group); }
      group.items.push(item[1].trim());
    } else if (group && group.items.length && /^\s{2,}\S/.test(line)) {
      group.items[group.items.length - 1] += ` ${line.trim()}`;   // 条目的续行
    }
  }
  return out;
}

/**
 * since 之后（不含）到 current（含）的各版本，新的在前。
 * @returns {{current:string, versions:object[]}}
 */
export function changelogSince(text, since, current) {
  const all = parseChangelog(text);
  const versions = all.filter(v => compareVersions(v.version, since) > 0 && compareVersions(v.version, current) <= 0);
  return { current, versions };
}

export function readChangelog() {
  return readFileSync(join(config.paths.root, 'CHANGELOG.md'), 'utf8');
}

export function currentVersion() {
  return JSON.parse(readFileSync(join(config.paths.root, 'package.json'), 'utf8')).version;
}

export { VERSION_RE };
