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
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/* ---------------- 附件上传配置 ---------------- */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 16);
    cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

// 附件白名单：扩展名 + MIME 双重校验，避免 SVG(<script>)、.lnk/.exe 钓鱼/可执行附件
const ALLOWED_FILE_EXT = new Set(['.txt', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.json', '.csv', '.md']);
const ALLOWED_FILE_MIME = new Set([
  'text/plain', 'text/csv', 'text/markdown', 'application/pdf', 'application/json',
  'application/zip', 'application/x-zip-compressed',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  if (!ALLOWED_FILE_EXT.has(ext) || !ALLOWED_FILE_MIME.has(mime)) {
    const err = new Error(`不支持的附件类型（${ext || mime || '未知'}）`);
    // 自定义 code 加项目前缀，避免与 multer 内置 code 冲突，也避免被业务层误用
    err.code = 'UPLOAD_UNSUPPORTED_TYPE';
    return cb(err);
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 10 },
});

function removeUploadedFiles(files) {
  let firstError = null;
  const uploadRoot = `${path.resolve(UPLOAD_DIR)}${path.sep}`;
  for (const file of files || []) {
    const filePath = path.resolve(file.path || path.join(UPLOAD_DIR, file.filename || ''));
    if (!filePath.startsWith(uploadRoot)) {
      firstError ||= new Error('拒绝清理上传目录之外的文件');
      continue;
    }
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') firstError ||= error;
    }
  }
  if (firstError) throw firstError;
}

function rejectUploadedRequest(req, res, next, status, message) {
  try {
    removeUploadedFiles(req.files);
  } catch (error) {
    return next(error);
  }
  return res.status(status).json({ error: message });
}

function forwardAfterUploadFailure(req, next, error) {
  try {
    removeUploadedFiles(req.files);
  } catch (cleanupError) {
    cleanupError.cause = error;
    return next(cleanupError);
  }
  return next(error);
}

function runInTransaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      rollbackError.cause = error;
      throw rollbackError;
    }
    throw error;
  }
}

function normalizeDueAt(value) {
  if (value === undefined || value === null || value === '') return { valid: true, value: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { valid: false, value: null };
  return { valid: true, value: date.toISOString() };
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) return fallback;
  return Math.min(number, max);
}

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
  const returned = t.status === 'in_progress' && Boolean(t.returned_at);
  const awaitingConfirmation = t.status === 'in_progress' && !returned && Boolean(t.completion_requested_at);
  const overdue =
    t.status === 'in_progress' && !returned && !awaitingConfirmation && t.due_at && new Date(t.due_at).getTime() < Date.now();
  return {
    ...t,
    duration_ms: ms,
    duration_text: ms == null ? '' : humanDuration(ms),
    returned,
    awaiting_confirmation: awaitingConfirmation,
    overdue: !!overdue,
  };
}

/* ---------------- 任务列表 ---------------- */

router.get('/', requireLogin, (req, res) => {
  const { status, assignee_id, creator_id, category, q } = req.query;
  const where = [];
  const args = [];

  // 查询参数不能扩大角色可见范围；管理员的 scopeClause 本身就是全量。
  const sc = scopeClause(req.user);
  where.push(sc.sql);
  args.push(...sc.args);
  if (status === 'pending_confirmation') {
    where.push("t.status = 'in_progress' AND t.returned_at IS NULL AND t.completion_requested_at IS NOT NULL");
  } else if (status === 'returned') {
    where.push("t.status = 'in_progress' AND t.returned_at IS NOT NULL");
  } else if (status === 'in_progress') {
    where.push("t.status = 'in_progress' AND t.returned_at IS NULL");
  } else if (status === 'completed') {
    where.push("t.status = 'completed'");
  }
  if (assignee_id) { where.push('t.assignee_id = ?'); args.push(Number(assignee_id)); }
  if (creator_id)  { where.push('t.creator_id = ?');  args.push(Number(creator_id)); }
  if (category)    { where.push('t.category = ?');    args.push(String(category)); }
  if (q) {
    where.push('(t.title LIKE ? OR t.description LIKE ? OR au.name LIKE ?)');
    const kw = `%${q}%`;
    args.push(kw, kw, kw);
  }

  const limit = boundedInteger(req.query.limit, 200, 1, 500);
  const requestedPage = boundedInteger(req.query.page, 1, 1, 2_147_483_647);
  const offset = req.query.offset === undefined
    ? (requestedPage - 1) * limit
    : boundedInteger(req.query.offset, 0, 0, 2_147_483_647);
  const total = Number(db.prepare(
    `SELECT COUNT(*) AS count
       FROM tasks t
       JOIN users cu ON cu.id = t.creator_id
       JOIN users au ON au.id = t.assignee_id
      WHERE ${where.join(' AND ')}`
  ).get(...args).count);

  const sql = `${BASE_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY CASE t.status WHEN 'in_progress' THEN 0 ELSE 1 END,
             CASE WHEN t.returned_at IS NOT NULL AND t.status='in_progress' THEN 0 ELSE 1 END,
             CASE WHEN t.completion_requested_at IS NOT NULL AND t.status='in_progress' THEN 0 ELSE 1 END,
             CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             t.created_at DESC
    LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, limit, offset).map(decorate);
  res.json({
    tasks: rows,
    total,
    pagination: {
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      pages: Math.ceil(total / limit),
      has_more: offset + rows.length < total,
    },
  });
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

router.post('/', requireRole('admin', 'assigner'), upload.array('files', 10), (req, res, next) => {
  const { title, description, category, priority, assignee_id, due_at } = req.body || {};
  if (!title || !String(title).trim()) {
    return rejectUploadedRequest(req, res, next, 400, '请填写任务标题');
  }
  if (!assignee_id) return rejectUploadedRequest(req, res, next, 400, '请指定任务执行人');

  const assignee = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(assignee_id));
  if (!assignee || assignee.active !== 1) {
    return rejectUploadedRequest(req, res, next, 400, '执行人不存在或已停用');
  }
  if (assignee.role !== 'executor') {
    return rejectUploadedRequest(req, res, next, 400, '所选用户不是任务执行者');
  }

  const normalizedDueAt = normalizeDueAt(due_at);
  if (!normalizedDueAt.valid) return rejectUploadedRequest(req, res, next, 400, '截止时间不合法');
  if (normalizedDueAt.value && new Date(normalizedDueAt.value).getTime() <= Date.now()) {
    return rejectUploadedRequest(req, res, next, 400, '要求完成时间必须晚于当前时间');
  }

  const pr = ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal';
  let taskId;
  try {
    taskId = runInTransaction(() => {
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
          normalizedDueAt.value,
          nowISO()
        );

      const id = Number(info.lastInsertRowid);
      const n = saveAttachments(id, req.files, req.user.id, 'task');
      log(id, req.user.id, 'create', `任务已派发给 ${assignee.name}${n ? `，附件 ${n} 个` : ''}`);
      return id;
    });
  } catch (error) {
    return forwardAfterUploadFailure(req, next, error);
  }

  res.status(201).json({ id: taskId });
});

/* ---------------- 执行者提交完成申请 ---------------- */

function authorizeCompletionRequest(req, res, next) {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.assignee_id !== req.user.id || req.user.role !== 'executor') {
    return res.status(403).json({ error: '只有任务执行人可以提交完成申请' });
  }
  if (task.status === 'completed') {
    return res.status(400).json({ error: '该任务已经完成' });
  }
  if (task.completion_requested_at) {
    return res.status(409).json({ error: '该任务已提交完成申请，请等待发布者确认' });
  }
  if (task.returned_at) {
    return res.status(409).json({ error: '该任务已退回，请等待发布者重新派发' });
  }
  req.completionTask = task;
  next();
}

router.post('/:id/completion-request', requireLogin, authorizeCompletionRequest, upload.array('files', 10), (req, res, next) => {
  const id = req.completionTask.id;

  const note = String((req.body && req.body.result_note) || '').trim();
  if (note.length > 2000) {
    // multer 已在前一中间件将附件落盘；业务校验失败时必须一并清理，
    // 否则可借由超长说明反复提交无主文件占满上传目录。
    return rejectUploadedRequest(req, res, next, 400, '完成说明不能超过 2000 个字符');
  }
  const requestedAt = nowISO();
  let attachmentCount;
  try {
    attachmentCount = runInTransaction(() => {
      const count = saveAttachments(id, req.files, req.user.id, 'result');
      const update = db.prepare(
        "UPDATE tasks SET completion_requested_at = ?, completion_request_note = ? WHERE id = ? AND status = 'in_progress' AND completion_requested_at IS NULL"
      ).run(requestedAt, note, id);
      if (update.changes !== 1) {
        const conflict = new Error('该任务状态已变化，请刷新后重试');
        conflict.status = 409;
        throw conflict;
      }
      log(id, req.user.id, 'complete_request', `提交完成申请${count ? `，成果附件 ${count} 个` : ''}`);
      return count;
    });
  } catch (error) {
    return forwardAfterUploadFailure(req, next, error);
  }

  res.json({ ok: true, attachment_count: attachmentCount, requested_at: requestedAt });
});

/* ---------------- 执行者退回任务 ---------------- */

router.post('/:id/return', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (req.user.role !== 'executor' || task.assignee_id !== req.user.id) {
    return res.status(403).json({ error: '只有任务接收者可以退回任务' });
  }
  if (task.status === 'completed') return res.status(400).json({ error: '已完成任务不能退回' });
  if (task.completion_requested_at) {
    return res.status(409).json({ error: '任务正在等待完成确认，不能退回' });
  }
  if (task.returned_at) return res.status(409).json({ error: '该任务已经退回' });

  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: '请填写退回理由' });
  if (reason.length > 1000) return res.status(400).json({ error: '退回理由不能超过 1000 个字符' });

  const returnedAt = nowISO();
  try {
    runInTransaction(() => {
      const update = db.prepare(
        "UPDATE tasks SET returned_at = ?, return_reason = ?, completion_requested_at = NULL, completion_request_note = '' WHERE id = ? AND status = 'in_progress' AND returned_at IS NULL AND completion_requested_at IS NULL"
      ).run(returnedAt, reason, id);
      if (update.changes !== 1) {
        const conflict = new Error('该任务状态已变化，请刷新后重试');
        conflict.status = 409;
        throw conflict;
      }
      log(id, req.user.id, 'return', `退回任务：${reason}`);
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || '退回任务失败' });
  }

  res.json({ ok: true, returned_at: returnedAt });
});

/* ---------------- 编辑任务 ---------------- */

function updateTaskComplete(task, user) {
  if (task.status === 'completed') return { status: 400, body: { error: '该任务已完成' } };
  if (!task.completion_requested_at) return { status: 400, body: { error: '执行人尚未提交完成申请' } };
  const ts = nowISO();
  // 乐观锁：WHERE 条件要求 status 仍为 in_progress 且 completion_requested_at 仍存在，
  // 防止两个并发请求都通过前置校验后都执行 UPDATE，重复写 complete_confirm 日志或丢失 result_note。
  const update = db.prepare(
    "UPDATE tasks SET status='completed', completed_at=?, result_note=?, returned_at=NULL, return_reason='' " +
    "WHERE id=? AND status='in_progress' AND completion_requested_at IS NOT NULL"
  ).run(ts, String(task.completion_request_note || '').trim(), task.id);
  if (update.changes !== 1) {
    return { status: 409, body: { error: '任务状态已变化，请刷新后重试' } };
  }
  const ms = new Date(ts).getTime() - new Date(task.created_at).getTime();
  log(task.id, user.id, 'complete_confirm', `发布者确认完成，耗时 ${humanDuration(ms)}`);
  return { status: 200, body: { ok: true, duration_text: humanDuration(ms) } };
}

function updateTaskReopen(task, user) {
  if (task.returned_at) return { status: 400, body: { error: '请编辑任务后重新派发' } };
  if (task.status === 'in_progress') return { status: 400, body: { error: '该任务已经在执行中' } };
  // 乐观锁：仅允许将 completed 状态重新开启；并发 reopen 双写日志由 changes 守护
  const update = db.prepare(
    "UPDATE tasks SET status='in_progress', completed_at=NULL, result_note='', completion_requested_at=NULL, completion_request_note='', returned_at=NULL, return_reason='' " +
    "WHERE id=? AND status='completed'"
  ).run(task.id);
  if (update.changes !== 1) {
    return { status: 409, body: { error: '任务状态已变化，请刷新后重试' } };
  }
  log(task.id, user.id, 'reopen', '任务被重新开启');
  return { status: 200, body: { ok: true } };
}

function updateTaskDetail(task, user, body) {
  if (task.completion_requested_at) return { status: 409, body: { error: '任务正在等待完成确认，确认后再修改' } };

  const { title, description, category, priority, assignee_id, due_at } = body || {};
  const redispatching = Boolean(task.returned_at);
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
    const normalizedDueAt = normalizeDueAt(due_at);
    if (!normalizedDueAt.valid) return { status: 400, body: { error: '截止时间不合法' } };
    const unchanged = normalizedDueAt.value === task.due_at;
    if (normalizedDueAt.value && (redispatching || !unchanged) && new Date(normalizedDueAt.value).getTime() <= Date.now()) {
      return { status: 400, body: { error: '要求完成时间必须晚于当前时间' } };
    }
    sets.push('due_at = ?'); args.push(normalizedDueAt.value); changes.push('截止时间');
  }
  if (assignee_id !== undefined && Number(assignee_id) !== task.assignee_id) {
    const assignee = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(assignee_id));
    if (!assignee || assignee.role !== 'executor' || assignee.active !== 1) {
      return { status: 400, body: { error: '执行人不合法' } };
    }
    sets.push('assignee_id = ?'); args.push(assignee.id);
    changes.push(`执行人改为 ${assignee.name}`);
  }

  if (!sets.length) return { status: 400, body: { error: '没有需要修改的内容' } };
  if (redispatching) {
    sets.push("status = 'in_progress'", 'completed_at = NULL', "result_note = ''", 'completion_requested_at = NULL', "completion_request_note = ''", 'returned_at = NULL', "return_reason = ''");
  }
  args.push(task.id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  log(task.id, user.id, redispatching ? 'redispatch_edit' : 'update', redispatching
    ? `重新编辑并派发任务，修改了：${changes.join('、')}`
    : `修改了：${changes.join('、')}`);
  return { status: 200, body: { ok: true, redispatched: redispatching } };
}

router.patch('/:id', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const u = req.user;
  const isOwner = u.role === 'admin' || task.creator_id === u.id;
  const { status } = req.body || {};

  /* --- 状态流转 --- */
  if (status !== undefined) {
    if (!['in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ error: '状态不合法' });
    }
    if (status === 'completed') {
      if (!isOwner) return res.status(403).json({ error: '只有任务发布者或管理员可以确认完成' });
      const result = updateTaskComplete(task, u);
      return res.status(result.status).json(result.body);
    }
    // 仅允许重新开启已完成任务；退回任务必须通过编辑后重新派发。
    if (!isOwner) return res.status(403).json({ error: '只有管理员或任务创建者可以重新开启任务' });
    const result = updateTaskReopen(task, u);
    return res.status(result.status).json(result.body);
  }

  /* --- 内容编辑 --- */
  if (!isOwner) return res.status(403).json({ error: '只有管理员或任务创建者可以修改任务内容' });
  const result = updateTaskDetail(task, u, req.body);
  return res.status(result.status).json(result.body);
});

/* ---------------- 追加附件 ---------------- */

function authorizeAttachmentUpload(req, res, next) {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const u = req.user;
  const allowed = u.role === 'admin' || task.creator_id === u.id;
  if (!allowed) {
    const message = task.assignee_id === u.id && u.role === 'executor'
      ? '请在标记完成时上传成果附件'
      : '无权上传附件';
    return res.status(403).json({ error: message });
  }

  req.uploadTask = task;
  next();
}

router.post('/:id/attachments', requireLogin, authorizeAttachmentUpload, upload.array('files', 10), (req, res, next) => {
  const task = req.uploadTask;
  const id = task.id;
  const u = req.user;

  if (!req.files || !req.files.length) return res.status(400).json({ error: '未接收到文件' });

  let n;
  try {
    n = runInTransaction(() => {
      const count = saveAttachments(id, req.files, u.id, 'task');
      log(id, u.id, 'attach', `上传了 ${count} 个附件`);
      return count;
    });
  } catch (error) {
    return forwardAfterUploadFailure(req, next, error);
  }
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
// 供入口错误中间件在 multer 失败时清理已上传到磁盘的临时文件
module.exports.removeUploadedFiles = removeUploadedFiles;
