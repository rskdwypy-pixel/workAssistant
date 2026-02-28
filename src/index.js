import express from 'express';
import { config, validateConfig } from './config.js';
import apiRouter from './routes/api.js';
import { startReminder } from './services/reminder.js';
import { startSummary } from './services/summary.js';

const app = express();
const { server } = config;

// 中间件
app.use(express.json());

// CORS支持（用于浏览器插件）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// 请求日志
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// API路由
app.use('/api', apiRouter);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

// 启动服务器
function startServer() {
  // 验证配置
  if (!validateConfig()) {
    console.log('⚠️  配置验证有警告，但继续启动...');
  }

  app.listen(server.port, server.host, () => {
    console.log('╔════════════════════════════════════════╗');
    console.log('║        🏠 工作助手服务已启动           ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  地址: http://${server.host}:${server.port}     ║`);
    console.log(`║  早间提醒: 每天 ${config.schedule.morningHour}:00           ║`);
    console.log(`║  晚间日报: 每天 ${config.schedule.eveningHour}:00           ║`);
    console.log('╚════════════════════════════════════════╝');
  });

  startReminder();
  startSummary();
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
