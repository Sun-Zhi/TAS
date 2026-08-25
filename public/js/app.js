/* ============ 任务分配系统 · 工作台逻辑（主文件） ============
 * 依赖顺序：util.js → modal.js → due-picker.js → task-actions.js → users.js → 本文件
 * 经典脚本共享全局作用域；本文件负责初始化、列表/详情渲染、筛选导出、
 * 事件委托分发与自动刷新。 */
'use strict';

/* ---------------- 初始化 ---------------- */

async function init() {
  try {
    const { user } = await api('/api/auth/me');
    state.me = user;
  } catch { location.href = '/login.html'; return; }

  const me = state.me;
  $('#uName').textContent = me.name;
  $('#uRole').textContent = ROLE_TEXT[me.role];
  $('#uAvatar').textContent = me.name.slice(0, 1);

  if (me.role === 'admin') {
    $('#navUsers').style.display = '';
    $('#scopeDesc').textContent = '管理员视角 · 可查看系统内全部任务';
    $('#responsibilityDesc').textContent = '管理员可定义每位执行者负责的岗位职责';
  } else if (me.role === 'assigner') {
    $('#scopeDesc').textContent = '分配者视角 · 展示我发布或承接的任务';
  } else {
    $('#scopeDesc').textContent = '执行者视角 · 展示我发布或承接的任务';
  }
  $('#btnNewTask').style.display = '';

  await loadAssigneeOptions();
  await loadCategories();
  await refresh();
  initDuePicker();
}

function uniqueUsers(users) {
  const byId = new Map();
  users.forEach((user) => byId.set(user.id, user));
  return Array.from(byId.values());
}

function populateTaskAssignees(users) {
  const showRoles = users.some((user) => user.role !== 'executor');
  const options = users.map((user) => {
    const role = showRoles ? ` · ${ROLE_TEXT[user.role]}` : '';
    const dept = user.dept ? ` · ${esc(user.dept)}` : '';
    return `<option value="${user.id}" data-role="${user.role}">${esc(user.name)}${role}${dept}</option>`;
  }).join('');
  $('#tfAssignee').innerHTML = '<option value="">请选择任务接收人</option>' + options;
  syncRoundSelects();
}

async function loadAssigneeOptions() {
  const [{ users: visibleAssignees }, { users: taskAssignees }] = await Promise.all([
    api('/api/users/task-filter-assignees'),
    api('/api/users/task-assignees'),
  ]);
  state.taskAssignees = taskAssignees;

  const filterUsers = uniqueUsers([
    ...visibleAssignees,
    ...taskAssignees,
    ...(state.me.role === 'admin' ? [] : [state.me]),
  ]);
  const showRoles = filterUsers.some((user) => user.role !== 'executor');
  const filterOptions = filterUsers.map((user) => {
    const role = showRoles ? ` · ${ROLE_TEXT[user.role]}` : '';
    const dept = user.dept ? ` · ${esc(user.dept)}` : '';
    return `<option value="${user.id}">${esc(user.name)}${role}${dept}</option>`;
  }).join('');
  $('#fAssignee').innerHTML = '<option value="">全部接收人</option>' + filterOptions;
  $('#exAssignee').innerHTML = '<option value="">全部接收人</option>' + filterOptions;
  populateTaskAssignees(taskAssignees);
}

async function refresh() {
  await Promise.all([loadStats(), loadTasks()]);
}

async function loadStats() {
  const s = await api('/api/overview');
  $('#statGrid').innerHTML = `
    <div class="stat blue"><div class="k">任务总数</div><div class="v">${s.total}</div></div>
    <div class="stat orange"><div class="k">执行中</div><div class="v">${s.running}</div></div>
    <div class="stat purple"><div class="k">待确认完成</div><div class="v">${s.pending_confirmation}</div></div>
    <div class="stat returned"><div class="k">已退回</div><div class="v">${s.returned}</div></div>
    <div class="stat green"><div class="k">已完成</div><div class="v">${s.done}</div></div>
    <div class="stat red"><div class="k">已逾期</div><div class="v">${s.overdue}</div></div>
    <div class="stat"><div class="k">平均完成耗时</div><div class="v sm">${esc(s.avg_duration_text)}</div></div>`;

  const actionablePending = Number(s.pending_confirmation_to_confirm || 0);
  const showNotice = actionablePending > 0;
  $('#completionNotice').hidden = !showNotice;
  $('#completionNoticeCount').textContent = String(actionablePending);
}

const TASKS_PAGE_SIZE = 200;
// 请求序号：追加请求在途时若发生重置（切筛选/搜索/自动刷新），
// 旧响应按序号丢弃，避免旧筛选数据混入新列表、页码错乱
let tasksLoadSeq = 0;

async function loadTasks({ reset = true } = {}) {
  // reset=false 为「加载更多」追加模式：翻页期间防重入
  if (!reset && state.loadingMore) return;
  const seq = ++tasksLoadSeq;
  if (reset) {
    state.tasks = [];
    state.taskTotal = 0;
    state.taskHasMore = false;
    state.tasksPage = 0;
  }
  state.loadingMore = true;
  try {
    const p = new URLSearchParams();
    Object.entries(state.filters).forEach(([k, v]) => { if (v) p.set(k, v); });
    p.set('limit', String(TASKS_PAGE_SIZE));
    p.set('page', String(state.tasksPage + 1));
    const result = await api('/api/tasks?' + p.toString());
    if (seq !== tasksLoadSeq) return; // 过期响应：期间已触发新一轮加载
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];
    state.tasks = reset ? tasks : state.tasks.concat(tasks);
    const total = result.total === undefined || result.total === null || result.total === '' ? NaN : Number(result.total);
    state.taskTotal = Number.isFinite(total) ? total : tasks.length;
    state.tasksPage += 1;
    state.taskHasMore = Boolean(result.pagination && result.pagination.has_more);
    renderTasks();
  } finally {
    // 只有最新一轮请求负责复位防重入标志
    if (seq === tasksLoadSeq) state.loadingMore = false;
  }
}

async function loadMoreTasks() {
  await loadTasks({ reset: false });
}

function loadMoreButtonHtml() {
  if (!state.taskHasMore) return '';
  return `<div class="load-more"><button class="btn ghost" data-action="load-more"${state.loadingMore ? ' disabled' : ''}>加载更多任务</button></div>`;
}

async function loadCategories() {
  const { categories } = await api('/api/tasks/categories');
  const cur = state.filters.category;
  $('#fCategory').innerHTML = '<option value="">全部类别</option>' +
    categories.map((c) => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
  $('#catList').innerHTML = categories.map((c) => `<option value="${esc(c)}">`).join('');
  syncRoundSelects();
}

/* ---------------- 任务列表渲染 ---------------- */

function isCreatorOrAdmin(t) {
  return t.creator_id === state.me.id || state.me.role === 'admin';
}

function isCurrentTaskRecipient(t) {
  return t.assignee_id === state.me.id && ['executor', 'assigner'].includes(state.me.role);
}

/** 任务状态徽章：列表（带脉冲圆点）与详情共用同一份判定逻辑 */
function taskStatusBadge(t, withDot = true) {
  const dot = withDot ? '<i class="dot-live"></i>' : '';
  if (t.status === 'completed') return '<span class="badge done">已完成</span>';
  if (t.returned) return '<span class="badge returned">已退回</span>';
  if (t.awaiting_confirmation) return `<span class="badge pending">${dot}${isCreatorOrAdmin(t) ? '待您确认' : '待发布者确认'}</span>`;
  if (t.overdue) return `<span class="badge overdue">${dot}已逾期</span>`;
  return `<span class="badge running">${dot}执行中</span>`;
}

function renderTaskRow(t) {
  const timeCell = t.status === 'completed'
    ? `<b style="color:var(--success)">${esc(t.duration_text)}</b><div class="cell-sub">${fmt(t.completed_at)} 完成</div>`
    : t.returned
      ? `<b style="color:#fbbf24">任务已退回</b><div class="cell-sub">${fmt(t.returned_at)}</div>`
      : t.awaiting_confirmation
      ? `<b style="color:#c4b5fd">已提交完成申请</b><div class="cell-sub">${fmt(t.completion_requested_at)}</div>`
      : `<span style="color:var(--warn)">已进行 ${elapsed(t.created_at)}</span>${t.due_at ? `<div class="cell-sub">要求 ${fmt(t.due_at)}</div>` : ''}`;

  const canRequestDone = t.status === 'in_progress' && !t.returned && !t.awaiting_confirmation &&
    isCurrentTaskRecipient(t);
  const canConfirmDone = t.awaiting_confirmation && isCreatorOrAdmin(t);
  const waitingButton = t.awaiting_confirmation && t.assignee_id === state.me.id
    ? '<button class="btn ghost sm" disabled>等待发布者确认</button>' : '';
  const delBtn = canDelete(t)
    ? `<button class="btn danger sm" data-action="del-task" data-id="${t.id}" title="删除此任务">删除</button>` : '';

  const checked = state.selectedIds.has(t.id) ? 'checked' : '';
  const selCls = state.selectedIds.has(t.id) ? ' sel' : '';

  return `<tr class="${selCls}" data-id="${t.id}">
    <td class="cb-col"><input type="checkbox" ${checked} data-action="toggle-sel" data-id="${t.id}" aria-label="选择任务 ${esc(t.title)}"></td>
    <td class="tid">T${String(t.id).padStart(4, '0')}</td>
    <td>
      <div class="title-cell" data-action="show-detail" data-id="${t.id}">${esc(t.title)}
        ${t.attachment_count ? `<span class="cell-sub">📎${t.attachment_count}</span>` : ''}</div>
      <div class="cell-sub">${esc(t.category)}　创建人：${esc(t.creator_name)}</div>
    </td>
    <td>${esc(t.assignee_name)}<div class="cell-sub">${esc(t.assignee_dept || '')}</div></td>
    <td><span class="pri ${t.priority}">${PRI_TEXT[t.priority]}</span></td>
    <td>${taskStatusBadge(t)}</td>
    <td>${fmt(t.created_at)}</td>
    <td>${timeCell}</td>
    <td style="white-space:nowrap">
      <button class="btn ghost sm" data-action="show-detail" data-id="${t.id}">详情</button>
      ${canRequestDone ? `<button class="btn success sm" data-action="mark-done" data-id="${t.id}">标记完成</button>` : ''}
      ${canRequestDone ? `<button class="btn danger sm" data-action="return-task" data-id="${t.id}">退回</button>` : ''}
      ${canConfirmDone ? `<button class="btn success sm" data-action="confirm-completion" data-id="${t.id}">确认完成</button>` : ''}
      ${waitingButton}
      ${delBtn}
    </td>
  </tr>`;
}

function renderTasks() {
  const list = state.tasks;
  $('#taskCount').textContent = `当前显示 ${list.length} / 共 ${state.taskTotal} 条`;

  if (!list.length) {
    $('#taskTableWrap').innerHTML =
      '<div class="empty"><div class="ico">📋</div>暂无与你相关的任务</div>';
    $('#btnBatchDel').style.display = 'none';
    return;
  }

  const hasDelPerm = list.some((t) => canDelete(t));
  const allSel = list.length > 0 && list.every((t) => state.selectedIds.has(t.id));

  const cbHead = hasDelPerm
    ? `<th class="cb-col"><input type="checkbox" id="selAll" ${allSel ? 'checked' : ''} data-action="toggle-all"></th>`
    : '<th class="cb-col"></th>';

  $('#taskTableWrap').innerHTML = `<table class="tbl">
    <thead><tr>
      ${cbHead}
      <th>编号</th><th>任务</th><th>任务接收人</th><th>优先级</th><th>状态</th><th>创建时间</th><th>耗时 / 进度</th><th>操作</th>
    </tr></thead>
    <tbody>${list.map(renderTaskRow).join('')}</tbody></table>${loadMoreButtonHtml()}`;

  // 批量删除按钮显隐
  updateBatchDelUI();
}

function syncSelAllCheckbox() {
  const selAll = $('#selAll');
  if (selAll) selAll.checked = state.tasks.length > 0 && state.tasks.every((t) => state.selectedIds.has(t.id));
}

function toggleSel(id, on) {
  if (on) state.selectedIds.add(id); else state.selectedIds.delete(id);
  // 只更新该行选中态，不重建整个表格（避免勾选时丢失焦点、整表闪烁）
  const row = $(`#taskTableWrap tr[data-id="${id}"]`);
  if (row) row.classList.toggle('sel', on);
  syncSelAllCheckbox();
  updateBatchDelUI();
}

function toggleAll(on) {
  if (on) state.tasks.forEach((t) => state.selectedIds.add(t.id));
  else state.selectedIds.clear();
  // 同步所有行的选中 class 与复选框状态，不重建整个表格
  $$('#taskTableWrap tbody tr[data-id]').forEach((row) => {
    const selected = state.selectedIds.has(Number(row.dataset.id));
    row.classList.toggle('sel', selected);
    const cb = row.querySelector('input[data-action="toggle-sel"]');
    if (cb) cb.checked = selected;
  });
  syncSelAllCheckbox();
  updateBatchDelUI();
}

function updateBatchDelUI() {
  const n = state.selectedIds.size;
  const btn = $('#btnBatchDel');
  if (n > 0 && state.tasks.some((t) => state.selectedIds.has(t.id) && canDelete(t))) {
    btn.style.display = '';
    renderBatchDeleteButton(n);
  } else {
    btn.style.display = 'none';
  }
}

function renderBatchDeleteButton(count, loading = false) {
  const btn = $('#btnBatchDel');
  if (loading) {
    btn.textContent = '删除中...';
    return;
  }
  const countEl = document.createElement('b');
  countEl.id = 'selCount';
  countEl.textContent = String(count);
  btn.replaceChildren('删除选中（', countEl, '）');
}

/* ---------------- 任务详情 ---------------- */

async function loadTaskDetail(id) {
  const { task: t, attachments, logs } = await api('/api/tasks/' + id);
  $('#dtTitle').textContent = `T${String(t.id).padStart(4, '0')} · ${t.title}`;

  // 任务接收人只在“标记完成”弹窗提交成果附件；任务详情仅供下载。
  const canUpload = isCreatorOrAdmin(t);
  $('#dtBody').innerHTML = detailBodyHtml(t, attachmentsHtml(attachments), logsHtml(logs), canUpload);
  if (canUpload) bindDetailUpload(id);

  const canEdit = isCreatorOrAdmin(t);
  const canRepairSelfAssignment = canEdit && t.awaiting_confirmation && t.creator_id === t.assignee_id;
  const canRequestDone = t.status === 'in_progress' && !t.returned && !t.awaiting_confirmation &&
    isCurrentTaskRecipient(t);
  const canConfirmDone = t.awaiting_confirmation && canEdit && !canRepairSelfAssignment;
  const waitingButton = t.awaiting_confirmation && t.assignee_id === state.me.id && !canRepairSelfAssignment
    ? '<button class="btn ghost" disabled>等待发布者确认</button>' : '';
  $('#dtFoot').innerHTML = detailFooterHtml(t, canEdit, canRequestDone, canConfirmDone, waitingButton, canRepairSelfAssignment);

  openModal('#detailModal');
}

function attachmentsHtml(attachments) {
  return attachments.length
    ? attachments.map((a) => `<div class="file-item">
        <span>${a.kind === 'result' ? '📤' : '📎'}</span>
        <span class="fname">${esc(a.orig_name)}</span>
        <span class="fsize">${fileSize(a.size)}</span>
        <a class="btn ghost sm" href="/api/tasks/attachments/${a.id}/download">下载</a>
      </div>`).join('')
    : '<div class="hint">暂无附件</div>';
}

function logsHtml(logs) {
  return `<ul class="timeline">${logs.map((l) => `<li>
    <div class="t-act">${esc(l.detail || l.action)}</div>
    <div class="t-meta">${esc(l.user_name || '系统')} · ${fmt(l.created_at)}</div></li>`).join('') || '<span class="hint">无</span>'}</ul>`;
}

function detailBodyHtml(t, attHtml, logs, canUpload) {
  return `
    <div class="detail-row"><div class="lb">状态</div><div class="vl">${taskStatusBadge(t, false)}
      <span class="pri ${t.priority}" style="margin-left:8px">优先级：${PRI_TEXT[t.priority]}</span></div></div>
    <div class="detail-row"><div class="lb">任务类别</div><div class="vl">${esc(t.category)}</div></div>
    <div class="detail-row"><div class="lb">任务接收人</div><div class="vl">${esc(t.assignee_name)} ${t.assignee_dept ? `<span class="cell-sub">· ${esc(t.assignee_dept)}</span>` : ''}</div></div>
    <div class="detail-row"><div class="lb">创建人</div><div class="vl">${esc(t.creator_name)}</div></div>
    <div class="detail-row"><div class="lb">创建时间</div><div class="vl">${fmt(t.created_at)}</div></div>
    <div class="detail-row"><div class="lb">要求完成</div><div class="vl">${fmt(t.due_at)}</div></div>
    ${t.status === 'completed' ? `
      <div class="detail-row"><div class="lb">完成时间</div><div class="vl">${fmt(t.completed_at)}</div></div>
      <div class="detail-row"><div class="lb">执行耗时</div><div class="vl"><b style="color:var(--success);font-size:15px">${esc(t.duration_text)}</b></div></div>
      ${t.result_note ? `<div class="detail-row"><div class="lb">完成说明</div><div class="vl">${esc(t.result_note)}</div></div>` : ''}
    ` : t.returned ? `
      <div class="detail-row"><div class="lb">退回时间</div><div class="vl"><b style="color:#fbbf24">${fmt(t.returned_at)}</b></div></div>
      <div class="detail-row"><div class="lb">退回理由</div><div class="vl" style="white-space:pre-wrap;color:#fcd34d">${esc(t.return_reason)}</div></div>
    ` : t.awaiting_confirmation ? `
      <div class="detail-row"><div class="lb">完成申请</div><div class="vl"><b style="color:#c4b5fd">${fmt(t.completion_requested_at)} 已提交</b></div></div>
      <div class="detail-row"><div class="lb">完成说明</div><div class="vl" style="white-space:pre-wrap">${esc(t.completion_request_note) || '<span class="hint">未填写</span>'}</div></div>
    ` : `<div class="detail-row"><div class="lb">已进行</div><div class="vl" style="color:var(--warn)">${elapsed(t.created_at)}</div></div>`}
    <div class="detail-row"><div class="lb">任务描述</div><div class="vl" style="white-space:pre-wrap">${esc(t.description) || '<span class="hint">无</span>'}</div></div>
    <div class="detail-row"><div class="lb">附件</div><div class="vl">
      <div class="file-list">${attHtml}</div>
      ${canUpload ? `<div style="margin-top:8px">
        <input type="file" id="dtFiles" multiple hidden>
        <button class="btn ghost sm" id="dtUploadButton" data-action="trigger-dt-files">＋ 上传附件</button>
        <button class="btn ghost sm" id="dtCancelUpload" hidden>取消上传</button>
        <span class="hint">单个附件不得超过 50MB</span>
        <span class="hint upload-inline-progress" id="dtUpTip"></span></div>` : ''}
    </div></div>
    <div class="detail-row"><div class="lb">操作记录</div><div class="vl">${logs}</div></div>`;
}

function detailFooterHtml(t, canEdit, canRequestDone, canConfirmDone, waitingButton, canRepairSelfAssignment) {
  return `
    ${canEdit && t.status === 'completed' ? `<button class="btn ghost" data-action="reopen-task" data-id="${t.id}">重新开启</button>` : ''}
    ${canEdit ? `<button class="btn danger" data-action="remove-task" data-id="${t.id}">删除任务</button>` : ''}
    ${canEdit && t.status === 'in_progress' && (!t.awaiting_confirmation || canRepairSelfAssignment) ? `<button class="btn ghost" data-action="edit-task" data-id="${t.id}">${canRepairSelfAssignment ? '重新指派' : '编辑任务'}</button>` : ''}
    ${canRequestDone ? `<button class="btn success" data-action="mark-done" data-id="${t.id}">标记执行完成</button>` : ''}
    ${canRequestDone ? `<button class="btn danger" data-action="return-task" data-id="${t.id}">退回任务</button>` : ''}
    ${canConfirmDone ? `<button class="btn success" data-action="confirm-completion" data-id="${t.id}">确认完成</button>` : ''}
    ${waitingButton}
    <button class="btn ghost" data-close>关闭</button>`;
}

function bindDetailUpload(id) {
  $('#dtFiles').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    if (files.length > 10) { e.target.value = ''; return toast('一次最多上传 10 个附件', 'err'); }
    const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) { e.target.value = ''; return toast(`「${oversized.name}」超过 50MB，不能上传`, 'err'); }
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    const controller = new AbortController();
    const uploadButton = $('#dtUploadButton');
    const cancelButton = $('#dtCancelUpload');
    uploadButton.disabled = true;
    cancelButton.hidden = false;
    cancelButton.onclick = () => controller.abort();
    $('#dtUpTip').textContent = '准备上传...';
    try {
      await uploadForm(`/api/tasks/${id}/attachments`, fd, {
        signal: controller.signal,
        onProgress: (progress) => { $('#dtUpTip').textContent = uploadProgressText(progress); },
        onUploaded: () => { $('#dtUpTip').textContent = '文件已发送，服务器处理中...'; },
      });
      toast('附件上传成功', 'ok');
      runAsync(() => loadTaskDetail(id), '任务详情刷新失败');
      runAsync(() => loadTasks(), '任务列表刷新失败');
    } catch (err) {
      $('#dtUpTip').textContent = err.message;
      toast(err.message, 'err');
    } finally {
      uploadButton.disabled = false;
      cancelButton.hidden = true;
      e.target.value = '';
    }
  });
}

function showDetail(id) {
  runAsync(() => loadTaskDetail(id), '任务详情加载失败');
}

/* ---------------- 新建任务 ---------------- */

$('#btnNewTask').addEventListener('click', () => {
  $('#taskModalTitle').textContent = '发布新任务';
  $('#taskForm').reset();
  populateTaskAssignees(state.taskAssignees);
  clearDue();
  $('#tfDue').dataset.original = '';
  $('#tfDue').dataset.returned = '';
  $('#tfId').value = '';
  $('#tfPriority').value = 'normal';
  syncRoundSelects();
  state.pendingFiles = [];
  renderPendingFiles();
  $('#tfFileField').style.display = '';
  $('#btnSaveTask').textContent = '保存并派发';
  runAsync(() => loadCategories(), '任务类别加载失败');
  openModal('#taskModal');
});

const dz = $('#dropzone');
dz.addEventListener('click', () => $('#tfFiles').click());
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault(); dz.classList.remove('over');
  addFiles(Array.from(e.dataTransfer.files));
});
$('#tfFiles').addEventListener('change', (e) => {
  addFiles(Array.from(e.target.files));
  e.target.value = '';
});

function addFiles(files) {
  for (const f of files) {
    if (state.pendingFiles.length >= 10) { toast('最多上传 10 个附件', 'err'); break; }
    if (f.size > MAX_ATTACHMENT_BYTES) { toast(`「${f.name}」超过 50MB，不能上传`, 'err'); continue; }
    state.pendingFiles.push(f);
  }
  renderPendingFiles();
}

let taskUploadController = null;
$('#btnCancelTaskUpload').addEventListener('click', () => {
  if (taskUploadController) taskUploadController.abort();
});

$('#btnSaveTask').addEventListener('click', async () => {
  const id = $('#tfId').value;
  const title = $('#tfTitle').value.trim();
  const assignee = $('#tfAssignee').value;
  if (!title) return toast('请填写任务标题', 'err');
  if (!assignee) return toast('请指定任务接收人', 'err');
  const dueValue = $('#tfDue').value;
  const dueTime = dueValue ? new Date(dueValue).getTime() : null;
  const originalDue = $('#tfDue').dataset.original;
  const unchangedExistingDue = Boolean(id && originalDue && dueTime === new Date(originalDue).getTime());
  const isReturned = $('#tfDue').dataset.returned === '1';
  // 退回任务重新派发时服务端要求截止时间晚于当前时间（即使未变更也校验）；
  // 编辑未退回任务且截止时间未变更时保持既有放行逻辑。
  if (dueTime && dueTime <= Date.now() && !(unchangedExistingDue && !isReturned)) {
    return toast(unchangedExistingDue ? '退回任务重新派发需设置晚于当前时间的截止时间' : '要求完成时间必须晚于当前时间', 'err');
  }
  const oversized = state.pendingFiles.find((file) => file.size > MAX_ATTACHMENT_BYTES);
  if (oversized) return toast(`「${oversized.name}」超过 50MB，不能上传`, 'err');

  const btn = $('#btnSaveTask');
  const originalButtonText = btn.textContent;
  btn.disabled = true;
  try {
    if (id) {
      const result = await api('/api/tasks/' + id, {
        method: 'PATCH',
        body: {
          title, description: $('#tfDesc').value, category: $('#tfCategory').value.trim() || '常规任务',
          priority: $('#tfPriority').value, assignee_id: Number(assignee),
          due_at: $('#tfDue').value || null,
        },
      });
      toast(result.redispatched ? '任务已重新编辑并派发给任务接收人' : '任务已更新', 'ok');
    } else {
      const fd = new FormData();
      fd.append('title', title);
      fd.append('description', $('#tfDesc').value);
      fd.append('category', $('#tfCategory').value.trim() || '常规任务');
      fd.append('priority', $('#tfPriority').value);
      fd.append('assignee_id', assignee);
      if ($('#tfDue').value) fd.append('due_at', $('#tfDue').value);
      state.pendingFiles.forEach((f) => fd.append('files', f));
      taskUploadController = new AbortController();
      const status = $('#tfUploadStatus');
      status.hidden = false;
      $('#tfUploadText').textContent = '准备上传...';
      $('#tfUploadBar').style.width = '0%';
      $$('#taskModal [data-close]').forEach((closeButton) => { closeButton.disabled = true; });
      await uploadForm('/api/tasks', fd, {
        signal: taskUploadController.signal,
        onProgress: (progress) => {
          $('#tfUploadText').textContent = uploadProgressText(progress);
          $('#tfUploadBar').style.width = `${progress.percent}%`;
          btn.textContent = `上传中 ${progress.percent}%`;
        },
        onUploaded: () => {
          $('#tfUploadText').textContent = '文件已发送，服务器处理中...';
          $('#tfUploadBar').style.width = '100%';
          btn.textContent = '服务器处理中...';
        },
      });
      toast('任务已发布并派发给任务接收人', 'ok');
    }
    closeModal('#taskModal');
    state.pendingFiles = [];
    runAsync(() => refresh(), '任务列表刷新失败');
  } catch (e) { toast(e.message, 'err'); }
  finally {
    taskUploadController = null;
    btn.disabled = false;
    btn.textContent = originalButtonText;
    $('#tfUploadStatus').hidden = true;
    $$('#taskModal [data-close]').forEach((closeButton) => { closeButton.disabled = false; });
  }
});

/* ---------------- 筛选 ---------------- */

$('#statusSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $$('#statusSeg button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  state.filters.status = b.dataset.status;
  state.selectedIds.clear();
  runAsync(() => loadTasks(), '任务筛选失败');
});
$('#btnShowPending').addEventListener('click', () => {
  state.filters.status = 'pending_confirmation';
  $$('#statusSeg button').forEach((button) => button.classList.toggle('on', button.dataset.status === 'pending_confirmation'));
  state.selectedIds.clear();
  runAsync(() => loadTasks(), '待确认任务加载失败');
  $('#taskTableWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#fAssignee').addEventListener('change', (e) => { state.filters.assignee_id = e.target.value; state.selectedIds.clear(); runAsync(() => loadTasks(), '任务筛选失败'); });
$('#fCategory').addEventListener('change', (e) => { state.filters.category = e.target.value; state.selectedIds.clear(); runAsync(() => loadTasks(), '任务筛选失败'); });

let searchTimer;
$('#fSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); runAsync(() => loadTasks(), '任务搜索失败'); }, 300);
});
$('#btnReset').addEventListener('click', () => {
  state.filters = { status: '', assignee_id: '', category: '', q: '' };
  $('#fSearch').value = ''; $('#fAssignee').value = ''; $('#fCategory').value = '';
  syncRoundSelects();
  $$('#statusSeg button').forEach((x, i) => x.classList.toggle('on', i === 0));
  state.selectedIds.clear();
  runAsync(() => loadTasks(), '任务列表刷新失败');
});

/* ---------------- 导出 ---------------- */

$('#btnExport').addEventListener('click', () => {
  $('#exAssignee').disabled = false;
  openModal('#exportModal');
});
$('#btnDoExport').addEventListener('click', () => {
  const p = new URLSearchParams();
  if ($('#exAssignee').value) p.set('assignee_id', $('#exAssignee').value);
  if ($('#exStatus').value) p.set('status', $('#exStatus').value);
  window.open('/api/export?' + p.toString(), '_blank');
  closeModal('#exportModal');
  toast('已开始导出', 'ok');
});

/* ---------------- 导航 ---------------- */

$$('.nav a[data-view]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const view = a.dataset.view;
    $$('.nav a').forEach((x) => x.classList.remove('active'));
    a.classList.add('active');
    $('#view-tasks').style.display = view === 'tasks' ? '' : 'none';
    $('#view-users').style.display = view === 'users' ? '' : 'none';
    $('#view-responsibilities').style.display = view === 'responsibilities' ? '' : 'none';
    if (view === 'users') runAsync(() => loadUsers(), '用户列表加载失败');
    else if (view === 'responsibilities') runAsync(() => loadResponsibilities(), '岗位分工加载失败');
    else runAsync(() => refresh(), '任务列表刷新失败');
  });
});

/* ---------------- 账号 ---------------- */

$('#btnLogout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  } catch (e) { toast(e.message || '退出失败，请稍后重试', 'err'); }
});
$('#btnPwd').addEventListener('click', () => { $('#pwOld').value = ''; $('#pwNew').value = ''; openModal('#pwdModal'); });
$('#btnSavePwd').addEventListener('click', async () => {
  try {
    await api('/api/auth/password', { method: 'POST', body: { oldPassword: $('#pwOld').value, newPassword: $('#pwNew').value } });
    toast('密码修改成功', 'ok');
    closeModal('#pwdModal');
  } catch (e) { toast(e.message, 'err'); }
});

/* ---------------- 事件委托分发 ----------------
 * CSP 禁止内联事件处理器（script-src 'self'），所有渲染出的按钮/复选框
 * 均以 data-action / data-id / data-value / data-index 描述意图，
 * 由文档级委托统一分发。 */

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id !== undefined ? Number(el.dataset.id) : null;
  if (action === 'show-detail') showDetail(id);
  else if (action === 'del-task') delTask(id, el);
  else if (action === 'mark-done') markDone(id);
  else if (action === 'return-task') returnTask(id);
  else if (action === 'confirm-completion') confirmCompletion(id);
  else if (action === 'reopen-task') reopenTask(id);
  else if (action === 'remove-task') removeTask(id);
  else if (action === 'edit-task') editTask(id);
  else if (action === 'edit-user') editUser(id);
  else if (action === 'toggle-user') toggleUser(id, Number(el.dataset.value));
  else if (action === 'del-user') delUser(id);
  else if (action === 'edit-responsibility') editResponsibility(id);
  else if (action === 'rm-done-file') rmDoneFile(Number(el.dataset.index));
  else if (action === 'rm-file') rmFile(Number(el.dataset.index));
  else if (action === 'trigger-dt-files') $('#dtFiles').click();
  else if (action === 'load-more') runAsync(() => loadMoreTasks(), '加载更多失败，请稍后重试');
});

document.addEventListener('change', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'toggle-sel') toggleSel(Number(el.dataset.id), el.checked);
  else if (action === 'toggle-all') toggleAll(el.checked);
});

/* ---------------- 自动刷新 ----------------
 * 每 30 秒自动刷新任务，执行者可及时看到新派发的任务。
 * 递归 setTimeout + 在途标记：上一轮未完成时跳过本轮，避免请求堆积重入。 */

let autoRefreshInFlight = false;
function scheduleAutoRefresh() {
  setTimeout(async () => {
    if ($('#view-tasks').style.display !== 'none' && !$$('.modal-mask.show').length && !autoRefreshInFlight) {
      autoRefreshInFlight = true;
      try {
        await refresh();
      } catch (error) {
        console.error('自动刷新失败', error);
      } finally {
        autoRefreshInFlight = false;
      }
    }
    scheduleAutoRefresh();
  }, 30000);
}
scheduleAutoRefresh();

/* ---------------- 启动 ---------------- */

$$('select').forEach(enhanceSelect);
initCategoryCombo();
runAsync(() => init(), '工作台初始化失败，请刷新页面重试');
