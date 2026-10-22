/**
 * 回归测试：AI 设置（分类模型 / Key 按地址保存 / 获取模型列表 / 测速推荐 / 测试连接）
 *
 * 后端：本地模拟一个 OpenAI 兼容服务（/v1/models、/v1/chat/completions），不访问网络、不写 .env。
 * 前端：jsdom 加载真实 newtab.html，从 newtab.js 抽出真实代码原样执行。
 *
 * 覆盖：
 *   - 两类模型：任务解析（新建任务 / Bug、执行匹配）与报告总结分别取模型；报告留空时与任务解析相同
 *   - Key 按接口地址（主机）保存：留空时只用该地址保存过的 Key，不会发给别的地址
 *   - 接口地址填完整聊天地址时规整为 base URL
 *   - 获取模型列表；测试连接按用途给结论（任务解析看是否在 8 秒内）；测速推荐：任务解析选实测最快的，
 *     报告选实测可用里档位更高的；非对话模型、cn: 重复项不测
 *   - 设置页：获取后两个下拉框都可选；测速结果可一键填入；切换服务商不丢已填的 Key / 地址 / 模型，切回来恢复；
 *     已保存 Key 的地址提示「留空即可」；保存时不再把 Key 存进浏览器
 *   - 后端地址只认本机地址
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const { JSDOM } = require('jsdom');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ---------- 模拟 OpenAI 兼容服务 ----------
const seen = [];
const ai = express();
ai.use(express.json());
const GOOD_KEYS = new Set(['Bearer sk-good', 'Bearer sk-saved']);
ai.get('/v1/models', (req, res) => {
  seen.push({ path: '/models', auth: req.headers.authorization });
  if (!GOOD_KEYS.has(req.headers.authorization)) return res.status(401).json({ error: { message: 'invalid key' } });
  res.json({ object: 'list', data: ['fast-flash', 'cn:fast-flash', 'big-pro', 'thinker', 'broken', 'text-embedding-3', 'fast-flash'].map(id => ({ id })) });
});
ai.post('/v1/chat/completions', async (req, res) => {
  seen.push({ path: '/chat', auth: req.headers.authorization, body: req.body });
  if (!GOOD_KEYS.has(req.headers.authorization)) return res.status(401).json({ error: { message: 'invalid key' } });
  const m = req.body.model;
  if (m === 'broken' || m === 'nope') return res.status(400).json({ error: { message: 'model not found' } });
  const isTask = /executionId/.test(JSON.stringify(req.body.messages));
  if (m === 'big-pro') await tick(300);
  const content = isTask ? JSON.stringify({ title: '修复登录', status: 'in_progress', priority: 1, progress: 50, executionId: '149' }) : JSON.stringify({ summary: '今天完成两项' });
  res.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, reasoning_content: m === 'thinker' ? '想一想' : undefined } }] });
});
const aiServer = await new Promise(r => { const s = ai.listen(0, '127.0.0.1', () => r(s)); });
const AI = `http://127.0.0.1:${aiServer.address().port}`;

const configModule = await import('../src/config.js');
const { config, normalizeAiBaseUrl, aiModelFor, savedKeyFor, rememberKey, aiKeyHost } = configModule;
Object.assign(config.ai, { apiKey: 'sk-saved', baseURL: `${AI}/v1`, model: 'fast-flash', reportModel: '', keys: {} });
const probe = await import('../src/services/aiProbe.js');
const apiRouter = (await import('../src/routes/api.js')).default;
const app = express();
app.use(express.json());
app.use('/api', apiRouter);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));

try {
  // ============ 分类模型 ============
  check('报告模型留空：与任务解析模型相同', aiModelFor('report') === 'fast-flash' && aiModelFor('task') === 'fast-flash');
  config.ai.reportModel = 'big-pro';
  check('报告模型单独设置：报告用它，任务解析不受影响', aiModelFor('report') === 'big-pro' && aiModelFor('task') === 'fast-flash');
  config.ai.reportModel = '';
  const src = (f) => readFileSync(join(ROOT, 'src', 'ai', f), 'utf8');
  check('调用处按用途取模型：新建任务解析、执行匹配、Bug 分析用任务模型；报告用报告模型',
    /model: aiModelFor\('task'\)/.test(src('unifiedAnalyzer.js')) && (src('openai.js').match(/aiModelFor\('task'\)/g) || []).length === 2 &&
    /model: aiModelFor\('report'\)/.test(src('openai.js')) && /model: aiModelFor\('report'\)/.test(src('reportAI.js')) && !/config\.ai\.model/.test(src('openai.js') + src('reportAI.js') + src('unifiedAnalyzer.js')));
  check('不再在模块加载时固定 AI 客户端（改设置后无需重启）', !/^const client = createOpenAIClient\(\);/m.test(src('openai.js')));

  // ============ Key 按地址保存 ============
  check('主机识别（含端口，忽略路径）', aiKeyHost('https://dyschop.online:8444/v1/chat/completions') === 'dyschop.online:8444');
  check('升级前只有一个 Key：当前地址仍能取到', savedKeyFor(`${AI}/v1`) === 'sk-saved' && savedKeyFor('https://other.com/v1') === '');
  const encoded = rememberKey('https://relay.example:8444/v1', 'sk-relay');
  check('按地址记住 Key，写进 .env 的值是单行 base64', savedKeyFor('https://relay.example:8444/v1/chat/completions') === 'sk-relay' && /^[A-Za-z0-9+/=]+$/.test(encoded) && JSON.parse(Buffer.from(encoded, 'base64').toString()).hasOwnProperty('relay.example:8444'));
  check('切到别的地址再切回来：原来的 Key 还在', savedKeyFor(`${AI}/v1`) === 'sk-saved');

  // ============ 地址规整 ============
  check('完整聊天地址规整为 base URL', normalizeAiBaseUrl('https://dyschop.online:8444/v1/chat/completions') === 'https://dyschop.online:8444/v1');
  check('末尾斜杠、/models 也去掉；正常地址不变', normalizeAiBaseUrl(' https://a.com/v1/ ') === 'https://a.com/v1' && normalizeAiBaseUrl('https://a.com/v1/models') === 'https://a.com/v1');

  // ============ 获取模型列表 ============
  let r = await post('/api/ai/models', { baseUrl: `${AI}/v1/chat/completions`, apiKey: 'sk-good' });
  check('获取模型列表：去重、排序、返回规整后的地址', r.success && r.models.join() === 'big-pro,broken,cn:fast-flash,fast-flash,text-embedding-3,thinker' && r.baseUrl === `${AI}/v1`, JSON.stringify(r));
  r = await post('/api/ai/models', { baseUrl: `${AI}/v1`, apiKey: 'sk-bad' });
  check('Key 不对：给出可读原因', !r.success && /API Key 无效/.test(r.message), r.message);
  r = await post('/api/ai/models', { baseUrl: `${AI}/wrong`, apiKey: 'sk-good' });
  check('地址不对（404）：提示一般以 /v1 结尾', !r.success && /404/.test(r.message), r.message);
  r = await post('/api/ai/models', { baseUrl: `${AI}/v1`, apiKey: '' });
  check('没填 Key：用这个地址保存过的', r.success && seen[seen.length - 1].auth === 'Bearer sk-saved');
  const before = seen.length;
  r = await post('/api/ai/models', { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' });
  check('没填 Key、地址没保存过：不把别的地址的 Key 发出去', !r.success && /API Key/.test(r.message) && seen.length === before, r.message);

  // ============ 测试连接（按用途） ============
  r = await post('/api/ai/test', { baseUrl: `${AI}/v1`, apiKey: 'sk-good', model: 'fast-flash', purpose: 'task' });
  const chat = seen.filter(x => x.path === '/chat').pop();
  check('任务解析测试：用与真实场景同类的 JSON 请求', r.success && r.verdict.level === 'good' && /适合任务解析/.test(r.message) && chat.body.response_format && /executionId/.test(JSON.stringify(chat.body.messages)), JSON.stringify(r));
  check('测试请求的 max_tokens 给够（推理模型先思考）', chat.body.max_tokens >= 1000);
  r = await post('/api/ai/test', { baseUrl: `${AI}/v1`, apiKey: 'sk-good', model: 'thinker', purpose: 'report' });
  check('报告测试：推理模型标出来，结论是适合报告', r.success && r.reasoning === true && /适合生成报告/.test(r.message), JSON.stringify(r));
  r = await post('/api/ai/test', { baseUrl: `${AI}/v1`, apiKey: 'sk-good', model: 'nope', purpose: 'task' });
  check('模型不存在：给出原因', !r.success && /model not found/.test(r.message), r.message);
  r = await post('/api/ai/test', { baseUrl: `${AI}/v1`, apiKey: 'sk-good', model: '' });
  check('没填模型：400', r.status === 400);

  // ============ 结论与推荐（规则） ============
  const v = (seconds, extra = {}) => probe.verdictFor('task', { ok: true, seconds, reasoning: false, ...extra });
  check('任务解析：5 秒内适合、5~8 秒接近上限、超过 8 秒会改用本地解析', v(2.5).level === 'good' && v(7).level === 'slow' && v(11, { reasoning: true }).level === 'bad' && /本地解析/.test(v(11).text) && /可用于报告/.test(v(11).text));
  check('报告：60 秒内都适合', probe.verdictFor('report', { ok: true, seconds: 30, reasoning: true }).level === 'good');
  check('测速候选：去掉向量等非对话模型，cn: 与同名只测一个；超出上限的列为未测', probe.pickCandidates(['fast-flash', 'cn:fast-flash', 'cn:only', 'text-embedding-3', 'whisper-1']).models.join() === 'fast-flash,cn:only' && probe.pickCandidates(['a', 'b', 'c'], 2).skipped.join() === 'c');
  const rec = probe.recommend([
    { model: 'glm-flash', ok: true, seconds: 2.6, reasoning: false },
    { model: 'minimax-m3', ok: true, seconds: 3.0, reasoning: false },
    { model: 'deepseek-v4-pro', ok: true, seconds: 8.0, reasoning: true },
    { model: 'kimi-k3-1', ok: true, seconds: 15, reasoning: true },
    { model: 'auto', ok: false, seconds: 25, reasoning: true },
    { model: 'glm-5v-turbo', ok: true, seconds: 3.5, reasoning: false }
  ]);
  check('推荐：任务解析按实测速度（不看名字），慢的推理模型不推荐', rec.task.join() === 'glm-flash,minimax-m3,glm-5v-turbo', rec.task.join());
  check('推荐：报告在可用的里优先 pro / k3 / 推理模型，失败的不推荐', rec.report[0] === 'deepseek-v4-pro' && rec.report[1] === 'kimi-k3-1' && !rec.report.includes('auto'), rec.report.join());

  // ============ 测速推荐接口 ============
  r = await post('/api/ai/benchmark', { baseUrl: `${AI}/v1`, apiKey: 'sk-good', models: ['fast-flash', 'cn:fast-flash', 'big-pro', 'thinker', 'broken', 'text-embedding-3'] });
  check('测速接口：只测对话模型、去掉重复', r.success && r.tested === 4 && r.results.length === 4, JSON.stringify(r).slice(0, 300));
  check('测速接口：每个模型两类用途的结论；失败的排在最后', r.results[r.results.length - 1].model === 'broken' && r.results[0].task && r.results[0].report);
  check('测速接口：可用的模型测两轮，按较慢的一次算', r.results.find(x => x.model === 'fast-flash').samples.length === 2 && r.results.find(x => x.model === 'broken').samples.length === 1);
  check('测速接口：给出推荐', r.recommend.task.includes('fast-flash') && r.recommend.report[0] === 'big-pro', JSON.stringify(r.recommend));

  // ============ 设置页 ============
  const SRC = readFileSync(join(ROOT, 'extension', 'newtab.js'), 'utf8');
  const HTML = readFileSync(join(ROOT, 'extension', 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const AST = acorn.parse(SRC, { ecmaVersion: 'latest', sourceType: 'script' });
  const top = (name) => {
    const n = AST.body.find(x => (x.type === 'FunctionDeclaration' && x.id.name === name) || (x.type === 'VariableDeclaration' && x.declarations.some(d => d.id.name === name)));
    if (!n) throw new Error(`找不到 ${name}`);
    return SRC.slice(n.start, n.end);
  };
  const bind = AST.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'bindEvents');
  const markers = /getElementById\('(fetchAiModels|benchAiModels|aiBenchResult|testAi|aiProvider|apiBaseUrl)'\)|querySelectorAll\('\.ai-model-select'\)/;
  const stmts = bind.body.body.filter(n => n.type === 'ExpressionStatement' && markers.test(SRC.slice(n.start, n.end)) && !/getElementById\('saveSettings'\)/.test(SRC.slice(n.start, n.end)));
  check('抽到设置页的绑定代码', stmts.length === 7, stmts.length);
  check('AI 设置相关声明都在顶层（loadSettings 等顶层函数能用到）', ['AI_PROVIDERS', 'postAiSettings', 'AiModelPicker', 'applyAiProviderPreset'].every(n => AST.body.some(x => (x.type === 'FunctionDeclaration' && x.id.name === n) || (x.type === 'VariableDeclaration' && x.declarations.some(d => d.id.name === n)))));

  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window;
  const doc = win.document;
  const calls = [];
  win.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/api/config') && !init.method) {
      return { ok: true, json: async () => ({ success: true, data: { ai: { savedKeyHosts: [new URL(AI).host] } } }) };
    }
    return fetch(String(url).replace('http://127.0.0.1:3721', BASE), init);
  };
  win.eval(`let API_BASE_URL = 'http://127.0.0.1:3721';
${top('escapeHtml')}
${top('AI_PROVIDERS')}
${top('applyAiProviderPreset')}
${top('postAiSettings')}
${top('AiModelPicker')}
${top('resolveBackendUrl')}
window.AiModelPicker = AiModelPicker; window.resolveBackendUrl = resolveBackendUrl;
${stmts.map(n => SRC.slice(n.start, n.end)).join('\n')}`);
  const $ = (id) => doc.getElementById(id);
  // 当前是「自定义」，已保存过 Key
  $('aiProvider').value = 'custom';
  $('apiBaseUrl').value = `${AI}/v1/chat/completions`;
  $('aiModel').value = 'old-model';
  $('apiKey').value = '';
  win.AiModelPicker.init({ aiProvider: 'custom' });
  await tick(30);
  check('已保存 Key 的地址：Key 留空并提示「已保存」', $('apiKey').placeholder.includes('已保存'));

  $('fetchAiModels').click();
  await tick(150);
  check('获取后：两个模型下拉框都可选，测速按钮可用', $('aiModelSelect').style.display === '' && $('aiReportModelSelect').options.length === 7 && !$('benchAiModels').disabled, $('aiReportModelSelect').options.length);
  check('获取后：地址回填为规整后的 base URL', $('apiBaseUrl').value === `${AI}/v1`);
  $('aiReportModelSelect').value = 'big-pro';
  $('aiReportModelSelect').dispatchEvent(new win.Event('change'));
  check('下拉框选中后写入对应的模型输入框', $('aiReportModel').value === 'big-pro' && $('aiModel').value === 'old-model');

  $('benchAiModels').click();
  await tick(1200);
  const box = $('aiBenchResult');
  check('测速推荐：显示两类推荐与每个模型的结论', !box.hidden && /任务解析推荐/.test(box.textContent) && /报告总结推荐/.test(box.textContent) && box.querySelectorAll('tbody tr').length === 4, box.textContent.slice(0, 200));
  box.querySelector('[data-pick-target="aiModel"][data-pick-model="fast-flash"]').click();
  check('点推荐的模型名即可填入', $('aiModel').value === 'fast-flash');

  $('testAi').click();
  await tick(800);
  check('测试连接：两类模型分别测，结论分两行', /任务解析（fast-flash）：.*适合任务解析/.test($('aiTestResult').textContent) && /报告总结（big-pro）/.test($('aiTestResult').textContent), $('aiTestResult').textContent);
  check('测试连接带上用途', calls.some(c => c.url.endsWith('/api/ai/test') && c.body.purpose === 'task') && calls.some(c => c.url.endsWith('/api/ai/test') && c.body.purpose === 'report'));

  // 切换服务商：填了新 Key、还没保存就切走再切回来
  $('apiKey').value = 'sk-typed-relay';
  $('aiProvider').value = 'deepseek';
  $('aiProvider').dispatchEvent(new win.Event('change'));
  check('切到 DeepSeek：用预设地址与模型，报告模型清空、模型列表收起', /deepseek/.test($('apiBaseUrl').value) && $('aiModel').value && $('aiReportModel').value === '' && $('aiModelSelect').style.display === 'none');
  check('切到没保存过 Key 的服务商：Key 为空并提示输入', $('apiKey').value === '' && $('apiKey').placeholder === '请输入 API Key');
  $('aiProvider').value = 'custom';
  $('aiProvider').dispatchEvent(new win.Event('change'));
  check('切回自定义：地址、两类模型、刚填的 Key 都恢复', $('apiBaseUrl').value === `${AI}/v1` && $('aiModel').value === 'fast-flash' && $('aiReportModel').value === 'big-pro' && $('apiKey').value === 'sk-typed-relay');

  // 保存：Key 不再存进浏览器
  const saveStmt = bind.body.body.find(n => n.type === 'ExpressionStatement' && /getElementById\('saveSettings'\)/.test(SRC.slice(n.start, n.end)));
  const saveSrc = SRC.slice(saveStmt.start, saveStmt.end);
  check('保存：不再把 Key 明文存进浏览器，带上报告模型与各服务商配置',
    !/apiKey: document\.getElementById\('apiKey'\)/.test(saveSrc.split('localStorage.setItem')[0]) && /aiReportModel/.test(saveSrc) && /aiProfiles: AiModelPicker\.profiles/.test(saveSrc) && /apiKey: typedKey/.test(saveSrc));

  check('保存：禅道密码只发给后端，不写进浏览器', !/zentaoPassword:/.test(saveSrc.split('localStorage.setItem')[0]) && /password: typedZentaoPassword/.test(saveSrc));

  // ============ 禅道设置以后端为准回填 ============
  // 浏览器缓存里已有地址时，以前不回填，密码「已保存」的提示也不出现，看起来像没填密码
  const zwin = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only' }).window;
  zwin.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { enabled: true, url: 'http://10.0.0.1:8088', username: 'lijc', hasPassword: true, createTaskUrl: '167' } }) });
  zwin.eval(`let API_BASE_URL = 'http://127.0.0.1:3721';\n${top('loadZentaoConfigStatus')}\nwindow.loadZentaoConfigStatus = loadZentaoConfigStatus;`);
  const z$ = (id) => zwin.document.getElementById(id);
  z$('zentaoUrl').value = 'http://old-cache:1';
  z$('zentaoEnabled').checked = false;
  await zwin.loadZentaoConfigStatus();
  check('禅道设置：缓存里已有地址也按后端回填，已保存的密码给出提示',
    z$('zentaoUrl').value === 'http://10.0.0.1:8088' && z$('zentaoEnabled').checked && z$('zentaoUsername').value === 'lijc' &&
    z$('zentaoPassword').value === '' && /已保存/.test(z$('zentaoPassword').placeholder) && z$('zentaoCreateTaskUrl').value === '167');
  check('禅道设置：打开设置时不回填浏览器里的密码', /setVal\('zentaoPassword', ''\)/.test(top('loadSettings')));

  // ============ 后端地址 ============
  const rb = win.resolveBackendUrl;
  check('后端地址：用保存的本机后端地址（localhost 换成 127.0.0.1）', rb({ backendUrl: 'http://localhost:3721' }, 'X') === 'http://127.0.0.1:3721');
  check('后端地址：AI 接口地址不会被当成后端地址', rb({ apiBaseUrl: 'https://dyschop.online:8444/v1' }, 'http://127.0.0.1:3721') === 'http://127.0.0.1:3721');
  check('后端地址：很早的配置（本机地址存在 apiBaseUrl）仍兼容', rb({ apiBaseUrl: 'http://127.0.0.1:3721/' }, 'X') === 'http://127.0.0.1:3721');
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  server.close();
  aiServer.close();
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
