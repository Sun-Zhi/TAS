/* ============ 任务操作：完成申请 / 退回 / 确认 / 重新开启 / 删除 / 编辑 ============ */
'use strict';

/* ---------------- 完成申请（标记执行完成） ---------------- */

let donePendingFiles = [];
let doneUploadController = null;
$('#btnCancelDoneUpload').addEventListener('click', () => {
  if (doneUploadController) doneUploadController.abort();
});

function renderDoneFiles() {
  $('#doneFileList').innerHTML = donePendingFiles.map((file, index) => `<div class="file-item">
    <span>📤</span><span class="fname">${esc(file.name)}</span>
    <span class="fsize">${fileSize(file.size)}</span>
    <button class="rm" data-action="rm-done-file" data-index="${index}" aria-label="移除附件 ${esc(file.name)}">&times;</button></div>`).join('');
}

function addDoneFiles(files) {
  for (const file of files) {
    if (donePendingFiles.length >= 10) { toast('最多上传 10 个成果附件', 'err'); break; }
    if (file.size > MAX_ATTACHMENT_BYTES) { toast(`「${file.name}」超过 50MB，不能上传`, 'err'); continue; }
    donePendingFiles.push(file);
  }
  renderDoneFiles();
}

function rmDoneFile(index) {
  donePendingFiles.splice(index, 1);
  renderDoneFiles();
}

const doneDropzone = $('#doneDropzone');
doneDropzone.addEventListener('click', () => $('#doneFiles').click());
doneDropzone.addEventListener('dragover', (event) => { event.preventDefault(); doneDropzone.classList.add('over'); });
doneDropzone.addEventListener('dragleave', () => doneDropzone.classList.remove('over'));
doneDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  doneDropzone.classList.remove('over');
  addDoneFiles(Array.from(event.dataTransfer.files));
});
$('#doneFiles').addEventListener('change', (event) => {
  addDoneFiles(Array.from(event.target.files));
  event.target.value = '';
});

function markDone(id) {
  const t = state.tasks.find((x) => x.id === id);
  $('#doneTaskInfo').innerHTML = t
    ? `<b>T${String(t.id).padStart(4, '0')} · ${esc(t.title)}</b>
       <div class="cell-sub" style="margin-top:4px">执行人 ${esc(t.assignee_name)}　·　已进行 ${elapsed(t.created_at)}</div>`
    : `<b>任务 T${String(id).padStart(4, '0')}</b>`;
  $('#doneNote').value = '';
  donePendingFiles = [];
  renderDoneFiles();
  $('#doneUploadStatus').hidden = true;
  $('#btnConfirmDone').dataset.taskId = id;
  openModal('#doneModal');
}

function returnTask(id) {
  const t = state.tasks.find((task) => task.id === id);
  $('#returnTaskInfo').innerHTML = t
    ? `<b>T${String(t.id).padStart(4, '0')} · ${esc(t.title)}</b>
       <div class="cell-sub" style="margin-top:4px">发布者 ${esc(t.creator_name)}　·　执行人 ${esc(t.assignee_name)}</div>`
    : `<b>任务 T${String(id).padStart(4, '0')}</b>`;
  $('#returnReason').value = '';
  $('#btnConfirmReturn').dataset.taskId = id;
  openModal('#returnModal');
  $('#returnReason').focus();
}

$('#btnConfirmReturn').addEventListener('click', async () => {
  const id = $('#btnConfirmReturn').dataset.taskId;
  const reason = $('#returnReason').value.trim();
  if (!reason) return toast('请填写退回理由', 'err');

  const button = $('#btnConfirmReturn');
  button.disabled = true;
  try {
    await api(`/api/tasks/${id}/return`, { method: 'POST', body: { reason } });
    toast('任务已退回给发布者', 'ok');
    closeModal('#returnModal');
    closeModal('#detailModal');
    runAsync(() => refresh(), '任务列表刷新失败');
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
  }
});

$('#btnConfirmDone').addEventListener('click', async () => {
  const id = $('#btnConfirmDone').dataset.taskId;
  const btn = $('#btnConfirmDone');
  const oversized = donePendingFiles.find((file) => file.size > MAX_ATTACHMENT_BYTES);
  if (oversized) return toast(`「${oversized.name}」超过 50MB，不能上传`, 'err');
  const formData = new FormData();
  formData.append('result_note', $('#doneNote').value.trim());
  donePendingFiles.forEach((file) => formData.append('files', file));
  doneUploadController = new AbortController();
  const originalText = btn.textContent;
  btn.disabled = true;
  $('#doneUploadStatus').hidden = false;
  $('#doneUploadText').textContent = '准备提交完成申请...';
  $('#doneUploadBar').style.width = '0%';
  $$('#doneModal [data-close]').forEach((closeButton) => { closeButton.disabled = true; });
  try {
    await uploadForm(`/api/tasks/${id}/completion-request`, formData, {
      signal: doneUploadController.signal,
      onProgress: (progress) => {
        $('#doneUploadText').textContent = uploadProgressText(progress);
        $('#doneUploadBar').style.width = `${progress.percent}%`;
        btn.textContent = `提交中 ${progress.percent}%`;
      },
      onUploaded: () => {
        $('#doneUploadText').textContent = '材料已发送，正在提交申请...';
        $('#doneUploadBar').style.width = '100%';
        btn.textContent = '正在提交...';
      },
    });
    toast('完成申请已提交，等待发布者确认', 'ok');
    closeModal('#doneModal');
    closeModal('#detailModal');
    donePendingFiles = [];
    runAsync(() => refresh(), '任务列表刷新失败');
  } catch (e) { toast(e.message, 'err'); }
  finally {
    doneUploadController = null;
    btn.disabled = false;
    btn.textContent = originalText;
    $('#doneUploadStatus').hidden = true;
    $$('#doneModal [data-close]').forEach((closeButton) => { closeButton.disabled = false; });
  }
});

async function confirmCompletion(id) {
  if (!await askConfirm('执行人已提交完成申请。确认后任务将正式完成并记录耗时。', '确认任务完成', '确认完成')) return;
  try {
    const result = await api('/api/tasks/' + id, { method: 'PATCH', body: { status: 'completed' } });
    toast(`任务已确认完成，本次耗时 ${result.duration_text}`, 'ok');
    closeModal('#detailModal');
    runAsync(() => refresh(), '任务列表刷新失败');
  } catch (error) { toast(error.message, 'err'); }
}

async function reopenTask(id) {
  if (!await askConfirm('完成时间与耗时将被清空。', '重新开启任务', '确认重新开启')) return;
  try {
    await api('/api/tasks/' + id, { method: 'PATCH', body: { status: 'in_progress' } });
    toast('任务已重新开启', 'ok');
    closeModal('#detailModal');
    runAsync(() => refresh(), '任务列表刷新失败');
  } catch (e) { toast(e.message, 'err'); }
}

async function removeTask(id) {
  if (!await askConfirm('任务及其附件将被一并删除，删除后不可恢复。', '删除任务', '确认删除')) return;
  try {
    await api('/api/tasks/' + id, { method: 'DELETE' });
    toast('任务已删除', 'ok');
    closeModal('#detailModal');
    runAsync(() => refresh(), '任务列表刷新失败');
  } catch (e) { toast(e.message, 'err'); }
}

async function openTaskEditor(id) {
  const { task: t } = await api('/api/tasks/' + id);
  closeModal('#detailModal');
  const isReturned = Boolean(t.returned);
  $('#taskModalTitle').textContent = isReturned ? '编辑并重新派发任务' : '编辑任务';
  $('#tfId').value = t.id;
  $('#tfTitle').value = t.title;
  $('#tfDesc').value = t.description || '';
  $('#tfAssignee').value = t.assignee_id;
  $('#tfCategory').value = t.category;
  $('#tfPriority').value = t.priority;
  syncRoundSelects();
  setDue(t.due_at);
  $('#tfDue').dataset.original = $('#tfDue').value;
  // 记录任务是否已退回：#btnSaveTask 据此对重新派发校验截止时间
  $('#tfDue').dataset.returned = isReturned ? '1' : '';
  $('#tfFileField').style.display = 'none';
  $('#btnSaveTask').textContent = isReturned ? '保存并重新派发' : '保存修改';
  openModal('#taskModal');
}

function editTask(id) {
  runAsync(() => openTaskEditor(id), '任务加载失败，暂时无法编辑');
}

/* ---------------- 删除（单条 + 批量） ---------------- */

function canDelete(t) {
  return state.me.role === 'admin' || t.creator_id === state.me.id;
}

// 事件委托中 currentTarget 恒为 document，因此按钮元素由委托处理器显式传入。
async function delTask(id, buttonEl) {
  if (!await askConfirm('附件将一并清除，删除后不可恢复。', '删除任务', '确认删除')) return;
  const originalText = buttonEl ? buttonEl.textContent : '';
  if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = '删除中...'; }
  try {
    await api('/api/tasks/' + id, { method: 'DELETE' });
    state.selectedIds.delete(id);
    toast('任务已删除', 'ok');
    runAsync(() => refresh(), '任务列表刷新失败');
  } catch (e) { toast(e.message, 'err'); }
  finally {
    if (buttonEl && document.contains(buttonEl)) { buttonEl.disabled = false; buttonEl.textContent = originalText; }
  }
}

$('#btnBatchDel').addEventListener('click', async () => {
  // 只提交有权限删除的 ID
  const ids = [...state.selectedIds].filter((id) => {
    const t = state.tasks.find((x) => x.id === id);
    return t && canDelete(t);
  });
  if (!ids.length) return;
  if (!await askConfirm(`将删除选中的 ${ids.length} 个任务及其附件，删除后不可恢复。`, '批量删除任务', '确认删除')) return;
  const btn = $('#btnBatchDel');
  btn.disabled = true;
  renderBatchDeleteButton(0, true);
  // 并发发起删除，allSettled 保证单个失败不影响其余任务
  const results = await Promise.allSettled(ids.map((id) => api('/api/tasks/' + id, { method: 'DELETE' })));
  const ok = results.filter((result) => result.status === 'fulfilled').length;
  const fail = results.length - ok;
  state.selectedIds.clear();
  btn.disabled = false;
  renderBatchDeleteButton(0);
  toast(`已删除 ${ok} 个任务${fail ? `，${fail} 个失败` : ''}`, ok > 0 ? 'ok' : 'err');
  runAsync(() => refresh(), '任务列表刷新失败');
});

/* ---------------- 新建任务表单的待上传附件列表 ---------------- */

function renderPendingFiles() {
  $('#fileList').innerHTML = state.pendingFiles.map((f, i) => `<div class="file-item">
    <span>📎</span><span class="fname">${esc(f.name)}</span>
    <span class="fsize">${fileSize(f.size)}</span>
    <button class="rm" data-action="rm-file" data-index="${i}" aria-label="移除附件 ${esc(f.name)}">&times;</button></div>`).join('');
}

function rmFile(index) {
  state.pendingFiles.splice(index, 1);
  renderPendingFiles();
}
