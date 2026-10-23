/**
 * 真函数测试：设置的「后端为准 + 前端缓存」——后端部分
 *   - GET /api/config 返回快照 + 内容指纹 rev；带着同样的 rev 来问只回「没变」
 *   - 快照里没有密码和 Key；包含默认执行 createTaskUrl 与「各服务商记住的地址与模型」
 *   - POST /api/config 保存服务商设置（真身在后端 data/client-settings.json，不在浏览器）
 *   - 冲突检测：baseRev 过期 → 409 且什么都没写；baseRev 最新 → 保存成功并返回新的 rev
 *   - 配置导出时服务商设置取后端存的（前端不用传）；导入时写回后端
 * 临时 .env 与临时数据目录，不碰真实配置、不访问网络。
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

const tmp = mkdtempSync(join(tmpdir(), 'wa-settings-sync-'));
const envFile = join(tmp, '.env');
writeFileSync(envFile, [
  'ZENTAO_ENABLED=true', 'ZENTAO_URL=http://10.0.0.1:8088', 'ZENTAO_USERNAME=lijc', 'ZENTAO_PASSWORD=zt-secret-123', 'ZENTAO_CREATE_TASK_URL=167',
  'OPENAI_BASE_URL=https://relay.example/v1', 'OPENAI_API_KEY=sk-relay-AAA', 'OPENAI_MODEL=minimax-m3',
  'MORNING_HOUR=8', 'EVENING_HOUR=20', 'WEBHOOK_URL=https://hook.example/send?key=hook-CCC', 'WEBHOOK_TYPE=wecom', 'PORT=3721'
].join('\n') + '\n');
process.env.WA_ENV_FILE = envFile;

const { config } = await import('../src/config.js');
config.paths.data = tmp;
writeFileSync(join(tmp, 'executions.json'), JSON.stringify({ executions: [{ id: '167', name: '工作日志' }], favoriteExecutionIds: [] }));
const api = (await import('../src/routes/api.js')).default;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', api);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
const get = (p) => fetch(url(p)).then(async r => ({ status: r.status, ...(await r.json()) }));
const post = (p, body) => fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));

try {
  const g1 = await get('/config');
  check('快照：返回 rev 与数据', g1.success && /^[0-9a-f]{16}$/.test(g1.rev) && g1.data.ai.apiBaseUrl === 'https://relay.example/v1', g1.rev);
  const text = JSON.stringify(g1);
  check('快照：不含密码和 Key（只有「已设置」）', !/zt-secret-123|sk-relay-AAA/.test(text) && g1.data.ai.apiKey === '***已设置***' && g1.data.zentao.hasPassword === true);
  check('快照：含默认执行 createTaskUrl、定时、推送、禅道账号', g1.data.zentao.createTaskUrl === '167' && g1.data.schedule.eveningHour === 20 && g1.data.webhook.type === 'wecom' && g1.data.zentao.username === 'lijc');
  check('快照：服务商设置默认为空', g1.data.client.aiProvider === '' && Object.keys(g1.data.client.aiProfiles).length === 0);

  const g2 = await get('/config');
  check('内容没变 rev 就不变', g2.rev === g1.rev);
  const same = await get(`/config?rev=${g1.rev}`);
  check('带着最新 rev 来问：只回「没变」，不带数据', same.unchanged === true && same.rev === g1.rev && !same.data);
  const stale = await get('/config?rev=0000000000000000');
  check('带着过期 rev 来问：回完整快照', !stale.unchanged && stale.data && stale.rev === g1.rev);

  // 保存服务商设置
  const profiles = { zhipu: { apiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', aiModel: 'glm-4' }, custom: { apiBaseUrl: 'https://relay.example/v1', aiModel: 'minimax-m3', aiReportModel: 'kimi-k3-1' } };
  const s1 = await post('/config', { client: { aiProvider: 'custom', aiProfiles: profiles }, baseRev: g1.rev });
  check('保存：成功并返回新的 rev', s1.success && s1.rev && s1.rev !== g1.rev, JSON.stringify(s1));
  check('服务商设置落在后端文件里（不在浏览器）', existsSync(join(tmp, 'client-settings.json')) && JSON.parse(readFileSync(join(tmp, 'client-settings.json'), 'utf8')).aiProvider === 'custom');
  const g3 = await get('/config');
  check('读回：服务商设置在快照里，rev 与保存时返回的一致', g3.data.client.aiProvider === 'custom' && g3.data.client.aiProfiles.custom.aiReportModel === 'kimi-k3-1' && g3.rev === s1.rev);

  // 冲突检测
  const conflict = await post('/config', { aiModel: 'should-not-save', baseRev: g1.rev });   // g1.rev 已经过期
  check('冲突：过期的 baseRev 被拒绝（409 + CONFIG_CONFLICT + 最新 rev）', conflict.status === 409 && conflict.code === 'CONFIG_CONFLICT' && conflict.rev === g3.rev, JSON.stringify(conflict));
  const g4 = await get('/config');
  check('冲突时什么都没写', g4.data.ai.aiModel === 'minimax-m3' && g4.rev === g3.rev);
  const ok = await post('/config', { aiModel: 'glm-5', baseRev: g3.rev });
  check('baseRev 是最新的：保存成功，模型改了，rev 更新', ok.success && ok.rev !== g3.rev && (await get('/config')).data.ai.aiModel === 'glm-5');
  const noBase = await post('/config', { aiModel: 'glm-5.1' });
  check('不带 baseRev 的老调用方照常保存（向后兼容）', noBase.success && (await get('/config')).data.ai.aiModel === 'glm-5.1');
  check('其它设置变化也会让 rev 变（改定时）', (await post('/config', { eveningHour: '22' })).rev !== noBase.rev && (await get('/config')).data.schedule.eveningHour === 22);

  // 上班日历（节假日 / 调休日）
  const gh0 = await get('/config');
  check('快照：上班日历默认为空', gh0.data.schedule.holidays === '' && gh0.data.schedule.makeup === '');
  const badH = await post('/config', { workHolidays: '2026-10-01~2026-10-07, 乱写的', aiModel: 'should-not-save-2' });
  check('节假日格式不对：400 并指出哪一项，同一次请求里的其它设置也不写', badH.status === 400 && /节假日的格式不对：乱写的/.test(badH.message) && (await get('/config')).data.ai.aiModel !== 'should-not-save-2');
  const badM = await post('/config', { workMakeup: '2026-02-30' });
  check('调休日格式不对（不存在的日期）：400', badM.status === 400 && /调休日的格式不对/.test(badM.message));
  const goodH = await post('/config', { workHolidays: '2026-10-01~2026-10-07, 2026-12-25', workMakeup: '2026-09-20, 2026-10-10' });
  const gh1 = await get('/config');
  check('保存成功：快照里有节假日和调休日，rev 变了', goodH.success && gh1.data.schedule.holidays === '2026-10-01~2026-10-07, 2026-12-25' && gh1.data.schedule.makeup === '2026-09-20, 2026-10-10' && gh1.rev !== gh0.rev);
  check('写进了 .env（WORK_HOLIDAYS / WORK_MAKEUP_DAYS）', /WORK_HOLIDAYS=.*2026-10-01~2026-10-07/.test(readFileSync(envFile, 'utf8')) && /WORK_MAKEUP_DAYS=.*2026-10-10/.test(readFileSync(envFile, 'utf8')));
  await post('/config', { workHolidays: '', workMakeup: '' });
  check('可以清空', (await get('/config')).data.schedule.holidays === '');

  // 工时补填参数（调试页）
  const ga0 = await get('/config');
  check('快照：补填参数有默认值（3 个任务 / 1~4 小时 / 同一任务 8 天 / 无额外要求）', JSON.stringify(ga0.data.autofill) === JSON.stringify({ maxTasksPerDay: 3, minChunk: 1, maxChunk: 4, maxDaysPerTask: 8, prompt: '' }), JSON.stringify(ga0.data.autofill));
  for (const [bad, re] of [[{ maxTasksPerDay: 9 }, /1~5/], [{ minChunk: 5 }, /下限/], [{ maxChunk: 0.5 }, /上限/], [{ minChunk: 3, maxChunk: 2 }, /不能大于/], [{ maxDaysPerTask: 0 }, /1~31/], [{ prompt: 'x'.repeat(501) }, /500/], [{ minChunk: 1.3 }, /下限/]]) {
    const r = await post('/config', { aiModel: 'should-not-save-3', autofill: { maxTasksPerDay: 3, minChunk: 1, maxChunk: 4, maxDaysPerTask: 8, prompt: '', ...bad } });
    check(`补填参数不合法被拒（${JSON.stringify(bad).slice(0, 40)}）：400，且同一请求里的其它设置也不写`, r.status === 400 && re.test(r.message) && (await get('/config')).data.ai.aiModel !== 'should-not-save-3', JSON.stringify(r).slice(0, 120));
  }
  const okAf = await post('/config', { autofill: { maxTasksPerDay: 2, minChunk: 1.5, maxChunk: 3, maxDaysPerTask: 5, prompt: '每条不超过 40 字' } });
  const ga1 = await get('/config');
  check('合法的补填参数保存成功，快照与 rev 更新', okAf.success && ga1.data.autofill.maxTasksPerDay === 2 && ga1.data.autofill.minChunk === 1.5 && ga1.data.autofill.prompt === '每条不超过 40 字' && ga1.rev !== ga0.rev);
  check('写进 .env（提示词用 base64，避免换行和特殊字符）', /AUTOFILL_MAX_TASKS=2/.test(readFileSync(envFile, 'utf8')) && readFileSync(envFile, 'utf8').includes(`AUTOFILL_PROMPT=${Buffer.from('每条不超过 40 字').toString('base64')}`));

  // 清洗
  const bad = await post('/config', { client: { aiProvider: 123, aiProfiles: 'x', evil: '<script>' } });
  const g5 = await get('/config');
  check('服务商设置只收 aiProvider（字符串）和 aiProfiles（对象），别的丢掉', bad.success && g5.data.client.aiProvider === 'custom' && typeof g5.data.client.aiProfiles === 'object' && !('evil' in g5.data.client));

  // 导出 / 导入
  const t = await import('../src/services/configTransfer.js');
  const collected = await t.collectSettings();
  check('导出：不传 client 时取后端存的服务商设置', collected.client.aiProvider === 'custom' && collected.client.aiProfiles.zhipu.aiModel === 'glm-4');
  const forced = await t.collectSettings({ aiProvider: 'zhipu', aiProfiles: {} });
  check('导出：调用方显式传了就以传的为准（兼容老调用）', forced.client.aiProvider === 'zhipu');
  const file = t.encryptSettings({ ...collected, client: { aiProvider: 'openai', aiProfiles: { openai: { apiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' } } } }, '导入用的口令 123');
  const imp = await post('/config/import', { file, passphrase: '导入用的口令 123' });
  check('导入：成功并列出「服务商设置」', imp.success && imp.data.applied.some(x => /服务商/.test(x)), JSON.stringify(imp.data && imp.data.applied));
  const g6 = await get('/config');
  check('导入：服务商设置写回了后端', g6.data.client.aiProvider === 'openai' && g6.data.client.aiProfiles.openai.aiModel === 'gpt-4o-mini');
  check('导入后 rev 变了（别的浏览器的缓存会因此校对到新设置）', g6.rev !== g5.rev);
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  server.close();
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n设置同步（后端）：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
