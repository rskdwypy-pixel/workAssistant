/**
 * 回归测试：禅道「回读校验」的假阴性
 *
 * 真实 bug（用户报的）：
 *   [Optimistic] 禅道同步失败: 更新未生效（当前仍为 wait）
 *   [Optimistic] 禅道同步失败: 操作失败
 *   [Optimistic] 禅道同步失败: 工时记录未生效，请检查任务状态或参数
 *
 * 根因：禅道操作**其实成功了**，但代码用「回读我的任务」来校验，
 * 而任务一旦 closed/done 就会从「我的任务」列表消失 → 回读 null → 误报失败。
 * 工时接口还额外漏认了禅道的收尾脚本：
 *   <script>if(typeof(parent.parent.ajaxRefresh) == 'function') parent.parent.ajaxRefresh()</script>
 * 这是禅道操作成功后的标准收尾，原先只认 selfClose/closeModal。
 *
 * 本测试直接跑 zentaoService 里抽出来的**真函数**，用日志里抓到的真实禅道响应做样本。
 *
 * 运行：
 *   node scripts/test-zentao-verify.cjs
 */

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'zentaoService.js'), 'utf8');

let AST = null;

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

/**
 * 抽出一个函数（含它前面的 JSDoc 注释），并**验证抽取结果能独立解析**。
 * 从前一次踩坑吸取：updateTaskStatus 因为紧邻注释/结构问题导致大括号
 * 配平截断（表现为 Unexpected token '}'），所以这里必须做语法校验，
 * 抽不出来宁可明确报错，也不要静默跑一个残缺函数得出错误结论。
 */
/**
 * 用 acorn 精确抽取顶层函数声明（AST 定位，不靠数大括号）。
 *
 * 为什么不用数大括号：函数体里有模板字符串 `${...}`、正则、正则量词
 * （如 /[\s\S]*?/）都会干扰配平，updateTaskStatus 就被截断成
 * "Unexpected token '}'"。踩过两次，AST 是唯一可靠解。
 */
function extractFunction(name) {
  if (!AST) AST = acorn.parse(SRC, { ecmaVersion: 2022, sourceType: 'module' });
  const ast = AST;
  const fn = ast.body.find(
    n => (n.type === 'FunctionDeclaration' || n.type === 'AsyncFunctionDeclaration') && n.id.name === name
  );
  if (!fn) throw new Error(`源码里找不到函数声明 ${name}`);
  const code = SRC.slice(fn.start, fn.end);
  try {
    new Function('env', 'fetch', 'responses', `(async()=>{\n${code}\n})()`);
  } catch (e) {
    throw new Error(`${name} 抽取后无法独立解析: ${e.message}`);
  }
  return code;
}

// ---- 真实禅道响应样本（抓自 /tmp/workassistant-backend.log）----
const REAL_AJAX_REFRESH = `<script>if(typeof(parent.parent.ajaxRefresh) == 'function') parent.parent.ajaxRefresh()
</script><script>parent.parent.ajaxRefresh()</script>`;

const SELF_CLOSE = `<div class="modal fade" id="selfClose"><script>$('#selfClose').modal('show');</script></div>`;

// 校验不通过退回表单的样子：应判为失败
const BACK_TO_FORM = `<form method="post" action="/zentao/task-close-943.html"><div class="alert alert-danger">失败，请填写剩余工时</div></form>`;

/**
 * 把抽出来的真函数装进 env。
 *
 * 踩过的坑：
 *  -不能 `const fetch = env.fetch` 在 IIFE 里提前捕获 —— env.fetch 是之后才设的
 *    所以 fetch / config 等一律作为**函数参数**注入，让真函数按名字自由引用
 *  - IIFE 是 async 的，直接 return 会返回 Promise；这里只做同步的函数挂载，
 *    所以不用 IIFE，直接在函数体里组装并return env
 */
function makeEnv() {
  // env 必须做成全局共享：new Function 里声明的 const env 是另一个作用域，
  // 外层 makeEnv 里的 env 对象它看不见（用例里的 env.fetch 赋值会落空）。
  const env = (globalThis.__zenv = {});
  const code = [
    `const env = globalThis.__zenv;`,
    extractFunction('isZentaoSubmitSuccess'),
    extractFunction('extractZentaoError'),
    extractFunction('toFormBody'),
    extractFunction('readZentaoJson'),
    extractFunction('fetchMyList'),
    extractFunction('readMyTask'),
    extractFunction('readMyTaskStatus'),
    extractFunction('readMyTaskConsumed'),
    extractFunction('updateTaskStatus'),
    extractFunction('recordTaskEstimate'),
    `env.updateTaskStatus = updateTaskStatus;`,
    `env.recordTaskEstimate = recordTaskEstimate;`,
    `env.isZentaoSubmitSuccess = isZentaoSubmitSuccess;`,
    `return env;`
  ].join('\n');

  // 真函数里引用了 fetch / config / getZentaoCookies / cookiesToString /
  // extractFormFields / nowDateTime / zentaoBase / MY_LIST_PAGE_SIZE，全部按参数注入
  const fn = new Function(
    'fetch', 'config', 'getZentaoCookies', 'cookiesToString',
    'extractFormFields', 'nowDateTime', 'zentaoBase', 'MY_LIST_PAGE_SIZE',
    code
  );

  const stubs = {
    config: { zentao: { url: 'http://z' } },
    getZentaoCookies: async () => [],
    cookiesToString: () => 'c=1',
    extractFormFields: () => ({ id: '943' }),
    nowDateTime: () => '2026-10-14 10:00:00'
  };
  // fetch 用转发：每次调用都读 env.fetch，方便用例替换
  const forwardFetch = (...a) => globalThis.__zenv.fetch(...a);

  return fn(forwardFetch, stubs.config, stubs.getZentaoCookies, stubs.cookiesToString,
    stubs.extractFormFields, stubs.nowDateTime, () => 'http://z', 500);
}

// package.json 是 ESM，.cjs 不允许顶层 await，整体包一层
async function main() {
// ============ isZentaoSubmitSuccess 的识别能力 ============
{
  const env = makeEnv();
  check('识别 ajaxRefresh 收尾脚本（工时接口的真实返回）',
    env.isZentaoSubmitSuccess(REAL_AJAX_REFRESH) === true);
  check('识别 selfClose 收尾页', env.isZentaoSubmitSuccess(SELF_CLOSE) === true);
  check('识别跳转详情页（编辑任务成功的真实返回）',
    env.isZentaoSubmitSuccess("<html><script>parent.location='/zentao/task-view-952.html'; </script>") === true);
  check('识别刷新父页面', env.isZentaoSubmitSuccess("<script>parent.location.reload();</script>") === true);
  check('跳转登录页不算成功（会话失效）', env.isZentaoSubmitSuccess("<script>parent.location='/zentao/user-login-L3plbnRhby8=.html'</script>") === false);
  check('跳转到其他页面（非详情/列表）不算成功', env.isZentaoSubmitSuccess("<script>parent.location='/zentao/my.html'</script>") === false);
  check('识别 alert-success', env.isZentaoSubmitSuccess('<div class="alert alert-success">ok</div>') === true);
  check('识别「保存成功」文案', env.isZentaoSubmitSuccess('<div>保存成功</div>') === true);
  check('退回表单判为失败（不能误放行）',
    env.isZentaoSubmitSuccess(BACK_TO_FORM) === false);
  check('空响应判为失败', env.isZentaoSubmitSuccess('') === false);
  check('null 不炸', env.isZentaoSubmitSuccess(null) === false);
}

// ============ updateTaskStatus：任务已从「我的任务」消失时的判定 ============
{
  const env = makeEnv();
  env.fetch = async (url) => {
    if (/\/zentao\/my-task[-.]/.test(String(url))) {
      return { ok: true, json: async () => ({ data: JSON.stringify({ tasks: [] }) }) };  // 列表里没有该任务
    }
    if (String(url).includes('task-close-943')) {
      return { text: async () => REAL_AJAX_REFRESH };
    }
    return { text: async () => '<form></form>' };
  };

  const r = await env.updateTaskStatus(943, 'closed');
  check('任务已从我的任务消失 + 禅道收尾脚本 → 判成功（原来误报失败）',
    r.success === true, JSON.stringify(r));
}

{
  // 真的失败了：退回表单 + 回读状态不变
  const env = makeEnv();
  env.fetch = async (url) => {
    if (/\/zentao\/my-task[-.]/.test(String(url))) {
      return { ok: true, json: async () => ({ data: JSON.stringify({ tasks: [{ id: '944', status: 'wait' }] }) }) };
    }
    return { text: async () => BACK_TO_FORM };
  };

  const r = await env.updateTaskStatus(944, 'doing');
  check('真失败（退回表单 + 状态仍为 wait）→ 判失败', r.success === false, JSON.stringify(r));
  check('真失败时消息包含当前状态', /wait/.test(r.message || ''), r.message);
}

// ============ recordTaskEstimate：工时记录成功却不误报 ============
{
  const env = makeEnv();
  env.fetch = async (url) => {
    if (/\/zentao\/my-task[-.]/.test(String(url))) {
      // 任务已关闭 → 不在列表 → consumed 回读为 null
      return { ok: true, json: async () => ({ data: JSON.stringify({ tasks: [] }) }) };
    }
    return { text: async () => REAL_AJAX_REFRESH };
  };

  const r = await env.recordTaskEstimate(943, { work: '更新进度至 100%', consumed: 1, left: 0 });
  check('工时记录：回读不到但禅道返回收尾脚本 → 判成功（原来误报）',
    r.success === true, JSON.stringify(r));
}

{
  // 工时真的没记上：无收尾脚本、回读也没增长
  const env = makeEnv();
  env.fetch = async (url) => {
    if (/\/zentao\/my-task[-.]/.test(String(url))) {
      return { ok: true, json: async () => ({ data: JSON.stringify({ tasks: [{ id: '885', consumed: 3 }] }) }) };
    }
    return { text: async () => '<form>退回表单</form>' };
  };

  const r = await env.recordTaskEstimate(885, { work: 'x', consumed: 1, left: 0 });
  check('工时真没记上 → 判失败（不能误放行）', r.success === false, JSON.stringify(r));
}

}

main()
  .then(() => {
    // ============ 汇总 ============
    const pass = results.filter(r => r.pass).length;
    console.log('');
    results.forEach(r => console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.pass ? '' : '   → ' + r.extra}`));
    console.log(`\n${pass}/${results.length} 通过\n`);
    process.exit(pass === results.length ? 0 : 1);
  })
  .catch(e => { console.error('测试自身崩溃：', e); process.exit(1); });