/**
 * 真函数测试：设置的前端缓存 ConfigStore（以后端为准）
 *   - 启动读缓存；平铺字段名与旧版一致；缓存损坏当没有
 *   - 静默校对：带本地 rev 问；没变不通知；变了替换缓存并通知；暂停（hold）时不通知但缓存照更新
 *   - 回到页面：距上次校对超过 2 分钟才再问；每 10 分钟定期问一次
 *   - 后端没起来：返回 false，继续用缓存；force 忽略本地 rev
 *   - 后端地址只接受本机地址；老版本 workAssistantConfig 里的后端地址启动即沿用
 *   - 迁移：服务商设置上传后端（后端没有时）→ 删旧键；后端已有不覆盖；后端连不上不删旧键
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'config-store.js'), 'utf8');
const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const SNAP = (over = {}) => ({
  ai: { apiBaseUrl: 'https://relay.example/v1', aiModel: 'minimax-m3', aiReportModel: 'kimi-k3-1' },
  schedule: { morningHour: 9, eveningHour: 21, workHours: 8 },
  webhook: { url: 'https://hook.example', type: 'wecom' },
  zentao: { enabled: true, url: 'http://10.0.0.1:8088', username: 'lijc', createTaskUrl: '167' },
  client: { aiProvider: 'custom', aiProfiles: { custom: { apiBaseUrl: 'https://relay.example/v1' } } },
  ...over
});

function setup({ local = {}, backend = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window;
  for (const [k, v] of Object.entries(local)) win.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  const b = { rev: backend.rev || 'rev1', snap: backend.snap || SNAP(), down: !!backend.down, calls: [], posts: [] };
  win.fetch = async (url, init = {}) => {
    const u = String(url);
    b.calls.push(u);
    if (b.down) throw new Error('ECONNREFUSED');
    if (init.method === 'POST') {
      b.posts.push(JSON.parse(init.body));
      const body = JSON.parse(init.body);
      if (body.client) { b.snap = { ...b.snap, client: body.client }; b.rev = 'rev-after-post'; }
      return { ok: true, json: async () => ({ success: true, rev: b.rev }) };
    }
    const rev = new URL(u).searchParams.get('rev');
    if (rev && rev === b.rev) return { ok: true, json: async () => ({ success: true, unchanged: true, rev: b.rev }) };
    return { ok: true, json: async () => ({ success: true, rev: b.rev, data: b.snap }) };
  };
  const timers = [];
  win.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  win.eval(SRC);
  return { win, store: win.ConfigStore, b, timers };
}

(async () => {
  // ── 缓存 ──
  let { win, store, b } = setup({ local: { waSettingsCache: { rev: 'rev0', fetchedAt: 1, snap: SNAP() } } });
  check('启动读出缓存（不用等后端）', store.rev === 'rev0' && store.get().ai.aiModel === 'minimax-m3');
  const f = store.flat();
  check('平铺字段名与旧版一致（apiBaseUrl / morningHour / webhookUrl / zentaoUrl / aiProvider…）', f.apiBaseUrl === 'https://relay.example/v1' && f.morningHour === '9' && f.webhookUrl === 'https://hook.example' && f.zentaoUrl === 'http://10.0.0.1:8088' && f.zentaoCreateTaskUrl === '167' && f.aiProvider === 'custom' && f.aiProfiles.custom && f.workHours === '8');
  check('没有缓存时 flat() 是空对象（设置页据此用预设）', setup().store.flat() && Object.keys(setup().store.flat()).length === 0);
  check('缓存损坏当没有，不抛错', Object.keys(setup({ local: { waSettingsCache: '{坏的' } }).store.flat()).length === 0);

  // ── 静默校对 ──
  let notified = 0;
  store.onChange(() => notified++);
  b.rev = 'rev0';   // 后端没变
  let changed = await store.sync();
  check('校对：带着本地 rev 问', b.calls[0].includes('/api/config?rev=rev0'), b.calls[0]);
  check('后端没变：返回 false、不通知、不改缓存', changed === false && notified === 0 && store.rev === 'rev0');
  b.rev = 'rev2'; b.snap = SNAP({ schedule: { morningHour: 8, eveningHour: 20, workHours: 7.5 } });
  changed = await store.sync();
  check('后端变了：替换缓存、通知界面、写进 localStorage', changed === true && notified === 1 && store.rev === 'rev2' && store.flat().eveningHour === '20' && JSON.parse(win.localStorage.getItem('waSettingsCache')).rev === 'rev2');
  b.rev = 'rev3'; b.snap = SNAP();
  store.hold(true);
  changed = await store.sync();
  check('暂停时：缓存照样更新，但不通知界面（不会把你正在改的表单刷掉）', store.rev === 'rev3' && notified === 1);
  store.hold(false);
  b.calls.length = 0;
  await store.sync({ force: true });
  check('force：忽略本地 rev，要完整快照', !b.calls[0].includes('rev='), b.calls[0]);
  b.down = true;
  check('后端没起来：返回 false，缓存还在', (await store.sync()) === false && store.rev === 'rev3' && !!store.get());
  b.down = false;

  // 并发合并
  b.calls.length = 0;
  await Promise.all([store.sync(), store.sync(), store.sync()]);
  check('同时多次校对只发一个请求', b.calls.length === 1, b.calls.length);

  // ── 回到页面 / 定期 ──
  ({ win, store, b, timers } = setup({ local: { waSettingsCache: { rev: 'rev1', fetchedAt: Date.now(), snap: SNAP() } } }));
  store.start(); await tick(10);
  check('启动：立刻校对一次', b.calls.length === 1);
  check('登记了每 10 分钟的定期校对', timers.length === 1 && timers[0].ms === 10 * 60 * 1000, JSON.stringify(timers.map(t => t.ms)));
  b.calls.length = 0;
  win.dispatchEvent(new win.Event('focus')); await tick(10);
  check('刚校对过就回到页面：不再问', b.calls.length === 0);
  store.fetchedAt = Date.now() - 3 * 60 * 1000;
  win.dispatchEvent(new win.Event('focus')); await tick(10);
  check('距上次校对超过 2 分钟再回到页面：问一次', b.calls.length === 1);
  timers[0].fn(); await tick(10);
  check('定期校对触发：再问一次', b.calls.length === 2);

  // ── 后端地址 ──
  ({ store } = setup());
  check('后端地址：默认本机 3721', store.backendUrl() === 'http://127.0.0.1:3721');
  store.setBackendUrl('https://evil.example.com');
  check('后端地址：非本机地址被拒绝', store.backendUrl() === 'http://127.0.0.1:3721');
  store.setBackendUrl('http://localhost:4000/');
  check('后端地址：本机地址接受，localhost 换成 127.0.0.1', store.backendUrl() === 'http://127.0.0.1:4000');
  ({ store, win } = setup({ local: { workAssistantConfig: { backendUrl: 'http://localhost:3999' } } }));
  check('老版本把后端地址存在 workAssistantConfig 里：启动就沿用，并搬到 waBackendUrl', store.backendUrl() === 'http://127.0.0.1:3999' && win.localStorage.getItem('waBackendUrl') === 'http://127.0.0.1:3999');

  // ── 迁移 ──
  const legacy = { backendUrl: 'http://127.0.0.1:3721', apiBaseUrl: 'https://x', aiProvider: 'zhipu', aiProfiles: { zhipu: { aiModel: 'glm-4' } }, zentaoPassword: 'p' };
  ({ win, store, b } = setup({ local: { workAssistantConfig: legacy }, backend: { snap: SNAP({ client: { aiProvider: '', aiProfiles: {} } }) } }));
  await store.migrateLegacy();
  check('迁移：后端没有服务商设置 → 上传浏览器里的', b.posts.length === 1 && b.posts[0].client.aiProvider === 'zhipu' && b.posts[0].client.aiProfiles.zhipu.aiModel === 'glm-4');
  check('迁移：上传的内容不含密码 / 其它字段', JSON.stringify(b.posts[0]) === JSON.stringify({ client: { aiProvider: 'zhipu', aiProfiles: { zhipu: { aiModel: 'glm-4' } } } }));
  check('迁移成功：旧键删掉，缓存里能读到刚上传的', win.localStorage.getItem('workAssistantConfig') === null && store.flat().aiProvider === 'zhipu');

  ({ win, store, b } = setup({ local: { workAssistantConfig: legacy }, backend: { snap: SNAP() } }));
  await store.migrateLegacy();
  check('迁移：后端已有服务商设置 → 不覆盖，直接删旧键', b.posts.length === 0 && win.localStorage.getItem('workAssistantConfig') === null && store.flat().aiProvider === 'custom');

  ({ win, store, b } = setup({ local: { workAssistantConfig: legacy }, backend: { down: true } }));
  await store.migrateLegacy();
  check('迁移：后端连不上 → 旧键保留，下次启动再试（不丢数据）', win.localStorage.getItem('workAssistantConfig') !== null && b.posts.length === 0);

  ({ win, store, b } = setup({ local: {} }));
  await store.migrateLegacy();
  check('迁移：没有旧键时什么都不做', b.calls.length === 0);

  const passed = results.filter(r => r.pass).length;
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
  console.log(`\n设置缓存（前端）：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
