'use strict';

const express = require('express');
const { db } = require('../db');
const { requireLogin } = require('../auth');
const { taskDuration, humanDuration, toCSV, fmtLocal, PRIORITY_TEXT, STATUS_TEXT } = require('../utils');
const taskRoutes = require('./taskRoutes');

const router = express.Router();
const { BASE_SELECT, scopeClause, decorate } = taskRoutes;

const SCREEN_SELECT = `
  SELECT t.id, t.title, t.category, t.priority, t.status, t.assignee_id,
         t.due_at, t.created_at, t.completed_at, t.completion_requested_at,
         t.returned_at, t.return_reason,
         au.name AS assignee_name, au.dept AS assignee_dept, au.role AS assignee_role,
         cu.name AS creator_name, cu.role AS creator_role
  FROM tasks t
  JOIN users au ON au.id = t.assignee_id
  JOIN users cu ON cu.id = t.creator_id
`;

function durationText(ms) {
  return ms == null ? '-' : humanDuration(Math.max(0, Number(ms)));
}

/* ---------------- 大屏数据 ---------------- */

function buildScreenSummary(nowIso, todayIso) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status='in_progress' AND returned_at IS NULL THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status='in_progress' AND returned_at IS NOT NULL THEN 1 ELSE 0 END) AS returned,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status='in_progress' AND returned_at IS NULL AND completion_requested_at IS NULL AND due_at IS NOT NULL AND due_at < ? THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN status='completed' AND completed_at >= ? THEN 1 ELSE 0 END) AS done_today,
           SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS created_today,
           AVG(CASE WHEN status='completed' AND completed_at IS NOT NULL
                    THEN (julianday(completed_at)-julianday(created_at))*86400000 END) AS avg_ms,
           MIN(CASE WHEN status='completed' AND completed_at IS NOT NULL
                    THEN (julianday(completed_at)-julianday(created_at))*86400000 END) AS fastest_ms
      FROM tasks
  `).get(nowIso, todayIso, todayIso);
  const total = Number(row.total || 0);
  const done = Number(row.done || 0);
  return {
    total,
    running: Number(row.running || 0),
    returned: Number(row.returned || 0),
    done,
    overdue: Number(row.overdue || 0),
    done_today: Number(row.done_today || 0),
    created_today: Number(row.created_today || 0),
    complete_rate: total ? Math.round((done / total) * 100) : 0,
    avg_duration_text: durationText(row.avg_ms),
    fastest_duration_text: durationText(row.fastest_ms),
  };
}

function buildScreenTaskLists() {
  const running = db.prepare(`${SCREEN_SELECT}
    WHERE t.status='in_progress' AND t.returned_at IS NULL
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             t.created_at DESC LIMIT 60`).all().map(decorate);
  const done = db.prepare(`${SCREEN_SELECT}
    WHERE t.status='completed'
    ORDER BY t.completed_at DESC LIMIT 60`).all().map(decorate);
  return { running, done };
}

function buildScreenRecipients(nowIso) {
  // 按实际任务接收人统计，覆盖管理员、分配者、执行者等所有角色；不显示 0 任务空记录。
  const rows = db.prepare(`
    SELECT u.id, u.name, u.role, u.dept, COUNT(t.id) AS total,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NULL THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS returned,
           SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NULL AND t.completion_requested_at IS NULL AND t.due_at IS NOT NULL AND t.due_at < ? THEN 1 ELSE 0 END) AS overdue,
           AVG(CASE WHEN t.status='completed' AND t.completed_at IS NOT NULL
                    THEN (julianday(t.completed_at)-julianday(t.created_at))*86400000 END) AS avg_ms
      FROM users u JOIN tasks t ON t.assignee_id = u.id
     GROUP BY u.id, u.name, u.role, u.dept
     ORDER BY total DESC, done DESC
  `).all(nowIso);
  return rows.map((recipient) => ({
    id: recipient.id,
    name: recipient.name,
    role: recipient.role,
    dept: recipient.dept || '',
    total: Number(recipient.total),
    running: Number(recipient.running),
    returned: Number(recipient.returned),
    done: Number(recipient.done),
    overdue: Number(recipient.overdue),
    rate: recipient.total ? Math.round((Number(recipient.done) / Number(recipient.total)) * 100) : 0,
    avg_duration_text: durationText(recipient.avg_ms),
  }));
}

function buildScreenCategories() {
  return db.prepare(`
    SELECT COALESCE(NULLIF(category, ''), '常规任务') AS category,
           COUNT(*) AS total,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS done
      FROM tasks GROUP BY COALESCE(NULLIF(category, ''), '常规任务')
     ORDER BY total DESC
  `).all().map((c) => ({ category: c.category, total: Number(c.total), done: Number(c.done) }));
}

function buildScreenTrend() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    days.push(day);
  }
  const since = days[0].toISOString();
  // 直接在 SQL 端按本地自然日聚合，避免把近 7 天的全部时间字段拉进 JS 再逐行过滤
  const createdByDay = new Map(
    db.prepare("SELECT date(created_at, 'localtime') AS day, COUNT(*) AS n FROM tasks WHERE created_at >= ? GROUP BY day")
      .all(since).map((row) => [row.day, Number(row.n)])
  );
  const completedByDay = new Map(
    db.prepare("SELECT date(completed_at, 'localtime') AS day, COUNT(*) AS n FROM tasks WHERE completed_at >= ? GROUP BY day")
      .all(since).map((row) => [row.day, Number(row.n)])
  );
  return days.map((day) => {
    const pad = (n) => String(n).padStart(2, '0');
    const dayKey = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    return {
      date: `${day.getMonth() + 1}/${day.getDate()}`,
      done: completedByDay.get(dayKey) || 0,
      created: createdByDay.get(dayKey) || 0,
    };
  });
}

router.get('/screen', requireLogin, (req, res) => {
  // 大屏是全局监控视图：所有已登录角色看到相同的汇总、任务明细和人员分布。
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();
  const nowISO = new Date().toISOString();

  const summary = buildScreenSummary(nowISO, todayISO);
  const { running, done } = buildScreenTaskLists();
  const recipients = buildScreenRecipients(nowISO);
  const categories = buildScreenCategories();
  const trend = buildScreenTrend();

  res.json({
    updated_at: nowISO,
    summary,
    running,
    done,
    recipients,
    // 保留旧字段，避免既有大屏调用方在缓存刷新期间报错。
    executors: recipients,
    categories,
    trend,
  });
});

/* ---------------- 个人工作台统计 ---------------- */

router.get('/overview', requireLogin, (req, res) => {
  const sc = scopeClause(req.user);
  const now = new Date().toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NULL THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS returned,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NULL AND t.completion_requested_at IS NOT NULL THEN 1 ELSE 0 END) AS pending_confirmation,
           SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NULL AND t.completion_requested_at IS NULL AND t.due_at IS NOT NULL AND t.due_at < ? THEN 1 ELSE 0 END) AS overdue,
           AVG(CASE WHEN t.status='completed' AND t.completed_at IS NOT NULL
                    THEN (julianday(t.completed_at)-julianday(t.created_at))*86400000 END) AS avg_ms
      FROM tasks t WHERE ${sc.sql}
  `).get(now, ...sc.args);
  const pendingToConfirm = req.user.role === 'admin'
    ? Number(row.pending_confirmation || 0)
    : Number(db.prepare(
      `SELECT COUNT(*) AS count FROM tasks t
        WHERE t.creator_id = ? AND t.status='in_progress'
          AND t.returned_at IS NULL AND t.completion_requested_at IS NOT NULL`
    ).get(req.user.id).count);

  res.json({
    total: Number(row.total || 0),
    running: Number(row.running || 0),
    pending_confirmation: Number(row.pending_confirmation || 0),
    pending_confirmation_to_confirm: pendingToConfirm,
    returned: Number(row.returned || 0),
    done: Number(row.done || 0),
    overdue: Number(row.overdue || 0),
    avg_duration_text: durationText(row.avg_ms),
  });
});

/* ---------------- 导出 CSV ---------------- */

router.get('/export', requireLogin, (req, res) => {
  const { assignee_id, status, category } = req.query;
  const where = [];
  const args = [];

  // 与工作台保持同一可见范围，再叠加导出筛选；筛选条件不得扩大角色范围。
  const sc = scopeClause(req.user);
  where.push(sc.sql);
  args.push(...sc.args);

  let who = '全部接收人';
  if (assignee_id) {
    const assigneeId = Number(assignee_id);
    where.push('t.assignee_id = ?');
    args.push(assigneeId);
    // 文件名也必须遵守与导出数据相同的行级范围，不能通过任意用户 ID 查询全局姓名。
    const visibleAssignee = db.prepare(`
      SELECT u.name
      FROM tasks t
      JOIN users u ON u.id = t.assignee_id
      WHERE t.assignee_id = ? AND ${sc.sql}
      LIMIT 1
    `).get(assigneeId, ...sc.args);
    who = visibleAssignee ? visibleAssignee.name : '所选接收人';
  } else if (req.user.role !== 'admin') {
    who = req.user.name;
  }

  if (status === 'returned') where.push("t.status = 'in_progress' AND t.returned_at IS NOT NULL");
  else if (status === 'in_progress') where.push("t.status = 'in_progress' AND t.returned_at IS NULL");
  else if (status === 'completed') where.push("t.status = 'completed'");
  if (category) { where.push('t.category = ?'); args.push(String(category)); }

  const rows = db
    .prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.category, t.created_at DESC`)
    .all(...args)
    .map(decorate);

  const data = rows.map((t) => [
    `T${String(t.id).padStart(4, '0')}`,
    t.title,
    t.category,
    PRIORITY_TEXT[t.priority] || t.priority,
    t.returned ? '已退回' : t.awaiting_confirmation ? '等待发布者确认' : (STATUS_TEXT[t.status] || t.status),
    t.assignee_name,
    t.assignee_username,
    t.assignee_dept || '',
    t.creator_name,
    fmtLocal(t.created_at),
    fmtLocal(t.due_at),
    fmtLocal(t.completed_at),
    t.duration_text || '',
    t.attachment_count,
    (t.description || '').replace(/\r?\n/g, ' '),
    (t.result_note || '').replace(/\r?\n/g, ' '),
  ]);

  const csv = toCSV(data);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `任务清单_${who}_${stamp}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="tasks_${stamp}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.send(csv);
});

module.exports = router;
