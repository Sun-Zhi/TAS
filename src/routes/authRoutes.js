'use strict';

const express = require('express');
const { db, verifyPasswordAsync, hashPasswordAsync, isLegacyHash, DUMMY_HASH, DUMMY_HASH_LEGACY } = require('../db');
const auth = require('../auth');
const { runWithScryptGate, getScryptGateState, resetScryptGateMetrics } = require('../scryptGate');
const { validatePassword } = require('../utils');

const router = express.Router();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
// 辅维度（username 仅）：阈值高于主维度，锁定窗口更短，防止「5 个不同 IP 各 1 次错误
// 口令就锁死任意账号 15 分钟」的远程 DoS。主维度 (IP+username) 仍能在密码喷洒中拦截。
const LOGIN_USERNAME_MAX_FAILURES = 20;
const LOGIN_USERNAME_LOCK_MS = 5 * 60 * 1000;
const LOGIN_STALE_MS = 30 * 60 * 1000; // 超出窗口的 entry 视为 stale，可清理
const LOGIN_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// 每 IP 固定窗口限流：拦截高频口令喷洒（与失败计数维度互补，成功登录也计入）
const LOGIN_IP_WINDOW_MS = 60 * 1000;
const LOGIN_IP_MAX_ATTEMPTS = 60;
// Map 容量上限：防止恶意多维度 key（IP/账号）撑爆内存
const LOGIN_MAX_MAP_ENTRIES = 10_000;
const LOGIN_MAX_USERNAME_LEN = 64;
// 改密端点限流：按用户维度计数（已登录用户只影响自己的计数），
// 防止持有会话者借改密端点做 scrypt 洪水 DoS 或无限尝试旧密码。
const PASSWORD_MAX_ATTEMPTS = 10;
const PASSWORD_WINDOW_MS = 60 * 1000;
const passwordAttempts = new Map();
// 防 password spraying：主维度 (IP+username) 组合 + 辅维度 username 独立
const loginFailures = new Map();
const loginIpAttempts = new Map();

function ipKey(req) {
  return `${req.ip || req.socket.remoteAddress || 'unknown'}`;
}
function usernameKey(username) {
  // 截断超长账号：Map key 防御性限长，超长输入在 /login 入口已被拒绝
  return `u:${String(username || '').trim().toLowerCase().slice(0, LOGIN_MAX_USERNAME_LEN)}`;
}
function comboKey(req, username) {
  return `${ipKey(req)}::${usernameKey(username)}`;
}

function failureState(key) {
  const now = Date.now();
  const state = loginFailures.get(key);
  if (!state || now - state.firstAt >= LOGIN_WINDOW_MS) {
    const fresh = { count: 0, firstAt: now };
    loginFailures.set(key, fresh);
    return fresh;
  }
  return state;
}

/** 仅查询锁定状态，不写入 Map（避免查询语义污染统计）。
 *  返回命中维度的锁定窗口毫秒数（主维度 15 分钟 / 辅维度 5 分钟），未命中返回 0。 */
function peekLocked(req, username) {
  const now = Date.now();
  const ck = loginFailures.get(comboKey(req, username));
  if (ck && now - ck.firstAt < LOGIN_WINDOW_MS && ck.count >= LOGIN_MAX_FAILURES) return LOGIN_WINDOW_MS;
  const uk = loginFailures.get(usernameKey(username));
  if (uk && now - uk.firstAt < LOGIN_USERNAME_LOCK_MS && uk.count >= LOGIN_USERNAME_MAX_FAILURES) {
    return LOGIN_USERNAME_LOCK_MS;
  }
  return 0;
}

function recordFailure(req, username) {
  failureState(comboKey(req, username)).count += 1;
  failureState(usernameKey(username)).count += 1;
  trimMapToLimit(loginFailures);
}

function clearFailures(req, username) {
  loginFailures.delete(comboKey(req, username));
  loginFailures.delete(usernameKey(username));
}

/** 每 IP 固定窗口限流（60 次/分钟，含成功登录）：返回 true 表示本次请求应拒绝 */
function ipRateLimited(req) {
  const now = Date.now();
  const key = ipKey(req);
  const state = loginIpAttempts.get(key);
  if (state && now - state.firstAt < LOGIN_IP_WINDOW_MS && state.count >= LOGIN_IP_MAX_ATTEMPTS) {
    return true;
  }
  if (!state || now - state.firstAt >= LOGIN_IP_WINDOW_MS) {
    loginIpAttempts.set(key, { count: 1, firstAt: now });
  } else {
    state.count += 1;
  }
  trimMapToLimit(loginIpAttempts);
  return false;
}

/** Map 超容量时：先删 stale entry，仍超限则删最早插入的 key（Map 迭代顺序即插入顺序） */
function trimMapToLimit(map) {
  if (map.size <= LOGIN_MAX_MAP_ENTRIES) return;
  const now = Date.now();
  for (const [key, state] of map) {
    if (now - state.firstAt >= LOGIN_STALE_MS) map.delete(key);
    if (map.size <= LOGIN_MAX_MAP_ENTRIES) return;
  }
  const oldestKey = map.keys().next().value;
  if (oldestKey !== undefined) map.delete(oldestKey);
}

async function verifyLoginPassword(password, user) {
  // 所有分支都执行 2 次闸门内的 scrypt 且总成本恒定：
  // - 旧格式账号：低成本真实校验（N=16384）+ 高成本新格式 dummy
  // - 新格式账号 / 不存在账号：高成本校验 + 低成本旧格式 dummy
  // 依次排入队列而非 Promise.all：单次登录不会绕开预算占用两个 slot。
  if (user && isLegacyHash(user.password)) {
    const passwordOk = await runWithScryptGate(() => verifyPasswordAsync(password, user.password));
    await runWithScryptGate(() => verifyPasswordAsync(password, DUMMY_HASH));
    return passwordOk;
  }
  const passwordOk = await runWithScryptGate(() => verifyPasswordAsync(password, user ? user.password : DUMMY_HASH));
  await runWithScryptGate(() => verifyPasswordAsync(password, DUMMY_HASH_LEGACY));
  return passwordOk;
}

// 旧格式哈希升级队列：登录成功后移出请求路径异步执行，串行化避免
// 升级瞬间的多个高成本 scrypt 同时挤占线程池。失败不阻断登录，下次登录重试。
// 队列加长度上限：避免恶意账号反复登录把明文密码无限堆进内存；
// 超限时跳过本次升级，该账号下次登录成功时仍会再次尝试升级。
const LEGACY_UPGRADE_QUEUE_LIMIT = 100;
const legacyUpgradeQueue = [];
let legacyUpgradeRunning = false;

function scheduleLegacyUpgrade(userId, plainPassword, expectedHash) {
  if (legacyUpgradeQueue.length >= LEGACY_UPGRADE_QUEUE_LIMIT) {
    console.warn('[login] 旧哈希升级队列已满，跳过本次升级，待下次登录重试');
    return;
  }
  legacyUpgradeQueue.push({ userId, plainPassword, expectedHash });
  drainLegacyUpgradeQueue();
}

function drainLegacyUpgradeQueue() {
  if (legacyUpgradeRunning || !legacyUpgradeQueue.length) return;
  legacyUpgradeRunning = true;
  setImmediate(async () => {
    try {
      const { userId, plainPassword, expectedHash } = legacyUpgradeQueue.shift();
      // 后台升级和前台登录共用全局预算；避免升级在流量高峰额外占满线程池。
      const newHash = await runWithScryptGate(() => hashPasswordAsync(plainPassword));
      // CAS 条件：排队/哈希期间密码可能已被本人或管理员修改，若哈希已不是
      // 登录时读到的旧值则放弃升级，避免把新密码静默还原为旧密码
      const changed = db.prepare(
        'UPDATE users SET password = ? WHERE id = ? AND password = ?'
      ).run(newHash, userId, expectedHash).changes;
      if (!changed) console.warn(`[login] 用户 ${userId} 密码已变更，跳过旧哈希升级`);
    } catch (error) {
      console.error('[login] 旧哈希后台升级失败:', error.message);
    } finally {
      legacyUpgradeRunning = false;
      drainLegacyUpgradeQueue();
    }
  });
}

// 周期性清理 stale key，防止 username spraying 导致 Map 无限增长（内存 DoS）。
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of loginFailures) {
    if (now - state.firstAt >= LOGIN_STALE_MS) loginFailures.delete(key);
  }
  for (const [key, state] of loginIpAttempts) {
    if (now - state.firstAt >= LOGIN_STALE_MS) loginIpAttempts.delete(key);
  }
  for (const [key, state] of passwordAttempts) {
    if (now - state.firstAt >= LOGIN_STALE_MS) passwordAttempts.delete(key);
  }
}, LOGIN_CLEANUP_INTERVAL_MS).unref();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });

    // 超长账号直接拒绝（与失败计数 Map key 限长互为兜底），响应与口令错误一致避免枚举
    if (String(username).length > LOGIN_MAX_USERNAME_LEN) {
      return res.status(401).json({ error: '账号或密码错误' });
    }
    // 超长口令直接拒绝（上限与改密路径一致）：超大输入只放大 scrypt 成本不改变结果，
    // 响应与口令错误一致，避免暴露区分信息。
    if (typeof password !== 'string' || password.length > 1024) {
      return res.status(401).json({ error: '账号或密码错误' });
    }
    if (ipRateLimited(req)) {
      return res.status(429).json({ error: '登录尝试过于频繁，请 1 分钟后再试' });
    }
    const lockWindowMs = peekLocked(req, username);
    if (lockWindowMs) {
      // 按实际命中的维度提示：主维度 (IP+username) 15 分钟 / 辅维度 (username) 5 分钟
      return res.status(429).json({ error: `登录失败次数过多，请 ${Math.round(lockWindowMs / 60000)} 分钟后再试` });
    }

    const trimmedUsername = String(username).trim();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(trimmedUsername);
    // 所有分支都执行两次 scrypt 且总成本恒定；两次运算与后台升级共用同一个全局预算。
    const passwordOk = await verifyLoginPassword(password, user);
    if (!user || !passwordOk) {
      recordFailure(req, trimmedUsername);
      return res.status(401).json({ error: '账号或密码错误' });
    }
    if (user.active !== 1) return res.status(403).json({ error: '该账号已被停用，请联系管理员' });

    clearFailures(req, trimmedUsername);
    auth.cleanupSessions();
    const { token, expires } = auth.createSession(user.id);
    auth.setAuthCookie(res, token, expires);
    // 会话令牌只经 HttpOnly Cookie 下发，不放进 JS 可读的响应体（安全评审 M2）：
    // 避免 XSS/恶意扩展/前端错误上报把长效令牌带出浏览器；需要令牌的回归测试
    // 改从 Set-Cookie 解析，前端本就完全依赖 Cookie。
    // 曾存在 x-return-token: 1/true/yes 时随响应体回传令牌的豁免（安全评审 S1）：
    // 无环境约束、生产同样生效，等于给 M2 留了一条「日后加宽松 CORS 即整体绕过」
    // 的后门，且全仓库无调用方——已移除。非浏览器 CLI/API 客户端请改用
    // x-auth-token 头（auth.js 原生支持）。
    const body = {
      user: { id: user.id, username: user.username, name: user.name, role: user.role, dept: user.dept },
    };
    res.json(body);
    // 旧格式哈希（N=16384）登录成功后自动升级为高强度新格式，无需用户改密。
    // 必须放在 res.json 之后异步执行：同步升级（~400ms）会阻塞事件循环，
    // 且让「密码正确」的响应比「密码错误」慢一个升级耗时，形成口令判定 oracle。
    if (isLegacyHash(user.password)) scheduleLegacyUpgrade(user.id, String(password), user.password);
  } catch (error) {
    // 带 status 的错误（如 scrypt 排队超限 429）直接按状态码返回
    if (error && error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.post('/logout', (req, res) => {
  auth.destroySession(req.token);
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  res.json({ user: req.user });
});

function passwordChangeRateLimited(userId) {
  const now = Date.now();
  const state = passwordAttempts.get(userId);
  if (state && now - state.firstAt < PASSWORD_WINDOW_MS && state.count >= PASSWORD_MAX_ATTEMPTS) return true;
  if (!state || now - state.firstAt >= PASSWORD_WINDOW_MS) {
    passwordAttempts.set(userId, { count: 1, firstAt: now });
  } else {
    state.count += 1;
  }
  trimMapToLimit(passwordAttempts);
  return false;
}

router.post('/password', auth.requireLogin, async (req, res, next) => {
  try {
    if (passwordChangeRateLimited(req.user.id)) {
      return res.status(429).json({ error: '改密尝试过于频繁，请 1 分钟后再试' });
    }
    const { oldPassword, newPassword } = req.body || {};
    const passwordError = validatePassword(newPassword);
    if (passwordError) return res.status(400).json({ error: passwordError });
    const row = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    // session 仍有效但用户已被删除 → 销毁 session 让用户重新登录，避免后续 handler 出现 TypeError
    if (!row) {
      auth.destroyUserSessions(req.user.id);
      auth.clearAuthCookie(res);
      return res.status(401).json({ error: '账号已不存在，请重新登录' });
    }
    // 旧密码长度封顶：超长输入只增加成本不改变结果，直接拒绝。
    if (typeof oldPassword !== 'string' || oldPassword.length > 1024) {
      return res.status(400).json({ error: '原密码不正确' });
    }
    // 旧密码校验与新哈希计算都必须进入全局 scrypt 预算，防止绕过闸门打满线程池。
    // 同步 hashPassword 会阻塞事件循环（单次约 370ms），请求路径一律走异步版。
    const ok = await runWithScryptGate(() => verifyPasswordAsync(oldPassword, row.password));
    if (!ok) return res.status(400).json({ error: '原密码不正确' });
    const newHash = await runWithScryptGate(() => hashPasswordAsync(newPassword));
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(newHash, req.user.id);
    auth.destroyUserSessions(req.user.id);
    auth.clearAuthCookie(res);
    res.json({ ok: true, relogin: true });
  } catch (error) {
    // 带 status 的错误（如 scrypt 排队超限 429）直接按状态码返回
    if (error && error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

// 仅供隔离回归测试观察调度状态；不经 HTTP 暴露，也不参与业务逻辑。
router.__test = {
  getScryptGateState,
  resetScryptGateMetrics,
  runWithScryptGate,
  verifyLoginPassword,
  scheduleLegacyUpgrade,
};

module.exports = router;
