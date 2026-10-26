/**
 * 统一测试入口：依次跑各个测试脚本，汇总结果。
 *
 * 存在的意义：
 *   - 不再把 NODE_PATH 等本机路径硬编码进 package.json，
 *     换台机器 `npm install && npm test` 就能直接跑。
 *   - 任何一项失败即整体失败（exit 1），便于接 CI。
 *
 * 依赖：jsdom / acorn 已在 devDependencies 里声明。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'test-zentao-verify',
  'test-script-scope',
  'test-progress-real',
  'test-priority-real',
  'test-optimistic',
  'test-rollback',
  'test-backend-fixes.mjs',
  'test-login-storm.mjs',
  'test-assign-notify.mjs',
  'test-notify-ui',
  'test-task-intake.mjs',
  'test-task-modal-flow',
  'test-task-card-bindings',
  'test-attachments.mjs',
  'test-attachments-ui',
  'test-card-actions.mjs',
  'test-card-actions-ui',
  'test-reports.mjs',
  'test-reports-ui',
  'test-docs.mjs',
  'test-docs-files.mjs',
  'test-docs-ui',
  'test-zentao-cache.mjs',
  'test-stories.mjs',
  'test-task-link.mjs',
  'test-time-line',
  'test-task-link-ui',
  'test-stories-ui',
  'test-efforts.mjs',
  'test-efforts-write.mjs',
  'test-autofill.mjs',
  'test-work-calendar.mjs',
  'test-autofill-ui',
  'test-efforts-ui',
  'test-no-local-data',
  'test-repo-hygiene',
  'test-release-gitee',
  'test-todos.mjs',
  'test-todos-ui',
  'test-ai-settings.mjs',
  'test-zentao-truth.mjs',
  'test-config-transfer.mjs',
  'test-settings-sync.mjs',
  'test-config-store-ui',
  'test-account.mjs',
  'test-account-ui',
  'test-onboarding.mjs',
  'test-onboarding-ui',
  'test-bug-board-ui',
  'test-installer',
  'test-updater.mjs',
  'test-update-ui'
];

// 让子进程能解析到项目本地的 node_modules（jsdom / acorn）
const nodePath = [path.join(__dirname, '..', 'node_modules')].concat(
  process.env.NODE_PATH ? [process.env.NODE_PATH] : []
).join(path.delimiter);

let failed = 0;

for (const name of SUITES) {
  const file = path.join(__dirname, /\.m?js$/.test(name) ? name : `${name}.cjs`);
  console.log(`\n${'='.repeat(56)}\n▶ ${name}\n${'='.repeat(56)}`);

  const res = spawnSync(process.execPath, [file], {
    stdio: 'inherit',
    env: { ...process.env, NODE_PATH: nodePath }
  });

  if (res.status !== 0) {
    failed++;
    console.error(`✗ ${name} 失败（exit ${res.status}）`);
  }
}

console.log(`\n${'='.repeat(56)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${SUITES.length} 个测试套件通过`);
} else {
  console.log(`❌ ${failed}/${SUITES.length} 个测试套件失败`);
}
process.exit(failed === 0 ? 0 : 1);