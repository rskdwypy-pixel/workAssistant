/**
 * 回归测试：乐观更新「后端写失败必须回滚」
 *
 * 背景（真实 bug）：updateTaskProgress 里
 *   const task = allTasks.find(...)        // 引用，指向 allTasks 里的对象
 *   OptimisticUI.patchTask(taskId, {...})  // 直接把这个对象改了
 *   ...失败回滚时 patchTask(taskId, { progress: task.progress })   // ← 读到的已是新值
 * 于是回滚等于没回滚，界面与后端永久错位。
 *
 * 修法：改动前先做快照（snapshot），回滚用快照。
 * 本测试把 updateTaskProgress 的这段逻辑抽出来复现。
 */

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
}

// ---- 最小替身 ----
const allTasks = [{ id: 't1', progress: 20, status: 'in_progress', totalConsumedTime: 4, zentaoId: 945 }];
let renderCount = 0;

function patchTask(taskId, patch) {
  const t = allTasks.find(x => String(x.id) === String(taskId));
  if (!t) return null;
  Object.assign(t, patch);
  renderCount++;
  return t;
}
const statusOf = (p) => (Number(p) >= 100 ? 'done' : Number(p) > 0 ? 'in_progress' : 'todo');

/** —— 模拟修好后的 updateTaskProgress —— */
async function updateTaskProgress(taskId, progress, backendOk) {
  const task = allTasks.find(t => t.id === taskId);
  if (!task) return false;

  // 快照必须在 patch 之前取
  const snapshot = {
    progress: task.progress,
    status: task.status,
    totalConsumedTime: task.totalConsumedTime
  };

  const previousTotal = snapshot.totalConsumedTime || 0;
  patchTask(taskId, {
    progress,
    status: statusOf(progress),
    totalConsumedTime: previousTotal + 1
  });

  if (!backendOk) {
    patchTask(taskId, {
      progress: snapshot.progress,
      status: snapshot.status,
      totalConsumedTime: snapshot.totalConsumedTime
    });
    return false;
  }
  return true;
}

/** —— 复现修复前的错误写法，用于确认测试确实能抓到它 —— */
async function updateTaskProgressBuggy(taskId, progress, backendOk) {
  const task = allTasks.find(t => t.id === taskId);
  if (!task) return false;

  patchTask(taskId, { progress, status: statusOf(progress) });

  if (!backendOk) {
    // 错误写法：task 已被 patch 改过，这里读到的已是新值
    patchTask(taskId, { progress: task.progress, status: task.status });
    return false;
  }
  return true;
}

(async () => {
  console.log('\n=========== 回滚回归测试 ===========');

  // ---- 1. 修复后：后端失败要真正回滚 ----
  let r = await updateTaskProgress('t1', 70, false);
  check('后端失败时返回 false', r === false);
  check('回滚后 progress 恢复为20', allTasks[0].progress === 20, `实际=${allTasks[0].progress}`);
  check('回滚后 status 恢复为 in_progress', allTasks[0].status === 'in_progress', `实际=${allTasks[0].status}`);
  check('回滚后 totalConsumedTime 恢复为 4', allTasks[0].totalConsumedTime === 4, `实际=${allTasks[0].totalConsumedTime}`);

  // ---- 2. 修复后：后端成功要保留新值 ----
  r = await updateTaskProgress('t1', 70, true);
  check('后端成功时返回 true', r === true);
  check('成功后 progress 为 70', allTasks[0].progress === 70);
  check('成功后 status 变为 in_progress', allTasks[0].status === 'in_progress');
  check('成功后 totalConsumedTime 累加为 5', allTasks[0].totalConsumedTime === 5, `实际=${allTasks[0].totalConsumedTime}`);

  // ---- 3. 确认这个测试能抓到「修复前」的 bug（反向验证）----
  allTasks[0].progress = 20;
  allTasks[0].status = 'in_progress';
  allTasks[0].totalConsumedTime = 4;
  await updateTaskProgressBuggy('t1', 70, false);
  const buggyFailsToRollback = allTasks[0].progress !== 20;
  check('【反向验证】旧写法确实回滚失败（测试有效）', buggyFailsToRollback,
    `旧写法回滚后 progress=${allTasks[0].progress}`);

  // ---- 输出 ----
  const pass = results.filter(x => x.pass).length;
  for (const x of results) {
    console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.extra ? '  → ' + x.extra : ''}`);
  }
  console.log(`\n  ${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exitCode = 1;
})();