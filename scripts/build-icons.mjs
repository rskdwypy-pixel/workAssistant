#!/usr/bin/env node
/**
 * 由 extension/icons/icon.svg（32px 及以上）和 icon-small.svg（16px 简化版）生成扩展图标 PNG
 * 用本机 Chrome 无头渲染（透明底）。改了 SVG 后运行：node scripts/build-icons.mjs
 */
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ICONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Helium.app/Contents/MacOS/Helium']
  .find(p => existsSync(p));
if (!CHROME) throw new Error('需要本机装有 Chrome 才能渲染图标');

const tmp = mkdtempSync(join(tmpdir(), 'wa-icons-'));
try {
  for (const size of [16, 32, 48, 128]) {
    const svg = readFileSync(join(ICONS, size <= 16 ? 'icon-small.svg' : 'icon.svg'), 'utf8');
    const html = join(tmp, `${size}.html`);
    writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">
      <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`);
    const out = join(ICONS, `icon${size}.png`);
    rmSync(out, { force: true });
    // 无头 Chrome 截完图不一定自己退出：等文件出现后结束它
    const p = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(tmp, `prof-${size}`)}`,
      '--default-background-color=00000000', `--window-size=${size},${size}`, '--force-device-scale-factor=1', `--screenshot=${out}`, `file://${html}`], { stdio: 'ignore' });
    for (let i = 0; i < 100 && !(existsSync(out) && statSync(out).size > 0); i++) await new Promise(r => setTimeout(r, 200));
    await new Promise(r => setTimeout(r, 300));
    p.kill();
    if (!existsSync(out)) throw new Error(`渲染 ${size}px 失败`);
    console.log(`✅ ${out}`);
  }
} finally {
  // 被结束的 Chrome 可能还在写临时配置目录：稍等再删，删不掉也不影响结果
  await new Promise(r => setTimeout(r, 800));
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 临时目录，系统会清理 */ }
}
