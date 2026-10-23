/**
 * 回归测试：本机同步 Gitee 的发版脚本（scripts/release-gitee.sh）
 *   - 语法正确；标签不对 / 没有令牌时在发任何请求之前就退出并说明
 *   - 令牌不放进地址（只走请求头），推送输出里会被抹掉
 *   - CI 的发布流程不再碰 Gitee，也不再有手动补同步的工作流
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SH = path.join(ROOT, 'scripts', 'release-gitee.sh');
const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const run = (args, env = {}) => spawnSync('bash', [SH, ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent-home', ...env } });

const src = fs.readFileSync(SH, 'utf8');
check('语法正确（bash -n）', spawnSync('bash', ['-n', SH]).status === 0);

const badTag = run(['1.4.1'], { GITEE_TOKEN: 'x' });
check('标签格式不对 → 退出并提示，不联网', badTag.status !== 0 && /版本标签不对/.test(badTag.stderr));
const noTag = run(['v9.9.9'], { GITEE_TOKEN: 'x' });
check('本地没有这个标签 → 退出并提示', noTag.status !== 0 && /本地没有标签 v9\.9\.9/.test(noTag.stderr));
const tag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (tag) {
  const noToken = run([tag]);
  check('没有令牌 → 退出并说明去哪设置，不联网', noToken.status !== 0 && /缺少 Gitee 令牌/.test(noToken.stderr), noToken.stderr);
}
check('令牌不拼进地址，只走 http.extraHeader', !/https:\/\/[^\s"']*\$\{?TOKEN/.test(src) && /http\.extraHeader/.test(src));
check('推送输出里令牌会被替换成 ***', /sed "s#\$TOKEN#\*\*\*#g"/.test(src));

const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
check('GitHub 发布流程里没有 Gitee 步骤和令牌', !/gitee/i.test(wf.replace(/^#.*$/gm, '')));
check('没有手动补同步 Gitee 的工作流', !fs.existsSync(path.join(ROOT, '.github', 'workflows', 'gitee-sync.yml')));
check('npm run release:gitee 已登记', JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['release:gitee'] === 'bash scripts/release-gitee.sh');

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n本机同步 Gitee：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
