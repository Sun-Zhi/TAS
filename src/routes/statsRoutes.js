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
         au.name AS assignee_name, au.dept AS assignee_dept
  FROM tasks t JOIN users au ON au.id = t.assignee_id
`;

function durationText(ms) {
  return ms == null ? '-' : humanDuration(Math.max(0, Number(ms)));
}

/* ---------------- 大屏数据 ---------------- */

router.get('/screen', requireLogin, (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();
  const now = new Date().toISOString();

  const summaryRow = db.prepare(`
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
  `).get(now, todayISO, todayISO);

  const running = db.prepare(`${SCREEN_SELECT}
    WHERE t.status='in_progress' AND t.returned_at IS NULL
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             t.created_at DESC LIMIT 60`).all().map(decorate);
  const done = db.prepare(`${SCREEN_SELECT}
    WHERE t.status='completed'
    ORDER BY t.completed_at DESC LIMIT 60`).all().map(decorate);

  // 执行者维度统计
  const executors = db.prepare(`
    SELECT u.id, u.name, u.dept, COUNT(t.id) AS total,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NULL THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS returned,
           SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NULL AND t.completion_requested_at IS NULL AND t.due_at IS NOT NULL AND t.due_at < ? THEN 1 ELSE 0 END) AS overdue,
           AVG(CASE WHEN t.status='completed' AND t.completed_at IS NOT NULL
                    THEN (julianday(t.completed_at)-julianday(t.created_at))*86400000 END) AS avg_ms
      FROM users u JOIN tasks t ON t.assignee_id = u.id
     GROUP BY u.id, u.name, u.dept
     ORDER BY total DESC, done DESC
  `).all(now).map((e) => ({
    id: e.id, name: e.name, dept: e.dept || '', total: Number(e.total),
    running: Number(e.running), returned: Number(e.returned), done: Number(e.done), overdue: Number(e.overdue),
    rate: e.total ? Math.round((Number(e.done) / Number(e.total)) * 100) : 0,
    avg_duration_text: durationText(e.avg_ms),
  }));

  // 类别分布
  const categories = db.prepare(`
    SELECT COALESCE(NULLIF(category, ''), '常规任务') AS category,
           COUNT(*) AS total,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS done
      FROM tasks GROUP BY COALESCE(NULLIF(category, ''), '常规任务')
     ORDER BY total DESC
  `).all().map((c) => ({ category: c.category, total: Number(c.total), done: Number(c.done) }));

  // 近 7 天完成趋势
  const dayRanges = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    dayRanges.push({ day, next });
  }
  const since = dayRanges[0].day.toISOString();
  const recent = db.prepare(
    'SELECT created_at, completed_at FROM tasks WHERE created_at >= ? OR completed_at >= ?'
  ).all(since, since);
  const trend = dayRanges.map(({ day, next }) => ({
    date: `${day.getMonth() + 1}/${day.getDate()}`,
    done: recent.filter((t) => t.completed_at && new Date(t.completed_at) >= day && new Date(t.completed_at) < next).length,
    created: recent.filter((t) => new Date(t.created_at) >= day && new Date(t.created_at) < next).length,
  }));

  const total = Number(summaryRow.total || 0);
  const doneCount = Number(summaryRow.done || 0);

  res.json({
    updated_at: new Date().toISOString(),
    summary: {
      total,
      running: Number(summaryRow.running || 0),
      returned: Number(summaryRow.returned || 0),
      done: doneCount,
      overdue: Number(summaryRow.overdue || 0),
      done_today: Number(summaryRow.done_today || 0),
      created_today: Number(summaryRow.created_today || 0),
      complete_rate: total ? Math.round((doneCount / total) * 100) : 0,
      avg_duration_text: durationText(summaryRow.avg_ms),
      fastest_duration_text: durationText(summaryRow.fastest_ms),
    },
    running,
    done,
    executors,
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
  res.json({
    total: Number(row.total || 0),
    running: Number(row.running || 0),
    pending_confirmation: Number(row.pending_confirmation || 0),
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

  // 管理员可导出任意执行者；分配者只能导出自己创建的；执行者只能导出自己的
  if (req.user.role === 'assigner') { where.push('t.creator_id = ?'); args.push(req.user.id); }
  else if (req.user.role === 'executor') { where.push('t.assignee_id = ?'); args.push(req.user.id); }
  else where.push('1=1');

  let who = '全部执行者';
  if (assignee_id) {
    if (req.user.role === 'executor' && Number(assignee_id) !== req.user.id) {
      return res.status(403).send('无权导出其他执行者的任务');
    }
    where.push('t.assignee_id = ?');
    args.push(Number(assignee_id));
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(Number(assignee_id));
    who = u ? u.name : `用户${assignee_id}`;
  } else if (req.user.role === 'executor') {
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
