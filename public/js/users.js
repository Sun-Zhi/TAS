/* ============ 用户管理与岗位分工 ============ */
'use strict';

async function loadUsers() {
  const { users } = await api('/api/users');
  state.users = users;
  const rows = users.map((u) => `<tr>
    <td class="tid">#${u.id}</td>
    <td><b>${esc(u.name)}</b><div class="cell-sub">${esc(u.username)}</div></td>
    <td><span class="badge ${u.role === 'admin' ? 'overdue' : u.role === 'assigner' ? 'running' : 'gray'}">${ROLE_TEXT[u.role]}</span></td>
    <td>${esc(u.dept || '-')}</td>
    <td>${u.active ? '<span class="t-success">启用</span>' : '<span class="t-mute">停用</span>'}</td>
    <td>创建 ${u.created_count} / 承接 ${u.assigned_count} / 完成 ${u.done_count}</td>
    <td>${fmt(u.created_at, false)}</td>
    <td class="nowrap">
      <button class="btn ghost sm" data-action="edit-user" data-id="${u.id}">编辑</button>
      ${u.id === state.me.id
        ? '<span class="cell-sub px-8">当前登录</span>'
        : `<button class="btn ghost sm" data-action="toggle-user" data-id="${u.id}" data-value="${u.active ? 0 : 1}">${u.active ? '停用' : '启用'}</button>
           <button class="btn danger sm" data-action="del-user" data-id="${u.id}">删除</button>`}
    </td></tr>`).join('');

  $('#userTableWrap').innerHTML = `<table class="tbl">
    <thead><tr><th>ID</th><th>用户</th><th>角色</th><th>部门</th><th>状态</th><th>任务统计</th><th>创建时间</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// 密码可见性：默认掩码，管理员确认临时密码时可手动切换显示；
// 每次打开弹窗都复位为掩码，避免上次切换状态残留
function resetPasswordField() {
  $('#ufPassword').type = 'password';
  $('#btnToggleUfPwd').textContent = '显示';
  $('#btnToggleUfPwd').setAttribute('aria-pressed', 'false');
}

$('#btnToggleUfPwd').addEventListener('click', () => {
  const input = $('#ufPassword');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  $('#btnToggleUfPwd').textContent = showing ? '显示' : '隐藏';
  $('#btnToggleUfPwd').setAttribute('aria-pressed', String(!showing));
});

$('#btnNewUser').addEventListener('click', () => {
  $('#userModalTitle').textContent = '新建用户';
  $('#userForm').reset();
  $('#ufId').value = '';
  resetPasswordField();
  syncRoundSelects();
  $('#ufUsername').disabled = false;
  $('#ufPwdReq').style.display = '';
  $('#ufPwdHint').textContent = '至少 8 位，请告知用户首次登录密码';
  openModal('#userModal');
});

function editUser(id) {
  const u = state.users.find((x) => x.id === id);
  if (!u) return;
  $('#userModalTitle').textContent = '编辑用户';
  $('#ufId').value = u.id;
  $('#ufUsername').value = u.username;
  $('#ufUsername').disabled = true;
  $('#ufName').value = u.name;
  $('#ufRole').value = u.role;
  syncRoundSelects();
  $('#ufDept').value = u.dept || '';
  $('#ufPassword').value = '';
  resetPasswordField();
  $('#ufPwdReq').style.display = 'none';
  $('#ufPwdHint').textContent = '留空表示不修改密码';
  openModal('#userModal');
}

$('#btnSaveUser').addEventListener('click', async () => {
  const id = $('#ufId').value;
  const payload = {
    name: $('#ufName').value.trim(),
    role: $('#ufRole').value,
    dept: $('#ufDept').value.trim(),
  };
  if (!payload.name) return toast('请填写姓名', 'err');
  const pwd = $('#ufPassword').value;
  if (id) {
    if (pwd) payload.password = pwd;
  } else {
    payload.username = $('#ufUsername').value.trim();
    payload.password = pwd;
    if (!payload.username) return toast('请填写登录账号', 'err');
    if (!pwd || pwd.length < 8) return toast('密码至少 8 位', 'err');
  }
  // 防重入：请求期间禁用按钮，所有成功/失败路径统一在 finally 恢复
  const btn = $('#btnSaveUser');
  const originalButtonText = btn.textContent;
  btn.disabled = true;
  try {
    await api(id ? '/api/users/' + id : '/api/users', { method: id ? 'PATCH' : 'POST', body: payload });
    toast(id ? '用户已更新' : '用户创建成功', 'ok');
    closeModal('#userModal');
    await Promise.all([loadUsers(), loadAssigneeOptions()]);
  } catch (e) { toast(e.message, 'err'); }
  finally {
    btn.disabled = false;
    btn.textContent = originalButtonText;
  }
});

async function toggleUser(id, active) {
  try {
    await api('/api/users/' + id, { method: 'PATCH', body: { active } });
    toast(active ? '已启用' : '已停用', 'ok');
    await Promise.all([loadUsers(), loadAssigneeOptions()]);
  } catch (e) { toast(e.message, 'err'); }
}

async function delUser(id) {
  if (!await askConfirm('删除后该账号将无法登录。', '删除用户', '确认删除')) return;
  try {
    await api('/api/users/' + id, { method: 'DELETE' });
    toast('用户已删除', 'ok');
    await Promise.all([loadUsers(), loadAssigneeOptions()]);
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- 岗位分工 ---------------- */

async function loadResponsibilities() {
  const { users } = await api('/api/users/responsibilities');
  state.responsibilityUsers = users;
  const canEdit = state.me.role === 'admin';
  $('#responsibilityGrid').innerHTML = users.length ? users.map((user) => `
    <article class="responsibility-card">
      <div class="rc-head">
        <div class="avatar">${esc(user.name).slice(0, 1) || '-'}</div>
        <div>
          <div class="rc-name">${esc(user.name)} ${user.active ? '' : '<span class="badge gray">已停用</span>'}</div>
          <div class="rc-meta">${esc(user.dept || '未设置部门')} · ${esc(user.username)}</div>
        </div>
      </div>
      <div class="rc-body${user.responsibilities ? '' : ' empty'}">${user.responsibilities ? esc(user.responsibilities) : '暂未定义岗位职责'}</div>
      ${canEdit ? `<div class="rc-actions"><button class="btn ghost sm" data-action="edit-responsibility" data-id="${user.id}">编辑职责</button></div>` : ''}
    </article>`).join('') : '<div class="empty"><div class="ico">👥</div>暂未创建执行者账号</div>';
}

function editResponsibility(id) {
  const user = state.responsibilityUsers.find((item) => item.id === id);
  if (!user) return toast('执行者信息不存在，请刷新后重试', 'err');
  $('#responsibilityUserId').value = user.id;
  $('#responsibilityUserInfo').innerHTML = `<b>${esc(user.name)}</b><div class="cell-sub mt-4">${esc(user.dept || '未设置部门')} · ${esc(user.username)}</div>`;
  $('#responsibilityText').value = user.responsibilities || '';
  openModal('#responsibilityModal');
  $('#responsibilityText').focus();
}

$('#btnSaveResponsibility').addEventListener('click', async () => {
  const id = $('#responsibilityUserId').value;
  const button = $('#btnSaveResponsibility');
  button.disabled = true;
  try {
    await api(`/api/users/${id}/responsibilities`, {
      method: 'PATCH', body: { responsibilities: $('#responsibilityText').value.trim() },
    });
    closeModal('#responsibilityModal');
    await loadResponsibilities();
    toast('岗位职责已保存', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
  }
});
