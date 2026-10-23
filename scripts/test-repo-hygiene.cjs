/**
 * 守护测试：仓库里不能有会话 cookie / 抓包目录 / 密钥文件。
 *
 * 起因：抓包得到的 cURL 里带着内网禅道的真实会话 cookie；一次 `git add -A docs` 把抓包目录提交进了本地历史
 * （幸好没推送，已重写历史清掉）。这个仓库是公开的，所以在 CI 里也要卡住。
 * 只检查「已被 git 跟踪的文件」，所以本机上被 .gitignore 忽略的抓包目录不影响。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

let files = [];
try {
  files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  console.log('（没有 git，跳过仓库卫生检查）');
  process.exit(0);
}

check('没有跟踪任何抓包目录（docs/zentao-*capture*/）', !files.some(f => /^docs\/zentao-[^/]*capture[^/]*\//.test(f)), files.filter(f => /^docs\/zentao-[^/]*capture/.test(f)).slice(0, 3).join(','));
check('.gitignore 忽略抓包目录', /^docs\/zentao-\*capture\*\/$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
check('没有跟踪 .env / 私钥文件', !files.some(f => /(^|\/)\.env($|\.)|\.pem$|release-signing-key/.test(f) && !/\.env\.example$/.test(f)), files.filter(f => /(^|\/)\.env($|\.)|\.pem$/.test(f)).join(','));

// 内容扫描：会话 cookie、常见密钥形态
const PATTERNS = [
  [/zentaosid=[0-9a-f]{16,}/i, '禅道会话 cookie（zentaosid=…）'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'OpenAI 风格的 API Key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, '私钥']
];
const hits = [];
for (const f of files) {
  if (/\.(png|jpg|jpeg|gif|ico|zip|gz|woff2?)$/i.test(f)) continue;
  let text;
  try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
  // 测试文件里的假数据（如 sk-relay-AAA）长度不够，不会命中；真正的 Key 才会
  for (const [re, label] of PATTERNS) if (re.test(text)) hits.push(`${f}：${label}`);
}
check('已跟踪的文件里没有会话 cookie / API Key / 私钥', hits.length === 0, hits.slice(0, 5).join('；'));

const passed = results.filter(r => r.pass).length;
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra && !r.pass ? `  (${r.extra})` : ''}`);
console.log(`\n仓库卫生：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
