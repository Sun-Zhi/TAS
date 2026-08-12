'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');

const { attachUser, cleanupSessions } = require('./src/auth');
// 入口错误中间件在 multer 失败时复用 taskRoutes 的清理函数
const { removeUploadedFiles } = require('./src/routes/taskRoutes');
// 优雅关闭时需要关闭 SQLite 连接
const { db } = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;
// 默认监听所有网卡，便于同一局域网内访问；可用 HOST 环境变量收窄。
const HOST = process.env.HOST || '0.0.0.0';

/* ---------------- boot-time 校验 ---------------- */
// 生产环境强制要求关键环境变量，避免静默使用默认值或运行时崩溃。
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[fatal] 缺少必需环境变量：${name}`);
    process.exit(1);
  }
  return value;
}
if (process.env.NODE_ENV === 'production') {
  requireEnv('ADMIN_PASSWORD');
  requireEnv('DATA_DIR');
  requireEnv('UPLOAD_DIR');
}

app.disable('x-powered-by');
/* ---------------- HTTP 安全头 ---------------- */
// 注：script-src 保留 'unsafe-inline' 是为了兼容 public/js/app.js 中模板字符串拼接的
// inline event handler（onclick="..."）。未来重构为 addEventListener 后改为严格 CSP。
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
  );
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(attachUser);

/* ---------------- API 路由 ---------------- */
app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/users', require('./src/routes/userRoutes'));
app.use('/api/tasks', require('./src/routes/taskRoutes'));
app.use('/api', require('./src/routes/statsRoutes'));

/* ---------------- 静态资源 ---------------- */
// 不启用 extensions：避免访问 /foo 自动猜测 /foo.html，减少文件存在性泄露。
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/index.html'));

/* ---------------- 统一错误处理（含 multer 错误） ---------------- */

// multer 错误码 → HTTP 状态码 + 客户端可读消息。避免 5 层三元嵌套。
const MULTER_ERROR_MAP = {
  LIMIT_FILE_SIZE: { status: 413, message: '单个附件不能超过 50MB' },
  LIMIT_FILE_COUNT: { status: 400, message: '一次最多上传 10 个附件' },
  LIMIT_UNEXPECTED_EOF: { status: 400, message: '上传连接中断，请重试' },
  LIMIT_FIELD_KEY: { status: 400, message: '附件字段不合法' },
  LIMIT_FIELD_VALUE: { status: 400, message: '附件字段不合法' },
};

/** 清理 multer 已写入磁盘的临时文件；错误仅记录日志，不影响主流程 */
function safeCleanupFiles(req) {
  try {
    removeUploadedFiles(req.files);
  } catch (cleanupErr) {
    console.error('[upload-cleanup]', cleanupErr);
  }
}

app.use((err, req, res, next) => {
  // 先判断自定义 code（项目前缀 UPLOAD_）：避免与 multer.MulterError 误判。
  // multer fileFilter 拒绝（白名单外的扩展名/MIME，如 SVG/.lnk/.exe）
  if (err && err.code === 'UPLOAD_UNSUPPORTED_TYPE') {
    safeCleanupFiles(req);
    return res.status(415).json({ error: err.message || '不支持的附件类型' });
  }
  if (err instanceof multer.MulterError) {
    safeCleanupFiles(req);
    const mapped = MULTER_ERROR_MAP[err.code] || { status: 400, message: `附件上传失败：${err.message}` };
    return res.status(mapped.status).json({ error: mapped.message });
  }
  // express.json / urlencoded body 超过 limit 时统一映射为中文 413，避免泄露英文 message
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大，不能超过 2MB' });
  }
  console.error('[error]', err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  // 5xx 不向客户端透传内部 message，避免泄露 SQL/路径/堆栈；4xx 仅在 message 命中危险模式时收紧，业务错误正常透传
  const rawMessage = err.message || '';
  const dangerous = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b|\bat\s+\S+\s*\(|\bnode_modules\b|\.js:\d+:\d+/i.test(rawMessage);
  const message = status >= 500 ? '服务器内部错误'
    : dangerous ? '请求失败'
    : rawMessage || '请求失败';
  res.status(status).json({ error: message });
});

// 每 30 分钟清理一次过期 session，避免 sessions 表膨胀
setInterval(cleanupSessions, 30 * 60 * 1000).unref();

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  任务分配系统已启动');
  console.log(`  工作台：http://${HOST}:${PORT}/index.html`);
  console.log(`  大屏：  http://${HOST}:${PORT}/screen.html`);
  console.log('');
});

// Large LAN uploads may legitimately take longer than Node's default 5-minute request window.
server.requestTimeout = 30 * 60 * 1000;
// headersTimeout 保持 Node 默认 60s：仅用于等待请求头，不应拉伸到 31 分钟（会被慢连接耗尽资源）。
// keepAliveTimeout 略大于 headersTimeout 即可，让客户端能复用连接。
server.keepAliveTimeout = 65 * 1000;

/* ---------------- 优雅关闭 ---------------- */
// SIGTERM/SIGINT 收到后停止接受新连接、关闭 idle keep-alive、等待 in-flight 请求完成，
// 再关闭数据库并退出；30 秒超时兜底避免 zombie。
function shutdown(signal) {
  console.log(`[shutdown] 收到 ${signal}，开始优雅关闭...`);
  server.close((err) => {
    if (err) console.error('[shutdown] server.close 错误', err);
    try {
      db.close();
    } catch (closeErr) {
      console.error('[shutdown] db.close 错误', closeErr);
    }
    console.log('[shutdown] 数据库已关闭，进程退出');
    process.exit(0);
  });
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  setTimeout(() => {
    console.error('[shutdown] 超时 30s，强制关闭所有连接');
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(() => process.exit(1), 1000).unref();
  }, 30000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
