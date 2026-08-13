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

function buildScreenTaskLists(isExecutor, userId) {
  const userArgs = isExecutor ? [userId] : [];
  const whereUser = isExecutor ? ' AND t.assignee_id = ?' : '';
  const running = db.prepare(`${SCREEN_SELECT}
    WHERE t.status='in_progress' AND t.returned_at IS NULL${whereUser}
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             t.created_at DESC LIMIT 60`).all(...userArgs).map(decorate);
  const done = db.prepare(`${SCREEN_SELECT}
    WHERE t.status='completed'${whereUser}
    ORDER BY t.completed_at DESC LIMIT 60`).all(...userArgs).map(decorate);
  return { running, done };
}

function buildScreenExecutors(isExecutor, userId, nowIso) {
  // 仅统计实际承担过任务的执行者：不显示管理员、发布者，也不显示 0 任务的空记录。
  // executor 访问大屏时仍只保留自己这一行。
  const executorWhere = isExecutor ? ' AND u.id = ?' : '';
  const rows = db.prepare(`
    SELECT u.id, u.name, u.dept, COUNT(t.id) AS total,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NULL THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS returned,
           SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN t.status='in_progress' AND t.returned_at IS NULL AND t.completion_requested_at IS NULL AND t.due_at IS NOT NULL AND t.due_at < ? THEN 1 ELSE 0 END) AS overdue,
           AVG(CASE WHEN t.status='completed' AND t.completed_at IS NOT NULL
                    THEN (julianday(t.completed_at)-julianday(t.created_at))*86400000 END) AS avg_ms
      FROM users u JOIN tasks t ON t.assignee_id = u.id
      WHERE u.role = 'executor'${executorWhere}
     GROUP BY u.id, u.name, u.dept
     ${isExecutor ? '' : 'ORDER BY total DESC, done DESC'}
  `).all(...(isExecutor ? [nowIso, userId] : [nowIso]));
  return rows.map((e) => ({
    id: e.id, name: e.name, dept: e.dept || '', total: Number(e.total),
    running: Number(e.running), returned: Number(e.returned), done: Number(e.done), overdue: Number(e.overdue),
    rate: e.total ? Math.round((Number(e.done) / Number(e.total)) * 100) : 0,
    avg_duration_text: durationText(e.avg_ms),
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
  // 大屏按角色控制可见性：executor 只看自己作为 assignee 的任务明细；
  // admin/assigner 看全公司。聚合数字（summary/categories/trend）对所有角色可见，不含个人隐私。
  const isExecutor = req.user.role === 'executor';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();
  const nowISO = new Date().toISOString();

  const summary = buildScreenSummary(nowISO, todayISO);
  const { running, done } = buildScreenTaskLists(isExecutor, req.user.id);
  const executors = buildScreenExecutors(isExecutor, req.user.id, nowISO);
  const categories = buildScreenCategories();
  const trend = buildScreenTrend();

  res.json({
    updated_at: nowISO,
    summary,
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
