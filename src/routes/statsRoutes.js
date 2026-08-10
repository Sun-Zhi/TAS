'use strict';

const express = require('express');
const { db } = require('../db');
const { requireLogin } = require('../auth');
const { taskDuration, humanDuration, toCSV, fmtLocal, PRIORITY_TEXT, STATUS_TEXT } = require('../utils');
const taskRoutes = require('./taskRoutes');

const router = express.Router();
const { BASE_SELECT, scopeClause, decorate } = taskRoutes;

/* ---------------- 大屏数据 ---------------- */

router.get('/screen', requireLogin, (req, res) => {
  const all = db.prepare(`${BASE_SELECT} ORDER BY t.created_at DESC`).all().map(decorate);

  const running = all.filter((t) => t.status === 'in_progress');
  const done = all.filter((t) => t.status === 'completed');

  const durations = done.map((t) => t.duration_ms).filter((n) => n != null);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const fastest = durations.length ? Math.min(...durations) : null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const doneToday = done.filter((t) => new Date(t.completed_at) >= today).length;
  const createdToday = all.filter((t) => new Date(t.created_at) >= today).length;

  // 执行者维度统计
  const byExecutor = {};
  for (const t of all) {
    const k = t.assignee_id;
    if (!byExecutor[k]) {
      byExecutor[k] = {
        id: k, name: t.assignee_name, dept: t.assignee_dept || '',
        total: 0, running: 0, done: 0, overdue: 0, durations: [],
      };
    }
    const e = byExecutor[k];
    e.total++;
    if (t.status === 'completed') { e.done++; if (t.duration_ms != null) e.durations.push(t.duration_ms); }
    else { e.running++; if (t.overdue) e.overdue++; }
  }
  const executors = Object.values(byExecutor)
    .map((e) => {
      const avgMs = e.durations.length ? e.durations.reduce((a, b) => a + b, 0) / e.durations.length : null;
      return {
        id: e.id, name: e.name, dept: e.dept, total: e.total, running: e.running,
        done: e.done, overdue: e.overdue,
        rate: e.total ? Math.round((e.done / e.total) * 100) : 0,
        avg_duration_text: avgMs == null ? '-' : humanDuration(avgMs),
      };
    })
    .sort((a, b) => b.total - a.total || b.done - a.done);

  // 类别分布
  const catMap = {};
  for (const t of all) {
    catMap[t.category] = catMap[t.category] || { category: t.category, total: 0, done: 0 };
    catMap[t.category].total++;
    if (t.status === 'completed') catMap[t.category].done++;
  }
  const categories = Object.values(catMap).sort((a, b) => b.total - a.total);

  // 近 7 天完成趋势
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    const next = new Date(day.getTime() + 86400_000);
    trend.push({
      date: `${day.getMonth() + 1}/${day.getDate()}`,
      done: done.filter((t) => {
        const d = new Date(t.completed_at);
        return d >= day && d < next;
      }).length,
      created: all.filter((t) => {
        const d = new Date(t.created_at);
        return d >= day && d < next;
      }).length,
    });
  }

  res.json({
    updated_at: new Date().toISOString(),
    summary: {
      total: all.length,
      running: running.length,
      done: done.length,
      overdue: running.filter((t) => t.overdue).length,
      done_today: doneToday,
      created_today: createdToday,
      complete_rate: all.length ? Math.round((done.length / all.length) * 100) : 0,
      avg_duration_text: avg == null ? '-' : humanDuration(avg),
      fastest_duration_text: fastest == null ? '-' : humanDuration(fastest),
    },
    running: running.slice(0, 60),
    done: done.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at)).slice(0, 60),
    executors,
    categories,
    trend,
  });
});

/* ---------------- 个人工作台统计 ---------------- */

router.get('/overview', requireLogin, (req, res) => {
  const sc = scopeClause(req.user);
  const rows = db.prepare(`${BASE_SELECT} WHERE ${sc.sql}`).all(...sc.args).map(decorate);
  const done = rows.filter((t) => t.status === 'completed');
  const durations = done.map((t) => t.duration_ms).filter((n) => n != null);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  res.json({
    total: rows.length,
    running: rows.filter((t) => t.status === 'in_progress').length,
    done: done.length,
    overdue: rows.filter((t) => t.overdue).length,
    avg_duration_text: avg == null ? '-' : humanDuration(avg),
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

  if (status && ['in_progress', 'completed'].includes(status)) { where.push('t.status = ?'); args.push(status); }
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
    STATUS_TEXT[t.status] || t.status,
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
