/* 端到端自测：node scripts/e2e-test.js */
'use strict';
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'taskassign-e2e-'));
// 测试实例凭据，支持环境变量覆盖（TEST_ADMIN_PASSWORD / TEST_DEMO_PASSWORD），
// 默认值仅用于临时测试进程；生产部署请勿沿用
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123';
const DEMO_PASSWORD = process.env.TEST_DEMO_PASSWORD || 'demo1234';
// 端口通过实际探测确定，避免 pid 派生端口被其他进程占用导致测试失败
let PORT;
let BASE;

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 200; port++) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.unref();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`从 ${startPort} 起连续 200 个端口均被占用，无法启动测试服务`);
}
let server;
let serverOutput = '';
let pass = 0;

// 首败即中止：失败后继续跑只会级联出大量误导性结果
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); return; }
  throw new Error(`断言失败：${label}${extra ? `（${extra}）` : ''}`);
}

async function req(path, { method = 'GET', token, body, raw } = {}) {
  const headers = {};
  if (token) headers['x-auth-token'] = token;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, text: await res.text() };
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
}

async function login(username, password) {
  const r = await req('/api/auth/login', { method: 'POST', body: { username, password } });
  if (r.status !== 200) throw new Error(`${username} 登录失败: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATA_DIR: path.join(TEST_ROOT, 'data'),
      UPLOAD_DIR: path.join(TEST_ROOT, 'uploads'),
      ADMIN_PASSWORD,
      ENABLE_DEMO_ACCOUNTS: '1',
      DEMO_PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`测试服务提前退出\n${serverOutput}`);
    try {
      const response = await fetch(`${BASE}/index.html`);
      if (response.ok) return;
    } catch {
      // 服务尚未启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`测试服务启动超时\n${serverOutput}`);
}

async function stopServer() {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
}

(async () => {
  PORT = await findFreePort(32000 + (process.pid % 1000));
  BASE = `http://127.0.0.1:${PORT}`;
  await startServer();
  console.log('\n【1】登录与鉴权');
  const admin = await login('admin', ADMIN_PASSWORD);
  const pm = await login('pm01', DEMO_PASSWORD);
  const dev = await login('dev01', DEMO_PASSWORD);
  ok(admin && pm && dev, '三种角色均可登录');
  const bad = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  ok(bad.status === 401, '错误密码被拒绝');
  const lockStatuses = [];
  for (let i = 0; i < 6; i++) {
    lockStatuses.push((await req('/api/auth/login', {
      method: 'POST', body: { username: 'rate-limit-probe', password: 'wrong' },
    })).status);
  }
  ok(lockStatuses.slice(0, 5).every((status) => status === 401), '前 5 次错误口令正常返回 401');
  ok(lockStatuses[5] === 429, '第 6 次错误口令触发 429 锁定');
  ok((await req('/api/tasks')).status === 401, '未登录访问受保护接口返回 401');

  console.log('\n【2】管理员创建用户');
  const uname = 'exec_' + Date.now().toString().slice(-6);
  const cu = await req('/api/users', {
    method: 'POST', token: admin,
    body: { username: uname, password: DEMO_PASSWORD, name: '测试执行者', role: 'executor', dept: '测试部' },
  });
  ok(cu.status === 201, '管理员创建执行者成功', JSON.stringify(cu.data));
  const newUserId = cu.data.id;
  const cu2 = await req('/api/users', {
    method: 'POST', token: pm,
    body: { username: 'x1', password: DEMO_PASSWORD, name: 'x', role: 'executor' },
  });
  ok(cu2.status === 403, '分配者无权创建用户');
  const weakCreate = await req('/api/users', {
    method: 'POST', token: admin,
    body: { username: 'weak_probe', password: '12345678', name: '弱口令', role: 'executor' },
  });
  ok(weakCreate.status === 400, '管理员创建纯数字弱口令用户被拒绝');
  ok((await req('/api/users', {
    method: 'POST', token: admin,
    body: { username: 'blank_probe', password: '        ', name: '空白', role: 'executor' },
  })).status === 400, '纯空白密码被拒绝');
  ok((await req('/api/auth/login', { method: 'POST', body: { username: uname, password: DEMO_PASSWORD } })).status === 200,
    '新建用户可正常登录');

  const responsibilityView = await req('/api/users/responsibilities', { token: pm });
  ok(responsibilityView.status === 200 && responsibilityView.data.users.some((user) => user.id === newUserId),
    '已登录用户可查看执行者岗位分工');
  const responsibilityForbidden = await req(`/api/users/${newUserId}/responsibilities`, {
    method: 'PATCH', token: pm, body: { responsibilities: '越权修改' },
  });
  ok(responsibilityForbidden.status === 403, '非管理员不能编辑执行者岗位职责');
  const responsibilitySave = await req(`/api/users/${newUserId}/responsibilities`, {
    method: 'PATCH', token: admin, body: { responsibilities: '负责前端功能开发和联调验收' },
  });
  ok(responsibilitySave.status === 200, '管理员可保存执行者岗位职责');
  const responsibilityCheck = await req('/api/users/responsibilities', { token: admin });
  ok(responsibilityCheck.data.users.some((user) => user.id === newUserId && user.responsibilities === '负责前端功能开发和联调验收'),
    '岗位职责可被正确读取');

  const allUsers = (await req('/api/users', { token: admin })).data.users;
  const adminUser = allUsers.find((user) => user.username === 'admin');
  const pmUser = allUsers.find((user) => user.username === 'pm01');
  const devUser = allUsers.find((user) => user.username === 'dev01');
  ok(adminUser && pmUser && devUser, '测试所需的管理员、分配者和执行者账号存在');

  console.log('\n【3】创建任务 + 中文附件上传');
  const fd = new FormData();
  fd.append('title', '首页改版需求评审');
  fd.append('description', '完成新版首页交互稿评审并输出结论');
  fd.append('category', '需求开发');
  fd.append('priority', 'high');
  fd.append('assignee_id', String(newUserId));
  fd.append('files', new Blob(['这是附件正文内容 attachment body'], { type: 'text/plain' }), '需求说明文档.txt');
  const ct = await req('/api/tasks', { method: 'POST', token: pm, body: fd });
  ok(ct.status === 201, '分配者创建任务并上传附件', JSON.stringify(ct.data));
  const taskId = ct.data.id;

  const detail = await req('/api/tasks/' + taskId, { token: pm });
  ok(detail.data.task.title === '首页改版需求评审', '中文标题存储正确', detail.data.task.title);
  ok(detail.data.task.category === '需求开发', '中文类别存储正确');
  ok(detail.data.attachments.length === 1, '附件已关联');
  ok(detail.data.attachments[0].orig_name === '需求说明文档.txt',
    '中文附件名未乱码', detail.data.attachments[0].orig_name);
  const attId = detail.data.attachments[0].id;
  const dl = await req(`/api/tasks/attachments/${attId}/download`, { token: pm, raw: true });
  ok(dl.status === 200 && dl.text.includes('附件正文内容'), '附件可下载且内容正确');

  const noAssignee = await req('/api/tasks', { method: 'POST', token: pm, body: { title: '缺执行人' } });
  ok(noAssignee.status === 400, '未指定执行人被拒绝');
  const executorAssignees = await req('/api/users/task-assignees', { token: dev });
  ok(executorAssignees.status === 200 &&
    executorAssignees.data.users.some((user) => user.role === 'executor') &&
    executorAssignees.data.users.some((user) => user.role === 'assigner') &&
    executorAssignees.data.users.every((user) => user.role !== 'admin') &&
    executorAssignees.data.users.every((user) => user.id !== devUser.id),
    '执行者发布时可选择其他执行者或分配者，但不能选择管理员和自己');
  ok(executorAssignees.data.users.every((user) => user.username === undefined),
    '任务接收人候选接口不返回登录账号');
  const selfCreate = await req('/api/tasks', {
    method: 'POST', token: dev, body: { title: '禁止自派任务', assignee_id: devUser.id },
  });
  ok(selfCreate.status === 400, '执行者不能把任务派发给自己');
  const assignerAssignees = await req('/api/users/task-assignees', { token: pm });
  ok(assignerAssignees.status === 200 && assignerAssignees.data.users.every((user) => user.role === 'executor'),
    '原分配者的任务接收人范围仍只有执行者');

  const devCreate = await req('/api/tasks', {
    method: 'POST', token: dev, body: { title: '执行者派发给执行者', assignee_id: newUserId },
  });
  ok(devCreate.status === 201, '执行者可向执行者发布任务', JSON.stringify(devCreate.data));
  const executorToExecutorTaskId = devCreate.data.id;
  const reassignSelf = await req(`/api/tasks/${executorToExecutorTaskId}`, {
    method: 'PATCH', token: dev, body: { assignee_id: devUser.id },
  });
  ok(reassignSelf.status === 400, '执行者不能把已创建任务改派给自己');
  const adminReassignToCreator = await req(`/api/tasks/${executorToExecutorTaskId}`, {
    method: 'PATCH', token: admin, body: { assignee_id: devUser.id },
  });
  ok(adminReassignToCreator.status === 400, '管理员代维护时也不能把任务改派给创建者本人');
  const devToAssigner = await req('/api/tasks', {
    method: 'POST', token: dev, body: { title: '执行者派发给分配者', assignee_id: pmUser.id },
  });
  ok(devToAssigner.status === 201, '执行者可向分配者发布任务', JSON.stringify(devToAssigner.data));
  const executorToAssignerTaskId = devToAssigner.data.id;
  const assignerToAssigner = await req('/api/tasks', {
    method: 'POST', token: pm, body: { title: '分配者越权派发', assignee_id: pmUser.id },
  });
  ok(assignerToAssigner.status === 400, '原分配者仍不能向分配者发布任务');
  const adminToAssigner = await req('/api/tasks', {
    method: 'POST', token: admin, body: { title: '管理员越权派发', assignee_id: pmUser.id },
  });
  ok(adminToAssigner.status === 400, '管理员原有的接收人范围仍只有执行者');
  const executorToAdmin = await req('/api/tasks', {
    method: 'POST', token: dev, body: { title: '执行者越权派发', assignee_id: adminUser.id },
  });
  ok(executorToAdmin.status === 400, '执行者不能向管理员发布任务');

  const assignerCompletionForm = new FormData();
  assignerCompletionForm.append('result_note', '分配者作为任务接收人完成任务');
  const assignerCompletion = await req(`/api/tasks/${executorToAssignerTaskId}/completion-request`, {
    method: 'POST', token: pm, body: assignerCompletionForm,
  });
  ok(assignerCompletion.status === 200, '分配者作为接收人可提交完成申请');
  const creatorOverviewWaiting = await req('/api/overview', { token: dev });
  ok(creatorOverviewWaiting.data.pending_confirmation_to_confirm === 1, '执行者发布者收到待确认完成通知');
  const recipientOverviewWaiting = await req('/api/overview', { token: pm });
  ok(recipientOverviewWaiting.data.pending_confirmation_to_confirm === 0, '任务接收人不会收到误导性的确认通知');
  const executorConfirmAssigner = await req(`/api/tasks/${executorToAssignerTaskId}`, {
    method: 'PATCH', token: dev, body: { status: 'completed' },
  });
  ok(executorConfirmAssigner.status === 200, '执行者发布者可确认分配者完成的任务');

  console.log('\n【4】数据可见范围');
  const newUserToken = await login(uname, DEMO_PASSWORD);
  const seeAdmin = await req('/api/tasks', { token: admin });
  const seePm = await req('/api/tasks', { token: pm });
  const seeExec = await req('/api/tasks', { token: newUserToken });
  const seeDev = await req('/api/tasks', { token: dev });
  ok(seeAdmin.data.tasks.length >= seePm.data.tasks.length, '管理员可见任务数 >= 分配者');
  ok(seePm.data.tasks.every((task) => task.creator_id === pmUser.id || task.assignee_id === pmUser.id),
    '分配者只能看到自己发布或承接的任务');
  ok(seePm.data.tasks.some((task) => task.id === executorToAssignerTaskId), '分配者可看到执行者派发给自己的任务');
  ok(seeExec.data.tasks.every((task) => task.creator_id === newUserId || task.assignee_id === newUserId),
    '执行者只能看到自己发布或承接的任务');
  ok(seeDev.data.tasks.every((task) => task.creator_id === devUser.id || task.assignee_id === devUser.id),
    '发布任务的执行者没有扩大到其他人的任务');
  ok(seeDev.data.tasks.some((task) => task.id === executorToExecutorTaskId) &&
    seeDev.data.tasks.some((task) => task.id === executorToAssignerTaskId),
    '执行者可持续查看自己向两类角色发布的任务');
  const otherView = await req('/api/tasks/' + taskId, { token: dev });
  ok(otherView.status === 404, '无关执行者查看他人任务详情返回 404（与不存在一致）');

  console.log('\n【5】执行与完成');
  const wrongRequestForm = new FormData();
  wrongRequestForm.append('result_note', '无关人员申请');
  const wrongDone = await req('/api/tasks/' + taskId + '/completion-request', {
    method: 'POST', token: dev, body: wrongRequestForm,
  });
  ok(wrongDone.status === 403, '非执行人无法提交完成申请');
  const executorConfirm = await req('/api/tasks/' + taskId, {
    method: 'PATCH', token: newUserToken, body: { status: 'completed' },
  });
  ok(executorConfirm.status === 403, '执行者不能直接确认任务完成');

  const detailUploadForm = new FormData();
  detailUploadForm.append('files', new Blob(['错误入口附件'], { type: 'text/plain' }), '详情上传.txt');
  const executorDetailUpload = await req('/api/tasks/' + taskId + '/attachments', {
    method: 'POST', token: newUserToken, body: detailUploadForm,
  });
  ok(executorDetailUpload.status === 403, '执行者不能从任务详情追加附件');

  const wrongReturn = await req('/api/tasks/' + taskId + '/return', {
    method: 'POST', token: dev, body: { reason: '越权退回' },
  });
  ok(wrongReturn.status === 403, '非任务接收者不能退回任务');
  const emptyReturn = await req('/api/tasks/' + taskId + '/return', {
    method: 'POST', token: newUserToken, body: { reason: '   ' },
  });
  ok(emptyReturn.status === 400, '退回任务必须填写理由');
  const returned = await req('/api/tasks/' + taskId + '/return', {
    method: 'POST', token: newUserToken, body: { reason: '当前任务要求不完整，请补充验收标准' },
  });
  ok(returned.status === 200, '任务接收者可填写理由并退回任务', JSON.stringify(returned.data));
  const returnedDetail = await req('/api/tasks/' + taskId, { token: pm });
  ok(returnedDetail.data.task.returned && returnedDetail.data.task.return_reason === '当前任务要求不完整，请补充验收标准',
    '发布者可查看已退回状态和退回理由');
  const returnedOverview = await req('/api/overview', { token: pm });
  ok(returnedOverview.data.returned === 1, '发布者统计包含一个已退回任务');
  const returnedList = await req('/api/tasks?status=returned', { token: admin });
  ok(returnedList.data.tasks.some((task) => task.id === taskId), '管理员的已退回筛选包含该任务');
  const blockedCompletionForm = new FormData();
  const blockedCompletion = await req('/api/tasks/' + taskId + '/completion-request', {
    method: 'POST', token: newUserToken, body: blockedCompletionForm,
  });
  ok(blockedCompletion.status === 409, '已退回任务不能提交完成申请');
  const directRedispatch = await req('/api/tasks/' + taskId, {
    method: 'PATCH', token: pm, body: { status: 'in_progress' },
  });
  ok(directRedispatch.status === 400, '退回任务不能跳过编辑直接重新派发');
  const redispatchEdit = await req('/api/tasks/' + taskId, {
    method: 'PATCH', token: pm, body: { description: '已补充验收标准，重新派发给执行者处理' },
  });
  ok(redispatchEdit.status === 200 && redispatchEdit.data.redispatched, '发布者编辑后可重新派发退回任务');
  const redispatchedDetail = await req('/api/tasks/' + taskId, { token: newUserToken });
  ok(!redispatchedDetail.data.task.returned && !redispatchedDetail.data.task.return_reason &&
    redispatchedDetail.data.task.description.includes('已补充验收标准'),
  '重新编辑并派发后清除退回状态和理由');
  ok(redispatchedDetail.data.logs.some((log) => log.action === 'redispatch_edit'),
    '重新编辑并派发记录保留在历史操作中');

  const uploadDir = path.join(TEST_ROOT, 'uploads');
  const uploadsBeforeInvalidCompletion = fs.readdirSync(uploadDir).length;
  const overlongCompletionForm = new FormData();
  overlongCompletionForm.append('result_note', '超'.repeat(2001));
  overlongCompletionForm.append('files', new Blob(['不应保留的成果附件'], { type: 'text/plain' }), '超长说明附件.txt');
  const overlongCompletion = await req('/api/tasks/' + taskId + '/completion-request', {
    method: 'POST', token: newUserToken, body: overlongCompletionForm,
  });
  ok(overlongCompletion.status === 400, '超长完成说明被拒绝');
  ok(fs.readdirSync(uploadDir).length === uploadsBeforeInvalidCompletion,
    '超长完成说明会清理已落盘附件');

  const completionForm = new FormData();
  completionForm.append('result_note', '评审结论已同步至文档');
  completionForm.append('files', new Blob(['最终评审成果'], { type: 'text/plain' }), '评审成果.txt');
  const requestDone = await req('/api/tasks/' + taskId + '/completion-request', {
    method: 'POST', token: newUserToken, body: completionForm,
  });
  ok(requestDone.status === 200, '执行者提交完成申请和成果附件成功', JSON.stringify(requestDone.data));

  const waiting = await req('/api/tasks/' + taskId, { token: pm });
  ok(waiting.data.task.status === 'in_progress' && waiting.data.task.awaiting_confirmation,
    '发布者确认前任务保持执行中并显示待确认');
  ok(waiting.data.task.completion_request_note === '评审结论已同步至文档', '完成说明已保存');
  ok(waiting.data.attachments.some((attachment) => attachment.orig_name === '评审成果.txt' && attachment.kind === 'result'),
    '完成申请附件保存为成果附件');
  const overviewWaiting = await req('/api/overview', { token: pm });
  ok(overviewWaiting.data.pending_confirmation === 1, '发布者收到一个待确认完成通知');
  const pendingList = await req('/api/tasks?status=pending_confirmation', { token: pm });
  ok(pendingList.data.tasks.some((task) => task.id === taskId), '待确认筛选包含完成申请任务');

  const duplicateForm = new FormData();
  const duplicateRequest = await req('/api/tasks/' + taskId + '/completion-request', {
    method: 'POST', token: newUserToken, body: duplicateForm,
  });
  ok(duplicateRequest.status === 409, '重复完成申请被拒绝');

  const done = await req('/api/tasks/' + taskId, {
    method: 'PATCH', token: pm, body: { status: 'completed' },
  });
  ok(done.status === 200, '任务发布者确认完成成功', JSON.stringify(done.data));
  const after = await req('/api/tasks/' + taskId, { token: pm });
  ok(after.data.task.status === 'completed', '状态变为已完成');
  ok(!!after.data.task.completed_at, '记录完成时间');
  ok(!!after.data.task.duration_text, `耗时已计算：${after.data.task.duration_text}`);
  ok(after.data.task.result_note === '评审结论已同步至文档', '确认后完成说明写入任务结果');
  ok(after.data.logs.length >= 3, '完成申请和确认日志已记录');

  const reopen = await req('/api/tasks/' + taskId, { method: 'PATCH', token: pm, body: { status: 'in_progress' } });
  ok(reopen.status === 200, '创建者可重新开启任务');
  const repeatForm = new FormData();
  await req('/api/tasks/' + taskId + '/completion-request', { method: 'POST', token: newUserToken, body: repeatForm });
  await req('/api/tasks/' + taskId, { method: 'PATCH', token: pm, body: { status: 'completed' } });

  console.log('\n【6】大屏与统计');
  const scr = await req('/api/screen', { token: admin });
  ok(scr.status === 200, '大屏接口可访问');
  ok(typeof scr.data.summary.total === 'number' && scr.data.summary.total > 0, `大屏统计正常（共 ${scr.data.summary.total} 个任务）`);
  ok(Array.isArray(scr.data.running) && Array.isArray(scr.data.done), '大屏返回执行中/已完成两个列表');
  const screenCreatorRoles = new Set([...scr.data.running, ...scr.data.done].map((task) => task.creator_role));
  ok(screenCreatorRoles.has('executor') && screenCreatorRoles.has('assigner'),
    '大屏执行中和已完成明细包含不同发布角色创建的任务');
  ok(scr.data.recipients.length > 0 && scr.data.recipients.every((recipient) => recipient.total > 0),
    '所有角色任务分布只显示实际承担过任务的人员');
  ok(scr.data.recipients.some((recipient) => recipient.role === 'assigner'),
    '所有角色任务分布包含作为任务接收人的分配者');
  ok(scr.data.executors.length === scr.data.recipients.length,
    '旧 executors 字段与新 recipients 字段保持兼容');
  const executorScreen = await req('/api/screen', { token: dev });
  ok(JSON.stringify(executorScreen.data.running.map((task) => task.id)) ===
    JSON.stringify(scr.data.running.map((task) => task.id)) &&
    JSON.stringify(executorScreen.data.done.map((task) => task.id)) ===
    JSON.stringify(scr.data.done.map((task) => task.id)),
  '执行者登录大屏也能看到全局执行中和已完成任务');
  ok(JSON.stringify(executorScreen.data.recipients) === JSON.stringify(scr.data.recipients),
    '执行者登录大屏看到相同的所有角色任务分布');
  const assignerScreen = await req('/api/screen', { token: pm });
  ok(JSON.stringify(assignerScreen.data.recipients) === JSON.stringify(scr.data.recipients),
    '分配者登录大屏看到相同的所有角色任务分布');
  const anonymousScreen = await req('/api/screen');
  ok(anonymousScreen.status === 401, '大屏全局数据仍要求登录后访问');
  ok(scr.data.trend.length === 7, '近 7 日趋势数据完整');
  // 断言与 humanDuration 输出格式一致（如「0分」「1小时5分」「2天3小时15分」），
  // 而非仅 != '-'，确保平均耗时计算真实产出可读时长
  ok(/^(\d+天)?(\d+小时)?\d+分$/.test(scr.data.summary.avg_duration_text), `平均耗时：${scr.data.summary.avg_duration_text}`);

  console.log('\n【7】按执行者导出');
  const exp = await req(`/api/export?assignee_id=${newUserId}`, { token: admin, raw: true });
  ok(exp.status === 200, '按执行者导出成功');
  const rawBytes = new Uint8Array(
    await (await fetch(`${BASE}/api/export?assignee_id=${newUserId}`, { headers: { 'x-auth-token': admin } })).arrayBuffer()
  );
  ok(rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf, 'CSV 含 UTF-8 BOM（Excel 中文不乱码）');
  ok(exp.text.includes('首页改版需求评审') && exp.text.includes('需求开发'), 'CSV 含任务标题与类别');
  ok(exp.text.split('\r\n').length >= 2, `CSV 数据行数：${exp.text.split('\r\n').length - 1}`);
  const expDev = await req('/api/export', { token: dev, raw: true });
  ok(expDev.status === 200 &&
    expDev.text.includes('执行者派发给执行者') &&
    expDev.text.includes('执行者派发给分配者'),
  '执行者可导出自己发布或承接的任务');
  const expDevToAssigner = await req(`/api/export?assignee_id=${pmUser.id}`, { token: dev, raw: true });
  ok(expDevToAssigner.status === 200 && expDevToAssigner.text.includes('执行者派发给分配者'),
    '执行者按其他接收人筛选时仍只能导出自己可见的已发布任务');
  const visibleExportResponse = await fetch(`${BASE}/api/export?assignee_id=${pmUser.id}`, {
    headers: { 'x-auth-token': dev },
  });
  const visibleExportDisposition = decodeURIComponent(
    visibleExportResponse.headers.get('content-disposition') || ''
  );
  await visibleExportResponse.arrayBuffer();
  ok(visibleExportDisposition.includes(pmUser.name), '导出可见任务时文件名保留接收人姓名');
  const hiddenExportResponse = await fetch(`${BASE}/api/export?assignee_id=${adminUser.id}`, {
    headers: { 'x-auth-token': dev },
  });
  const hiddenExportDisposition = decodeURIComponent(
    hiddenExportResponse.headers.get('content-disposition') || ''
  );
  await hiddenExportResponse.arrayBuffer();
  ok(hiddenExportResponse.status === 200 &&
    !hiddenExportDisposition.includes(adminUser.name) &&
    hiddenExportDisposition.includes('所选接收人'),
  '任意用户 ID 不能通过导出文件名泄露不可见用户姓名');
  const expPm = await req('/api/export', { token: pm, raw: true });
  ok(expPm.status === 200 &&
    expPm.text.includes('首页改版需求评审') &&
    expPm.text.includes('执行者派发给分配者'),
  '分配者导出同时包含自己发布和承接的任务');

  console.log('\n【8】清理校验');
  const delUser = await req('/api/users/' + newUserId, { method: 'DELETE', token: admin });
  ok(delUser.status === 400, '有关联任务的用户不允许删除（提示改为停用）');
  const weakReset = await req('/api/users/' + newUserId, {
    method: 'PATCH', token: admin, body: { password: '12345678' },
  });
  ok(weakReset.status === 400, '管理员重置为纯数字弱口令被拒绝');
  const resetPassword = await req('/api/users/' + newUserId, {
    method: 'PATCH', token: admin, body: { password: 'changed1234' },
  });
  ok(resetPassword.status === 200, '管理员可重置用户密码');
  ok((await req('/api/tasks', { token: newUserToken })).status === 401, '密码重置后旧会话立即失效');

  console.log('\n【9】用户自行修改密码');
  const weakSelf = await req('/api/auth/password', {
    method: 'POST', token: pm, body: { oldPassword: DEMO_PASSWORD, newPassword: '12345678' },
  });
  ok(weakSelf.status === 400, '修改为纯数字弱口令被拒绝');
  const selfChange = await req('/api/auth/password', {
    method: 'POST', token: pm, body: { oldPassword: DEMO_PASSWORD, newPassword: 'pmnew1234' },
  });
  ok(selfChange.status === 200 && selfChange.data.relogin, '用户可使用正确旧密码修改密码');
  ok((await req('/api/tasks', { token: pm })).status === 401, '自行改密后旧会话立即失效');
  ok((await req('/api/auth/login', {
    method: 'POST', body: { username: 'pm01', password: 'pmnew1234' },
  })).status === 200, '用户可使用新密码重新登录');

  console.log('\n【10】改密端点限流');
  const changeStatuses = [];
  for (let i = 0; i < 11; i++) {
    changeStatuses.push((await req('/api/auth/password', {
      method: 'POST', token: dev, body: { oldPassword: 'wrong-old-password', newPassword: 'newPass123' },
    })).status);
  }
  // 计数先到阈值才拒绝：前 10 次正常计数并返回 400（旧密码错误），第 11 次触发 429
  ok(changeStatuses.slice(0, 10).every((status) => status === 400), '前 10 次改密尝试正常返回 400');
  ok(changeStatuses[10] === 429, '第 11 次改密尝试触发 429 限流');

  console.log(`\n${'='.repeat(46)}\n  全部 ${pass} 项断言通过\n${'='.repeat(46)}\n`);
})().catch((e) => {
  console.error('测试异常:', e.message);
  console.log(`\n  已通过 ${pass} 项，失败 1 项（后续断言已跳过）\n`);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
}).finally(stopServer);
