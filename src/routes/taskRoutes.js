'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { db, nowISO, UPLOAD_DIR } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { taskDuration, humanDuration, toCSV, fmtLocal, PRIORITY_TEXT, STATUS_TEXT } = require('../utils');

const router = express.Router();

/* ---------------- 附件上传配置 ---------------- */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 16);
    cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

/** 修正 multer 中文文件名乱码（busboy 默认按 latin1 解析 header） */
function decodeName(name) {
  if (!name) return 'unnamed';
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch {
    return name;
  }
}

function saveAttachments(taskId, files, uploaderId, kind = 'task') {
  if (!files || !files.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO attachments (task_id, orig_name, stored_name, size, mime, kind, uploader_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const ts = nowISO();
  for (const f of files) {
    stmt.run(taskId, decodeName(f.originalname), f.filename, f.size, f.mimetype || '', kind, uploaderId, ts);
  }
  return files.length;
}

function log(taskId, userId, action, detail = '') {
  db.prepare(
    'INSERT INTO task_logs (task_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(taskId, userId, action, detail, nowISO());
}

/* ---------------- 查询构造 ---------------- */

const BASE_SELECT = `
  SELECT t.*,
         cu.name AS creator_name,  cu.username AS creator_username,
         au.name AS assignee_name, au.username AS assignee_username, au.dept AS assignee_dept,
         (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count
  FROM tasks t
  JOIN users cu ON cu.id = t.creator_id
  JOIN users au ON au.id = t.assignee_id
`;

/** 按角色注入数据可见范围 */
function scopeClause(user) {
  if (user.role === 'admin') return { sql: '1=1', args: [] };
  if (user.role === 'assigner') return { sql: 't.creator_id = ?', args: [user.id] };
  return { sql: 't.assignee_id = ?', args: [user.id] };
}

function decorate(t) {
  const ms = taskDuration(t);
  const overdue =
    t.status === 'in_progress' && t.due_at && new Date(t.due_at).getTime() < Date.now();
  return {
    ...t,
    duration_ms: ms,
    duration_text: ms == null ? '' : humanDuration(ms),
    overdue: !!overdue,
  };
}

/* ---------------- 任务列表 ---------------- */

router.get('/', requireLogin, (req, res) => {
  const { status, assignee_id, creator_id, category, q, scope } = req.query;
  const where = [];
  const args = [];

  // scope=all 供大屏使用：任何登录用户都可看全量（只读展示）
  if (scope !== 'all') {
    const sc = scopeClause(req.user);
    where.push(sc.sql);
    args.push(...sc.args);
  }
  if (status && ['in_progress', 'completed'].includes(status)) {
    where.push('t.status = ?'); args.push(status);
  }
  if (assignee_id) { where.push('t.assignee_id = ?'); args.push(Number(assignee_id)); }
  if (creator_id)  { where.push('t.creator_id = ?');  args.push(Number(creator_id)); }
  if (category)    { where.push('t.category = ?');    args.push(String(category)); }
  if (q) {
    where.push('(t.title LIKE ? OR t.description LIKE ? OR au.name LIKE ?)');
    const kw = `%${q}%`;
    args.push(kw, kw, kw);
  }

  const sql = `${BASE_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY CASE t.status WHEN 'in_progress' THEN 0 ELSE 1 END,
             CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             t.created_at DESC`;
  const rows = db.prepare(sql).all(...args).map(decorate);
  res.json({ tasks: rows });
});

/** 任务类别列表（用于筛选下拉） */
router.get('/categories', requireLogin, (req, res) => {
  const rows = db.prepare("SELECT DISTINCT category FROM tasks WHERE category IS NOT NULL AND category <> '' ORDER BY category").all();
  res.json({ categories: rows.map((r) => r.category) });
});

/* ---------------- 任务详情 ---------------- */

router.get('/:id', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare(`${BASE_SELECT} WHERE t.id = ?`).get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const u = req.user;
  const visible =
    u.role === 'admin' || task.creator_id === u.id || task.assignee_id === u.id;
  if (!visible) return res.status(403).json({ error: '无权查看该任务' });

  const attachments = db
    .prepare('SELECT id, orig_name, size, mime, kind, created_at FROM attachments WHERE task_id = ? ORDER BY id')
    .all(id);
  const logs = db
    .prepare(
      `SELECT l.action, l.detail, l.created_at, u.name AS user_name
       FROM task_logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.task_id = ? ORDER BY l.id`
    )
    .all(id);

  res.json({ task: decorate(task), attachments, logs });
});

/* ---------------- 创建任务 ---------------- */

router.post('/', requireRole('admin', 'assigner'), upload.array('files', 10), (req, res) => {
  const { title, description, category, priority, assignee_id, due_at } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '请填写任务标题' });
  if (!assignee_id) return res.status(400).json({ error: '请指定任务执行人' });

  const assignee = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(assignee_id));
  if (!assignee || assignee.active !== 1) return res.status(400).json({ error: '执行人不存在或已停用' });
  if (assignee.role !== 'executor') return res.status(400).json({ error: '所选用户不是任务执行者' });

  const pr = ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal';
  const info = db
    .prepare(
      `INSERT INTO tasks (title, description, category, priority, status, creator_id, assignee_id, due_at, created_at)
       VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)`
    )
    .run(
      String(title).trim(),
      String(description || '').trim(),
      String(category || '常规任务').trim() || '常规任务',
      pr,
      req.user.id,
      assignee.id,
      due_at ? new Date(due_at).toISOString() : null,
      nowISO()
    );

  const taskId = Number(info.lastInsertRowid);
  const n = saveAttachments(taskId, req.files, req.user.id, 'task');
  log(taskId, req.user.id, 'create', `任务已派发给 ${assignee.name}${n ? `，附件 ${n} 个` : ''}`);

  res.status(201).json({ id: taskId });
});

/* ---------------- 编辑任务 ---------------- */

router.patch('/:id', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const u = req.user;
  const isOwner = u.role === 'admin' || task.creator_id === u.id;
  const isAssignee = task.assignee_id === u.id;

  const { status, result_note } = req.body || {};

  /* --- 状态流转 --- */
  if (status !== undefined) {
    if (!['in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ error: '状态不合法' });
    }
    if (status === 'completed') {
      if (!isAssignee && !isOwner) return res.status(403).json({ error: '只有执行人或任务创建者可以标记完成' });
      if (task.status === 'completed') return res.status(400).json({ error: '该任务已完成' });
      const ts = nowISO();
      db.prepare("UPDATE tasks SET status='completed', completed_at=?, result_note=? WHERE id=?")
        .run(ts, String(result_note || '').trim(), id);
      const ms = new Date(ts).getTime() - new Date(task.created_at).getTime();
      log(id, u.id, 'complete', `标记完成，耗时 ${humanDuration(ms)}`);
      return res.json({ ok: true, duration_text: humanDuration(ms) });
    }
    // 重新打开
    if (!isOwner) return res.status(403).json({ error: '只有管理员或任务创建者可以重新开启任务' });
    db.prepare("UPDATE tasks SET status='in_progress', completed_at=NULL WHERE id=?").run(id);
    log(id, u.id, 'reopen', '任务被重新开启');
    return res.json({ ok: true });
  }

  /* --- 内容编辑 --- */
  if (!isOwner) return res.status(403).json({ error: '只有管理员或任务创建者可以修改任务内容' });

  const { title, description, category, priority, assignee_id, due_at } = req.body || {};
  const sets = [];
  const args = [];
  const changes = [];

  if (title !== undefined && String(title).trim()) { sets.push('title = ?'); args.push(String(title).trim()); changes.push('标题'); }
  if (description !== undefined) { sets.push('description = ?'); args.push(String(description)); changes.push('描述'); }
  if (category !== undefined) { sets.push('category = ?'); args.push(String(category) || '常规任务'); changes.push('类别'); }
  if (priority !== undefined && ['low', 'normal', 'high', 'urgent'].includes(priority)) {
    sets.push('priority = ?'); args.push(priority); changes.push('优先级');
  }
  if (due_at !== undefined) {
    sets.push('due_at = ?'); args.push(due_at ? new Date(due_at).toISOString() : null); changes.push('截止时间');
  }
  if (assignee_id !== undefined && Number(assignee_id) !== task.assignee_id) {
    const assignee = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(assignee_id));
    if (!assignee || assignee.role !== 'executor' || assignee.active !== 1) {
      return res.status(400).json({ error: '执行人不合法' });
    }
    sets.push('assignee_id = ?'); args.push(assignee.id);
    changes.push(`执行人改为 ${assignee.name}`);
  }

  if (!sets.length) return res.status(400).json({ error: '没有需要修改的内容' });
  args.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  log(id, u.id, 'update', `修改了：${changes.join('、')}`);
  res.json({ ok: true });
});

/* ---------------- 追加附件 ---------------- */

router.post('/:id/attachments', requireLogin, upload.array('files', 10), (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const u = req.user;
  const allowed = u.role === 'admin' || task.creator_id === u.id || task.assignee_id === u.id;
  if (!allowed) return res.status(403).json({ error: '无权上传附件' });

  const kind = task.assignee_id === u.id && u.role === 'executor' ? 'result' : 'task';
  const n = saveAttachments(id, req.files, u.id, kind);
  if (!n) return res.status(400).json({ error: '未接收到文件' });
  log(id, u.id, 'attach', `上传了 ${n} 个附件`);
  res.json({ ok: true, count: n });
});

/* ---------------- 附件下载 ---------------- */

router.get('/attachments/:aid/download', requireLogin, (req, res) => {
  const aid = Number(req.params.aid);
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(aid);
  if (!att) return res.status(404).send('附件不存在');

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(att.task_id);
  const u = req.user;
  const allowed = u.role === 'admin' || task.creator_id === u.id || task.assignee_id === u.id;
  if (!allowed) return res.status(403).send('无权下载该附件');

  const filePath = path.join(UPLOAD_DIR, att.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('文件已丢失');
  res.download(filePath, att.orig_name);
});

/** 删除附件 */
router.delete('/attachments/:aid', requireLogin, (req, res) => {
  const aid = Number(req.params.aid);
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(aid);
  if (!att) return res.status(404).json({ error: '附件不存在' });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(att.task_id);
  const u = req.user;
  const allowed = u.role === 'admin' || task.creator_id === u.id || att.uploader_id === u.id;
  if (!allowed) return res.status(403).json({ error: '无权删除该附件' });

  db.prepare('DELETE FROM attachments WHERE id = ?').run(aid);
  fs.promises.unlink(path.join(UPLOAD_DIR, att.stored_name)).catch(() => {});
  log(att.task_id, u.id, 'attach_del', `删除附件 ${att.orig_name}`);
  res.json({ ok: true });
});

/* ---------------- 删除任务 ---------------- */

router.delete('/:id', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (req.user.role !== 'admin' && task.creator_id !== req.user.id) {
    return res.status(403).json({ error: '只有管理员或任务创建者可以删除任务' });
  }
  const atts = db.prepare('SELECT stored_name FROM attachments WHERE task_id = ?').all(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  for (const a of atts) fs.promises.unlink(path.join(UPLOAD_DIR, a.stored_name)).catch(() => {});
  res.json({ ok: true });
});

module.exports = router;
module.exports.BASE_SELECT = BASE_SELECT;
module.exports.scopeClause = scopeClause;
module.exports.decorate = decorate;
