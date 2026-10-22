#!/usr/bin/env node
/**
 * 修复：被「同步任务」误改成 type='task' 的 Bug 记录
 *
 * 背景：旧版 importZentaoTasks 会把所有带 zentaoId 的记录强制改成 type='task'，
 * Bug 因此混进了任务列表。Bug 记录带有任务没有的字段（severity / bugType / steps），
 * 据此识别并改回 type='bug'，zentaoId 按 Bug 约定转为数字。
 *
 * 用法：
 *   node scripts/repair-bug-types.mjs          只列出待修复记录（默认 dry-run）
 *   node scripts/repair-bug-types.mjs --apply  执行修复（写入前会自动备份 tasks.json）
 *
 * 建议先停掉后端再执行 --apply，避免与后端同时写 tasks.json。
 */
import { readTasks, updateTasks } from '../src/utils/storage.js';

const apply = process.argv.includes('--apply');

function looksLikeBug(t) {
  return t.type !== 'bug' &&
    (t.severity !== undefined || t.bugType !== undefined || t.steps !== undefined);
}

const data = await readTasks();
const victims = data.tasks.filter(looksLikeBug);

if (victims.length === 0) {
  console.log('没有需要修复的记录');
  process.exit(0);
}

console.log(`发现 ${victims.length} 条被误改为任务的 Bug：`);
victims.forEach(t => console.log(`  #${t.zentaoId ?? '-'}  ${t.title}`));

if (!apply) {
  console.log('\n(dry-run) 加 --apply 执行修复');
  process.exit(0);
}

let fixed = 0;
await updateTasks((fresh) => {
  fresh.tasks.forEach(t => {
    if (!looksLikeBug(t)) return;
    t.type = 'bug';
    if (t.zentaoId !== null && t.zentaoId !== undefined && t.zentaoId !== '') {
      t.zentaoId = Number(t.zentaoId);
    }
    fixed++;
  });
  return fresh;
});

console.log(`\n✅ 已修复 ${fixed} 条（修复前的 tasks.json 已备份到 data/backups/）`);
