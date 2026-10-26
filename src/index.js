import express from 'express';
import { existsSync, statSync, copyFileSync, truncateSync, chmodSync } from 'fs';
import { config, validateConfig } from './config.js';
import { createRequestGuard } from './utils/requestGuard.js';
import apiRouter from './routes/api.js';
import adminRouter from './routes/admin.js';
import attachmentsRouter from './routes/attachments.js';
import reportsRouter from './routes/reports.js';
import docsRouter from './routes/docs.js';
import storiesRouter from './routes/stories.js';
import taskLinkRouter from './routes/taskLink.js';
import todosRouter from './routes/todos.js';
import effortsRouter from './routes/efforts.js';
import autofillRouter from './routes/autofill.js';
import accountRouter from './routes/account.js';
import notifyRouter from './routes/notify.js';
import quickSearchRouter from './routes/quickSearch.js';
import workloadRouter from './routes/workload.js';
import timerRouter from './routes/timer.js';
import { startAttachmentRetry } from './services/attachmentSync.js';
import { startReminder } from './services/reminder.js';
import { start as startAssignNotifier } from './services/assignNotify.js';
import { startSummary } from './services/summary.js';
import updateRouter from './routes/update.js';
import { getUpdater } from './services/updater.js';

const app = express();
const { server } = config;

// 自动更新：避开早晚提醒、日报、周五周报的时间段重启
const updater = getUpdater({
  scheduleHours: (d) => [config.schedule.morningHour, config.schedule.eveningHour, ...(d.getDay() === 5 ? [17] : [])]
});

// /health 返回的应用标识：端口被占用时据此判断「占着端口的是不是我们自己」
const APP_ID = 'workassistant';

// 来源校验 + CORS（只放行本插件与本机命令行，见 utils/requestGuard.js）
app.use(createRequestGuard({ port: server.port, projectRoot: config.paths.root }));

// 中间件
app.use(express.json({ limit: '1mb' })); // 加密的配置文件（含长提示词）可能超过默认的 100kb

// 请求日志
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  // 有人在用就不重启安装更新（插件定时查的状态接口不算）
  if (req.path !== '/health' && req.path !== '/api/update/status') updater.touch();
  next();
});

// API路由
app.use('/api', apiRouter);
app.use('/api', adminRouter);
app.use('/api', attachmentsRouter);
app.use('/api', reportsRouter);
app.use('/api', docsRouter);
app.use('/api', storiesRouter);
app.use('/api', taskLinkRouter);
app.use('/api', todosRouter);
app.use('/api', notifyRouter);
app.use('/api', quickSearchRouter);
app.use('/api', workloadRouter);
app.use('/api', timerRouter);
app.use('/api', autofillRouter);
app.use('/api', effortsRouter);
app.use('/api', accountRouter);
app.use('/api', updateRouter);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: APP_ID, version: config.app.version, pid: process.pid, timestamp: new Date().toISOString() });
});

// 404处理
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

/**
 * 日志文件维护：权限收紧为 600，超过 5MB 时按 copytruncate 方式轮转一份 .1
 *
 * 日志路径由启动方（LaunchAgent plist / backend-launcher.sh）通过 WORKASSISTANT_LOG_FILE 传入，
 * stdout 由它们重定向，进程内只能 copytruncate（不能 rename，否则仍写旧文件）。
 */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
function maintainLogFile() {
  const logFile = process.env.WORKASSISTANT_LOG_FILE;
  if (!logFile || !existsSync(logFile)) return;
  try {
    chmodSync(logFile, 0o600);
    if (statSync(logFile).size > LOG_MAX_BYTES) {
      copyFileSync(logFile, `${logFile}.1`);
      chmodSync(`${logFile}.1`, 0o600);
      truncateSync(logFile, 0);
      console.log('[Log] 日志已轮转:', `${logFile}.1`);
    }
  } catch (err) {
    console.warn('[Log] 日志维护失败:', err.message);
  }
}

/**
 * 端口被占用时，确认占用者是不是本项目的后端
 * @returns {Promise<boolean>}
 */
async function isOurBackendOnPort() {
  try {
    const resp = await fetch(`http://127.0.0.1:${server.port}/health`, { signal: AbortSignal.timeout(2000) });
    const json = await resp.json();
    return json && json.app === APP_ID;
  } catch {
    return false;
  }
}

// 启动服务器
function startServer() {
  maintainLogFile();
  setInterval(maintainLogFile, 60 * 60 * 1000).unref();

  // 验证配置
  if (!validateConfig()) {
    console.log('⚠️  配置验证有警告，但继续启动...');
  }

  const httpServer = app.listen(server.port, server.host, () => {
    console.log('╔════════════════════════════════════════╗');
    console.log('║        🏠 禅道助手服务已启动           ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  地址: http://${server.host}:${server.port}     ║`);
    console.log(`║  早间提醒: 每天 ${config.schedule.morningHour}:00           ║`);
    console.log(`║  晚间日报: 每天 ${config.schedule.eveningHour}:00           ║`);
    console.log('╚════════════════════════════════════════╝');

    // 端口真正拿到手了才挂定时任务，否则会多出一份重复的调度
    startReminder();
    startSummary();
    // 别人把任务 / Bug / 需求指派给我时提醒（每 5 分钟读一次「指派给我」的列表）
    startAssignNotifier();
    // 已同步到禅道、仍有待上传附件的记录：定时补传
    startAttachmentRetry();
    updater.start();
  });

  let portRetries = 0;
  httpServer.on('error', async (err) => {
    // 自动更新后重启（非开机自启拉起的情况）：旧进程正在退出，等它让出端口
    if (err.code === 'EADDRINUSE' && process.env.WA_RESTART_WAIT_PORT && portRetries < 20) {
      portRetries++;
      return setTimeout(() => httpServer.listen(server.port, server.host), 500);
    }
    if (err.code === 'EADDRINUSE') {
      // 已有本项目后端在跑 = 正常让位，以 0 退出：
      // LaunchAgent 的 KeepAlive 只对异常退出重启，不会因此陷入重启循环。
      if (await isOurBackendOnPort()) {
        console.error(`端口 ${server.port} 已有禅道助手后端在运行，本实例退出（不重复启动）`);
        process.exit(0);
      }
      // 被别的程序占了：以非 0 退出，让 launchd 稍后重试，并在日志里说清楚
      console.error(`端口 ${server.port} 被其他程序占用，禅道助手后端无法启动。` +
        `可执行 ${process.platform === 'win32' ? `netstat -ano | findstr :${server.port}` : `lsof -nP -iTCP:${server.port} -sTCP:LISTEN`} 查看占用者，或在 .env 中修改 PORT`);
      process.exit(2);
    }
    console.error('服务启动失败:', err);
    process.exit(1);
  });
}

// 优雅关闭
function shutdown() {
  console.log('\n👋 正在关闭服务...');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 启动
startServer();
