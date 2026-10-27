/** 真函数测试：自动同步（前端）。jsdom 里原样执行 auto-sync.js，fetch / loadTasks 换成模拟，时间可控。 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'auto-sync.js'), 'utf8');
const results = [];
const check = (name, pass) => results.push({ name, pass: !!pass });

async function make(reply, visible = 'visible') {
  const dom = new JSDOM('<html data-no-autosync><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.document, 'visibilityState', { get: () => visible, configurable: true });
  const s = { fetches: 0, loaded: 0, bugs: 0, t: 1e9 };
  w.fetch = async () => { s.fetches++; if (reply === 'throw') throw new TypeError('x'); return { json: async () => reply }; };
  w.loadTasks = async () => { s.loaded++; };
  w.BugManager = { loadBugs: async () => { s.bugs++; } };
  w.eval(SRC + ';window.__A = AutoSync;');
  const A = w.__A; A.now = () => s.t;
  return { A, s, w };
}
const none = { success: true, data: { added: 0, updated: 0, removed: 0, bugs: { added: 0, updated: 0 } } };

(async () => {
  let { A, s } = await make({ success: true, data: { added: 0, updated: 2, bugs: {} } });
  check('有更新：同步后刷新任务和 Bug 列表', (await A.run()) === true && s.fetches === 1 && s.loaded === 1 && s.bugs === 1);
  check('2 分钟内再触发：跳过', (await A.run()) === false && s.fetches === 1);
  s.t += 3 * 60 * 1000;
  check('超过 2 分钟：再同步', (await A.run()) === true && s.fetches === 2);
  check('定时触发（force）不受 2 分钟限制', (await A.run({ force: true })) === true && s.fetches === 3);

  ({ A, s } = await make(none));
  await A.run();
  check('无变化：不刷新列表', s.fetches === 1 && s.loaded === 0 && s.bugs === 0);

  ({ A, s } = await make({ success: true, data: { added: 0, updated: 0, bugs: { updated: 1 } } }));
  await A.run();
  check('只有 Bug 变化：也刷新', s.loaded === 1 && s.bugs === 1);

  ({ A, s } = await make({ success: false, message: '未配置' }));
  check('后端报错（没配置禅道）：静默返回 false，不刷新', (await A.run()) === false && s.loaded === 0);

  ({ A, s } = await make('throw'));
  check('连不上后台：静默，不抛错，running 复位', (await A.run()) === false && A.running === false);

  ({ A, s } = await make(none, 'hidden'));
  check('页面在后台：不同步', (await A.run({ force: true })) === false && s.fetches === 0);

  ({ A, s } = await make(none));
  const p1 = A.run(); const p2 = A.run({ force: true });
  await Promise.all([p1, p2]);
  check('上一次没完成时不重叠', s.fetches === 1);

  let bad = 0;
  for (const r of results) { console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}`); if (!r.pass) bad++; }
  console.log(`\n${results.length - bad}/${results.length} 通过`);
  process.exit(bad ? 1 : 0);
})();
