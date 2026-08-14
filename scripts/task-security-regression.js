/* 聚焦回归：node scripts/task-security-regression.js */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'taskassign-security-'));
process.env.DATA_DIR = path.join(TEST_ROOT, 'data');
process.env.UPLOAD_DIR = path.join(TEST_ROOT, 'uploads');
process.env.ADMIN_PASSWORD = 'security-admin-password';
process.env.ENABLE_DEMO_ACCOUNTS = '0';
const { db, hashPassword, nowISO, UPLOAD_DIR } = require('../src/db');

const PORT = 31377;
const BASE = `http://127.0.0.1:${PORT}`;
const runId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const marker = `task-security-${runId}`;
const createdUserIds = [];
let server;
let pass = 0;
let fail = 0;
let serverOutput = '';

function ok(condition, label, extra = '') {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? `: ${extra}` : ''}`);
  }
}

function uploadNames() {
  return new Set(fs.readdirSync(UPLOAD_DIR));
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function form(fields, filename, contentSuffix) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
  body.append(
    'files',
    new Blob([`${marker}:${contentSuffix}`], { type: 'text/plain' }),
    filename
  );
  return body;
}

async function request(urlPath, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers['x-auth-token'] = token;
  if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const response = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    data: contentType.includes('json') ? await response.json() : await response.text(),
  };
}

function addUser(role, suffix) {
  const info = db.prepare(
    `INSERT INTO users (username, password, name, role, dept, active, created_at)
     VALUES (?, ?, ?, ?, 'security-test', 1, ?)`
  ).run(
    `${marker}_${suffix}`,
    hashPassword('security-test-password'),
    `${marker}_${suffix}`,
    role,
    nowISO()
  );
  const id = Number(info.lastInsertRowid);
  createdUserIds.push(id);
  return id;
}

function addSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, nowISO(), new Date(Date.now() + 3600_000).toISOString());
  return token;
}

function addTask(title, creatorId, assigneeId) {
  const info = db.prepare(
    `INSERT INTO tasks
       (title, description, category, priority, status, creator_id, assignee_id, due_at, created_at)
     VALUES (?, '', 'security-test', 'normal', 'in_progress', ?, ?, NULL, ?)`
  ).run(title, creatorId, assigneeId, nowISO());
  return Number(info.lastInsertRowid);
}

async function waitForServer(token) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null) throw new Error(`测试服务器提前退出\n${serverOutput}`);
    try {
      const response = await request('/api/tasks', { token });
      if (response.status === 200) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`测试服务器启动超时\n${serverOutput}`);
}

function dropRegressionTriggers() {
  db.exec('DROP TRIGGER IF EXISTS task_security_attachment_abort;');
  db.exec('DROP TRIGGER IF EXISTS task_security_log_abort;');
}

function cleanup() {
  dropRegressionTriggers();

  if (createdUserIds.length) {
    const placeholders = createdUserIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM tasks WHERE creator_id IN (${placeholders}) OR assignee_id IN (${placeholders})`)
      .run(...createdUserIds, ...createdUserIds);
    db.prepare(`DELETE FROM sessions WHERE user_id IN (${placeholders})`).run(...createdUserIds);
    db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...createdUserIds);
  }

  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    const filePath = path.join(UPLOAD_DIR, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.size <= 1024 && fs.readFileSync(filePath, 'utf8').startsWith(marker)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // 清理由测试自身创建、且带唯一内容标记的文件；不存在时无需处理。
    }
  }
}

async function main() {
  console.log('\n任务路由安全回归');

  const adminId = addUser('admin', 'admin');
  const assignerAId = addUser('assigner', 'assigner_a');
  const assignerBId = addUser('assigner', 'assigner_b');
  const executorAId = addUser('executor', 'executor_a');
  const executorBId = addUser('executor', 'executor_b');
  const executorCId = addUser('executor', 'executor_c');
  const admin = addSession(adminId);
  const assignerA = addSession(assignerAId);
  const assignerB = addSession(assignerBId);
  const executorA = addSession(executorAId);
  const executorB = addSession(executorBId);
  const executorC = addSession(executorCId);
  const taskA = addTask(`${marker}_task_a`, assignerAId, executorAId);
  const taskB = addTask(`${marker}_task_b`, assignerBId, executorBId);
  const taskC = addTask(`${marker}_task_c`, assignerBId, executorBId);

  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  await waitForServer(admin);

  console.log('\n【1】列表范围');
  const assignerList = await request('/api/tasks?scope=all&status=in_progress', { token: assignerA });
  ok(
    assignerList.status === 200 &&
      assignerList.data.tasks.some((task) => task.id === taskA) &&
      !assignerList.data.tasks.some((task) => task.id === taskB),
    '分配者不能用 scope=all 查看他人任务',
    JSON.stringify(assignerList.data)
  );
  const executorList = await request('/api/tasks?scope=all&status=in_progress', { token: executorA });
  ok(
    executorList.status === 200 &&
      executorList.data.tasks.some((task) => task.id === taskA) &&
      !executorList.data.tasks.some((task) => task.id === taskB),
    '执行者不能用 scope=all 查看他人任务',
    JSON.stringify(executorList.data)
  );
  const adminList = await request('/api/tasks?scope=all', { token: admin });
  ok(
    adminList.status === 200 && [taskA, taskB].every((id) => adminList.data.tasks.some((task) => task.id === id)),
    '管理员仍可查看全量任务'
  );
  const pagedList = await request('/api/tasks?scope=all&status=in_progress&limit=1&page=2', { token: admin });
  ok(
    pagedList.status === 200 && pagedList.data.tasks.length === 1 &&
      pagedList.data.total >= 2 && pagedList.data.pagination.limit === 1 &&
      pagedList.data.pagination.offset === 1 && pagedList.data.pagination.page === 2,
    '列表返回兼容 tasks、总数和 page 分页信息',
    JSON.stringify(pagedList.data)
  );
  const cappedList = await request('/api/tasks?limit=9999', { token: admin });
  ok(
    cappedList.status === 200 && cappedList.data.pagination.limit === 500 && cappedList.data.tasks.length <= 500,
    '列表 limit 上限为 500'
  );

  console.log('\n【2】上传前授权与业务校验清理');
  let before = uploadNames();
  const forbidden = await request(`/api/tasks/${taskB}/attachments`, {
    method: 'POST',
    token: assignerA,
    body: form({}, `${marker}_forbidden.txt`, 'forbidden'),
  });
  ok(forbidden.status === 403, '无关用户追加附件返回 403');
  ok(sameSet(before, uploadNames()), '403 在落盘前拒绝且不留下文件');

  before = uploadNames();
  const executorDetailUpload = await request(`/api/tasks/${taskA}/attachments`, {
    method: 'POST',
    token: executorA,
    body: form({}, `${marker}_executor_detail.txt`, 'executor-detail'),
  });
  ok(executorDetailUpload.status === 403, '任务执行者不能从详情接口追加附件');
  ok(sameSet(before, uploadNames()), '执行者详情上传在落盘前拒绝且不留下文件');

  before = uploadNames();
  const missing = await request('/api/tasks/2147483647/attachments', {
    method: 'POST',
    token: assignerA,
    body: form({}, `${marker}_missing.txt`, 'missing'),
  });
  ok(missing.status === 404, '不存在任务追加附件返回 404');
  ok(sameSet(before, uploadNames()), '404 在落盘前拒绝且不留下文件');

  before = uploadNames();
  const forbiddenCompletion = await request(`/api/tasks/${taskB}/completion-request`, {
    method: 'POST',
    token: executorA,
    body: form({ result_note: '越权完成申请' }, `${marker}_forbidden_completion.txt`, 'forbidden-completion'),
  });
  ok(forbiddenCompletion.status === 403, '非任务执行人不能提交完成申请');
  ok(sameSet(before, uploadNames()), '越权完成申请在落盘前拒绝且不留下文件');

  before = uploadNames();
  const missingTitle = await request('/api/tasks', {
    method: 'POST',
    token: assignerA,
    body: form({ title: '', assignee_id: executorAId }, `${marker}_missing_title.txt`, 'missing-title'),
  });
  ok(missingTitle.status === 400, '缺少标题的创建请求返回 400');
  ok(sameSet(before, uploadNames()), '创建字段校验失败不留下文件');

  before = uploadNames();
  const invalidCreateDate = await request('/api/tasks', {
    method: 'POST',
    token: assignerA,
    body: form(
      { title: `${marker}_invalid_date`, assignee_id: executorAId, due_at: 'not-a-date' },
      `${marker}_invalid_date.txt`,
      'invalid-date'
    ),
  });
  ok(invalidCreateDate.status === 400, '创建任务的无效日期返回 400');
  ok(sameSet(before, uploadNames()), '无效创建日期不留下文件');

  before = uploadNames();
  const pastCreateDate = await request('/api/tasks', {
    method: 'POST',
    token: assignerA,
    body: form(
      { title: `${marker}_past_date`, assignee_id: executorAId, due_at: '2020-01-02T03:04:05Z' },
      `${marker}_past_date.txt`,
      'past-date'
    ),
  });
  ok(pastCreateDate.status === 400, '创建任务的过去截止时间被拒绝');
  ok(sameSet(before, uploadNames()), '过去截止时间不留下文件');

  console.log('\n【3】数据库原子性与失败清理');
  db.exec(`
    CREATE TRIGGER task_security_attachment_abort
    BEFORE INSERT ON attachments
    WHEN NEW.orig_name = '${marker}_metadata_failure.txt'
    BEGIN SELECT RAISE(ABORT, 'security regression attachment failure'); END;
  `);
  before = uploadNames();
  const failedTitle = `${marker}_metadata_failure_task`;
  const failedCreate = await request('/api/tasks', {
    method: 'POST',
    token: assignerA,
    body: form(
      { title: failedTitle, assignee_id: executorAId },
      `${marker}_metadata_failure.txt`,
      'metadata-failure'
    ),
  });
  ok(failedCreate.status === 500, '附件元数据写入失败返回 500');
  ok(!db.prepare('SELECT id FROM tasks WHERE title = ?').get(failedTitle), '附件元数据失败会回滚任务');
  ok(sameSet(before, uploadNames()), '附件元数据失败会清理已落盘文件');
  db.exec('DROP TRIGGER task_security_attachment_abort;');

  db.exec(`
    CREATE TRIGGER task_security_log_abort
    BEFORE INSERT ON task_logs
    WHEN NEW.task_id = ${taskA} AND NEW.action = 'attach'
    BEGIN SELECT RAISE(ABORT, 'security regression log failure'); END;
  `);
  const attachmentCountBefore = Number(
    db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE task_id = ?').get(taskA).count
  );
  before = uploadNames();
  const failedAppend = await request(`/api/tasks/${taskA}/attachments`, {
    method: 'POST',
    token: assignerA,
    body: form({}, `${marker}_log_failure.txt`, 'log-failure'),
  });
  const attachmentCountAfter = Number(
    db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE task_id = ?').get(taskA).count
  );
  ok(failedAppend.status === 500, '附件日志写入失败返回 500');
  ok(attachmentCountAfter === attachmentCountBefore, '日志失败会回滚附件元数据');
  ok(sameSet(before, uploadNames()), '日志失败会清理已落盘文件');
  db.exec('DROP TRIGGER task_security_log_abort;');

  console.log('\n【4】日期与合法上传对照');
  const invalidPatch = await request(`/api/tasks/${taskA}`, {
    method: 'PATCH', token: assignerA, body: { due_at: 'still-not-a-date' },
  });
  ok(invalidPatch.status === 400, '编辑任务的无效日期返回 400');
  ok(db.prepare('SELECT due_at FROM tasks WHERE id = ?').get(taskA).due_at === null, '无效日期不会改写任务');

  const pastPatch = await request(`/api/tasks/${taskA}`, {
    method: 'PATCH', token: assignerA, body: { due_at: '2020-01-02T03:04:05Z' },
  });
  ok(pastPatch.status === 400, '编辑任务不能设置过去的截止时间');
  ok(db.prepare('SELECT due_at FROM tasks WHERE id = ?').get(taskA).due_at === null, '过去截止时间不会改写任务');

  const futureDue = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const validCreate = await request('/api/tasks', {
    method: 'POST',
    token: assignerA,
    body: form(
      { title: `${marker}_valid_create`, assignee_id: executorAId, due_at: futureDue },
      `${marker}_valid_create.txt`,
      'valid-create'
    ),
  });
  ok(validCreate.status === 201, '合法创建任务与附件仍成功', JSON.stringify(validCreate.data));
  const validCreatedTask = validCreate.status === 201
    ? db.prepare('SELECT due_at FROM tasks WHERE id = ?').get(validCreate.data.id)
    : null;
  ok(validCreatedTask && validCreatedTask.due_at === futureDue, '合法截止时间仍规范化保存');

  const validAppend = await request(`/api/tasks/${taskA}/attachments`, {
    method: 'POST',
    token: assignerA,
    body: form({}, `${marker}_valid_append.txt`, 'valid-append'),
  });
  ok(validAppend.status === 200 && validAppend.data.count === 1, '任务发布者仍可追加任务附件');
  const validResult = db.prepare(
    "SELECT kind FROM attachments WHERE task_id = ? AND orig_name = ?"
  ).get(taskA, `${marker}_valid_append.txt`);
  ok(validResult && validResult.kind === 'task', '发布者追加附件仍标记为 task');

  // 为第 6 节构造「退回任务」：需在停用执行者 B 之前由其本人退回（停用会销毁其会话）
  const returnB = await request(`/api/tasks/${taskB}/return`, {
    method: 'POST', token: executorB, body: { reason: `${marker}_return_for_redispatch` },
  });
  ok(returnB.status === 200, '执行者 B 退回任务以构造重新派发场景', JSON.stringify(returnB.data));
  ok(Boolean(db.prepare('SELECT returned_at FROM tasks WHERE id = ?').get(taskB).returned_at), '任务 B 已标记退回');

  console.log('\n【5】LIKE 转义与 active 参数校验');
  const pctTask = addTask(`${marker}_100%真实`, assignerAId, executorAId);
  const pctWild = addTask(`${marker}_100X真实`, assignerAId, executorAId);
  const pctSearch = await request(`/api/tasks?q=${encodeURIComponent('0%')}`, { token: admin });
  ok(pctSearch.status === 200 && pctSearch.data.tasks.some((task) => task.id === pctTask),
    '搜索 0% 匹配字面百分号任务');
  ok(!pctSearch.data.tasks.some((task) => task.id === pctWild),
    '通配符 % 不会被当作任意匹配');
  const usTask = addTask(`${marker}_A_B`, assignerAId, executorAId);
  const usWild = addTask(`${marker}_AXB`, assignerAId, executorAId);
  const usSearch = await request(`/api/tasks?q=${encodeURIComponent('A_B')}`, { token: admin });
  ok(usSearch.status === 200 && usSearch.data.tasks.some((task) => task.id === usTask),
    '搜索 A_B 匹配字面下划线任务');
  ok(!usSearch.data.tasks.some((task) => task.id === usWild),
    '通配符 _ 不会被当作任意匹配');

  const activeNull = await request(`/api/users/${executorBId}`, {
    method: 'PATCH', token: admin, body: { active: null },
  });
  ok(activeNull.status === 400, 'active=null 被显式拒绝');
  const activeEmpty = await request(`/api/users/${executorBId}`, {
    method: 'PATCH', token: admin, body: { active: '' },
  });
  ok(activeEmpty.status === 400, 'active 空串被显式拒绝');
  const activeOff = await request(`/api/users/${executorBId}`, {
    method: 'PATCH', token: admin, body: { active: '0' },
  });
  ok(activeOff.status === 200, "active='0' 可正常停用", JSON.stringify(activeOff.data));
  ok(db.prepare('SELECT active FROM users WHERE id = ?').get(executorBId).active === 0,
    '停用后数据库 active 为 0');

  console.log('\n【6】停用执行人后的任务编辑与重新派发');
  // 执行人已停用但 assignee_id 未变化：仅修改其他字段应允许（前端编辑不会被逼改派）
  const keepAssignee = await request(`/api/tasks/${taskC}`, {
    method: 'PATCH', token: assignerB, body: { title: `${marker}_keep_assignee`, assignee_id: executorBId },
  });
  ok(keepAssignee.status === 200, '执行人已停用时，提交未变化的 assignee_id 仍可编辑其他字段',
    JSON.stringify(keepAssignee.data));
  ok(db.prepare('SELECT assignee_id FROM tasks WHERE id = ?').get(taskC).assignee_id === executorBId,
    '编辑后执行人保持原值不变');

  // 重新派发意味着重新进入执行：即使执行人未变化，也必须仍是启用中的执行者。
  // 否则退回任务可通过 API 保持原 assignee_id 绕过前端重选校验，继续挂在已停用账号上
  const redispatchInactive = await request(`/api/tasks/${taskB}`, {
    method: 'PATCH', token: assignerB, body: { title: `${marker}_redispatch_keep`, assignee_id: executorBId },
  });
  ok(redispatchInactive.status === 400, '退回任务重新派发时保持已停用执行人不变被拒绝',
    JSON.stringify(redispatchInactive.data));
  ok(Boolean(db.prepare('SELECT returned_at FROM tasks WHERE id = ?').get(taskB).returned_at),
    '被拒绝的重新派发不改变退回状态');

  // 对照：重新派发给启用中的执行者 C 应成功并清除退回标记
  const redispatchActive = await request(`/api/tasks/${taskB}`, {
    method: 'PATCH', token: assignerB, body: { title: `${marker}_redispatch_c`, assignee_id: executorCId },
  });
  ok(redispatchActive.status === 200, '重新派发给启用中的执行者成功', JSON.stringify(redispatchActive.data));
  ok(db.prepare('SELECT returned_at FROM tasks WHERE id = ?').get(taskB).returned_at === null,
    '重新派发后清除退回标记');

  // 对照：退回任务保持启用中的执行人不变（新校验分支的放行路径）应成功
  const returnC = await request(`/api/tasks/${taskB}/return`, {
    method: 'POST', token: executorC, body: { reason: `${marker}_return_for_keep_active` },
  });
  ok(returnC.status === 200, '执行者 C 退回任务以构造放行场景', JSON.stringify(returnC.data));
  const redispatchSameActive = await request(`/api/tasks/${taskB}`, {
    method: 'PATCH', token: assignerB, body: { title: `${marker}_redispatch_same_active`, assignee_id: executorCId },
  });
  ok(redispatchSameActive.status === 200, '退回任务保持启用中的执行人不变可重新派发',
    JSON.stringify(redispatchSameActive.data));

  const deactivateA = await request(`/api/users/${executorAId}`, {
    method: 'PATCH', token: admin, body: { active: 0 },
  });
  ok(deactivateA.status === 200, '停用执行者 A 以构造改派场景', JSON.stringify(deactivateA.data));
  const reassignInactive = await request(`/api/tasks/${taskB}`, {
    method: 'PATCH', token: assignerB, body: { assignee_id: executorAId },
  });
  ok(reassignInactive.status === 400, '改派给已停用执行者被拒绝');

  console.log(`\n${'='.repeat(48)}\n  通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(48)}\n`);
  if (fail) throw new Error(`安全回归失败 ${fail} 项`);
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error.message || error);
    if (serverOutput && (!server || server.exitCode !== null)) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once('exit', resolve));
    }
    cleanup();
    db.close();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
})();
