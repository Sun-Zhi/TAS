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

// 任务字段长度上限（POST 创建与 PATCH 编辑共用）
const TASK_TITLE_MAX_LEN = 200;
const TASK_DESCRIPTION_MAX_LEN = 5000;
const TASK_CATEGORY_MAX_LEN = 50;

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

/* ---------------- 按用户滑窗限流 ---------------- */

// 创建任务 / 上传附件按用户滑窗限流：Map + 时间戳数组，防单个用户高频请求
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const TASK_CREATE_MAX_PER_MIN = 60;
const ATTACH_UPLOAD_MAX_PER_MIN = 30;
const RATE_LIMIT_MAX_ENTRIES = 10_000; // 防止恶意多用户 ID 撑爆内存
const rateLimitStates = new Map();

/** 滑窗限流检查：返回 true 表示本次请求应拒绝（限流内每次请求计数 1） */
function userRateLimited(userId, maxPerWindow) {
  const now = Date.now();
  let timestamps = rateLimitStates.get(userId);
  if (!timestamps) {
    timestamps = [];
    rateLimitStates.set(userId, timestamps);
  }
  // 滑窗：先丢弃窗口外的旧时间戳
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
  if (timestamps.length >= maxPerWindow) return true;
  timestamps.push(now);
  // Map 超容量时删除最早插入的 key（Map 迭代顺序即插入顺序）
  if (rateLimitStates.size > RATE_LIMIT_MAX_ENTRIES) {
    const oldestKey = rateLimitStates.keys().next().value;
    if (oldestKey !== undefined) rateLimitStates.delete(oldestKey);
  }
  return false;
}

/** 创建任务限流：同一用户 60 次/分钟 */
function limitTaskCreate(req, res, next) {
  if (userRateLimited(req.user.id, TASK_CREATE_MAX_PER_MIN)) {
    return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  }
  next();
}

/** 上传附件限流：同一用户 30 次/分钟 */
function limitAttachmentUpload(req, res, next) {
  if (userRateLimited(req.user.id, ATTACH_UPLOAD_MAX_PER_MIN)) {
    return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  }
  next();
}

// 周期性清理长时间无活动的限流状态，防止 Map 无限增长（内存 DoS）
setInterval(() => {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  for (const [userId, timestamps] of rateLimitStates) {
    while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
    if (!timestamps.length) rateLimitStates.delete(userId);
  }
}, 5 * 60 * 1000).unref();

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
      // 有意使用同步删除：该函数仅在请求失败清理时调用（同步上下文），
      // 文件数少（≤10 个/请求）且需在下一次请求处理前确认已删除，避免残留。
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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
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
  return {
    sql: '(t.creator_id = ? OR t.assignee_id = ?)',
    args: [user.id, user.id],
  };
}

/** 执行者发布时可选择执行者或分配者；管理员和原分配者保持只能选择执行者。 */
function canReceiveTask(publisherRole, assigneeRole) {
  return assigneeRole === 'executor' || (publisherRole === 'executor' && assigneeRole === 'assigner');
}

function isTaskRecipientRole(role) {
  return role === 'executor' || role === 'assigner';
}

function isTaskRecipient(user, task) {
  return task.assignee_id === user.id && isTaskRecipientRole(user.role);
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
    // 转义 LIKE 通配符，避免用户输入 %/_ 变成任意匹配符；ESCAPE '\' 指定转义字符
    const escaped = String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`);
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR au.name LIKE ? ESCAPE '\\')");
    const kw = `%${escaped}%`;
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

/** 编辑候选按任务创建者的当前发布规则生成，管理员代维护也不能扩大或缩小该任务范围。 */
router.get('/:id/assignees', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT creator_id, assignee_id FROM tasks WHERE id = ?').get(id);
  const canEdit = task && (req.user.role === 'admin' || task.creator_id === req.user.id);
  if (!canEdit) return res.status(404).json({ error: '任务不存在' });

  const creator = db.prepare('SELECT role FROM users WHERE id = ?').get(task.creator_id);
  if (!creator) return res.status(409).json({ error: '任务创建者不存在，无法生成改派候选' });
  const roles = creator.role === 'executor' ? ['executor', 'assigner'] : ['executor'];
  const placeholders = roles.map(() => '?').join(', ');
  const users = db.prepare(`
    SELECT id, name, role, dept
    FROM users
    WHERE active = 1 AND id <> ?
      AND (role IN (${placeholders}) OR (id = ? AND role IN ('executor', 'assigner')))
    ORDER BY CASE role WHEN 'executor' THEN 0 ELSE 1 END, dept, name
  `).all(task.creator_id, ...roles, task.assignee_id);
  res.json({ users });
});
router.get('/:id', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare(`${BASE_SELECT} WHERE t.id = ?`).get(id);

  const u = req.user;
  // 任务不存在与无权查看统一返回 404，避免通过响应码枚举任务 ID 存在性
  const visible =
    !!task && (u.role === 'admin' || task.creator_id === u.id || task.assignee_id === u.id);
  if (!visible) return res.status(404).json({ error: '任务不存在' });

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

router.post('/', requireRole('admin', 'assigner', 'executor'), limitTaskCreate, upload.array('files', 10), (req, res, next) => {
  const { title, description, category, priority, assignee_id, due_at } = req.body || {};
  if (!title || !String(title).trim()) {
    return rejectUploadedRequest(req, res, next, 400, '请填写任务标题');
  }
  // 字段长度上限校验
  if (String(title).length > TASK_TITLE_MAX_LEN) {
    return rejectUploadedRequest(req, res, next, 400, `任务标题不能超过 ${TASK_TITLE_MAX_LEN} 个字符`);
  }
  if (String(description || '').length > TASK_DESCRIPTION_MAX_LEN) {
    return rejectUploadedRequest(req, res, next, 400, `任务描述不能超过 ${TASK_DESCRIPTION_MAX_LEN} 个字符`);
  }
  if (String(category || '').length > TASK_CATEGORY_MAX_LEN) {
    return rejectUploadedRequest(req, res, next, 400, `任务类别不能超过 ${TASK_CATEGORY_MAX_LEN} 个字符`);
  }
  if (!assignee_id) return rejectUploadedRequest(req, res, next, 400, '请指定任务接收人');

  const normalizedDueAt = normalizeDueAt(due_at);
  if (!normalizedDueAt.valid) return rejectUploadedRequest(req, res, next, 400, '截止时间不合法');
  if (normalizedDueAt.value && new Date(normalizedDueAt.value).getTime() <= Date.now()) {
    return rejectUploadedRequest(req, res, next, 400, '要求完成时间必须晚于当前时间');
  }

  const pr = ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal';
  let taskId;
  try {
    taskId = runInTransaction(() => {
      // multer 处理附件期间角色、启用状态或接收人可能变化；写入前在同一事务内重新读取，
      // 使权限校验与任务创建以一个明确时点生效，避免继续使用请求开始时的用户快照。
      const publisher = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(req.user.id);
      if (!publisher || publisher.active !== 1 || !['admin', 'assigner', 'executor'].includes(publisher.role)) {
        throw httpError(403, '发布者账号或权限已变化，请重新登录后重试');
      }
      const assignee = db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').get(Number(assignee_id));
      if (!assignee || assignee.active !== 1) {
        throw httpError(400, '任务接收人不存在或已停用');
      }
      if (assignee.id === publisher.id) {
        throw httpError(400, '不能将任务派发给自己');
      }
      if (!canReceiveTask(publisher.role, assignee.role)) {
        const roleChangedDuringRequest = publisher.role !== req.user.role;
        throw httpError(
          roleChangedDuringRequest ? 409 : 400,
          roleChangedDuringRequest ? '发布者权限已变化，请刷新后重试' : '所选用户不能接收此任务'
        );
      }

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
          publisher.id,
          assignee.id,
          normalizedDueAt.value,
          nowISO()
        );

      const id = Number(info.lastInsertRowid);
      const n = saveAttachments(id, req.files, publisher.id, 'task');
      log(id, publisher.id, 'create', `任务已派发给 ${assignee.name}${n ? `，附件 ${n} 个` : ''}`);
      return id;
    });
  } catch (error) {
    if (error && error.status >= 400 && error.status < 500) {
      return rejectUploadedRequest(req, res, next, error.status, error.message);
    }
    return forwardAfterUploadFailure(req, next, error);
  }

  res.status(201).json({ id: taskId });
});

/* ---------------- 任务接收人提交完成申请 ---------------- */

function authorizeCompletionRequest(req, res, next) {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!isTaskRecipient(req.user, task)) {
    return res.status(403).json({ error: '只有任务接收人可以提交完成申请' });
  }
  if (task.creator_id === task.assignee_id) {
    return res.status(409).json({ error: '创建者不能作为同一任务的接收人，请先重新指派' });
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
      // 上传可能持续较久；最终写入前重新读取账号和任务，防止上传期间的停用、改角色、
      // 改派、退回或自指派旧数据继续沿用授权阶段的快照。
      const currentUser = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(req.user.id);
      const currentTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!currentUser || currentUser.active !== 1) {
        throw httpError(409, '账号状态已变化，请重新登录后重试');
      }
      if (!currentTask) {
        throw httpError(409, '任务已不存在，请刷新后重试');
      }
      if (!isTaskRecipient(currentUser, currentTask)) {
        throw httpError(409, '任务接收人已变化，请刷新后重试');
      }
      if (currentTask.creator_id === currentTask.assignee_id) {
        throw httpError(409, '创建者不能作为同一任务的接收人，请先重新指派');
      }
      if (currentTask.status !== 'in_progress' || currentTask.returned_at || currentTask.completion_requested_at) {
        throw httpError(409, '该任务状态已变化，请刷新后重试');
      }

      const count = saveAttachments(id, req.files, currentUser.id, 'result');
      const update = db.prepare(
        "UPDATE tasks SET completion_requested_at = ?, completion_request_note = ? " +
        "WHERE id = ? AND status = 'in_progress' AND completion_requested_at IS NULL " +
        "AND returned_at IS NULL AND assignee_id = ? AND creator_id <> assignee_id"
      ).run(requestedAt, note, id, currentUser.id);
      if (update.changes !== 1) {
        throw httpError(409, '该任务状态已变化，请刷新后重试');
      }
      log(id, currentUser.id, 'complete_request', `提交完成申请${count ? `，成果附件 ${count} 个` : ''}`);
      return count;
    });
  } catch (error) {
    if (error && error.status >= 400 && error.status < 500) {
      return rejectUploadedRequest(req, res, next, error.status, error.message);
    }
    return forwardAfterUploadFailure(req, next, error);
  }

  res.json({ ok: true, attachment_count: attachmentCount, requested_at: requestedAt });
});

/* ---------------- 任务接收人退回任务 ---------------- */

router.post('/:id/return', requireLogin, (req, res, next) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!isTaskRecipient(req.user, task)) {
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
    // 带 status 的业务错误（如事务内 409 冲突）按原状态码返回；其余交给全局错误中间件统一处理（5xx 遮蔽）
    if (error && error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }

  res.json({ ok: true, returned_at: returnedAt });
});

/* ---------------- 编辑任务 ---------------- */

function updateTaskComplete(task, user) {
  if (task.status === 'completed') return { status: 400, body: { error: '该任务已完成' } };
  if (task.creator_id === task.assignee_id) {
    return { status: 409, body: { error: '创建者不能确认自己接收的任务，请先重新指派' } };
  }
  if (!task.completion_requested_at) return { status: 400, body: { error: '任务接收人尚未提交完成申请' } };
  const ts = nowISO();
  return runInTransaction(() => {
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
  });
}

function updateTaskReopen(task, user) {
  if (task.returned_at) return { status: 400, body: { error: '请编辑任务后重新派发' } };
  if (task.status === 'in_progress') return { status: 400, body: { error: '该任务已经在执行中' } };
  return runInTransaction(() => {
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
  });
}
function updateTaskDetail(task, user, body) {
  const { title, description, category, priority, assignee_id, due_at } = body || {};
  const repairingSelfAssignment = Boolean(
    task.completion_requested_at &&
    task.creator_id === task.assignee_id &&
    assignee_id !== undefined &&
    Number(assignee_id) !== task.assignee_id
  );
  if (task.completion_requested_at && !repairingSelfAssignment) {
    return { status: 409, body: { error: '任务正在等待完成确认，确认后再修改' } };
  }
  const redispatching = Boolean(task.returned_at);
  // 管理员代为维护时沿用任务创建者的接收人范围，避免把执行者发布给分配者的任务改坏。
  const creator = task.creator_id === user.id
    ? user
    : db.prepare('SELECT role FROM users WHERE id = ?').get(task.creator_id);
  const publisherRole = creator ? creator.role : user.role;


  // 长度校验：PATCH 语义下仅当字段存在（!== undefined）时才校验
  if (title !== undefined && String(title).length > TASK_TITLE_MAX_LEN) {
    return { status: 400, body: { error: `任务标题不能超过 ${TASK_TITLE_MAX_LEN} 个字符` } };
  }
  if (description !== undefined && String(description).length > TASK_DESCRIPTION_MAX_LEN) {
    return { status: 400, body: { error: `任务描述不能超过 ${TASK_DESCRIPTION_MAX_LEN} 个字符` } };
  }
  if (category !== undefined && String(category).length > TASK_CATEGORY_MAX_LEN) {
    return { status: 400, body: { error: `任务类别不能超过 ${TASK_CATEGORY_MAX_LEN} 个字符` } };
  }
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
    if (assignee && assignee.id === task.creator_id) {
      return { status: 400, body: { error: '不能将任务派发给创建者本人' } };
    }
    if (!assignee || !canReceiveTask(publisherRole, assignee.role) || assignee.active !== 1) {
      return { status: 400, body: { error: '任务接收人不合法' } };
    }
    sets.push('assignee_id = ?'); args.push(assignee.id);
    changes.push(`任务接收人改为 ${assignee.name}`);
  } else if (redispatching) {
    // 重新派发意味着重新进入执行：即使接收人未变化，也必须仍是启用中的合法接收角色。
    // 只校验变化时的 assignee 会留下缺口——退回任务可通过 API 保持原 assignee_id
    // 不变绕过前端重选校验，继续挂在已停用账号上，服务端需兜底。
    const current = db.prepare('SELECT role, active FROM users WHERE id = ?').get(task.assignee_id);
    if (task.assignee_id === task.creator_id) {
      return { status: 400, body: { error: '不能将任务重新派发给创建者本人' } };
    }
    // 接收人未变化时保留既有合法关系，避免创建者角色变更后让退回任务永久卡死；
    // 若改选其他人，仍由上方 canReceiveTask 按创建者当前角色收紧范围。
    if (!current || !isTaskRecipientRole(current.role) || current.active !== 1) {
      return { status: 400, body: { error: '当前任务接收人不可用，重新派发请改选启用中的任务接收人' } };
    }
  }

  if (repairingSelfAssignment) {
    sets.push('completion_requested_at = NULL', "completion_request_note = ''");
    changes.push('撤销不合法的完成申请');
  }
  if (!sets.length) return { status: 400, body: { error: '没有需要修改的内容' } };
  if (redispatching) {
    sets.push("status = 'in_progress'", 'completed_at = NULL', "result_note = ''", 'completion_requested_at = NULL', "completion_request_note = ''", 'returned_at = NULL', "return_reason = ''");
  }
  args.push(task.id, task.status, task.assignee_id);
  return runInTransaction(() => {
    const completionPredicate = repairingSelfAssignment
      ? 'completion_requested_at IS NOT NULL'
      : 'completion_requested_at IS NULL';
    const returnedPredicate = redispatching ? 'returned_at IS NOT NULL' : 'returned_at IS NULL';
    const update = db.prepare(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND status = ? AND assignee_id = ? ` +
      `AND ${completionPredicate} AND ${returnedPredicate}`
    ).run(...args);
    if (update.changes !== 1) {
      return { status: 409, body: { error: '任务状态已变化，请刷新后重试' } };
    }
    log(task.id, user.id, redispatching ? 'redispatch_edit' : 'update', redispatching
      ? `重新编辑并派发任务，修改了：${changes.join('、')}`
      : `修改了：${changes.join('、')}`);
    return { status: 200, body: { ok: true, redispatched: redispatching || repairingSelfAssignment } };
  });
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
    const message = isTaskRecipient(u, task)
      ? '请在标记完成时上传成果附件'
      : '无权上传附件';
    return res.status(403).json({ error: message });
  }

  req.uploadTask = task;
  next();
}

router.post('/:id/attachments', requireLogin, authorizeAttachmentUpload, limitAttachmentUpload, upload.array('files', 10), (req, res, next) => {
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
  // 清理文件名中的控制字符（0x00-0x1F、0x7F），防止通过 Content-Disposition 注入换行/响应头
  const safeName = String(att.orig_name || 'download')
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? '_' : ch))
    .join('');
  res.download(filePath, safeName);
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
  fs.promises.unlink(path.join(UPLOAD_DIR, att.stored_name)).catch((error) => {
    if (error.code !== 'ENOENT') console.error('[cleanup] 附件文件删除失败', att.stored_name, error.message);
  });
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
  for (const a of atts) {
    fs.promises.unlink(path.join(UPLOAD_DIR, a.stored_name)).catch((error) => {
      if (error.code !== 'ENOENT') console.error('[cleanup] 附件文件删除失败', a.stored_name, error.message);
    });
  }
  res.json({ ok: true });
});

module.exports = router;
module.exports.BASE_SELECT = BASE_SELECT;
module.exports.scopeClause = scopeClause;
module.exports.decorate = decorate;
// 供入口错误中间件在 multer 失败时清理已上传到磁盘的临时文件
module.exports.removeUploadedFiles = removeUploadedFiles;
