#!/usr/bin/env node
// 必须在其它模块之前导入：把 console.log 改道到 stderr，避免污染 MCP 的 stdout 协议
import './silence-stdout.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { config } from '../config.js';
import {
  loginZentao,
  createTask,
  getTasks,
  updateTaskStatus,
  recordTaskEstimate,
  getExecutions,
  getMyTasks,
  isConfigured
} from '../services/zentaoService.js';

const ok = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]
});
const fail = (message) => ({
  isError: true,
  content: [{ type: 'text', text: String(message) }]
});

const server = new McpServer({
  name: 'zentao-work-assistant',
  version: '1.0.0'
});

// 未配置时统一报错
function requireConfig() {
  if (!isConfigured()) {
    throw new Error('禅道未配置或未启用，请检查 .env（ZENTAO_ENABLED / ZENTAO_URL / ZENTAO_USERNAME / ZENTAO_PASSWORD）');
  }
}

// ---------- 工具定义 ----------

server.tool(
  'zentao_whoami',
  '验证禅道登录是否正常，返回当前账号。用于自检配置。',
  {},
  async () => {
    try {
      requireConfig();
      await loginZentao(config.zentao.url, config.zentao.username, config.zentao.password);
      return ok({ success: true, url: config.zentao.url, account: config.zentao.username });
    } catch (e) {
      return fail(e.message);
    }
  }
);

server.tool(
  'zentao_list_executions',
  '列出禅道中可用的执行（迭代/看板/阶段），用于确定任务应挂载到哪个执行。',
  {},
  async () => {
    try {
      requireConfig();
      const executions = await getExecutions();
      return ok({ count: executions.length, executions });
    } catch (e) {
      return fail(e.message);
    }
  }
);

server.tool(
  'zentao_list_tasks',
  '查询禅道任务列表。可不传参数（默认查默认执行），也可按执行、指派人、状态筛选。',
  {
    executionId: z.string().optional().describe('执行ID，缺省用默认执行(167)'),
    assignedTo: z.string().optional().describe('指派人账号，如 lijc'),
    status: z.string().optional().describe('状态：wait/doing/done/closed')
  },
  async ({ executionId, assignedTo, status }) => {
    try {
      requireConfig();
      const tasks = await getTasks({ executionId, assignedTo, status });
      return ok({ count: tasks.length, tasks });
    } catch (e) {
      return fail(e.message);
    }
  }
);

server.tool(
  'zentao_my_tasks',
  '查询"我的任务"（当前账号在禅道地盘里的任务列表）。',
  {},
  async () => {
    try {
      requireConfig();
      const tasks = await getMyTasks();
      return ok({ count: tasks.length, tasks });
    } catch (e) {
      return fail(e.message);
    }
  }
);

server.tool(
  'zentao_create_task',
  '在禅道创建任务。用于把一条工作登记为新任务。',
  {
    name: z.string().describe('任务标题（必填）'),
    desc: z.string().optional().describe('任务描述'),
    executionId: z.string().optional().describe('执行ID，缺省用默认执行(167)'),
    estimate: z.number().optional().describe('预计工时（小时）'),
    estStarted: z.string().optional().describe('预计开始日期 YYYY-MM-DD'),
    dueDate: z.string().optional().describe('截止日期 YYYY-MM-DD'),
    assignedTo: z.string().optional().describe('指派给，账号如 lijc'),
    priority: z.number().optional().describe('优先级 1-4，默认3'),
    type: z.string().optional().describe('任务类型，默认 devel')
  },
  async (args) => {
    try {
      requireConfig();
      const result = await createTask({
        title: args.name,
        content: args.desc,
        executionId: args.executionId,
        estimate: args.estimate,
        estStarted: args.estStarted,
        dueDate: args.dueDate,
        assignedTo: args.assignedTo,
        priority: args.priority,
        type: args.type
      });
      return result.success ? ok(result) : fail(result.message);
    } catch (e) {
      return fail(e.message);
    }
  }
);

server.tool(
  'zentao_record_estimate',
  '给禅道某个任务登记工时（写工时日志）。',
  {
    taskId: z.string().describe('禅道任务ID，如 885'),
    work: z.string().describe('工作内容描述'),
    consumed: z.number().optional().describe('本次消耗工时（小时）'),
    left: z.number().optional().describe('剩余工时（小时）')
  },
  async ({ taskId, work, consumed, left }) => {
    try {
      requireConfig();
      const result = await recordTaskEstimate(taskId, { work, consumed, left });
      return result.success ? ok(result) : fail(result.message);
    } catch (e) {
      return fail(e.message);
    }
  }
);

server.tool(
  'zentao_update_status',
  '更新禅道任务状态（wait/doing/done/closed/cancel）。完成或关闭时可顺带登记本次消耗工时与备注。',
  {
    taskId: z.string().describe('禅道任务ID'),
    status: z.enum(['wait', 'doing', 'done', 'closed', 'cancel']).describe('目标状态'),
    consumed: z.number().optional().describe('本次消耗工时（小时），用于 done 时顺带记账'),
    comment: z.string().optional().describe('备注/说明')
  },
  async ({ taskId, status, consumed, comment }) => {
    try {
      requireConfig();
      const result = await updateTaskStatus(taskId, status, { consumed, comment });
      return result.success ? ok(result) : fail(result.message);
    } catch (e) {
      return fail(e.message);
    }
  }
);

// ---------- 启动 ----------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[zentao-mcp] 服务已启动（stdio）\n');
}

main().catch((err) => {
  process.stderr.write(`[zentao-mcp] 启动失败: ${err.message}\n`);
  process.exit(1);
});
