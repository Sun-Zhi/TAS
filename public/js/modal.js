/* ============ 弹窗：打开/关闭/确认框/焦点圈 ============ */
'use strict';

// 弹窗内首个可聚焦元素：供 openModal 自动聚焦、以及「点击遮罩外部不关闭」时把焦点拉回弹窗内使用
function firstFocusable(mask) {
  return mask.querySelector('[autofocus], input:not([type="hidden"]):not([hidden]):not([disabled]), textarea:not([hidden]):not([disabled]), .round-select-trigger:not([hidden]):not([disabled]), button:not([hidden]):not([disabled])');
}

function openModal(id) {
  const mask = $(id);
  mask._returnFocus = document.activeElement;
  mask.classList.add('show');
  mask.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    // :not([hidden]) 排除带 hidden 属性的元素（如详情弹窗中 hidden 的上传控件），
    // 否则 focus() 落空，键盘用户无法感知弹窗已打开
    const target = firstFocusable(mask);
    if (target) target.focus();
  });
}

let confirmResolver = null;

function closeModal(id) {
  const mask = $(id);
  if (!mask || !mask.classList.contains('show')) return;
  if (id === '#confirmModal' && confirmResolver) {
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(false);
  }
  if (id === '#taskModal' && typeof closeDuePicker === 'function') closeDuePicker();
  mask.classList.remove('show');
  mask.setAttribute('aria-hidden', 'true');
  if (mask._returnFocus && document.contains(mask._returnFocus)) mask._returnFocus.focus();
}

function settleConfirm(value) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  closeModal('#confirmModal');
  resolve(value);
}

function askConfirm(message, title = '请确认', confirmText = '确认') {
  if (confirmResolver) settleConfirm(false);
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#btnConfirmAction').textContent = confirmText;
  openModal('#confirmModal');
  return new Promise((resolve) => { confirmResolver = resolve; });
}

$('#btnConfirmAction').addEventListener('click', () => settleConfirm(true));

$$('.modal-mask').forEach((mask) => {
  mask.addEventListener('click', (e) => {
    // 弹窗内的「关闭 / 取消」按钮（data-close 属性）始终可关闭弹窗
    if (e.target.hasAttribute('data-close')) { closeModal('#' + mask.id); return; }
    // 标记 data-close-on-mask="never" 的弹窗（如任务编辑/发布）禁止点击遮罩外部关闭，
    // 避免误触丢失已填写内容；同时把焦点拉回弹窗内首个可聚焦元素，保持 aria-modal 语义，
    // 避免键盘用户点外部后焦点落到 <body> 需要多按几次 Tab。
    if (mask.getAttribute('data-close-on-mask') === 'never') {
      // 只有真正点到遮罩空白处（e.target === mask）才拉回焦点；
      // 点弹窗内部任何元素（输入框、按钮等）时不抢焦点，否则表单填不了。
      if (e.target === mask) {
        const f = firstFocusable(mask);
        if (f && document.activeElement !== f) f.focus();
      }
      return;
    }
    if (e.target === mask) closeModal('#' + mask.id);
  });
});

document.addEventListener('keydown', (e) => {
  const shown = $$('.modal-mask.show');
  const mask = shown[shown.length - 1];
  const dpOpen = typeof duePicker !== 'undefined' && duePicker.open;
  if (!mask || dpOpen) return;
  if (e.key === 'Escape') {
    // 上传中（进度条可见）不允许通过 Esc 关闭弹窗，避免打断上传流程
    const uploading = Boolean(mask.querySelector('#tfUploadStatus:not([hidden]), #doneUploadStatus:not([hidden])'));
    if (uploading) return;
    e.preventDefault();
    closeModal('#' + mask.id);
    return;
  }
  if (e.key !== 'Tab') return;
  const focusable = $$(`#${mask.id} button:not([disabled]), #${mask.id} input:not([type="hidden"]):not([disabled]), #${mask.id} textarea:not([disabled]), #${mask.id} .round-select-trigger:not([disabled]), #${mask.id} a[href]`)
    .filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
