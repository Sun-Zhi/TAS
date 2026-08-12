'use strict';

const express = require('express');
const { db, hashPassword, nowISO } = require('../db');
const { requireLogin, requireRole, destroyUserSessions } = require('../auth');

const router = express.Router();
const ROLES = ['admin', 'assigner', 'executor'];

/**
 * 用户列表
 * - 管理员：全部用户（含统计）
 * - 其他角色：只返回可选执行者（用于创建任务时指定执行人）
 */
router.get('/', requireLogin, (req, res) => {
  if (req.user.role === 'admin') {
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.name, u.role, u.dept, u.active, u.created_at,
                (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id) AS assigned_count,
                (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status='completed') AS done_count,
                (SELECT COUNT(*) FROM tasks t WHERE t.creator_id  = u.id) AS created_count
         FROM users u ORDER BY
           CASE u.role WHEN 'admin' THEN 0 WHEN 'assigner' THEN 1 ELSE 2 END, u.id`
      )
      .all();
    return res.json({ users: rows });
  }
  const rows = db
    .prepare(
      `SELECT id, username, name, role, dept FROM users
       WHERE role = 'executor' AND active = 1 ORDER BY dept, name`
    )
    .all();
  res.json({ users: rows });
});

/** 执行者下拉（所有登录用户可用，用于筛选/导出） */
router.get('/executors', requireLogin, (req, res) => {
  const rows = db
    .prepare(`SELECT id, username, name, dept FROM users WHERE role='executor' AND active=1 ORDER BY dept, name`)
    .all();
  res.json({ users: rows });
});

/** 执行者岗位分工（所有已登录用户可查看） */
router.get('/responsibilities', requireLogin, (req, res) => {
  const scope = req.user.role === 'admin' ? '' : 'AND active = 1';
  const users = db.prepare(
    `SELECT id, username, name, dept, active, responsibilities
       FROM users WHERE role = 'executor' ${scope}
       ORDER BY active DESC, dept, name`
  ).all();
  res.json({ users });
});

/** 设置执行者岗位职责（仅管理员） */
router.patch('/:id/responsibilities', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role !== 'executor') return res.status(400).json({ error: '只能维护执行者的岗位职责' });

  const responsibilities = String((req.body && req.body.responsibilities) || '').trim();
  if (responsibilities.length > 2000) {
    return res.status(400).json({ error: '岗位职责不能超过 2000 个字符' });
  }
  db.prepare('UPDATE users SET responsibilities = ? WHERE id = ?').run(responsibilities, id);
  res.json({ ok: true });
});

/** 创建用户（仅管理员） */
router.post('/', requireRole('admin'), (req, res) => {
  const { username, password, name, role, dept } = req.body || {};
  if (!username || !password || !name || !role) {
    return res.status(400).json({ error: '账号、密码、姓名、角色均为必填' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ error: '角色不合法' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim());
  if (exists) return res.status(409).json({ error: '该账号已存在' });

  const info = db
    .prepare(
      `INSERT INTO users (username, password, name, role, dept, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    )
    .run(String(username).trim(), hashPassword(password), String(name).trim(), role, dept || '', nowISO());

  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

/** 修改用户（仅管理员） */
router.patch('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const { name, role, dept, active, password } = req.body || {};
  const sets = [];
  const args = [];

  if (name !== undefined) { sets.push('name = ?'); args.push(String(name).trim()); }
  if (dept !== undefined) { sets.push('dept = ?'); args.push(String(dept)); }
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: '角色不合法' });
    if (user.role === 'admin' && role !== 'admin') {
      const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;
      if (admins <= 1) return res.status(400).json({ error: '系统至少需要保留一名管理员' });
    }
    const pending = db.prepare(
      "SELECT COUNT(*) c FROM tasks WHERE assignee_id = ? AND status='in_progress'"
    ).get(id).c;
    if (role !== 'executor' && pending > 0) {
      return res.status(400).json({ error: `该用户尚有 ${pending} 个执行中的任务，无法切换角色` });
    }
    sets.push('role = ?'); args.push(role);
    // 角色变更必须销毁该用户所有旧 session，防止降级账号沿用旧权限
    destroyUserSessions(id);
  }
  if (active !== undefined) {
    const val = active ? 1 : 0;
    if (val === 0 && user.role === 'admin') {
      const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;
      if (admins <= 1) return res.status(400).json({ error: '系统至少需要保留一名启用状态的管理员' });
    }
    sets.push('active = ?'); args.push(val);
  }
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    sets.push('password = ?'); args.push(hashPassword(password));
  }

  if (!sets.length) return res.status(400).json({ error: '没有需要修改的内容' });
  args.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  if (password || active === false || active === 0) destroyUserSessions(id);
  res.json({ ok: true });
});

/** 删除用户（仅管理员，且无关联任务） */
router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除当前登录账号' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const related = db
    .prepare('SELECT COUNT(*) c FROM tasks WHERE assignee_id = ? OR creator_id = ?')
    .get(id, id).c;
  if (related > 0) {
    return res.status(400).json({ error: `该用户关联了 ${related} 个任务，建议改为「停用」而不是删除` });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
