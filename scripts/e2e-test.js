/* 端到端自测：node scripts/e2e-test.js */
'use strict';
const BASE = 'http://localhost:3000';
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

(async () => {
  console.log('\n【1】登录与鉴权');
  const admin = await login('admin', 'admin123');
  const pm = await login('pm01', '123456');
  const dev = await login('dev01', '123456');
  ok(admin && pm && dev, '三种角色均可登录');
  const bad = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  ok(bad.status === 401, '错误密码被拒绝');
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
  const wrongDone = await req('/api/tasks/' + taskId, { method: 'PATCH', token: dev, body: { status: 'completed' } });
  ok(wrongDone.status === 403, '非执行人无法标记完成');
  await new Promise((r) => setTimeout(r, 1200));
  const done = await req('/api/tasks/' + taskId, {
    method: 'PATCH', token: newUserToken, body: { status: 'completed', result_note: '评审结论已同步至文档' },
  });
  ok(done.status === 200, '执行者标记完成成功', JSON.stringify(done.data));
  const after = await req('/api/tasks/' + taskId, { token: pm });
  ok(after.data.task.status === 'completed', '状态变为已完成');
  ok(!!after.data.task.completed_at, '记录完成时间');
  ok(!!after.data.task.duration_text, `耗时已计算：${after.data.task.duration_text}`);
  ok(after.data.logs.length >= 2, '操作日志已记录');

  const reopen = await req('/api/tasks/' + taskId, { method: 'PATCH', token: pm, body: { status: 'in_progress' } });
  ok(reopen.status === 200, '创建者可重新开启任务');
  await req('/api/tasks/' + taskId, { method: 'PATCH', token: newUserToken, body: { status: 'completed' } });

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

  console.log(`\n${'='.repeat(46)}\n  通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(46)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
