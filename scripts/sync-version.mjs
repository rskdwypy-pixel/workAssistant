#!/usr/bin/env node
/**
 * 把 package.json 的版本号同步到扩展（manifest.json、newtab.html 里的静态版本兜底）
 *
 * `npm version x.y.z` 会自动调用（见 package.json 的 version 脚本），改完一并提交；打包时也会再核对一次。
 * 用法：node scripts/sync-version.mjs [--check]   --check：只检查，不一致时以非 0 退出（发版流水线用）
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function syncVersion({ check = false } = {}) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json 的版本号不合法：${version}`);
  const changed = [];

  const manifestPath = join(ROOT, 'extension', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.key) throw new Error('extension/manifest.json 缺少 key（固定扩展 ID 需要）');
  if (manifest.version !== version) {
    manifest.version = version;
    if (!check) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    changed.push('extension/manifest.json');
  }

  const htmlPath = join(ROOT, 'extension', 'newtab.html');
  const html = readFileSync(htmlPath, 'utf8');
  const updatedHtml = html.replace(/(?:工作助手|禅道助手) v\d+\.\d+\.\d+/g, `禅道助手 v${version}`);
  if (updatedHtml !== html) {
    if (!check) writeFileSync(htmlPath, updatedHtml);
    changed.push('extension/newtab.html');
  }
  return { version, changed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const { version, changed } = syncVersion({ check });
  if (check && changed.length) {
    console.error(`版本号不一致（应为 ${version}）：${changed.join('、')}。请运行 node scripts/sync-version.mjs 后提交`);
    process.exit(1);
  }
  console.log(changed.length ? `已把版本号同步为 ${version}：${changed.join('、')}` : `版本号一致：${version}`);
}
