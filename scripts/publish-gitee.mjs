#!/usr/bin/env node
/**
 * 把一次发版的产物发布到 Gitee Release（与 GitHub 的 `gh release create` 等价）。
 *
 * 用法：
 *   GITEE_TOKEN=xxx node scripts/publish-gitee.mjs <tag> <目录>
 *     <tag>   版本标签，如 v1.4.0（标签需已存在于 Gitee 仓库）
 *     <目录>  要上传的产物目录（里面放 workassistant.tar.gz / .sha256 / .sig / install.sh / install.ps1）
 *
 * 环境变量：
 *   GITEE_TOKEN   Gitee 私人令牌（仓库 → 发行版 权限）。CI 里放到密钥。
 *   GITEE_REPO    owner/repo，默认 iTreeNewBee/work-assistant
 *   GITEE_BRANCH  target_commitish，默认 main
 *
 * 校验参数而不发网络请求：加 --check。
 *
 * Gitee OpenAPI v5：
 *   POST /repos/{owner}/{repo}/releases                     建 release
 *   POST /repos/{owner}/{repo}/releases/{id}/attach_files   传附件
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { basename, join } from 'path';

const API = 'https://gitee.com/api/v5';
const REPO = process.env.GITEE_REPO || 'iTreeNewBee/work-assistant';
const BRANCH = process.env.GITEE_BRANCH || 'main';
const CHECK = process.argv.includes('--check');
const args = process.argv.slice(2).filter(a => a !== '--check');
const tag = args[0];
const dir = args[1];

function die(msg) { console.error(`[publish-gitee] ${msg}`); process.exit(1); }

if (!tag || !/^v?\d+\.\d+\.\d+$/.test(tag)) die(`标签不对：${tag || '(空)'}（应形如 v1.4.0）`);
if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) die(`产物目录不存在：${dir || '(空)'}`);

const files = readdirSync(dir).filter(f => statSync(join(dir, f)).isFile());
if (!files.length) die(`产物目录是空的：${dir}`);
if (!files.includes('workassistant.tar.gz')) die('产物目录缺少 workassistant.tar.gz');

const [owner, repo] = REPO.split('/');
if (!owner || !repo) die(`GITEE_REPO 格式应为 owner/repo，当前：${REPO}`);

console.log(`[publish-gitee] 仓库 ${REPO} 分支 ${BRANCH} 标签 ${tag}`);
console.log(`[publish-gitee] 待上传 ${files.length} 个文件：${files.join('、')}`);

if (CHECK) { console.log('[publish-gitee] --check 通过（未发请求）'); process.exit(0); }

const token = process.env.GITEE_TOKEN;
if (!token) die('缺少 GITEE_TOKEN');

// Gitee 从海外的 CI 机器上传大文件偶尔很慢甚至挂住：每次请求设超时，失败自动重试
const TIMEOUT_MS = 8 * 60 * 1000;
const RETRIES = 3;
async function api(path, { method = 'GET', form } = {}) {
  const url = `${API}${path}`;
  let lastErr;
  for (let i = 1; i <= RETRIES; i++) {
    try {
      const init = { method, signal: AbortSignal.timeout(TIMEOUT_MS) };
      if (form) init.body = form;
      const resp = await fetch(url, init);
      const text = await resp.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
      if (resp.status >= 500 && i < RETRIES) { lastErr = new Error(`HTTP ${resp.status}`); }
      else return { ok: resp.ok, status: resp.status, json, text };
    } catch (err) {
      lastErr = err;
    }
    console.warn(`[publish-gitee] 第 ${i} 次请求失败（${(lastErr && (lastErr.cause?.code || lastErr.message)) || '未知'}），${i < RETRIES ? '重试' : '放弃'}`);
    if (i < RETRIES) await new Promise(r => setTimeout(r, 5000 * i));
  }
  die(`请求 ${method} ${path.replace(/access_token=[^&]+/, 'access_token=***')} 失败：${(lastErr && lastErr.message) || '未知'}`);
}

// 1. 建 release（若该 tag 已有 release，Gitee 会报错，这里当作已存在并尝试找回它的 id）
async function ensureRelease() {
  const form = new FormData();
  form.set('access_token', token);
  form.set('tag_name', tag);
  form.set('name', tag);
  form.set('body', '已安装的电脑会自动更新（设置 → 关于 可查看或立即更新）。');
  form.set('prerelease', 'false');
  form.set('target_commitish', BRANCH);
  const r = await api(`/repos/${owner}/${repo}/releases`, { method: 'POST', form });
  if (r.ok && r.json && r.json.id) return r.json.id;
  // 已存在：查回同 tag 的 release
  const list = await api(`/repos/${owner}/${repo}/releases?access_token=${encodeURIComponent(token)}&per_page=50`);
  if (list.ok && Array.isArray(list.json)) {
    const hit = list.json.find(x => x.tag_name === tag);
    if (hit) { console.log(`[publish-gitee] release 已存在，复用 id ${hit.id}`); return hit.id; }
  }
  die(`建 release 失败：HTTP ${r.status} ${r.text.slice(0, 300)}`);
}

async function uploadFile(releaseId, name, already) {
  if (already.has(name)) { console.log(`[publish-gitee]   · ${name}（已在 Gitee 上，跳过）`); return; }
  const buf = readFileSync(join(dir, name));
  const form = new FormData();
  form.set('access_token', token);
  form.set('file', new Blob([buf]), name);
  const r = await api(`/repos/${owner}/${repo}/releases/${releaseId}/attach_files`, { method: 'POST', form });
  if (!r.ok) die(`上传 ${name} 失败：HTTP ${r.status} ${r.text.slice(0, 300)}`);
  console.log(`[publish-gitee]   ✓ ${name}`);
}

// 已经传上去的附件（重跑 / 补传时跳过，避免重名报错）
async function existingAttachments(releaseId) {
  const r = await api(`/repos/${owner}/${repo}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(token)}&per_page=100`);
  return new Set(r.ok && Array.isArray(r.json) ? r.json.map(a => a.name) : []);
}

const releaseId = await ensureRelease();
const already = await existingAttachments(releaseId);
console.log(`[publish-gitee] release id ${releaseId}，开始上传附件（已有 ${already.size} 个）`);
for (const f of files) await uploadFile(releaseId, f, already);
console.log(`[publish-gitee] 完成：https://gitee.com/${REPO}/releases/tag/${tag}`);
