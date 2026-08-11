'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');

const { attachUser, cleanupSessions } = require('./src/auth');

const app = express();
const PORT = process.env.PORT || 3000;
// 默认监听所有网卡，便于同一局域网内访问；可用 HOST 环境变量收窄。
const HOST = process.env.HOST || '0.0.0.0';

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(attachUser);

// API
app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/users', require('./src/routes/userRoutes'));
app.use('/api/tasks', require('./src/routes/taskRoutes'));
app.use('/api', require('./src/routes/statsRoutes'));

// 静态资源
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/', (req, res) => res.redirect('/index.html'));

// 统一错误处理（含 multer 错误）
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE' ? '单个附件不能超过 50MB'
        : err.code === 'LIMIT_FILE_COUNT' ? '一次最多上传 10 个附件'
          : `附件上传失败：${err.message}`;
    return res.status(400).json({ error: msg });
  }
  console.error('[error]', err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

setInterval(cleanupSessions, 6 * 3600 * 1000).unref();

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  任务分配系统已启动');
  console.log(`  工作台：http://${HOST}:${PORT}/index.html`);
  console.log(`  大屏：  http://${HOST}:${PORT}/screen.html`);
  console.log('');
});
