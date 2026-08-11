/* 端到端自测：node scripts/e2e-test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'taskassign-e2e-'));
const PORT = 32000 + (process.pid % 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let serverOutput = '';
let pass = 0, fail = 0;

function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
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
      ADMIN_PASSWORD: 'admin123',
      ENABLE_DEMO_ACCOUNTS: '1',
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
  await startServer();
  console.log('\n【1】登录与鉴权');
  const admin = await login('admin', 'admin123');
  const pm = await login('pm01', '123456');
  const dev = await login('dev01', '123456');
  ok(admin && pm && dev, '三种角色均可登录');
  const bad = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  ok(bad.status === 401, '错误密码被拒绝');
  let limited;
  for (let i = 0; i < 6; i++) {
    limited = await req('/api/auth/login', {
      method: 'POST', body: { username: 'rate-limit-probe', password: 'wrong' },
    });
  }
  ok(limited.status === 429, '连续登录失败触发 429 限流');
  ok((await req('/api/tasks')).status === 401, '未登录访问受保护接口返回 401');

  console.log('\n【2】管理员创建用户');
  const uname = 'exec_' + Date.now().toString().slice(-6);
  const cu = await req('/api/users', {
    method: 'POST', token: admin,
    body: { username: uname, password: '123456', name: '测试执行者', role: 'executor', dept: '测试部' },
  });
  ok(cu.status === 201, '管理员创建执行者成功', JSON.stringify(cu.data));
  const newUserId = cu.data.id;
  const cu2 = await req('/api/users', {
    method: 'POST', token: pm,
    body: { username: 'x1', password: '123456', name: 'x', role: 'executor' },
  });
  ok(cu2.status === 403, '分配者无权创建用户');
  ok((await req('/api/auth/login', { method: 'POST', body: { username: uname, password: '123456' } })).status === 200,
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
  const devCreate = await req('/api/tasks', { method: 'POST', token: dev, body: { title: 'x', assignee_id: 4 } });
  ok(devCreate.status === 403, '执行者无权创建任务');

  console.log('\n【4】数据可见范围');
  const newUserToken = await login(uname, '123456');
  const seeAdmin = await req('/api/tasks', { token: admin });
  const seePm = await req('/api/tasks', { token: pm });
  const seeExec = await req('/api/tasks', { token: newUserToken });
  ok(seeAdmin.data.tasks.length >= seePm.data.tasks.length, '管理员可见任务数 >= 分配者');
  ok(seePm.data.tasks.every((t) => t.creator_username === 'pm01'), '分配者只看到自己创建的任务');
  ok(seeExec.data.tasks.every((t) => t.assignee_id === newUserId), '执行者只看到派发给自己的任务');
  const otherView = await req('/api/tasks/' + taskId, { token: dev });
  ok(otherView.status === 403, '无关执行者无法查看他人任务详情');

  console.log('\n【5】执行与完成');
  const wrongRequestForm = new FormData();
  wrongRequestForm.append('result_note', '无关人员申请');
  const wrongDone = await req('/api/tasks/' + taskId + '/completion-request', {
    method: 'POST', token: dev, body: wrongRequestForm,
  });
  ok(wrongDone.status === 403, '非执行人无法提交完成申请');
  await new Promise((r) => setTimeout(r, 1200));
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
  const redispatch = await req('/api/tasks/' + taskId, {
    method: 'PATCH', token: pm, body: { status: 'in_progress' },
  });
  ok(redispatch.status === 200, '任务发布者可以重新派发已退回任务');
  const redispatchedDetail = await req('/api/tasks/' + taskId, { token: newUserToken });
  ok(!redispatchedDetail.data.task.returned && !redispatchedDetail.data.task.return_reason,
    '重新派发后清除退回状态和理由');

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
  const scr = await req('/api/screen', { token: dev });
  ok(scr.status === 200, '大屏接口可访问');
  ok(typeof scr.data.summary.total === 'number' && scr.data.summary.total > 0, `大屏统计正常（共 ${scr.data.summary.total} 个任务）`);
  ok(Array.isArray(scr.data.running) && Array.isArray(scr.data.done), '大屏返回执行中/已完成两个列表');
  ok(scr.data.executors.length > 0, '执行者维度统计存在');
  ok(scr.data.trend.length === 7, '近 7 日趋势数据完整');
  ok(scr.data.summary.avg_duration_text !== '-', `平均耗时：${scr.data.summary.avg_duration_text}`);

  console.log('\n【7】按执行者导出');
  const exp = await req(`/api/export?assignee_id=${newUserId}`, { token: admin, raw: true });
  ok(exp.status === 200, '按执行者导出成功');
  const rawBytes = new Uint8Array(
    await (await fetch(`${BASE}/api/export?assignee_id=${newUserId}`, { headers: { 'x-auth-token': admin } })).arrayBuffer()
  );
  ok(rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf, 'CSV 含 UTF-8 BOM（Excel 中文不乱码）');
  ok(exp.text.includes('首页改版需求评审') && exp.text.includes('需求开发'), 'CSV 含任务标题与类别');
  ok(exp.text.split('\r\n').length >= 2, `CSV 数据行数：${exp.text.split('\r\n').length - 1}`);
  const expExec = await req(`/api/export?assignee_id=1`, { token: newUserToken, raw: true });
  ok(expExec.status === 403, '执行者无法导出他人任务');

  console.log('\n【8】清理校验');
  const delUser = await req('/api/users/' + newUserId, { method: 'DELETE', token: admin });
  ok(delUser.status === 400, '有关联任务的用户不允许删除（提示改为停用）');
  const resetPassword = await req('/api/users/' + newUserId, {
    method: 'PATCH', token: admin, body: { password: 'changed-password' },
  });
  ok(resetPassword.status === 200, '管理员可重置用户密码');
  ok((await req('/api/tasks', { token: newUserToken })).status === 401, '密码重置后旧会话立即失效');

  console.log(`\n${'='.repeat(46)}\n  通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(46)}\n`);
  if (fail) process.exitCode = 1;
})().catch((e) => {
  console.error('测试异常:', e);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
}).finally(stopServer);
