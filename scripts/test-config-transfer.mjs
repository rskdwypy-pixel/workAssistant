/**
 * 回归测试：配置迁移（加密导出 / 解密导入）
 *
 * 用临时 .env（WA_ENV_FILE）与临时数据目录，不读写真实配置、不访问网络。
 *
 * 覆盖：
 *   导出只含用户自己配置的部分（含禅道密码与 AI Key），整份加密、文件里看不到明文
 *   口令错误 / 文件被改 / 旧版文件 / 恶意加密参数：拒绝，且不改动任何配置
 *   导入写回 .env 与运行时配置；本机其他地址的 AI Key 保留；收藏的执行、报告成员、提示词一并恢复
 *   接口：导出 → 导入往返
 *   设置保存时换接口地址：原地址的 Key 保留
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

const tmp = mkdtempSync(join(tmpdir(), 'wa-transfer-'));
const envFile = join(tmp, '.env');
const keyring = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
writeFileSync(envFile, [
  'ZENTAO_ENABLED=true', 'ZENTAO_URL=http://10.0.0.1:8088', 'ZENTAO_USERNAME=lijc', 'ZENTAO_PASSWORD=zt-secret-123', 'ZENTAO_CREATE_TASK_URL=167',
  'OPENAI_BASE_URL=https://relay.example/v1', 'OPENAI_API_KEY=sk-relay-AAA', `OPENAI_API_KEYS=${keyring({ 'relay.example': 'sk-relay-AAA', 'open.bigmodel.cn': 'zp-BBB' })}`,
  'OPENAI_MODEL=minimax-m3', 'OPENAI_REPORT_MODEL=kimi-k3-1', 'MORNING_HOUR=8', 'EVENING_HOUR=20',
  'WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=hook-CCC', 'WEBHOOK_TYPE=wecom',
  `PROMPT_DAILY=${Buffer.from('日报要简洁').toString('base64')}`, 'REPORT_MEMBERS=lijc,zhouh', 'PORT=3721'
].join('\n') + '\n');
process.env.WA_ENV_FILE = envFile;

const { config } = await import('../src/config.js');
config.paths.data = tmp;
writeFileSync(join(tmp, 'executions.json'), JSON.stringify({ executions: [{ id: '167', name: '工作日志' }], favoriteExecutionIds: ['167', '149'] }));
const t = await import('../src/services/configTransfer.js');
const api = (await import('../src/routes/api.js')).default;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', api);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const call = (path, body) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));

try {
  const settings = await t.collectSettings({ aiProvider: 'custom', aiProfiles: { custom: { apiBaseUrl: 'https://relay.example/v1', aiModel: 'minimax-m3' } } });
  check('收集：禅道账号密码与默认执行', settings.zentao.username === 'lijc' && settings.zentao.password === 'zt-secret-123' && settings.zentao.defaultExecution === '167');
  check('收集：AI 地址、两类模型、Key 与各地址的 Key', settings.ai.apiKey === 'sk-relay-AAA' && settings.ai.keys['open.bigmodel.cn'] === 'zp-BBB' && settings.ai.reportModel === 'kimi-k3-1');
  check('收集：提醒时间、推送地址（完整）、提示词、报告成员、收藏的执行、设置页服务商配置',
    settings.notify.morningHour === 8 && /hook-CCC/.test(settings.notify.webhookUrl) && settings.prompts.daily === '日报要简洁' &&
    settings.reportMembers.join() === 'lijc,zhouh' && settings.favorites.join() === '167,149' && settings.client.aiProvider === 'custom');
  check('收集：不含能从禅道同步的数据与本机相关项', !('users' in settings.zentao) && !('executions' in settings) && !('tasks' in settings) && !JSON.stringify(settings).includes('3721'));

  let short = null;
  try { t.encryptSettings(settings, '1234567'); } catch (e) { short = e; }
  check('导出：口令至少 8 位', short && /8 位/.test(short.message));

  const file = t.encryptSettings(settings, '正确的口令 horse');
  const text = JSON.stringify(file);
  check('导出：整份加密，文件里看不到任何账号、密码、Key、地址', !['zt-secret-123', 'sk-relay-AAA', 'zp-BBB', 'hook-CCC', 'lijc', '10.0.0.1', '日报要简洁'].some(x => text.includes(x)));
  check('导出：文件头只列内容类别，便于导入前确认', file.encrypted && file.contents.includes('禅道地址、账号与密码') && file.cipher === 'aes-256-gcm' && file.kdf.name === 'scrypt');
  const again = t.encryptSettings(settings, '正确的口令 horse');
  check('导出：每次的盐与 IV 不同（同口令同内容密文也不同）', again.data !== file.data && again.kdf.salt !== file.kdf.salt);

  const reject = (f, p) => { try { t.decryptSettings(f, p); return null; } catch (e) { return e.message; } };
  check('导入：口令错误被拒绝', /口令不正确/.test(reject(file, '错误的口令 horse')));
  check('导入：密文被改被拒绝', /口令不正确/.test(reject({ ...file, data: Buffer.from('x' + Buffer.from(file.data, 'base64').toString('latin1')).toString('base64') }, '正确的口令 horse')));
  check('导入：改了文件头的内容清单也被拒绝（参与校验）', /口令不正确/.test(reject({ ...file, contents: ['别的'] }, '正确的口令 horse')));
  check('导入：旧版明文文件给出说明', /旧版/.test(reject({ __app: 'workAssistant', __version: 1, config: {} }, 'x')));
  check('导入：拒绝超大加密参数（防止拖死后端）', /参数不正确/.test(reject({ ...file, kdf: { ...file.kdf, N: 2 ** 24 } }, '正确的口令 horse')));
  check('导入：不是本应用的文件', /不是禅道助手/.test(reject({ foo: 1 }, 'x')));
  const decrypted = t.decryptSettings(file, '正确的口令 horse');
  check('导入：正确口令解出完整内容', JSON.stringify(decrypted) === JSON.stringify(settings));

  // 模拟新机器：配置被改成别的，本机另有一个地址的 Key
  writeFileSync(envFile, `ZENTAO_ENABLED=false\nOPENAI_API_KEYS=${keyring({ 'api.deepseek.com': 'ds-LOCAL' })}\nPORT=4000\n`);
  Object.assign(config.zentao, { enabled: false, url: '', username: '', password: '', createTaskUrl: '' });
  Object.assign(config.ai, { baseURL: '', apiKey: '', model: '', reportModel: '', keys: { 'api.deepseek.com': 'ds-LOCAL' } });
  Object.assign(config.webhook, { url: '', type: 'generic' });
  config.reports.members = [];
  writeFileSync(join(tmp, 'executions.json'), JSON.stringify({ executions: [], favoriteExecutionIds: [] }));

  const r = await call('/config/import', { file, passphrase: '错误的口令 horse' });
  check('接口：口令错误返回 400，配置不变', r.status === 400 && /口令不正确/.test(r.message) && config.zentao.password === '' && !readFileSync(envFile, 'utf8').includes('ZENTAO_PASSWORD'));
  const ok = await call('/config/import', { file, passphrase: '正确的口令 horse' });
  const env = readFileSync(envFile, 'utf8');
  check('接口：导入成功并列出导入的内容', ok.success && ok.data.applied.includes('禅道地址、账号与密码') && ok.data.applied.includes('收藏的执行'), JSON.stringify(ok));
  check('导入：禅道配置写回 .env 与运行时（含密码、默认执行）', /ZENTAO_PASSWORD=zt-secret-123/.test(env) && /ZENTAO_CREATE_TASK_URL=167/.test(env) && config.zentao.password === 'zt-secret-123' && config.zentao.enabled === true);
  const keys = JSON.parse(Buffer.from(env.match(/^OPENAI_API_KEYS=(.*)$/m)[1], 'base64').toString());
  check('导入：AI Key 写回；本机其他地址的 Key 保留', /OPENAI_API_KEY=sk-relay-AAA/.test(env) && keys['relay.example'] === 'sk-relay-AAA' && keys['open.bigmodel.cn'] === 'zp-BBB' && keys['api.deepseek.com'] === 'ds-LOCAL' && config.ai.keys['api.deepseek.com'] === 'ds-LOCAL', JSON.stringify(keys));
  check('导入：模型、推送、提醒时间、提示词、报告成员', config.ai.reportModel === 'kimi-k3-1' && config.webhook.type === 'wecom' && /hook-CCC/.test(config.webhook.url) && /EVENING_HOUR=20/.test(env) && config.prompts.daily === '日报要简洁' && config.reports.members.join() === 'lijc,zhouh');
  check('导入：收藏的执行恢复（执行列表本身之后从禅道同步）', JSON.parse(readFileSync(join(tmp, 'executions.json'), 'utf8')).favoriteExecutionIds.join() === '167,149');
  check('导入：本机相关项（端口）不动', /PORT=4000/.test(env));
  check('导入：交给浏览器回填的设置不含密码与 Key', ok.data.client.aiProvider === 'custom' && ok.data.client.zentaoUrl === 'http://10.0.0.1:8088' && !/zt-secret|sk-relay|zp-BBB/.test(JSON.stringify(ok.data.client)));

  const exp = await call('/config/export', { passphrase: '另一个口令 12345', client: {} });
  const round = t.decryptSettings(exp.data, '另一个口令 12345');
  check('接口：导出 → 解密往返一致', exp.success && round.zentao.password === 'zt-secret-123' && round.ai.keys['api.deepseek.com'] === 'ds-LOCAL');

  // 设置页保存时换了接口地址：原地址的 Key 先记下来（以前直接换掉，切回原服务商要重填）
  Object.assign(config.ai, { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'zp-ONLY-IN-API-KEY', keys: {} });
  const sw = await call('/config', { apiBaseUrl: 'https://relay.example/v1', apiKey: 'sk-new-relay' });
  const swKeys = JSON.parse(Buffer.from(readFileSync(envFile, 'utf8').match(/^OPENAI_API_KEYS=(.*)$/m)[1], 'base64').toString());
  check('设置保存：换接口地址时原地址的 Key 保留', sw.success && swKeys['open.bigmodel.cn'] === 'zp-ONLY-IN-API-KEY' && swKeys['relay.example'] === 'sk-new-relay', JSON.stringify(swKeys));
  const sw2 = await call('/config', { apiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '' });
  check('设置保存：切回原地址、Key 留空 → 用原来的 Key', sw2.success && config.ai.apiKey === 'zp-ONLY-IN-API-KEY');
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
