/**
 * 工时计时器的状态（正在给哪个任务计时、从什么时候开始）。
 *
 * 存在后端 data/timer.json，不放浏览器：关页面、换浏览器、清浏览器数据都不丢，多个标签页天然一致。
 * 属于某个「禅道地址 + 账号」：换了地址 / 账号，别人的计时不会出现在现在的账号下。
 * 同一时间只有一个计时。记工时走工作日历同一个接口（见 extension/timer.js），这里只管“计到哪了”。
 */
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'fs';
import { config } from '../config.js';

const file = () => join(config.paths.data, 'timer.json');
const scopeKey = () => `${String(config.zentao.url || '').replace(/\/$/, '').toLowerCase()}|${config.zentao.username || ''}`;

function read() {
  try {
    const v = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf-8')) : null;
    return v && v.scope === scopeKey() && /^\d+$/.test(String(v.taskId)) && Number(v.startedAt) > 0 ? v : null;
  } catch {
    return null;
  }
}

/** @returns {{taskId:string, name:string, startedAt:number}|null} */
function getTimer() {
  const v = read();
  return v ? { taskId: String(v.taskId), name: String(v.name || ''), startedAt: Number(v.startedAt) } : null;
}

/**
 * 开始计时。已经有计时在走返回 { ok:false, code:'RUNNING', timer }（不覆盖）。
 * @param {{taskId:string|number, name?:string}} task
 */
function startTimer({ taskId, name } = {}, now = Date.now()) {
  if (!/^\d+$/.test(String(taskId))) return { ok: false, code: 'INVALID', message: '任务编号不正确' };
  const running = getTimer();
  if (running) return { ok: false, code: 'RUNNING', message: '已经有一个任务在计时了，请先停止', timer: running };
  const timer = { scope: scopeKey(), taskId: String(taskId), name: String(name || '').slice(0, 200), startedAt: now };
  mkdirSync(config.paths.data, { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(timer), 'utf-8');
  renameSync(tmp, file());
  return { ok: true, timer: getTimer() };
}

/** 结束（记完工时 / 放弃）：清掉计时 */
function clearTimer() {
  try { rmSync(file(), { force: true }); } catch { /* 清不掉也不影响 */ }
  return { ok: true };
}

export { getTimer, startTimer, clearTimer };
