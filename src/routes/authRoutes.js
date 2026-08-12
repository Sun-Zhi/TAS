'use strict';

const express = require('express');
const { db, verifyPasswordAsync, hashPassword, DUMMY_HASH } = require('../db');
const auth = require('../auth');

const router = express.Router();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
// 辅维度（username 仅）：阈值高于主维度，锁定窗口更短，防止「5 个不同 IP 各 1 次错误
// 口令就锁死任意账号 15 分钟」的远程 DoS。主维度 (IP+username) 仍能在密码喷洒中拦截。
const LOGIN_USERNAME_MAX_FAILURES = 20;
const LOGIN_USERNAME_LOCK_MS = 5 * 60 * 1000;
const LOGIN_STALE_MS = 30 * 60 * 1000; // 超出窗口的 entry 视为 stale，可清理
const LOGIN_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// 防 password spraying：主维度 (IP+username) 组合 + 辅维度 username 独立
const loginFailures = new Map();

function ipKey(req) {
  return `${req.ip || req.socket.remoteAddress || 'unknown'}`;
}
function usernameKey(username) {
  return `u:${String(username || '').trim().toLowerCase()}`;
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

/** 仅查询锁定状态，不写入 Map（避免查询语义污染统计） */
function peekLocked(req, username) {
  const now = Date.now();
  const ck = loginFailures.get(comboKey(req, username));
  if (ck && now - ck.firstAt < LOGIN_WINDOW_MS && ck.count >= LOGIN_MAX_FAILURES) return true;
  const uk = loginFailures.get(usernameKey(username));
  if (uk && now - uk.firstAt < LOGIN_USERNAME_LOCK_MS && uk.count >= LOGIN_USERNAME_MAX_FAILURES) return true;
  return false;
}

function recordFailure(req, username) {
  failureState(comboKey(req, username)).count += 1;
  failureState(usernameKey(username)).count += 1;
}

function clearFailures(req, username) {
  loginFailures.delete(comboKey(req, username));
  loginFailures.delete(usernameKey(username));
}

// 周期性清理 stale key，防止 username spraying 导致 Map 无限增长（内存 DoS）。
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of loginFailures) {
    if (now - state.firstAt >= LOGIN_STALE_MS) loginFailures.delete(key);
  }
}, LOGIN_CLEANUP_INTERVAL_MS).unref();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });

  if (peekLocked(req, username)) {
    return res.status(429).json({ error: '登录失败次数过多，请 15 分钟后再试' });
  }

  const trimmedUsername = String(username).trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(trimmedUsername);
  // 即使账号不存在也跑一次 dummy hash 校验，让响应时序接近真实失败分支，
  // 防止攻击者通过时序差异批量枚举有效账号。
  const hashToCheck = user ? user.password : DUMMY_HASH;
  const passwordOk = await verifyPasswordAsync(password, hashToCheck);
  if (!user || !passwordOk) {
    recordFailure(req, trimmedUsername);
    return res.status(401).json({ error: '账号或密码错误' });
  }
  if (user.active !== 1) return res.status(403).json({ error: '该账号已被停用，请联系管理员' });

  clearFailures(req, trimmedUsername);
  auth.cleanupSessions();
  const { token, expires } = auth.createSession(user.id);
  auth.setAuthCookie(res, token, expires);
  res.json({
    token,
    user: { id: user.id, username: user.username, name: user.name, role: user.role, dept: user.dept },
  });
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

router.post('/password', auth.requireLogin, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  const row = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
  // session 仍有效但用户已被删除 → 销毁 session 让用户重新登录，避免后续 handler 出现 TypeError
  if (!row) {
    auth.destroyUserSessions(req.user.id);
    auth.clearAuthCookie(res);
    return res.status(401).json({ error: '账号已不存在，请重新登录' });
  }
  const ok = await verifyPasswordAsync(oldPassword || '', row.password);
  if (!ok) return res.status(400).json({ error: '原密码不正确' });
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  auth.destroyUserSessions(req.user.id);
  auth.clearAuthCookie(res);
  res.json({ ok: true, relogin: true });
});

module.exports = router;



module.exports = router;