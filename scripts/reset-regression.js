/* 重置脚本回归：node scripts/reset-regression.js */
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'taskassign-reset-'));
process.env.DATA_DIR = path.join(TEST_ROOT, 'custom-data');
process.env.UPLOAD_DIR = path.join(TEST_ROOT, 'custom-uploads');
process.env.PORT = '39091';
const resetTool = require('./reset');

let pass = 0;
function ok(condition, label) {
  assert.ok(condition, label);
  pass += 1;
  console.log(`  ✓ ${label}`);
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

(async () => {
  try {
    console.log('\n重置脚本回归');
    fs.mkdirSync(resetTool.dataDir, { recursive: true });
    fs.mkdirSync(resetTool.uploadDir, { recursive: true });
    fs.writeFileSync(path.join(resetTool.dataDir, 'app.db'), 'db');
    fs.writeFileSync(path.join(resetTool.uploadDir, 'file.txt'), 'attachment');

    await resetTool.reset({ confirmRunningServer: async () => false, allowOutsideRoot: true });
    ok(!fs.existsSync(path.join(resetTool.dataDir, 'app.db')), '尊重 DATA_DIR 并删除数据库文件');
    ok(!fs.existsSync(path.join(resetTool.uploadDir, 'file.txt')), '尊重 UPLOAD_DIR 并删除附件文件');

    // 目录逃逸项目根且未加 --force 时拒绝删除，防止环境变量误配置清空宽泛目录
    const escapedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskassign-reset-escape-'));
    const escapedUploads = path.join(escapedRoot, 'uploads');
    fs.mkdirSync(escapedUploads, { recursive: true });
    const keepFile = path.join(escapedUploads, 'keep.txt');
    fs.writeFileSync(keepFile, 'keep');
    let refused = false;
    let refusedMessage = '';
    try {
      execFileSync(process.execPath, ['scripts/reset.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          DATA_DIR: path.join(escapedRoot, 'data'),
          UPLOAD_DIR: escapedUploads,
          PORT: '39092',
        },
        stdio: 'pipe',
      });
    } catch (error) {
      refused = true;
      refusedMessage = String(error.stderr || '');
    }
    ok(refused && refusedMessage.includes('--force') && fs.existsSync(keepFile),
      '目录逃逸项目根且未加 --force 时拒绝重置且文件保留');
    fs.rmSync(escapedRoot, { recursive: true, force: true });

    const unrelated = await listen((req, res) => res.end('other application'));
    const unrelatedPort = unrelated.address().port;
    ok(!(await resetTool.isTaskAssignServer({ host: '127.0.0.1', port: unrelatedPort })),
      '无关 HTTP 服务不会被误判为任务分配系统');
    await new Promise((resolve) => unrelated.close(resolve));

    const taskAssign = await listen((req, res) => res.end('<title>任务分配系统</title>'));
    const appPort = taskAssign.address().port;
    ok(await resetTool.isTaskAssignServer({ host: '127.0.0.1', port: appPort }),
      '显式端口上的任务分配系统可被可靠识别');
    await new Promise((resolve) => taskAssign.close(resolve));

    console.log(`\n通过 ${pass} 项`);
  } finally {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
