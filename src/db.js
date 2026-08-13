'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { isTruthyEnv } = require('./utils');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'));

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
  responsibilities TEXT DEFAULT '',
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
CREATE INDEX IF NOT EXISTS idx_tasks_created  ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed_at);
CREATE INDEX IF NOT EXISTS idx_tasks_due      ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_att_task       ON attachments(task_id);
CREATE INDEX IF NOT EXISTS idx_log_task       ON task_logs(task_id);
`);

// 兼容已部署的旧数据库：完成申请在发布者确认前仍属于执行中状态。
const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name));
if (!taskColumns.has('completion_requested_at')) {
  db.exec('ALTER TABLE tasks ADD COLUMN completion_requested_at TEXT');
}
if (!taskColumns.has('completion_request_note')) {
  db.exec("ALTER TABLE tasks ADD COLUMN completion_request_note TEXT DEFAULT ''");
}
if (!taskColumns.has('returned_at')) {
  db.exec('ALTER TABLE tasks ADD COLUMN returned_at TEXT');
}
if (!taskColumns.has('return_reason')) {
  db.exec("ALTER TABLE tasks ADD COLUMN return_reason TEXT DEFAULT ''");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_completion_request ON tasks(completion_requested_at);');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_returned ON tasks(returned_at);');

// 兼容已部署的旧数据库：为执行者补充可维护的岗位职责说明。
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
if (!userColumns.has('responsibilities')) {
  db.exec("ALTER TABLE users ADD COLUMN responsibilities TEXT DEFAULT ''");
}

/* ---------------- 密码哈希 ---------------- */

// scrypt 高强度参数：N=2^17（128MiB/次运算）远超旧默认值 N=16384，
// 必须显式传 maxmem，否则超过 Node 默认 32MiB 上限会直接抛错。
const SCRYPT_OPTS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
// 旧格式哈希使用的历史参数（Node scrypt 默认值），仅用于校验存量密码
const LEGACY_SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

/**
 * 解析存储的哈希：
 * - 新格式 scrypt$N$r$p$salt$digest（6 段）
 * - 旧格式 scrypt$salt$digest（3 段，按 LEGACY_SCRYPT_OPTS 校验）
 * 解析失败返回 null，调用方视为校验不通过。
 */
function parseStoredHash(stored) {
  const parts = String(stored).split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 3) {
    const [, salt, digest] = parts;
    if (!salt || !digest) return null;
    return { salt, digest, opts: LEGACY_SCRYPT_OPTS, legacy: true };
  }
  if (parts.length === 6) {
    const [, nStr, rStr, pStr, salt, digest] = parts;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    // N 必须是 2 的幂且参数为正整数；maxmem 封顶防止恶意哈希参数拖垮服务
    const paramsValid = Number.isInteger(N) && Number.isInteger(r) && Number.isInteger(p)
      && N >= 2 && (N & (N - 1)) === 0 && r >= 1 && p >= 1;
    if (!paramsValid || !salt || !digest) return null;
    return { salt, digest, opts: { N, r, p, maxmem: 256 * 1024 * 1024 }, legacy: false };
  }
  return null;
}

function formatScryptHash(salt, derived, opts) {
  return `scrypt$${opts.N}$${opts.r}$${opts.p}$${salt}$${derived.toString('hex')}`;
}


function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, 64, SCRYPT_OPTS);
  return formatScryptHash(salt, derived, SCRYPT_OPTS);
}

/** 异步哈希：走 libuv 线程池，用于请求路径之外的密码升级，避免阻塞事件循环 */
function hashPasswordAsync(plain) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(String(plain), salt, 64, SCRYPT_OPTS, (error, derived) => {
      if (error) return reject(error);
      resolve(formatScryptHash(salt, derived, SCRYPT_OPTS));
    });
  });
}

function verifyPassword(plain, stored) {
  try {
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;
    const derived = crypto.scryptSync(String(plain), parsed.salt, 64, parsed.opts).toString('hex');
    const a = Buffer.from(derived, 'hex');
    const b = Buffer.from(parsed.digest, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function verifyPasswordAsync(plain, stored) {
  return new Promise((resolve) => {
    try {
      const parsed = parseStoredHash(stored);
      if (!parsed) return resolve(false);
      crypto.scrypt(String(plain), parsed.salt, 64, parsed.opts, (error, derived) => {
        if (error) return resolve(false);
        const expected = Buffer.from(parsed.digest, 'hex');
        resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
      });
    } catch {
      resolve(false);
    }
  });
}

/** 是否为旧格式哈希（scrypt$salt$digest）：登录成功后应自动升级为高强度新格式 */
function isLegacyHash(stored) {
  const parsed = parseStoredHash(stored);
  return parsed !== null && parsed.legacy;
}

/* ---------------- 初始化种子数据 ---------------- */

function nowISO() {
  return new Date().toISOString();
}

// 初始凭据输出：TTY 环境直接打印；非 TTY（如服务管理器/日志采集环境）先收集，
// 种子完成后写入数据目录下 0600 权限的凭据文件并仅打印路径，
// 避免明文口令长期留存于集中日志。
const pendingCredentialLines = [];
function announceCredentials(line) {
  if (process.stdout.isTTY) { console.warn(line); return; }
  pendingCredentialLines.push(line);
}
function flushCredentialFile() {
  if (!pendingCredentialLines.length) return;
  const file = path.join(DATA_DIR, 'initial-credentials.txt');
  try {
    fs.writeFileSync(file, pendingCredentialLines.join('\n') + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows 上 chmod 可能不生效，忽略 */ }
    console.warn(`[db] 初始凭据已写入 ${file}（权限 0600），登录后请立即修改密码`);
  } catch (error) {
    console.error('[db] 初始凭据写入文件失败，请检查数据目录权限:', error.message);
  }
}

function seed() {
  // 生产环境禁止启用演示账号：5 个公开账号 + 弱口令 = 远程直接登录
  if (isTruthyEnv(process.env.ENABLE_DEMO_ACCOUNTS) && process.env.NODE_ENV === 'production') {
    console.error('[fatal] 演示账号不能在生产环境开启（口令为弱口令 123456）');
    process.exit(1);
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const insert = db.prepare(
    `INSERT INTO users (username, password, name, role, dept, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  );
  const ts = nowISO();
  const configuredAdminPassword = process.env.ADMIN_PASSWORD;
  const adminPassword = configuredAdminPassword || crypto.randomBytes(24).toString('base64url');
  const seeds = [['admin', adminPassword, '系统管理员', 'admin', '信息中心']];
  if (isTruthyEnv(process.env.ENABLE_DEMO_ACCOUNTS)) {
    // 演示账号口令从环境变量读取，未设置时随机生成并一次性输出——避免硬编码弱口令
    const demoPassword = process.env.DEMO_PASSWORD || crypto.randomBytes(12).toString('base64url');
    if (!process.env.DEMO_PASSWORD) {
      announceCredentials(`[db] 演示账号本次启动口令（仅本次显示，请立即记录，重启后失效）：${demoPassword}`);
    }
    seeds.push(
      ['pm01',  demoPassword, '张明（产品）', 'assigner', '产品部'],
      ['pm02',  demoPassword, '李婷（运营）', 'assigner', '运营部'],
      ['dev01', demoPassword, '王强',        'executor', '研发一组'],
      ['dev02', demoPassword, '赵磊',        'executor', '研发二组'],
      ['ops01', demoPassword, '陈静',        'executor', '交付部']
    );
  }
  for (const [username, pwd, name, role, dept] of seeds) {
    insert.run(username, hashPassword(pwd), name, role, dept, ts);
  }
  if (configuredAdminPassword) {
    console.log('[db] 已使用 ADMIN_PASSWORD 初始化管理员账号 admin');
  } else {
    announceCredentials(`[db] 已初始化管理员账号 admin；本次生成的随机密码（仅本次显示，请立即记录）：${adminPassword}`);
  }
  if (seeds.length > 1) console.warn('[db] 已显式启用演示账号（固定演示口令仅适用于本地演示）');
  flushCredentialFile();
}

seed();

// 固定 dummy hash：用于账号不存在时跑一次 scrypt 校验抹平时序差，防止枚举攻击
const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));
// 旧格式 dummy hash：与新格式 DUMMY_HASH 配对，让所有登录路径都执行
// 「真实校验 + 一次固定成本 dummy」共 2 次 scrypt 且总成本恒定，
// 消除跨账号/跨哈希格式的登录延迟差（账号存在性枚举）。
const DUMMY_HASH_LEGACY = (() => {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(crypto.randomBytes(24).toString('hex'), salt, 64, LEGACY_SCRYPT_OPTS);
  return `scrypt$${salt}$${derived.toString('hex')}`;
})();

module.exports = { db, hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync, isLegacyHash, parseStoredHash, nowISO, UPLOAD_DIR, DATA_DIR, ROOT, DUMMY_HASH, DUMMY_HASH_LEGACY };
