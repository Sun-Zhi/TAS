'use strict';

const express = require('express');
const { db, hashPasswordAsync, nowISO } = require('../db');
const { requireLogin, requireRole, destroyUserSessions } = require('../auth');
const { runWithScryptGate } = require('../scryptGate');
const { validatePassword } = require('../utils');

const router = express.Router();
const ROLES = ['admin', 'assigner', 'executor'];

// 与登录端 LOGIN_MAX_USERNAME_LEN=64 保持一致：超长账号将永远无法登录，创建/修改时必须拒绝
const USERNAME_MAX_LEN = 64;
const NAME_MAX_LEN = 100;
const DEPT_MAX_LEN = 100;

/**
 * 用户列表
 * - 管理员：全部用户（含统计）
 * - 其他角色：只返回可选执行者（用于创建任务时指定执行人）
 */
router.get('/', requireLogin, (req, res) => {
  if (req.user.role === 'admin') {
    // 统计用 JOIN+GROUP BY 一次算完，避免对每个用户执行 3 条 COUNT 子查询（N+1）
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.name, u.role, u.dept, u.active, u.created_at,
                COALESCE(a.assigned_count, 0) AS assigned_count,
                COALESCE(a.done_count, 0) AS done_count,
                COALESCE(c.created_count, 0) AS created_count
         FROM users u
         LEFT JOIN (SELECT assignee_id AS uid, COUNT(*) AS assigned_count,
                           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS done_count
                      FROM tasks GROUP BY assignee_id) a ON a.uid = u.id
         LEFT JOIN (SELECT creator_id AS uid, COUNT(*) AS created_count
                      FROM tasks GROUP BY creator_id) c ON c.uid = u.id
         ORDER BY
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
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { username, password, name, role, dept } = req.body || {};
    if (!username || !password || !name || !role) {
      return res.status(400).json({ error: '账号、密码、姓名、角色均为必填' });
    }
    if (!ROLES.includes(role)) return res.status(400).json({ error: '角色不合法' });
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    // 长度上限与登录端一致，避免超长账号无法登录
    if (String(username).trim().length > USERNAME_MAX_LEN) {
      return res.status(400).json({ error: '登录账号不能超过 64 个字符' });
    }
    if (String(name).trim().length > NAME_MAX_LEN) {
      return res.status(400).json({ error: '姓名不能超过 100 个字符' });
    }
    if (String(dept || '').length > DEPT_MAX_LEN) {
      return res.status(400).json({ error: '部门不能超过 100 个字符' });
    }

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim());
    if (exists) return res.status(409).json({ error: '该账号已存在' });

    // 高成本哈希进入全局 scrypt 闸门，请求路径不用同步哈希阻塞事件循环
    const hash = await runWithScryptGate(() => hashPasswordAsync(password));
    const info = db
      .prepare(
        `INSERT INTO users (username, password, name, role, dept, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(String(username).trim(), hash, String(name).trim(), role, dept || '', nowISO());

    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch (error) {
    // 带 status 的错误（如 scrypt 排队超限 429）直接按状态码返回
    if (error && error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

/** 修改用户（仅管理员） */
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const { name, role, dept, active, password } = req.body || {};
    const sets = [];
    // 角色变更标志：与密码/停用变更统一在全部校验成功后销毁 session，避免校验失败（如 scrypt 429）时误销毁
    let shouldDestroySessions = false;
    const args = [];

    if (name !== undefined) {
      if (String(name).trim().length > NAME_MAX_LEN) {
        return res.status(400).json({ error: '姓名不能超过 100 个字符' });
      }
      sets.push('name = ?'); args.push(String(name).trim());
    }
    if (dept !== undefined) {
      if (String(dept).length > DEPT_MAX_LEN) {
        return res.status(400).json({ error: '部门不能超过 100 个字符' });
      }
      sets.push('dept = ?'); args.push(String(dept));
    }
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
      // 角色变更需销毁该用户所有旧 session，防止降级账号沿用旧权限
      shouldDestroySessions = true;
    }
    let activeValue;
    if (active !== undefined) {
      // 仅接受 0|1|true|false|'0'|'1'：null/空串等异常值必须显式拒绝，
      // 不能被静默归一化为「启用」（静默启用会意外激活停用账号）
      const acceptedActive = [0, 1, true, false, '0', '1'];
      if (!acceptedActive.some((value) => value === active)) {
        return res.status(400).json({ error: 'active 参数不合法，仅接受 0 或 1' });
      }
      activeValue = (active === 0 || active === false || active === '0') ? 0 : 1;
      if (activeValue === 0 && user.role === 'admin') {
        const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;
        if (admins <= 1) return res.status(400).json({ error: '系统至少需要保留一名启用状态的管理员' });
      }
      sets.push('active = ?'); args.push(activeValue);
    }
    if (password) {
      const passwordError = validatePassword(password);
      if (passwordError) return res.status(400).json({ error: passwordError });
      // 高成本哈希进入全局 scrypt 闸门，请求路径不用同步哈希阻塞事件循环
      const hash = await runWithScryptGate(() => hashPasswordAsync(password));
      sets.push('password = ?'); args.push(hash);
    }

    if (!sets.length) return res.status(400).json({ error: '没有需要修改的内容' });
    args.push(id);
    // 角色、密码或停用变更都必须销毁该用户所有旧 session，防止降级账号沿用旧权限；
    // 放在 scrypt 闸门等所有校验成功之后、UPDATE 之前，避免请求失败（如 429）时误销毁 session
    if (shouldDestroySessions || password || activeValue === 0) destroyUserSessions(id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    res.json({ ok: true });
  } catch (error) {
    // 带 status 的错误（如 scrypt 排队超限 429）直接按状态码返回
    if (error && error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
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
