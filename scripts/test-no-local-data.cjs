/**
 * 守护测试：前端（extension/）不能把业务数据存在浏览器里。
 *
 * 原则：工时、任务、用户、报告等业务数据只在后端 / 禅道；前端只允许存「界面偏好」和「未提交的草稿」。
 * 这个测试扫描 extension/*.js 里所有 localStorage / sessionStorage / storageGet|Set|Del 的键，
 * 不在白名单里的一律失败——以后谁再加一个本地副本，这里会立刻报出来。
 *
 * 另外校验：老的本地工时 / 用户缓存键只允许出现在「清理老数据」那一行（标记 legacy-cleanup）。
 */
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', 'extension');

// 允许的键 → 为什么允许
const ALLOWED = {
  lastTabMode: '界面偏好：上次停留的标签页',
  debugMode: '界面偏好：调试开关',
  taskDraft: '未提交的表单草稿（任务）',
  bug_draft: '未提交的表单草稿（Bug）',
  waLoginSkipped: '界面偏好：点过「稍后再说」',
  waAiHintPending: '界面偏好：登录后提示配置 AI 一次',
  // 待迁移：含后端地址（前端要先知道后端在哪，属引导信息）和设置页表单的副本。
  // 副本部分要改成只读后端；迁完后这里改成只保留后端地址。见 docs/STATS-PRD.md §6
  workAssistantConfig: '【待迁移】后端地址（引导必需）+ 设置页配置副本'
};
const CONST_KEYS = { ACCOUNT_SKIP_KEY: 'waLoginSkipped', ACCOUNT_AI_HINT_KEY: 'waAiHintPending' };

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

const files = fs.readdirSync(EXT).filter(f => f.endsWith('.js'));
const seen = new Map();   // key → files
const bad = [];

for (const f of files) {
  const src = fs.readFileSync(path.join(EXT, f), 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;   // 注释行
    const re = /\b(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*([^,)]+?)\s*[,)]|\b(?:storageGet|storageSet|storageDel)\s*\(\s*([^,)]+?)\s*[,)]/g;
    let m;
    while ((m = re.exec(line))) {
      const arg = (m[1] || m[2]).trim();
      const lit = arg.match(/^['"]([^'"]+)['"]$/);
      let key = lit ? lit[1] : CONST_KEYS[arg];
      if (!key) {
        // account.js 里的封装函数自己的形参（storageGet = (k) => localStorage.getItem(k)）
        if (f === 'account.js' && /^k$/.test(arg)) continue;
        // 清理老数据：允许变量键，但这一行必须带 legacy-cleanup 标记
        if (/legacy-cleanup/.test(line)) continue;
        bad.push(`${f}:${i + 1} 用了无法确认的键 ${arg}`);
        continue;
      }
      if (!ALLOWED[key]) bad.push(`${f}:${i + 1} 键「${key}」不在白名单里`);
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(f);
    }
  });
}

check('前端只使用白名单里的本地存储键', bad.length === 0, bad.join('；'));
check('今日工时的本地键（workTime_ / taskWorkTime_）不再被写入', !files.some(f => /(workTime_|taskWorkTime_)\$\{|['"`](workTime|taskWorkTime)_/.test(fs.readFileSync(path.join(EXT, f), 'utf8').split('\n').filter(l => !/legacy-cleanup|^\s*\/\/|^\s*\*/.test(l)).join('\n'))));
check('用户列表缓存键 zentao_users 不再被读写', !seen.has('zentao_users'));
const used = [...seen.keys()];
check('白名单没有多余项（用不到的键要从白名单里删掉）', Object.keys(ALLOWED).every(k => used.includes(k)), Object.keys(ALLOWED).filter(k => !used.includes(k)).join(','));

// 工时只来自后端：前端不能再往 /api/workHours 写（POST 已移除）
const nt = fs.readFileSync(path.join(EXT, 'newtab.js'), 'utf8');
check('前端不再 POST /api/workHours（工时只有一个来源：禅道）', !/api\/workHours`?[^)]*\{\s*method:\s*'POST'/.test(nt));

const passed = results.filter(r => r.pass).length;
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
console.log('\n本地存储白名单：' + [...seen.entries()].map(([k, v]) => `${k}[${[...v].join(',')}]`).join('  '));
console.log(`\n前端存储守护：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
