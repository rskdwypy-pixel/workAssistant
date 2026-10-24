/**
 * 真函数测试：首次安装引导 + 更新说明——后端部分
 *   - CHANGELOG.md 解析：版本、日期、分组、条目（含续行）；「未发布」不返回
 *   - GET /api/changelog?since=：只返回 since 之后到当前版本的，新的在前；非法 since 拒绝；不带 since 返回全部
 *   - POST /api/config：早间提醒 / 日报时间必须是 0~23 的整数，不对整个请求拒绝且什么都没改
 *   - 保存新时间后定时按新时间重建（不用重启后端）
 * 临时 .env 与临时数据目录，不碰真实配置、不访问网络。
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

const tmp = mkdtempSync(join(tmpdir(), 'wa-onboarding-'));
writeFileSync(join(tmp, '.env'), 'MORNING_HOUR=9\nEVENING_HOUR=21\nPORT=3721\n');
process.env.WA_ENV_FILE = join(tmp, '.env');

const { config } = await import('../src/config.js');
config.paths.data = tmp;
const { parseChangelog, changelogSince, compareVersions } = await import('../src/utils/changelog.js');

// ---------- 解析 ----------
const SAMPLE = `# 更新记录

> 说明

## 未发布

### 新增

- 还没发的功能

## 1.5.2（2026-10-24）

### 修复

- **A**：第一条
  续行内容
- **B**：第二条

## 1.5.0（2026-10-23）

### 新增

- C

### 改进

- D

## 1.4.2

- 没有分组的条目
`;
const all = parseChangelog(SAMPLE);
check('解析：只返回版本号段落，「未发布」不返回', all.map(v => v.version).join() === '1.5.2,1.5.0,1.4.2', all.map(v => v.version).join());
check('解析：日期、分组、条目', all[0].date === '2026-10-24' && all[0].groups[0].title === '修复' && all[0].groups[0].items.length === 2 && all[1].groups.map(g => g.title).join() === '新增,改进');
check('解析：条目的续行并进上一条', all[0].groups[0].items[0] === '**A**：第一条 续行内容', all[0].groups[0].items[0]);
check('解析：没有日期、没有分组也能解析', all[2].date === '' && all[2].groups[0].title === '' && all[2].groups[0].items[0] === '没有分组的条目');
check('解析：空文本不报错', parseChangelog('').length === 0 && parseChangelog(undefined).length === 0);

check('版本比较：1.10.0 > 1.9.9，相等为 0', compareVersions('1.10.0', '1.9.9') > 0 && compareVersions('1.5.2', '1.5.2') === 0 && compareVersions('1.4.2', '1.5.0') < 0);
const since = changelogSince(SAMPLE, '1.4.2', '1.5.2');
check('since：不含 since 本身，含当前版本，新的在前', since.versions.map(v => v.version).join() === '1.5.2,1.5.0', since.versions.map(v => v.version).join());
check('since：超过当前版本的（还没装上的）不返回', changelogSince(SAMPLE, '1.0.0', '1.5.0').versions.map(v => v.version).join() === '1.5.0,1.4.2');
check('since：已是最新则为空', changelogSince(SAMPLE, '1.5.2', '1.5.2').versions.length === 0);

// ---------- 接口 ----------
const update = (await import('../src/routes/update.js')).default;
const api = (await import('../src/routes/api.js')).default;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', update);
app.use('/api', api);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
const get = (p) => fetch(url(p)).then(async r => ({ status: r.status, ...(await r.json()) }));
const post = (p, body) => fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));

try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const full = await get('/changelog');
  check('GET /changelog：不带 since 返回全部版本，current 是当前版本', full.success && full.data.current === pkg.version && full.data.versions.length > 0 && full.data.versions[0].version === pkg.version, full.data && full.data.current);
  const none = await get(`/changelog?since=${pkg.version}`);
  check('GET /changelog?since=当前版本：没有新内容', none.success && none.data.versions.length === 0);
  const bad = await get('/changelog?since=abc');
  check('GET /changelog：非法 since 返回 400', bad.status === 400 && !bad.success);
  const inj = await get('/changelog?since=1.0.0;rm');
  check('GET /changelog：带注入字符的 since 被拒绝', inj.status === 400);

  // ---------- 保存时间 ----------
  const rem = await import('../src/services/reminder.js');
  const sum = await import('../src/services/summary.js');
  check('导出了 rescheduleReminder / rescheduleSummary', typeof rem.rescheduleReminder === 'function' && typeof sum.rescheduleSummary === 'function');

  for (const [label, body] of [['25 点', { morningHour: '25' }], ['负数', { eveningHour: '-1' }], ['小数', { morningHour: '9.5' }], ['空', { eveningHour: '' }], ['文字', { morningHour: 'abc' }]]) {
    const r = await post('/config', body);
    check(`保存时间：${label}被拒绝（400）`, r.status === 400 && /0~23/.test(r.message || ''), JSON.stringify(r));
  }
  const mixed = await post('/config', { morningHour: '10', eveningHour: '99' });
  check('保存时间：有一项不合法整个请求拒绝，另一项也没改', mixed.status === 400 && config.schedule.morningHour === 9 && config.schedule.eveningHour === 21, `${config.schedule.morningHour}/${config.schedule.eveningHour}`);

  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  rem.startReminder();
  sum.startSummary();
  logs.length = 0;
  const okRes = await post('/config', { morningHour: '8', eveningHour: '20' });
  console.log = origLog;
  check('保存时间：合法值保存成功', okRes.success && config.schedule.morningHour === 8 && config.schedule.eveningHour === 20);
  check('保存时间：写进 .env', /MORNING_HOUR=8/.test(readFileSync(join(tmp, '.env'), 'utf8')) && /EVENING_HOUR=20/.test(readFileSync(join(tmp, '.env'), 'utf8')));
  check('保存时间：早间提醒和日报按新时间重建', logs.some(l => /早间提醒时间已更新.*8:00/.test(l)) && logs.some(l => /日报时间已更新.*20:00/.test(l)), logs.join(' | '));

  logs.length = 0;
  console.log = (...a) => { logs.push(a.join(' ')); };
  await post('/config', { morningHour: '8', eveningHour: '20' });
  await post('/config', { workHolidays: '2026-10-01~2026-10-07' });
  console.log = origLog;
  check('时间没变（或没传）就不重建定时', !logs.some(l => /时间已更新/.test(l)), logs.join(' | '));
  rem.stopReminder();
  sum.stopSummary();
  check('定时没启动时重建是空操作（不抛错）', (() => { try { rem.rescheduleReminder(); sum.rescheduleSummary(); return true; } catch { return false; } })());
} finally {
  server.close();
}

const failed = results.filter(r => !r.pass);
for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.name}${r.pass ? '' : `  → ${r.extra}`}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
