'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL UNIQUE,
  password    TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('admin','assigner','executor')),
  dept        TEXT    DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  description  TEXT    DEFAULT '',
  category     TEXT    DEFAULT '常规任务',
  priority     TEXT    NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status       TEXT    NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  creator_id   INTEGER NOT NULL,
  assignee_id  INTEGER NOT NULL,
  due_at       TEXT,
  created_at   TEXT    NOT NULL,
  completed_at TEXT,
  result_note  TEXT    DEFAULT '',
  FOREIGN KEY (creator_id)  REFERENCES users(id),
  FOREIGN KEY (assignee_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL,
  orig_name   TEXT    NOT NULL,
  stored_name TEXT    NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mime        TEXT    DEFAULT '',
  kind        TEXT    NOT NULL DEFAULT 'task' CHECK (kind IN ('task','result')),
  uploader_id INTEGER,
  created_at  TEXT    NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL,
  user_id    INTEGER,
  action     TEXT    NOT NULL,
  detail     TEXT    DEFAULT '',
  created_at TEXT    NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_creator  ON tasks(creator_id);
CREATE INDEX IF NOT EXISTS idx_att_task       ON attachments(task_id);
CREATE INDEX IF NOT EXISTS idx_log_task       ON task_logs(task_id);
`);

/* ---------------- 密码哈希 ---------------- */

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plain, stored) {
  try {
    const [algo, salt, digest] = String(stored).split('$');
    if (algo !== 'scrypt' || !salt || !digest) return false;
    const derived = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    const a = Buffer.from(derived, 'hex');
    const b = Buffer.from(digest, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* ---------------- 初始化种子数据 ---------------- */

function nowISO() {
  return new Date().toISOString();
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const insert = db.prepare(
    `INSERT INTO users (username, password, name, role, dept, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  );
  const ts = nowISO();
  const seeds = [
    ['admin',   'admin123', '系统管理员', 'admin',    '信息中心'],
    ['pm01',    '123456',   '张明（产品）', 'assigner', '产品部'],
    ['pm02',    '123456',   '李婷（运营）', 'assigner', '运营部'],
    ['dev01',   '123456',   '王强',        'executor', '研发一组'],
    ['dev02',   '123456',   '赵磊',        'executor', '研发二组'],
    ['ops01',   '123456',   '陈静',        'executor', '交付部'],
  ];
  for (const [username, pwd, name, role, dept] of seeds) {
    insert.run(username, hashPassword(pwd), name, role, dept, ts);
  }
  console.log('[db] 已初始化默认账号：admin/admin123，pm01/123456，dev01/123456 ...');
}

seed();

module.exports = { db, hashPassword, verifyPassword, nowISO, UPLOAD_DIR, DATA_DIR, ROOT };
