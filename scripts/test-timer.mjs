#!/usr/bin/env node
/**
 * 回归测试：工时计时器的后端状态（data/timer.json）
 * 覆盖：开始 / 查询 / 清除；同一时间只有一个；非法任务编号；换禅道地址 / 账号后看不到别人的计时；
 *       文件损坏当作没有；接口（409、now 校准时间）；重置 / 换账号清本地数据时一并清掉
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'node:http';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

const tmp = mkdtempSync(join(tmpdir(), 'wa-timer-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'lijc', password: 'pw' });
const { getTimer, startTimer, clearTimer } = await import('../src/services/timer.js');

try {
  check('一开始没有计时', getTimer() === null);
  let r = startTimer({ taskId: '944', name: '兼容性通杀工具开发' }, 1000);
  check('开始计时：记下任务、名字、开始时间', r.ok && r.timer.taskId === '944' && r.timer.name === '兼容性通杀工具开发' && r.timer.startedAt === 1000 && existsSync(join(tmp, 'timer.json')));
  check('随时可以查到', getTimer().taskId === '944');
  r = startTimer({ taskId: '5' }, 2000);
  check('同一时间只有一个：再开始被拒绝（RUNNING），原来的不变', !r.ok && r.code === 'RUNNING' && r.timer.taskId === '944' && getTimer().startedAt === 1000);
  check('任务编号不合法被拒绝', startTimer({ taskId: 'abc' }).code === 'INVALID' && startTimer({}).code === 'INVALID' && startTimer({ taskId: '' }).code === 'INVALID');
  // 换账号 / 地址
  config.zentao.username = 'yangkai';
  check('换了账号：看不到别人的计时', getTimer() === null);
  r = startTimer({ taskId: '7' }, 3000);
  check('换了账号后可以自己开始计时（会覆盖掉别人账号的那份）', r.ok && getTimer().taskId === '7');
  config.zentao.username = 'lijc'; config.zentao.url = 'http://other.test';
  check('换了禅道地址：同样看不到', getTimer() === null);
  config.zentao.url = 'http://z.test';
  // 清除
  clearTimer();
  check('清除后没有计时，文件也删了', getTimer() === null && !existsSync(join(tmp, 'timer.json')));
  check('清除一个不存在的：不报错', clearTimer().ok === true);
  // 损坏
  writeFileSync(join(tmp, 'timer.json'), '{坏掉了');
  check('文件损坏：当作没有计时', getTimer() === null);
  check('文件损坏时可以重新开始', startTimer({ taskId: '9' }).ok === true);
  writeFileSync(join(tmp, 'timer.json'), JSON.stringify({ scope: 'http://z.test|lijc', taskId: '9', startedAt: 0 }));
  check('开始时间不合法（0）：当作没有', getTimer() === null);
  clearTimer();

  // 接口
  const router = (await import('../src/routes/timer.js')).default;
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = await new Promise(rs => { const s = app.listen(0, '127.0.0.1', () => rs(s)); });
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api${path}`, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(b) }));
    });
    req.on('error', reject); req.end(data);
  });
  let a = await call('GET', '/timer');
  check('接口：没有计时时 timer 为 null，带后端当前时间', a.success && a.data.timer === null && Math.abs(a.data.now - Date.now()) < 5000);
  a = await call('POST', '/timer/start', { taskId: '944', name: '任务' });
  check('接口：开始计时', a.success && a.data.timer.taskId === '944');
  a = await call('POST', '/timer/start', { taskId: '1' });
  check('接口：已有计时 → 409，并把正在走的那个带回去（界面据此同步）', a.status === 409 && a.code === 'RUNNING' && a.data.timer.taskId === '944');
  a = await call('POST', '/timer/start', { taskId: 'x' });
  check('接口：编号不合法 → 400', a.status === 400);
  a = await call('POST', '/timer/clear');
  check('接口：清除', a.success && a.data.timer === null && getTimer() === null);

  // 换账号 / 重置时一并清掉
  startTimer({ taskId: '3' });
  const { clearLocalData } = await import('../src/services/account.js');
  await clearLocalData();
  check('换账号 / 重置清本地数据时，计时也清掉', getTimer() === null && !existsSync(join(tmp, 'timer.json')));
  server.close();
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
