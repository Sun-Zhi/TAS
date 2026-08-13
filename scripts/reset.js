/* 清空数据库与附件，恢复默认账号。用法：npm run reset（数据目录在项目根之外时：node scripts/reset.js --force） */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(root, 'uploads'));
const serverPort = Number(process.env.PORT || 3000);
const serverHost = process.env.HOST || '127.0.0.1';
const PROBE_TIMEOUT_MS = 1000;

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// 不再仅凭端口打开就拒绝：必须由 HTTP 响应确认其确为本系统，避免无关服务误报。
function isTaskAssignServer({ host = serverHost, port = serverPort } = {}) {
  if (!isValidPort(port)) return Promise.resolve(false);
  // 服务通常监听 0.0.0.0/::；探测本机时应连接 loopback，而不是把通配监听地址当目标。
  const probeHost = ['0.0.0.0', '::', '::0'].includes(host) ? '127.0.0.1' : host;
  return new Promise((resolve) => {
    const request = http.get({ host: probeHost, port, path: '/index.html', timeout: PROBE_TIMEOUT_MS }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(response.statusCode === 200 && body.includes('任务分配系统')));
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

/** 目录是否逃逸出项目根目录（相对路径以 .. 开头或为绝对路径） */
function escapesRoot(dir) {
  const rel = path.relative(root, dir);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

function removeFiles(dir, filter) {
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!filter(name)) continue;
    const target = path.join(dir, name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EBUSY') {
        throw new Error(`文件被占用：${target}。服务器可能仍在运行，请先停止服务再执行重置。`);
      }
      throw error;
    }
  }
}

async function reset({ confirmRunningServer = isTaskAssignServer, allowOutsideRoot = false } = {}) {
  if (await confirmRunningServer()) {
    throw new Error(`检测到任务分配系统正在运行（${serverHost}:${serverPort}）。请先停止服务再执行重置。`);
  }
  // 防误配保护：数据目录逃逸项目根时，删除前必须显式确认（--force），
  // 避免环境变量残留误指向宽泛目录（如 C:\、家目录）时静默清空数据。
  const outsideDirs = [dataDir, uploadDir].filter((dir) => escapesRoot(dir));
  if (outsideDirs.length && !allowOutsideRoot) {
    throw new Error(
      `数据目录位于项目根之外：${outsideDirs.join('、')}。` +
      '为防环境变量误配置导致误删，请确认无误后使用 --force 强制重置。'
    );
  }
  removeFiles(dataDir, (name) => name.startsWith('app.db'));
  removeFiles(uploadDir, () => true);
}

async function main() {
  try {
    // 数据目录在项目根之外时需显式 --force，防止误配置的环境变量导致误删
    await reset({ allowOutsideRoot: process.argv.includes('--force') });
    console.log(`已重置数据库与附件（数据目录：${dataDir}；附件目录：${uploadDir}）。下次启动将重新创建默认账号。`);
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { dataDir, uploadDir, serverPort, serverHost, isTaskAssignServer, removeFiles, reset };
