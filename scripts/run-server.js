/* 服务监督进程：包一层 server.js，负责日志的时间戳、PID、退出码与轮转。
 *
 * 为什么需要独立一层而不是在 server.js 里做：
 * 进程无法记录自己的退出码——被杀时它已经没有机会写任何东西了。只有父进程能
 * 观察到子进程是 code 退出还是 signal 终止。cmd.exe 的 `>>` 重定向同样加不了
 * 时间戳、也做不了轮转。
 *
 * 2026-08-31 那次事故（服务被 Task Scheduler 按 3 天执行时限掐掉）之所以查了
 * 很久，就是因为 server.log 里 39 次启动记录长得一模一样，只能靠文件 mtime
 * 做考古。这里补上的三个信号直接消除那个盲区：
 *   - 每行带本地时间戳，能与事件日志、文件时间直接对齐
 *   - 退出行带退出码/信号 + 本次运行时长（当时若有，72 小时一眼可见）
 *   - 有启动行而无退出行 = 被外部强杀；有退出行 = 自己退的
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server.js');
const LOG_DIR = process.env.LOG_DIR || path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
// 默认 10MB 轮转、保留 5 份归档；生产可用环境变量覆盖
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES) || 10 * 1024 * 1024;
const KEEP_FILES = Number(process.env.LOG_KEEP) || 5;

fs.mkdirSync(LOG_DIR, { recursive: true });

/* 本地时区的 ISO 时间戳。刻意不用 toISOString()：它是 UTC，而事件日志、
 * 文件时间和 PowerShell 脚本的 Get-Date -Format o 都是本地时间，混用会让
 * 排查时的时间对齐变成额外负担。 */
function localISO(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function humanUptime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
}

/* ---------------- 日志写入与轮转 ---------------- */

/* 刻意使用同步追加而不是 WriteStream。
 *
 * 这个监督进程存在的全部意义，就是记录服务被杀之前发生了什么。而进程被
 * TerminateProcess 强杀时不会有任何清理机会——WriteStream 缓冲区里尚未落盘的
 * 内容会直接蒸发，丢掉的恰恰是最有诊断价值的最后几行。
 *
 * 另外 createWriteStream(flags:'a') 只在首次写入时才真正创建文件，配合缓冲会
 * 让紧随其后的轮转 rename 撞上 ENOENT。同步追加让「写完文件一定存在」成立，
 * 轮转逻辑因此不需要考虑这种时序。
 *
 * 代价是阻塞事件循环，但这里每次启停只有个位数行，量级完全可以忽略。 */
let written = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;

/* 归档超出保留份数的旧日志。删除失败只告警不抛错——清理失败不该影响服务。 */
function pruneArchives() {
  try {
    const archives = fs.readdirSync(LOG_DIR)
      .filter((name) => /^server-\d{8}-\d{6}\.log$/.test(name))
      .sort();
    while (archives.length > KEEP_FILES) {
      const victim = archives.shift();
      try {
        fs.unlinkSync(path.join(LOG_DIR, victim));
      } catch (error) {
        process.stderr.write(`[supervisor] 归档清理失败 ${victim}: ${error.message}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`[supervisor] 归档扫描失败: ${error.message}\n`);
  }
}

function rotate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const target = path.join(LOG_DIR, `server-${stamp}.log`);
  try {
    fs.renameSync(LOG_FILE, target);
    written = 0;
  } catch (error) {
    // Windows 上文件被占用时改名会失败：放弃本次轮转、继续写原文件，
    // 总比因为轮转失败而丢日志或让服务跟着崩掉好。不重置 written，
    // 否则下一行又会立刻触发一次注定失败的轮转。
    process.stderr.write(`[supervisor] 日志轮转失败: ${error.message}\n`);
    return;
  }
  pruneArchives();
}

function writeLine(tag, text) {
  const line = `${localISO()} [${tag}] ${text}\n`;
  const bytes = Buffer.byteLength(line);
  if (written + bytes > MAX_BYTES) rotate();
  try {
    fs.appendFileSync(LOG_FILE, line);
    written += bytes;
  } catch (error) {
    // 磁盘满、权限变更等写失败不能把监督进程带崩，否则服务跟着一起没
    process.stderr.write(`[supervisor] 日志写入失败: ${error.message}\n`);
  }
}

/* ---------------- 启动子进程 ---------------- */

const startedAt = Date.now();
writeLine('supervisor', `启动 ${SERVER_ENTRY}（监督进程 pid=${process.pid}，轮转阈值 ${MAX_BYTES} 字节，保留 ${KEEP_FILES} 份）`);

const child = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: ROOT,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

writeLine('supervisor', `子进程已启动 pid=${child.pid}`);

/* 逐行转发，给每行打上子进程 PID：日志里同时出现多次启动时能区分是哪一次。
 *
 * 刻意不区分 stdout / stderr：server.js 的启动横幅用 console.warn 输出，与真正
 * 的错误同走 stderr，流本身区分不了二者。给每行都标上「错误」等于没标，只会
 * 训练读日志的人忽略这个标记。
 *
 * 空行只是横幅的排版，对排查毫无价值，跳过以保持日志可扫读。 */
for (const source of [child.stdout, child.stderr]) {
  readline.createInterface({ input: source, crlfDelay: Infinity })
    .on('line', (line) => {
      if (line.trim()) writeLine(String(child.pid), line);
    });
}

child.on('error', (error) => {
  writeLine('supervisor', `子进程启动失败: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  const uptime = humanUptime(Date.now() - startedAt);
  writeLine('supervisor', `子进程退出 code=${code} signal=${signal} 运行时长=${uptime}`);
  // 用子进程的退出码退出，让 Task Scheduler 能据此判定任务成败并触发重启策略
  // 同步追加，退出前无需等待缓冲刷盘
  process.exit(code === null ? 1 : code);
});

/* Windows 上外部很难对服务投递信号，但手工前台运行时 Ctrl+C 仍会到达这里。
 * 转发给子进程，让 server.js 自己的优雅关闭逻辑有机会执行。 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    writeLine('supervisor', `收到 ${signal}，转发给子进程 pid=${child.pid}`);
    try {
      child.kill(signal);
    } catch (error) {
      writeLine('supervisor', `转发 ${signal} 失败: ${error.message}`);
    }
  });
}

process.on('uncaughtException', (error) => {
  writeLine('supervisor', `监督进程未捕获异常: ${error.stack || error.message}`);
  process.exit(1);
});
