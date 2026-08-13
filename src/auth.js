'use strict';

const crypto = require('crypto');
const { db, nowISO } = require('./db');
const { isTruthyEnv } = require('./utils');

const SESSION_DAYS = 7;
const COOKIE_NAME = 'ta_token';

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        // 非法 URI 编码（如 %zz）→ 跳过该 Cookie，避免一个恶意请求头打挂所有请求
      }
    }
  }
  return out;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_DAYS * 86400_000);
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, created.toISOString(), expires.toISOString());
  return { token, expires };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function destroyUserSessions(userId, exceptToken = '') {
  if (exceptToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(userId, exceptToken);
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowISO());
}

/** 解析当前登录用户，挂到 req.user（未登录则为 null） */
function attachUser(req, res, next) {
  req.cookies = parseCookies(req);
  const token = req.cookies[COOKIE_NAME] || req.headers['x-auth-token'] || '';
  req.token = token;
  req.user = null;
  if (token) {
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.name, u.role, u.dept, u.active, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`
      )
      .get(token);
    if (row && row.active === 1 && new Date(row.expires_at) > new Date()) {
      req.user = { id: row.id, username: row.username, name: row.name, role: row.role, dept: row.dept };
    } else if (row) {
      destroySession(token);
      // session 已过期/账号已停用 → 同时清掉客户端 Cookie，避免每次请求都带着死 token 查库
      clearAuthCookie(res);
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '当前角色无权执行该操作' });
    }
    next();
  };
}

/** 是否给登录 Cookie 打 Secure 标记。
 *  默认安全（不打 Secure）—— 局域网 HTTP 部署友好，浏览器才能回传 Cookie。
 *  需要 Secure 时显式开启：
 *    1. SECURE_COOKIES=1/true/yes
 *    2. BASE_URL 以 https:// 开头（说明部署在 HTTPS 反代后）
 *  生产环境未启用 Secure 时进程启动即失败（fail-closed），除非显式设置
 *  ALLOW_INSECURE_COOKIE=1/true/yes 接受明文 Cookie 被窃听的风险；
 *  dev 环境则静默通过。
 */
function isCookieSecure() {
  if (isTruthyEnv(process.env.SECURE_COOKIES)) return true;
  if (/^https:\/\//i.test(process.env.BASE_URL || '')) return true;
  return false;
}

// 生产环境 fail-closed：未启用 Secure Cookie 且未显式放行时拒绝启动，
// 避免明文 Cookie 在 HTTP 链路上被窃听（启动即失败比线上静默降级更安全）。
if (
  process.env.NODE_ENV === 'production' &&
  !isCookieSecure() &&
  !isTruthyEnv(process.env.ALLOW_INSECURE_COOKIE)
) {
  throw new Error(
    '[auth] 生产环境未启用 Secure Cookie，已拒绝启动：' +
    '请设置 SECURE_COOKIES=1，或让 BASE_URL 以 https:// 开头；' +
    '如确需在明文 HTTP 下运行，可显式设置 ALLOW_INSECURE_COOKIE=1 接受风险。'
  );
}

function setAuthCookie(res, token, expires) {
  if (process.env.NODE_ENV === 'production' && !isCookieSecure()) {
    // 能走到这里说明已显式设置 ALLOW_INSECURE_COOKIE=1 放行，仍打一次 warn 提醒风险
    console.warn('[auth] 已通过 ALLOW_INSECURE_COOKIE=1 放行明文 Cookie，生产环境存在被窃听风险');
  }
  const secure = isCookieSecure();
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`
  );
}

function clearAuthCookie(res) {
  const secure = isCookieSecure();
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
  );
}

module.exports = {
  COOKIE_NAME,
  attachUser,
  requireLogin,
  requireRole,
  createSession,
  destroySession,
  destroyUserSessions,
  cleanupSessions,
  setAuthCookie,
  clearAuthCookie,
};
