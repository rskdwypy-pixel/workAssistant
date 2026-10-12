#!/usr/bin/env node
/**
 * 禅道推送 CLI —— 复用 src/services/zentaoService.js 的现成能力
 *
 * 为什么需要它：
 *   插件原本的"推送禅道"能力被迁移到了浏览器扩展端（注入脚本到禅道标签页），
 *   后端路由被废弃。此脚本把后端已有的 zentaoService 直接暴露成一个命令行入口，
 *   让自动化（如 WorkBuddy 的每日复盘）或人可以直接把工作写回禅道。
 *
 * 用法：
 *   测试登录:        node scripts/zentao-push.mjs whoami
 *   创建任务:        node scripts/zentao-push.mjs task --name "标题" [--desc "描述"] [--exec 167] [--estimate 8] [--start 2026-10-10] [--due 2026-10-15] [--pri 3] [--assign lijc]
 *   记录工时:        node scripts/zentao-push.mjs estimate --task 123 --hours 2 --work "今天做了什么" [--left 4]
 *   更新状态:        node scripts/zentao-push.mjs status --task 123 --status done [--hours 2] [--comment "说明"]   # wait/doing/done/closed/cancel
 *   我的任务:        node scripts/zentao-push.mjs mytasks
 *   任务列表:        node scripts/zentao-push.mjs tasks [--exec 167] [--status wait] [--assign lijc]
 *
 * 配置来源：workAssistant/.env
 *   ZENTAO_ENABLED=true
 *   ZENTAO_URL=http://your-zentao-host:port
 *   ZENTAO_USERNAME=你的账号
 *   ZENTAO_PASSWORD=你的密码
 */
import { config } from '../src/config.js';
import {
  loginZentao,
  createTask,
  recordTaskEstimate,
  updateTaskStatus,
  getTasks,
  getExecutions,
  getMyTasks,
  isConfigured
} from '../src/services/zentaoService.js';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    }
  }
  return { command, opts };
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));

  if (!command || command === 'help' || command === '--help') {
    console.log('用法: node scripts/zentao-push.mjs <whoami|task|estimate|status> [选项]');
    process.exit(0);
  }

  if (!isConfigured()) {
    out({ success: false, message: '禅道未配置或未启用，请检查 .env（ZENTAO_ENABLED / URL / 账号 / 密码）' });
    process.exit(1);
  }

  if (command === 'whoami') {
    const cookies = await loginZentao(config.zentao.url, config.zentao.username, config.zentao.password);
    out({ success: true, message: '登录成功', url: config.zentao.url, account: config.zentao.username });
    return;
  }

  if (command === 'task') {
    if (!opts.name) {
      out({ success: false, message: '缺少 --name 任务标题' });
      process.exit(1);
    }
    const result = await createTask({
      title: opts.name,
      content: opts.desc,
      dueDate: opts.due,
      executionId: opts.exec,
      priority: opts.pri ? Number(opts.pri) : undefined,
      assignedTo: opts.assign,
      type: opts.type,
      estimate: opts.estimate != null ? Number(opts.estimate) : undefined,
      estStarted: opts.start
    });
    out(result);
    process.exit(result.success ? 0 : 1);
  }

  if (command === 'estimate') {
    if (!opts.task) {
      out({ success: false, message: '缺少 --task 禅道任务ID' });
      process.exit(1);
    }
    const result = await recordTaskEstimate(opts.task, {
      work: opts.work || '工作进度更新',
      consumed: opts.hours ? Number(opts.hours) : 0,
      left: opts.left !== undefined ? Number(opts.left) : 0
    });
    out(result);
    process.exit(result.success ? 0 : 1);
  }

  if (command === 'status') {
    if (!opts.task || !opts.status) {
      out({ success: false, message: '缺少 --task 或 --status' });
      process.exit(1);
    }
    // 支持：status --task 123 --status done [--hours 2] [--comment "说明"]
    const result = await updateTaskStatus(opts.task, opts.status, {
      consumed: opts.hours != null ? Number(opts.hours) : undefined,
      comment: typeof opts.comment === 'string' ? opts.comment : undefined
    });
    out(result);
    process.exit(result.success ? 0 : 1);
  }

  if (command === 'execs') {
    const list = await getExecutions();
    out({ success: true, count: list.length, executions: list });
    return;
  }

  if (command === 'tasks') {
    const list = await getTasks({
      executionId: opts.exec,
      status: opts.status,
      assignedTo: opts.assign
    });
    out({ success: true, count: list.length, tasks: list });
    return;
  }

  if (command === 'mytasks') {
    const list = await getMyTasks();
    out({ success: true, count: list.length, tasks: list });
    return;
  }

  out({ success: false, message: `未知命令: ${command}` });
  process.exit(1);
}

main().catch((err) => {
  out({ success: false, message: err.message });
  process.exit(1);
});
