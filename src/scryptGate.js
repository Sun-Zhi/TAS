'use strict';

/* scrypt 全局并发闸门。
 * libuv 线程池默认仅 4 线程；登录、改密、旧哈希升级共用同一个全局预算，
 * 同一时刻的高频尝试若不排队会占满线程池，拖慢全站其他加密/文件操作。
 * 单 IP 限流挡不住窗口内前 N 个请求的瞬时并发，故再加全局上限。 */
const MAX_CONCURRENT_SCRYPT = 2;
// 排队上限：到达速率可能超过闸门消化速率（约 4.6 次/秒），
// 队列无限增长会拖垮登录延迟并形成内存 DoS，超限直接快速失败。
const SCRYPT_QUEUE_LIMIT = 100;

let activeScrypts = 0;
let maxObservedScrypts = 0;
const scryptQueue = [];

function finishScryptJob() {
  activeScrypts -= 1;
  // 先释放名额、再启动 FIFO 队首；任务自身不会递归占用闸门，因此不会死锁。
  const next = scryptQueue.shift();
  if (next) next();
}

function runWithScryptGate(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeScrypts += 1;
      maxObservedScrypts = Math.max(maxObservedScrypts, activeScrypts);
      Promise.resolve()
        .then(task)
        .then(
          (value) => { finishScryptJob(); resolve(value); },
          (error) => { finishScryptJob(); reject(error); }
        );
    };
    if (activeScrypts < MAX_CONCURRENT_SCRYPT) run();
    else if (scryptQueue.length >= SCRYPT_QUEUE_LIMIT) {
      const busy = new Error('请求过多，请稍后重试');
      busy.status = 429;
      reject(busy);
    } else scryptQueue.push(run);
  });
}

/** 仅供隔离回归测试观察调度状态；不经 HTTP 暴露，也不参与业务逻辑。 */
function getScryptGateState() {
  return { active: activeScrypts, queued: scryptQueue.length, maxObserved: maxObservedScrypts };
}

function resetScryptGateMetrics() {
  if (activeScrypts === 0) maxObservedScrypts = 0;
}

module.exports = { runWithScryptGate, getScryptGateState, resetScryptGateMetrics };
