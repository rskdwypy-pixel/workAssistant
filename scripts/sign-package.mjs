#!/usr/bin/env node
/**
 * 给安装包签名：生成 <安装包>.sig（Ed25519，base64）。后台自动更新只安装签名对得上的包。
 *
 * 私钥不进仓库：本机放在 ~/.config/workassistant/release-signing-key.pem，
 * 发版流水线里放在 GitHub 仓库的 Secret（RELEASE_SIGNING_KEY），通过环境变量传入。
 * 对应的公钥写在 src/services/releaseKey.js 里。
 *
 * 用法：node scripts/sign-package.mjs <安装包>     私钥：环境变量 WA_SIGNING_KEY（PEM 内容）或 WA_SIGNING_KEY_FILE
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { RELEASE_PUBLIC_KEY } from '../src/services/releaseKey.js';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('用法：node scripts/sign-package.mjs <安装包>');
  process.exit(1);
}
const keyFile = process.env.WA_SIGNING_KEY_FILE || join(homedir(), '.config', 'workassistant', 'release-signing-key.pem');
const pem = process.env.WA_SIGNING_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : '');
if (!pem) {
  console.error(`找不到签名私钥：设置 WA_SIGNING_KEY，或放在 ${keyFile}`);
  process.exit(1);
}
const key = createPrivateKey(pem);
// 私钥必须与代码里的公钥配对，否则签出来的包所有人都装不上
const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString().trim();
if (pub !== RELEASE_PUBLIC_KEY.trim()) {
  console.error('签名私钥与 src/services/releaseKey.js 里的公钥不匹配');
  process.exit(1);
}
const data = readFileSync(file);
const sig = sign(null, data, key);
if (!verify(null, data, RELEASE_PUBLIC_KEY, sig)) throw new Error('签名自检失败');
writeFileSync(`${file}.sig`, sig.toString('base64') + '\n');
console.log(`✅ 已签名：${file}.sig`);
