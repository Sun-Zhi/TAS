/* ============ 任务分配系统 · 工作台逻辑 ============ */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const ROLE_TEXT = { admin: '管理员', assigner: '任务分配者', executor: '任务执行者' };
const PRI_TEXT = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const STATUS_TEXT = { in_progress: '执行中', completed: '已完成' };
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const state = {
  me: null,
  tasks: [],
  taskTotal: 0,
  executors: [],
  users: [],
  filters: { status: '', assignee_id: '', category: '', q: '' },
  pendingFiles: [],
  selectedIds: new Set(),
};

/* ---------------- 工具 ---------------- */

function toast(msg, type) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + (type || '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = ''), 2800);
}

function runAsync(action, fallbackMessage = '操作失败，请稍后重试') {
  return Promise.resolve()
    .then(action)
    .catch((error) => {
      console.error(error);
      toast(error && error.message ? error.message : fallbackMessage, 'err');
    });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(iso, withTime = true) {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

function fileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function elapsed(fromISO) {
  const ms = Date.now() - new Date(fromISO).getTime();
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d) return `${d}天${h}小时`;
  if (h) return `${h}小时${m}分`;
  return `${m}分`;
}

async function api(url, options = {}) {
  const opt = { credentials: 'same-origin', ...options };
  if (opt.body && !(opt.body instanceof FormData)) {
    opt.headers = { 'Content-Type': 'application/json', ...(opt.headers || {}) };
    opt.body = typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body);
  }
  const res = await fetch(url, opt);
  if (res.status === 401) { location.href = '/login.html'; throw new Error('未登录'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || '请求失败');
  return data;
}

function uploadForm(url, formData, { onProgress, onUploaded, signal, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (action) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', abortUpload);
      action();
    };
    const abortUpload = () => xhr.abort();

    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.timeout = timeoutMs;
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress({ loaded: event.loaded, total: event.total, percent: Math.min(100, Math.round(event.loaded / event.total * 100)) });
    });
    xhr.upload.addEventListener('load', () => { if (onUploaded) onUploaded(); });
    xhr.addEventListener('load', () => finish(() => {
      const contentType = xhr.getResponseHeader('content-type') || '';
      let data = xhr.responseText;
      if (contentType.includes('json')) {
        try { data = JSON.parse(xhr.responseText || '{}'); } catch { data = {}; }
      }
      if (xhr.status === 401) {
        location.href = '/login.html';
        return reject(new Error('未登录'));
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        return reject(new Error((data && data.error) || `上传失败（HTTP ${xhr.status}）`));
      }
      resolve(data);
    }));
    xhr.addEventListener('error', () => finish(() => reject(new Error('上传连接中断，请检查网络后重试'))));
    xhr.addEventListener('timeout', () => finish(() => reject(new Error('上传超过 30 分钟，已自动停止'))));
    xhr.addEventListener('abort', () => finish(() => reject(new Error('上传已取消'))));

    if (signal) {
      if (signal.aborted) return finish(() => reject(new Error('上传已取消')));
      signal.addEventListener('abort', abortUpload, { once: true });
    }
    xhr.send(formData);
  });
}

function uploadProgressText({ loaded, total, percent }) {
  return `上传中 ${percent}% · ${fileSize(loaded)} / ${fileSize(total)}`;
}

/* ---------------- 自定义日期时间选择器 ---------------- */
const duePicker = { open: false, view: new Date(), selected: null, focused: null, hour: '09', minute: '00' };
const DUE_STEP_MINUTES = 5;
function pad2(n) { return String(n).padStart(2, '0'); }

function dateAtMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function sameDate(a, b) {
  return Boolean(a && b) && a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function nextFutureDue(from = new Date()) {
  const next = new Date(from.getTime() + DUE_STEP_MINUTES * 60 * 1000);
  next.setSeconds(0, 0);
  const remainder = next.getMinutes() % DUE_STEP_MINUTES;
  if (remainder) next.setMinutes(next.getMinutes() + DUE_STEP_MINUTES - remainder);
  return next;
}

function pickerDateTime() {
  if (!duePicker.selected) return null;
  return new Date(
    duePicker.selected.getFullYear(),
    duePicker.selected.getMonth(),
    duePicker.selected.getDate(),
    Number(duePicker.hour),
    Number(duePicker.minute),
    0,
    0
  );
}

function changeDuePickerMonth(delta) {
  const y = duePicker.view.getFullYear();
  const m = duePicker.view.getMonth();
  const focusDay = duePicker.focused ? duePicker.focused.getDate() : 1;
  // 先落到目标月 1 日，避免 29-31 日调用 setMonth 时溢出到下下个月。
  const earliest = nextFutureDue();
  const minimumMonth = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
  let target = new Date(y, m + delta, 1);
  if (target < minimumMonth) target = minimumMonth;
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  duePicker.view = target;
  duePicker.focused = new Date(target.getFullYear(), target.getMonth(), Math.min(focusDay, lastDay));
}

function focusDueDay() {
  const day = $('#dpDays .dp-day[tabindex="0"]');
  if (day) day.focus();
}

function initDuePicker() {
  const display = $('#tfDueDisplay');
  const picker = $('#tfDuePicker');
  const hourSel = $('#dpHour');
  const minuteSel = $('#dpMinute');
  hourSel.innerHTML = '';
  minuteSel.innerHTML = '';
  for (let i = 0; i < 24; i++) hourSel.append(new Option(pad2(i) + '时', pad2(i)));
  for (let i = 0; i < 60; i += 5) minuteSel.append(new Option(pad2(i) + '分', pad2(i)));

  // 将面板挂到 body，避免被任务弹窗的滚动区域裁剪。
  document.body.appendChild(picker);

  display.addEventListener('click', (e) => {
    e.stopPropagation();
    if (duePicker.open) closeDuePicker(); else openDuePicker();
  });
  display.addEventListener('keydown', (e) => {
    if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      openDuePicker();
    }
  });
  picker.addEventListener('click', (e) => e.stopPropagation());
  picker.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(picker.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), select:not([disabled])'))
      .filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('click', () => closeDuePicker());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && duePicker.open) {
      closeDuePicker();
      display.focus();
    }
  });
  window.addEventListener('resize', () => duePicker.open && positionDuePicker());
  window.addEventListener('scroll', () => duePicker.open && positionDuePicker(), true);

  $('#dpDays').addEventListener('click', (e) => {
    const cell = e.target.closest('.dp-day');
    if (!cell || cell.disabled) return;
    duePicker.selected = new Date(duePicker.view.getFullYear(), duePicker.view.getMonth(), Number(cell.dataset.day));
    duePicker.focused = dateAtMidnight(duePicker.selected);
    syncDueTimeInputs();
    renderDuePicker(true);
  });

  $('#dpDays').addEventListener('focusin', (e) => {
    const cell = e.target.closest('.dp-day');
    if (cell) duePicker.focused = new Date(duePicker.view.getFullYear(), duePicker.view.getMonth(), Number(cell.dataset.day));
  });

  $('#dpDays').addEventListener('keydown', (e) => {
    const cell = e.target.closest('.dp-day');
    if (!cell) return;
    const current = new Date(duePicker.view.getFullYear(), duePicker.view.getMonth(), Number(cell.dataset.day));
    let next = null;
    if (e.key === 'ArrowLeft') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
    else if (e.key === 'ArrowRight') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
    else if (e.key === 'ArrowUp') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 7);
    else if (e.key === 'ArrowDown') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 7);
    else if (e.key === 'Home') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() - current.getDay());
    else if (e.key === 'End') next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + (6 - current.getDay()));
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      duePicker.focused = current;
      changeDuePickerMonth((e.key === 'PageUp' ? -1 : 1) * (e.shiftKey ? 12 : 1));
      e.preventDefault();
      renderDuePicker(true);
      return;
    }
    if (!next) return;
    e.preventDefault();
    const minimumDay = dateAtMidnight(nextFutureDue());
    if (next < minimumDay) next = minimumDay;
    duePicker.focused = next;
    duePicker.view = new Date(next.getFullYear(), next.getMonth(), 1);
    renderDuePicker(true);
  });

  $$('#tfDuePicker .dp-nav').forEach((btn) => {
    btn.addEventListener('click', () => {
      changeDuePickerMonth(btn.dataset.dp === 'prev' ? -1 : 1);
      renderDuePicker();
    });
  });

  $('#dpHour').addEventListener('change', (e) => {
    duePicker.hour = e.target.value;
    syncDueTimeInputs();
  });
  $('#dpMinute').addEventListener('change', (e) => { duePicker.minute = e.target.value; });

  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dp]');
    if (!btn || btn.classList.contains('dp-nav')) return;
    const action = btn.dataset.dp;
    if (action === 'today') {
      const next = nextFutureDue();
      duePicker.selected = next;
      duePicker.focused = dateAtMidnight(next);
      duePicker.view = new Date(next.getFullYear(), next.getMonth(), 1);
      duePicker.hour = pad2(next.getHours());
      duePicker.minute = pad2(next.getMinutes());
      syncDueTimeInputs();
      renderDuePicker();
    } else if (action === 'clear') {
      clearDue();
      closeDuePicker(true);
    } else if (action === 'ok') {
      if (commitDue()) closeDuePicker(true);
    }
  });
}

function openDuePicker() {
  duePicker.open = true;
  const val = $('#tfDue').value;
  if (val && new Date(val).getTime() > Date.now()) {
    const d = new Date(val);
    duePicker.selected = new Date(d);
    duePicker.focused = dateAtMidnight(d);
    duePicker.view = new Date(d.getFullYear(), d.getMonth(), 1);
    duePicker.hour = pad2(d.getHours());
    duePicker.minute = pad2(d.getMinutes());
  } else {
    const next = nextFutureDue();
    duePicker.selected = next;
    duePicker.focused = dateAtMidnight(next);
    duePicker.view = new Date(next.getFullYear(), next.getMonth(), 1);
    duePicker.hour = pad2(next.getHours());
    duePicker.minute = pad2(next.getMinutes());
  }
  syncDueTimeInputs();
  renderDuePicker();
  const modalBody = $('#tfDueDisplay').closest('.modal-body');
  if (modalBody) {
    modalBody.classList.add('due-picker-open');
    modalBody.style.setProperty('--due-picker-space', `${$('#tfDuePicker').offsetHeight + 16}px`);
  }
  positionDuePicker();
  $('#tfDuePicker').classList.add('open');
  $('#tfDuePicker').setAttribute('aria-hidden', 'false');
  $('#tfDueDisplay').setAttribute('aria-expanded', 'true');
  requestAnimationFrame(focusDueDay);
}

function closeDuePicker(restoreFocus = false) {
  duePicker.open = false;
  $('#tfDuePicker').classList.remove('open');
  $('#tfDuePicker').setAttribute('aria-hidden', 'true');
  $('#tfDueDisplay').setAttribute('aria-expanded', 'false');
  const modalBody = $('#tfDueDisplay').closest('.modal-body');
  if (modalBody) {
    modalBody.classList.remove('due-picker-open');
    modalBody.style.removeProperty('--due-picker-space');
  }
  if (restoreFocus) $('#tfDueDisplay').focus();
}

function positionDuePicker() {
  const display = $('#tfDueDisplay');
  let displayRect = display.getBoundingClientRect();
  const picker = $('#tfDuePicker');
  const gap = 8, margin = 12;
  const pickerWidth = picker.offsetWidth;
  const pickerHeight = picker.offsetHeight;
  let bottomSpace = window.innerHeight - displayRect.bottom - gap - margin;
  let topSpace = displayRect.top - gap - margin;

  // 小屏弹窗中上下都放不下时，把触发框滚到内容区顶部，为面板留出完整空间。
  if (pickerHeight > bottomSpace && pickerHeight > topSpace) {
    const modalBody = display.closest('.modal-body');
    if (modalBody) {
      const bodyRect = modalBody.getBoundingClientRect();
      const targetTop = bodyRect.top + 8;
      modalBody.scrollTop += displayRect.top - targetTop;
      displayRect = display.getBoundingClientRect();
      bottomSpace = window.innerHeight - displayRect.bottom - gap - margin;
      topSpace = displayRect.top - gap - margin;
    }
  }
  const placeAbove = pickerHeight > bottomSpace && topSpace > bottomSpace;

  let top = placeAbove ? displayRect.top - pickerHeight - gap : displayRect.bottom + gap;
  let left = displayRect.left;
  top = Math.max(margin, Math.min(top, window.innerHeight - pickerHeight - margin));
  left = Math.max(margin, Math.min(left, window.innerWidth - pickerWidth - margin));

  picker.classList.toggle('place-above', placeAbove);
  picker.style.top = `${Math.round(top)}px`;
  picker.style.left = `${Math.round(left)}px`;
}

function syncDueTimeInputs() {
  const hourSelect = $('#dpHour');
  const minuteSelect = $('#dpMinute');
  const earliest = nextFutureDue();
  const onEarliestDay = sameDate(duePicker.selected, earliest);

  if (onEarliestDay && pickerDateTime() < earliest) {
    duePicker.hour = pad2(earliest.getHours());
    duePicker.minute = pad2(earliest.getMinutes());
  }

  Array.from(hourSelect.options).forEach((option) => {
    option.disabled = onEarliestDay && Number(option.value) < earliest.getHours();
  });
  Array.from(minuteSelect.options).forEach((option) => {
    option.disabled = onEarliestDay && Number(duePicker.hour) === earliest.getHours() &&
      Number(option.value) < earliest.getMinutes();
  });
  hourSelect.value = duePicker.hour;
  minuteSelect.value = duePicker.minute;
}

function renderDuePicker(restoreFocus = false) {
  const y = duePicker.view.getFullYear(), m = duePicker.view.getMonth();
  $('#dpTitle').textContent = `${y}年${pad2(m + 1)}月`;
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  let html = '';
  const today = dateAtMidnight(new Date());
  const minimumDay = dateAtMidnight(nextFutureDue());
  const minimumMonth = new Date(minimumDay.getFullYear(), minimumDay.getMonth(), 1);
  $('#tfDuePicker [data-dp="prev"]').disabled = new Date(y, m, 1) <= minimumMonth;
  let focusDate = duePicker.focused;
  if (focusDate && focusDate < minimumDay) focusDate = minimumDay;
  if (!focusDate || focusDate.getFullYear() !== y || focusDate.getMonth() !== m) {
    focusDate = duePicker.selected && duePicker.selected.getFullYear() === y && duePicker.selected.getMonth() === m
      ? dateAtMidnight(duePicker.selected)
      : (today.getFullYear() === y && today.getMonth() === m ? today : new Date(y, m, 1));
    duePicker.focused = focusDate;
  }
  for (let i = 0; i < firstDay; i++) html += '<span class="dp-day empty" aria-hidden="true"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const cls = [];
    const cur = new Date(y, m, d);
    const disabled = cur < minimumDay;
    const selected = sameDate(cur, duePicker.selected);
    if (selected) cls.push('selected');
    if (sameDate(cur, today)) cls.push('today');
    if (disabled) cls.push('disabled');
    const tabIndex = !disabled && sameDate(cur, focusDate) ? 0 : -1;
    html += `<button type="button" role="gridcell" class="dp-day ${cls.join(' ')}" data-day="${d}" tabindex="${tabIndex}" aria-selected="${selected}" aria-label="${y}年${m + 1}月${d}日${disabled ? '，不可选择' : ''}" ${disabled ? 'disabled' : ''}>${d}</button>`;
  }
  $('#dpDays').innerHTML = html;
  syncDueTimeInputs();
  if (restoreFocus) requestAnimationFrame(focusDueDay);
}

function commitDue() {
  if (!duePicker.selected) { toast('请先选择日期', 'err'); return false; }
  const selected = pickerDateTime();
  if (!selected || selected.getTime() <= Date.now()) {
    toast('要求完成时间必须晚于当前时间', 'err');
    const next = nextFutureDue();
    duePicker.selected = next;
    duePicker.focused = dateAtMidnight(next);
    duePicker.view = new Date(next.getFullYear(), next.getMonth(), 1);
    duePicker.hour = pad2(next.getHours());
    duePicker.minute = pad2(next.getMinutes());
    renderDuePicker(true);
    return false;
  }
  const y = duePicker.selected.getFullYear();
  const m = pad2(duePicker.selected.getMonth() + 1);
  const d = pad2(duePicker.selected.getDate());
  const iso = `${y}-${m}-${d}T${duePicker.hour}:${duePicker.minute}`;
  $('#tfDue').value = iso;
  $('#tfDueDisplay').value = `${y}/${m}/${d} ${duePicker.hour}:${duePicker.minute}`;
  return true;
}

function clearDue() {
  $('#tfDue').value = '';
  $('#tfDueDisplay').value = '';
  duePicker.selected = null;
}

function setDue(iso) {
  if (!iso) { clearDue(); return; }
  const local = new Date(iso);
  const y = local.getFullYear(), m = pad2(local.getMonth() + 1), d = pad2(local.getDate());
  const h = pad2(local.getHours()), min = pad2(local.getMinutes());
  const isoLocal = `${y}-${m}-${d}T${h}:${min}`;
  duePicker.selected = new Date(local);
  duePicker.focused = dateAtMidnight(local);
  duePicker.view = new Date(local.getFullYear(), local.getMonth(), 1);
  duePicker.hour = h;
  duePicker.minute = min;
  $('#tfDue').value = isoLocal;
  $('#tfDueDisplay').value = `${y}/${m}/${d} ${h}:${min}`;
  syncDueTimeInputs();
  renderDuePicker();
}

function openModal(id) {
  const mask = $(id);
  mask._returnFocus = document.activeElement;
  mask.classList.add('show');
  mask.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    const target = mask.querySelector('[autofocus], input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])');
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
  if (id === '#taskModal') closeDuePicker();
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
    if (e.target === mask || e.target.hasAttribute('data-close')) closeModal('#' + mask.id);
  });
});

document.addEventListener('keydown', (e) => {
  const shown = $$('.modal-mask.show');
  const mask = shown[shown.length - 1];
  if (!mask || duePicker.open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal('#' + mask.id);
    return;
  }
  if (e.key !== 'Tab') return;
  const focusable = $$(`#${mask.id} button:not([disabled]), #${mask.id} input:not([type="hidden"]):not([disabled]), #${mask.id} textarea:not([disabled]), #${mask.id} select:not([disabled]), #${mask.id} a[href]`)
    .filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

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
  } else if (me.role === 'assigner') {
    $('#scopeDesc').textContent = '分配者视角 · 展示我创建并派发的任务';
  } else {
    $('#scopeDesc').textContent = '执行者视角 · 展示派发给我的任务';
  }
  if (me.role === 'admin' || me.role === 'assigner') $('#btnNewTask').style.display = '';
  if (me.role === 'executor') $('#fAssignee').style.display = 'none';

  await loadExecutors();
  await refresh();
  initDuePicker();
}

async function loadExecutors() {
  const { users } = await api('/api/users/executors');
  state.executors = users;
  const opts = users.map((u) => `<option value="${u.id}">${esc(u.name)}${u.dept ? ' · ' + esc(u.dept) : ''}</option>`).join('');
  $('#tfAssignee').innerHTML = '<option value="">请选择执行人</option>' + opts;
  $('#fAssignee').innerHTML = '<option value="">全部执行者</option>' + opts;
  $('#exAssignee').innerHTML = '<option value="">全部执行者</option>' + opts;
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
    <div class="stat green"><div class="k">已完成</div><div class="v">${s.done}</div></div>
    <div class="stat red"><div class="k">已逾期</div><div class="v">${s.overdue}</div></div>
    <div class="stat"><div class="k">平均完成耗时</div><div class="v sm">${esc(s.avg_duration_text)}</div></div>`;

  const showNotice = state.me.role !== 'executor' && s.pending_confirmation > 0;
  $('#completionNotice').hidden = !showNotice;
  $('#completionNoticeCount').textContent = String(s.pending_confirmation || 0);
}

async function loadTasks() {
  const p = new URLSearchParams();
  Object.entries(state.filters).forEach(([k, v]) => { if (v) p.set(k, v); });
  const result = await api('/api/tasks?' + p.toString());
  const tasks = Array.isArray(result.tasks) ? result.tasks : [];
  state.tasks = tasks;
  const total = result.total === undefined || result.total === null || result.total === '' ? NaN : Number(result.total);
  state.taskTotal = Number.isFinite(total) ? total : tasks.length;
  renderTasks();
  await loadCategories();
}

async function loadCategories() {
  const { categories } = await api('/api/tasks/categories');
  const cur = state.filters.category;
  $('#fCategory').innerHTML = '<option value="">全部类别</option>' +
    categories.map((c) => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
  $('#catList').innerHTML = categories.map((c) => `<option value="${esc(c)}">`).join('');
}

/* ---------------- 任务列表渲染 ---------------- */

function canDelete(t) {
  return state.me.role === 'admin' || t.creator_id === state.me.id;
}

function renderTasks() {
  const list = state.tasks;
  $('#taskCount').textContent = `当前显示 ${list.length} / 共 ${state.taskTotal} 条`;

  if (!list.length) {
    $('#taskTableWrap').innerHTML =
      `<div class="empty"><div class="ico">📋</div>暂无任务${state.me.role === 'executor' ? '，当前没有派发给你的任务' : ''}</div>`;
    $('#btnBatchDel').style.display = 'none';
    return;
  }

  const hasDelPerm = list.some((t) => canDelete(t));
  const allSel = list.length > 0 && list.every((t) => state.selectedIds.has(t.id));

  const rows = list.map((t) => {
    const statusBadge = t.status === 'completed'
      ? `<span class="badge done">已完成</span>`
      : t.awaiting_confirmation
        ? `<span class="badge pending"><i class="dot-live"></i>${t.creator_id === state.me.id || state.me.role === 'admin' ? '待您确认' : '待发布者确认'}</span>`
        : t.overdue
        ? `<span class="badge overdue"><i class="dot-live"></i>已逾期</span>`
        : `<span class="badge running"><i class="dot-live"></i>执行中</span>`;

    const timeCell = t.status === 'completed'
      ? `<b style="color:var(--success)">${esc(t.duration_text)}</b><div class="cell-sub">${fmt(t.completed_at)} 完成</div>`
      : t.awaiting_confirmation
        ? `<b style="color:#c4b5fd">已提交完成申请</b><div class="cell-sub">${fmt(t.completion_requested_at)}</div>`
        : `<span style="color:var(--warn)">已进行 ${elapsed(t.created_at)}</span>${t.due_at ? `<div class="cell-sub">要求 ${fmt(t.due_at)}</div>` : ''}`;

    const canRequestDone = t.status === 'in_progress' && !t.awaiting_confirmation &&
      t.assignee_id === state.me.id && state.me.role === 'executor';
    const canConfirmDone = t.awaiting_confirmation &&
      (t.creator_id === state.me.id || state.me.role === 'admin');
    const waitingButton = t.awaiting_confirmation && t.assignee_id === state.me.id
      ? '<button class="btn ghost sm" disabled>等待发布者确认</button>' : '';
    const delBtn = canDelete(t)
      ? `<button class="btn danger sm" onclick="delTask(${t.id},event)" title="删除此任务">删除</button>` : '';

    const checked = state.selectedIds.has(t.id) ? 'checked' : '';
    const selCls = state.selectedIds.has(t.id) ? ' sel' : '';

    return `<tr class="${selCls}" data-id="${t.id}">
      <td class="cb-col"><input type="checkbox" ${checked} onchange="toggleSel(${t.id},this.checked)"></td>
      <td class="tid">T${String(t.id).padStart(4, '0')}</td>
      <td>
        <div class="title-cell" onclick="showDetail(${t.id})">${esc(t.title)}
          ${t.attachment_count ? `<span class="cell-sub">📎${t.attachment_count}</span>` : ''}</div>
        <div class="cell-sub">${esc(t.category)}　创建人：${esc(t.creator_name)}</div>
      </td>
      <td>${esc(t.assignee_name)}<div class="cell-sub">${esc(t.assignee_dept || '')}</div></td>
      <td><span class="pri ${t.priority}">${PRI_TEXT[t.priority]}</span></td>
      <td>${statusBadge}</td>
      <td>${fmt(t.created_at)}</td>
      <td>${timeCell}</td>
      <td style="white-space:nowrap">
        <button class="btn ghost sm" onclick="showDetail(${t.id})">详情</button>
        ${canRequestDone ? `<button class="btn success sm" onclick="markDone(${t.id})">标记完成</button>` : ''}
        ${canConfirmDone ? `<button class="btn success sm" onclick="confirmCompletion(${t.id})">确认完成</button>` : ''}
        ${waitingButton}
        ${delBtn}
      </td>
    </tr>`;
  }).join('');

  const cbHead = hasDelPerm
    ? `<th class="cb-col"><input type="checkbox" id="selAll" ${allSel ? 'checked' : ''} onchange="toggleAll(this.checked)"></th>`
    : '<th class="cb-col"></th>';

  $('#taskTableWrap').innerHTML = `<table class="tbl">
    <thead><tr>
      ${cbHead}
      <th>编号</th><th>任务</th><th>执行人</th><th>优先级</th><th>状态</th><th>创建时间</th><th>耗时 / 进度</th><th>操作</th>
    </tr></thead>
    <tbody>${rows}</tbody></table>`;

  // 批量删除按钮显隐
  updateBatchDelUI();
}

function toggleSel(id, on) {
  if (on) state.selectedIds.add(id); else state.selectedIds.delete(id);
  renderTasks();
}
window.toggleSel = toggleSel;

function toggleAll(on) {
  if (on) state.tasks.forEach((t) => state.selectedIds.add(t.id));
  else state.selectedIds.clear();
  renderTasks();
}
window.toggleAll = toggleAll;

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

async function delTask(id, ev) {
  if (ev) ev.stopPropagation();
  if (!await askConfirm('附件将一并清除，删除后不可恢复。', '删除任务', '确认删除')) return;
  const btn = ev && ev.currentTarget;
  const originalText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '删除中...'; }
  try {
    await api('/api/tasks/' + id, { method: 'DELETE' });
    state.selectedIds.delete(id);
    toast('任务已删除', 'ok');
    runAsync(() => refresh(), '任务列表刷新失败');
  } catch (e) { toast(e.message, 'err'); }
  finally {
    if (btn && document.contains(btn)) { btn.disabled = false; btn.textContent = originalText; }
  }
}
window.delTask = delTask;

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
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      await api('/api/tasks/' + id, { method: 'DELETE' }); ok++;
    } catch { fail++; }
  }
  state.selectedIds.clear();
  btn.disabled = false;
  renderBatchDeleteButton(0);
  toast(`已删除 ${ok} 个任务${fail ? `，${fail} 个失败` : ''}`, ok > 0 ? 'ok' : 'err');
  runAsync(() => refresh(), '任务列表刷新失败');
});

/* ---------------- 任务详情 ---------------- */

async function loadTaskDetail(id) {
  const { task: t, attachments, logs } = await api('/api/tasks/' + id);
  $('#dtTitle').textContent = `T${String(t.id).padStart(4, '0')} · ${t.title}`;

  const statusBadge = t.status === 'completed'
    ? `<span class="badge done">已完成</span>`
    : t.awaiting_confirmation
      ? `<span class="badge pending">${t.creator_id === state.me.id || state.me.role === 'admin' ? '待您确认' : '待发布者确认'}</span>`
      : t.overdue ? `<span class="badge overdue">已逾期</span>` : `<span class="badge running">执行中</span>`;

  const attHtml = attachments.length
    ? attachments.map((a) => `<div class="file-item">
        <span>${a.kind === 'result' ? '📤' : '📎'}</span>
        <span class="fname">${esc(a.orig_name)}</span>
        <span class="fsize">${fileSize(a.size)}</span>
        <a class="btn ghost sm" href="/api/tasks/attachments/${a.id}/download">下载</a>
      </div>`).join('')
    : '<div class="hint">暂无附件</div>';

  // 执行人只在“标记完成”弹窗提交成果附件；任务详情仅供下载。
  const canUpload = t.creator_id === state.me.id || state.me.role === 'admin';

  $('#dtBody').innerHTML = `
    <div class="detail-row"><div class="lb">状态</div><div class="vl">${statusBadge}
      <span class="pri ${t.priority}" style="margin-left:8px">优先级：${PRI_TEXT[t.priority]}</span></div></div>
    <div class="detail-row"><div class="lb">任务类别</div><div class="vl">${esc(t.category)}</div></div>
    <div class="detail-row"><div class="lb">执行人</div><div class="vl">${esc(t.assignee_name)} ${t.assignee_dept ? `<span class="cell-sub">· ${esc(t.assignee_dept)}</span>` : ''}</div></div>
    <div class="detail-row"><div class="lb">创建人</div><div class="vl">${esc(t.creator_name)}</div></div>
    <div class="detail-row"><div class="lb">创建时间</div><div class="vl">${fmt(t.created_at)}</div></div>
    <div class="detail-row"><div class="lb">要求完成</div><div class="vl">${fmt(t.due_at)}</div></div>
    ${t.status === 'completed' ? `
      <div class="detail-row"><div class="lb">完成时间</div><div class="vl">${fmt(t.completed_at)}</div></div>
      <div class="detail-row"><div class="lb">执行耗时</div><div class="vl"><b style="color:var(--success);font-size:15px">${esc(t.duration_text)}</b></div></div>
      ${t.result_note ? `<div class="detail-row"><div class="lb">完成说明</div><div class="vl">${esc(t.result_note)}</div></div>` : ''}
    ` : t.awaiting_confirmation ? `
      <div class="detail-row"><div class="lb">完成申请</div><div class="vl"><b style="color:#c4b5fd">${fmt(t.completion_requested_at)} 已提交</b></div></div>
      <div class="detail-row"><div class="lb">完成说明</div><div class="vl" style="white-space:pre-wrap">${esc(t.completion_request_note) || '<span class="hint">未填写</span>'}</div></div>
    ` : `<div class="detail-row"><div class="lb">已进行</div><div class="vl" style="color:var(--warn)">${elapsed(t.created_at)}</div></div>`}
    <div class="detail-row"><div class="lb">任务描述</div><div class="vl" style="white-space:pre-wrap">${esc(t.description) || '<span class="hint">无</span>'}</div></div>
    <div class="detail-row"><div class="lb">附件</div><div class="vl">
      <div class="file-list">${attHtml}</div>
      ${canUpload ? `<div style="margin-top:8px">
        <input type="file" id="dtFiles" multiple hidden>
        <button class="btn ghost sm" id="dtUploadButton" onclick="document.getElementById('dtFiles').click()">＋ 上传附件</button>
        <button class="btn ghost sm" id="dtCancelUpload" hidden>取消上传</button>
        <span class="hint">单个附件不得超过 50MB</span>
        <span class="hint upload-inline-progress" id="dtUpTip"></span></div>` : ''}
    </div></div>
    <div class="detail-row"><div class="lb">操作记录</div><div class="vl">
      <ul class="timeline">${logs.map((l) => `<li>
        <div class="t-act">${esc(l.detail || l.action)}</div>
        <div class="t-meta">${esc(l.user_name || '系统')} · ${fmt(l.created_at)}</div></li>`).join('') || '<span class="hint">无</span>'}</ul>
    </div></div>`;

  if (canUpload) {
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

  const canEdit = t.creator_id === state.me.id || state.me.role === 'admin';
  const canRequestDone = t.status === 'in_progress' && !t.awaiting_confirmation &&
    t.assignee_id === state.me.id && state.me.role === 'executor';
  const canConfirmDone = t.awaiting_confirmation && canEdit;
  const waitingButton = t.awaiting_confirmation && t.assignee_id === state.me.id
    ? '<button class="btn ghost" disabled>等待发布者确认</button>' : '';

  $('#dtFoot').innerHTML = `
    ${canEdit && t.status === 'completed' ? `<button class="btn ghost" onclick="reopenTask(${t.id})">重新开启</button>` : ''}
    ${canEdit ? `<button class="btn danger" onclick="removeTask(${t.id})">删除任务</button>` : ''}
    ${canEdit && t.status === 'in_progress' && !t.awaiting_confirmation ? `<button class="btn ghost" onclick="editTask(${t.id})">编辑任务</button>` : ''}
    ${canRequestDone ? `<button class="btn success" onclick="markDone(${t.id})">标记执行完成</button>` : ''}
    ${canConfirmDone ? `<button class="btn success" onclick="confirmCompletion(${t.id})">确认完成</button>` : ''}
    ${waitingButton}
    <button class="btn ghost" data-close>关闭</button>`;

  openModal('#detailModal');
}
window.showDetail = (id) => runAsync(() => loadTaskDetail(id), '任务详情加载失败');

/* ---------------- 任务操作 ---------------- */

let donePendingFiles = [];
let doneUploadController = null;
$('#btnCancelDoneUpload').addEventListener('click', () => {
  if (doneUploadController) doneUploadController.abort();
});

function renderDoneFiles() {
  $('#doneFileList').innerHTML = donePendingFiles.map((file, index) => `<div class="file-item">
    <span>📤</span><span class="fname">${esc(file.name)}</span>
    <span class="fsize">${fileSize(file.size)}</span>
    <button class="rm" onclick="rmDoneFile(${index})">&times;</button></div>`).join('');
}

function addDoneFiles(files) {
  for (const file of files) {
    if (donePendingFiles.length >= 10) { toast('最多上传 10 个成果附件', 'err'); break; }
    if (file.size > MAX_ATTACHMENT_BYTES) { toast(`「${file.name}」超过 50MB，不能上传`, 'err'); continue; }
    donePendingFiles.push(file);
  }
  renderDoneFiles();
}

window.rmDoneFile = (index) => {
  donePendingFiles.splice(index, 1);
  renderDoneFiles();
};

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
window.markDone = markDone;

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
window.confirmCompletion = confirmCompletion;

async function reopenTask(id) {
  if (!await askConfirm('完成时间与耗时将被清空。', '重新开启任务', '确认重新开启')) return;
  try {
    await api('/api/tasks/' + id, { method: 'PATCH', body: { status: 'in_progress' } });
    toast('任务已重新开启', 'ok');
    closeModal('#detailModal');
    runAsync(() => refresh(), '任务列表刷新失败');
  } catch (e) { toast(e.message, 'err'); }
}
window.reopenTask = reopenTask;

async function removeTask(id) {
  if (!await askConfirm('任务及其附件将被一并删除，删除后不可恢复。', '删除任务', '确认删除')) return;
  try {
    await api('/api/tasks/' + id, { method: 'DELETE' });
    toast('任务已删除', 'ok');
    closeModal('#detailModal');
    runAsync(() => refresh(), '任务列表刷新失败');
  } catch (e) { toast(e.message, 'err'); }
}
window.removeTask = removeTask;

async function openTaskEditor(id) {
  const { task: t } = await api('/api/tasks/' + id);
  closeModal('#detailModal');
  $('#taskModalTitle').textContent = '编辑任务';
  $('#tfId').value = t.id;
  $('#tfTitle').value = t.title;
  $('#tfDesc').value = t.description || '';
  $('#tfAssignee').value = t.assignee_id;
  $('#tfCategory').value = t.category;
  $('#tfPriority').value = t.priority;
  setDue(t.due_at);
  $('#tfDue').dataset.original = $('#tfDue').value;
  $('#tfFileField').style.display = 'none';
  $('#btnSaveTask').textContent = '保存修改';
  openModal('#taskModal');
}
window.editTask = (id) => runAsync(() => openTaskEditor(id), '任务加载失败，暂时无法编辑');

/* ---------------- 新建任务 ---------------- */

$('#btnNewTask').addEventListener('click', () => {
  $('#taskModalTitle').textContent = '发布新任务';
  $('#taskForm').reset();
  clearDue();
  $('#tfDue').dataset.original = '';
  $('#tfId').value = '';
  $('#tfPriority').value = 'normal';
  state.pendingFiles = [];
  renderPendingFiles();
  $('#tfFileField').style.display = '';
  $('#btnSaveTask').textContent = '保存并派发';
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

function renderPendingFiles() {
  $('#fileList').innerHTML = state.pendingFiles.map((f, i) => `<div class="file-item">
    <span>📎</span><span class="fname">${esc(f.name)}</span>
    <span class="fsize">${fileSize(f.size)}</span>
    <button class="rm" onclick="rmFile(${i})">&times;</button></div>`).join('');
}
window.rmFile = (i) => { state.pendingFiles.splice(i, 1); renderPendingFiles(); };

let taskUploadController = null;
$('#btnCancelTaskUpload').addEventListener('click', () => {
  if (taskUploadController) taskUploadController.abort();
});

$('#btnSaveTask').addEventListener('click', async () => {
  const id = $('#tfId').value;
  const title = $('#tfTitle').value.trim();
  const assignee = $('#tfAssignee').value;
  if (!title) return toast('请填写任务标题', 'err');
  if (!assignee) return toast('请指定任务执行人', 'err');
  const dueValue = $('#tfDue').value;
  const dueTime = dueValue ? new Date(dueValue).getTime() : null;
  const originalDue = $('#tfDue').dataset.original;
  const unchangedExistingDue = Boolean(id && originalDue && dueTime === new Date(originalDue).getTime());
  if (dueTime && dueTime <= Date.now() && !unchangedExistingDue) {
    return toast('要求完成时间必须晚于当前时间', 'err');
  }
  const oversized = state.pendingFiles.find((file) => file.size > MAX_ATTACHMENT_BYTES);
  if (oversized) return toast(`「${oversized.name}」超过 50MB，不能上传`, 'err');

  const btn = $('#btnSaveTask');
  const originalButtonText = btn.textContent;
  btn.disabled = true;
  try {
    if (id) {
      await api('/api/tasks/' + id, {
        method: 'PATCH',
        body: {
          title, description: $('#tfDesc').value, category: $('#tfCategory').value.trim() || '常规任务',
          priority: $('#tfPriority').value, assignee_id: Number(assignee),
          due_at: $('#tfDue').value || null,
        },
      });
      toast('任务已更新', 'ok');
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
      toast('任务已发布并派发给执行人', 'ok');
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
  $$('#statusSeg button').forEach((x, i) => x.classList.toggle('on', i === 0));
  state.selectedIds.clear();
  runAsync(() => loadTasks(), '任务列表刷新失败');
});

/* ---------------- 导出 ---------------- */

$('#btnExport').addEventListener('click', () => {
  if (state.me.role === 'executor') { $('#exAssignee').value = ''; $('#exAssignee').disabled = true; }
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

/* ---------------- 用户管理 ---------------- */

async function loadUsers() {
  const { users } = await api('/api/users');
  state.users = users;
  const rows = users.map((u) => `<tr>
    <td class="tid">#${u.id}</td>
    <td><b>${esc(u.name)}</b><div class="cell-sub">${esc(u.username)}</div></td>
    <td><span class="badge ${u.role === 'admin' ? 'overdue' : u.role === 'assigner' ? 'running' : 'gray'}">${ROLE_TEXT[u.role]}</span></td>
    <td>${esc(u.dept || '-')}</td>
    <td>${u.active ? '<span style="color:var(--success)">启用</span>' : '<span style="color:var(--text-mute)">停用</span>'}</td>
    <td>${u.role === 'executor' ? `承接 ${u.assigned_count} / 完成 ${u.done_count}` : `创建 ${u.created_count}`}</td>
    <td>${fmt(u.created_at, false)}</td>
    <td style="white-space:nowrap">
      <button class="btn ghost sm" onclick="editUser(${u.id})">编辑</button>
      ${u.id === state.me.id
        ? '<span class="cell-sub" style="padding:0 8px">当前登录</span>'
        : `<button class="btn ghost sm" onclick="toggleUser(${u.id},${u.active ? 0 : 1})">${u.active ? '停用' : '启用'}</button>
           <button class="btn danger sm" onclick="delUser(${u.id})">删除</button>`}
    </td></tr>`).join('');

  $('#userTableWrap').innerHTML = `<table class="tbl">
    <thead><tr><th>ID</th><th>用户</th><th>角色</th><th>部门</th><th>状态</th><th>任务统计</th><th>创建时间</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

$('#btnNewUser').addEventListener('click', () => {
  $('#userModalTitle').textContent = '新建用户';
  $('#userForm').reset();
  $('#ufId').value = '';
  $('#ufUsername').disabled = false;
  $('#ufPwdReq').style.display = '';
  $('#ufPwdHint').textContent = '至少 6 位，请告知用户首次登录密码';
  openModal('#userModal');
});

window.editUser = (id) => {
  const u = state.users.find((x) => x.id === id);
  if (!u) return;
  $('#userModalTitle').textContent = '编辑用户';
  $('#ufId').value = u.id;
  $('#ufUsername').value = u.username;
  $('#ufUsername').disabled = true;
  $('#ufName').value = u.name;
  $('#ufRole').value = u.role;
  $('#ufDept').value = u.dept || '';
  $('#ufPassword').value = '';
  $('#ufPwdReq').style.display = 'none';
  $('#ufPwdHint').textContent = '留空表示不修改密码';
  openModal('#userModal');
};

$('#btnSaveUser').addEventListener('click', async () => {
  const id = $('#ufId').value;
  const payload = {
    name: $('#ufName').value.trim(),
    role: $('#ufRole').value,
    dept: $('#ufDept').value.trim(),
  };
  if (!payload.name) return toast('请填写姓名', 'err');
  const pwd = $('#ufPassword').value;
  try {
    if (id) {
      if (pwd) payload.password = pwd;
      await api('/api/users/' + id, { method: 'PATCH', body: payload });
      toast('用户已更新', 'ok');
    } else {
      payload.username = $('#ufUsername').value.trim();
      payload.password = pwd;
      if (!payload.username) return toast('请填写登录账号', 'err');
      if (!pwd || pwd.length < 6) return toast('密码至少 6 位', 'err');
      await api('/api/users', { method: 'POST', body: payload });
      toast('用户创建成功', 'ok');
    }
    closeModal('#userModal');
    await Promise.all([loadUsers(), loadExecutors()]);
  } catch (e) { toast(e.message, 'err'); }
});

window.toggleUser = async (id, active) => {
  try {
    await api('/api/users/' + id, { method: 'PATCH', body: { active } });
    toast(active ? '已启用' : '已停用', 'ok');
    await Promise.all([loadUsers(), loadExecutors()]);
  } catch (e) { toast(e.message, 'err'); }
};

window.delUser = async (id) => {
  if (!await askConfirm('删除后该账号将无法登录。', '删除用户', '确认删除')) return;
  try {
    await api('/api/users/' + id, { method: 'DELETE' });
    toast('用户已删除', 'ok');
    await Promise.all([loadUsers(), loadExecutors()]);
  } catch (e) { toast(e.message, 'err'); }
};

/* ---------------- 导航 ---------------- */

$$('.nav a[data-view]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const view = a.dataset.view;
    $$('.nav a').forEach((x) => x.classList.remove('active'));
    a.classList.add('active');
    $('#view-tasks').style.display = view === 'tasks' ? '' : 'none';
    $('#view-users').style.display = view === 'users' ? '' : 'none';
    if (view === 'users') runAsync(() => loadUsers(), '用户列表加载失败');
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

/* 每 30 秒自动刷新任务，执行者可及时看到新派发的任务 */
setInterval(() => {
  if ($('#view-tasks').style.display !== 'none' && !$$('.modal-mask.show').length) {
    runAsync(() => refresh(), '自动刷新失败');
  }
}, 30000);

runAsync(() => init(), '工作台初始化失败，请刷新页面重试');
