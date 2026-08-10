'use strict';

const express = require('express');
const { db, verifyPassword, hashPassword } = require('../db');
const auth = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  if (user.active !== 1) return res.status(403).json({ error: '该账号已被停用，请联系管理员' });

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

/** 修改自己的密码 */
router.post('/password', auth.requireLogin, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  const row = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(oldPassword || '', row.password)) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
