/* ============ 圆角下拉组件 + 自定义日期时间选择器 ============ */
'use strict';

/* ---------------- 圆角下拉组件 ---------------- */
// 原生 select / datalist 的展开层不能可靠设置圆角与配色；保留原控件作状态源，
// 以项目自绘的深色圆角菜单承载交互。
const roundSelects = new Set();

function enhanceSelect(select) {
  if (!select || select.dataset.roundSelectReady) return;
  select.dataset.roundSelectReady = '1';
  const wrap = document.createElement('div');
  wrap.className = 'round-select';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'round-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'round-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  select.parentNode.insertBefore(wrap, select);
  wrap.append(select, trigger);
  document.body.append(menu);
  select.classList.add('native-select');

  const positionMenu = () => {
    const rect = trigger.getBoundingClientRect();
    const gap = 6;
    menu.style.width = `${Math.round(rect.width)}px`;
    menu.style.left = `${Math.round(rect.left)}px`;
    const below = window.innerHeight - rect.bottom - gap;
    const above = rect.top - gap;
    const placeAbove = menu.offsetHeight > below && above > below;
    menu.style.top = `${Math.round(placeAbove ? Math.max(8, rect.top - menu.offsetHeight - gap) : rect.bottom + gap)}px`;
  };

  const close = () => {
    wrap.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
  };
  // 键盘导航：菜单项不进 Tab 序列，方向键/Home/End 在可选项间移动焦点
  const menuOptions = () => Array.from(menu.querySelectorAll('.round-select-option:not([disabled])'));
  const focusMenuOption = (index) => {
    const options = menuOptions();
    if (!options.length) return;
    const i = index === -1 ? options.length - 1 : Math.min(Math.max(index, 0), options.length - 1);
    options[i].focus();
  };
  const open = (focusIndex = null) => {
    const opening = menu.hidden;
    document.querySelectorAll('.round-select.open').forEach((el) => el._roundClose?.());
    if (!opening) { close(); trigger.focus(); return; }
    render();
    wrap.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    positionMenu();
    if (focusIndex !== null) requestAnimationFrame(() => focusMenuOption(focusIndex));
  };
  const render = () => {
    const options = Array.from(select.options);
    const current = select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
    trigger.textContent = current ? current.textContent : (select.dataset.placeholder || '请选择');
    trigger.disabled = select.disabled;
    menu.replaceChildren();
    options.forEach((option, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `round-select-option${option.selected ? ' selected' : ''}`;
      item.textContent = option.textContent;
      item.disabled = option.disabled;
      item.tabIndex = -1;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.addEventListener('click', () => {
        select.selectedIndex = index;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        render(); close(); trigger.focus();
      });
      menu.append(item);
    });
  };
  // 菜单挂在 body，且选中选项会在 click 处理中触发 render() 并从 DOM 移除。
  // 必须在菜单容器层阻断冒泡，不能依赖 document 监听器中的 event.target.closest()
  // 判断；否则 target 脱离 DOM 后会被误判为点击日期面板外部。
  menu.addEventListener('click', (event) => event.stopPropagation());
  trigger.addEventListener('click', () => open());
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); trigger.focus(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(event.key === 'ArrowDown' ? 0 : -1);
    }
  });
  menu.addEventListener('keydown', (event) => {
    if (!menuOptions().length) return;
    const currentIndex = menuOptions().indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusMenuOption(currentIndex === -1 ? 0 : currentIndex + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home') { event.preventDefault(); focusMenuOption(0); }
    else if (event.key === 'End') { event.preventDefault(); focusMenuOption(-1); }
    else if (event.key === 'Escape') {
      // stopPropagation：菜单挂在 body，事件会冒泡到 modal.js 的 document 级
      // Escape 监听，不拦截的话「收起下拉」会连带关闭整个弹窗
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
    } else if (event.key === 'Tab') {
      // 菜单项不进 Tab 序列（tabIndex=-1），Tab 应先收起菜单回到触发器，
      // 避免焦点直接跳出弹窗焦点圈
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
    }
  });
  select.addEventListener('change', render);
  const observer = new MutationObserver(render);
  observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  wrap._roundClose = close;
  select._roundRender = render;
  const label = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
  if (label) label.addEventListener('click', (event) => { event.preventDefault(); trigger.focus(); trigger.click(); });
  roundSelects.add(select);
  render();
}

function syncRoundSelects() { roundSelects.forEach((select) => select._roundRender?.()); }

function initCategoryCombo() {
  const input = $('#tfCategory');
  const dataList = $('#catList');
  if (!input || !dataList || input.dataset.roundComboReady) return;
  input.dataset.roundComboReady = '1';
  input.removeAttribute('list');
  const wrap = document.createElement('div');
  wrap.className = 'round-combo';
  const menu = document.createElement('div');
  menu.className = 'round-combo-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  input.parentNode.insertBefore(wrap, input);
  wrap.append(input);
  document.body.append(menu);
  const close = () => { menu.hidden = true; };
  const render = () => {
    const keyword = input.value.trim().toLowerCase();
    const values = Array.from(dataList.options).map((option) => option.value)
      .filter((value) => value && value.toLowerCase().includes(keyword));
    menu.replaceChildren();
    if (!values.length) {
      const empty = document.createElement('div');
      empty.className = 'round-combo-empty'; empty.textContent = '暂无匹配类别'; menu.append(empty);
    } else values.forEach((value) => {
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'round-combo-option'; item.textContent = value;
      item.addEventListener('mousedown', (event) => {
        event.preventDefault(); input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true })); close();
      });
      menu.append(item);
    });
    menu.hidden = false;
    const rect = input.getBoundingClientRect();
    const gap = 4;
    menu.style.width = `${Math.round(rect.width)}px`;
    menu.style.left = `${Math.round(rect.left)}px`;
    const below = window.innerHeight - rect.bottom - gap;
    const above = rect.top - gap;
    menu.style.top = `${Math.round(menu.offsetHeight > below && above > below
      ? Math.max(8, rect.top - menu.offsetHeight - gap) : rect.bottom + gap)}px`;
  };
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('.round-select, .round-select-menu')) document.querySelectorAll('.round-select.open').forEach((el) => el._roundClose?.());
  if (!event.target.closest('.round-combo, .round-combo-menu')) document.querySelectorAll('.round-combo-menu').forEach((menu) => { menu.hidden = true; });
});

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
    const focusable = Array.from(picker.querySelectorAll('button:not([disabled]):not([tabindex="-1"])'))
      .filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('click', (event) => {
    // 自绘时间下拉菜单挂在 body，点击其选项不应误判为点击日历外部。
    if (!event.target.closest('#tfDuePicker, .round-select-menu')) closeDuePicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && duePicker.open) {
      closeDuePicker();
      display.focus();
    }
  });
  window.addEventListener('resize', () => duePicker.open && positionDuePicker());
  window.addEventListener('scroll', () => duePicker.open && positionDuePicker(), true);

  $('#dpDays').addEventListener('click', onDpDaysClick);
  $('#dpDays').addEventListener('focusin', (e) => {
    const cell = e.target.closest('.dp-day');
    if (cell) duePicker.focused = new Date(duePicker.view.getFullYear(), duePicker.view.getMonth(), Number(cell.dataset.day));
  });
  $('#dpDays').addEventListener('keydown', onDpDaysKeydown);

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

  picker.addEventListener('click', onDpActionClick);
}

function onDpDaysClick(e) {
  const cell = e.target.closest('.dp-day');
  if (!cell || cell.disabled) return;
  duePicker.selected = new Date(duePicker.view.getFullYear(), duePicker.view.getMonth(), Number(cell.dataset.day));
  duePicker.focused = dateAtMidnight(duePicker.selected);
  syncDueTimeInputs();
  renderDuePicker(true);
}

function onDpDaysKeydown(e) {
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
}

function onDpActionClick(e) {
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
  syncRoundSelects();
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
  // 带时区偏移发送，服务器跨时区部署时也能解析出同一绝对时间
  $('#tfDue').value = toLocalISO(selected);
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
  duePicker.selected = new Date(local);
  duePicker.focused = dateAtMidnight(local);
  duePicker.view = new Date(local.getFullYear(), local.getMonth(), 1);
  duePicker.hour = h;
  duePicker.minute = min;
  $('#tfDue').value = toLocalISO(local);
  $('#tfDueDisplay').value = `${y}/${m}/${d} ${h}:${min}`;
  syncDueTimeInputs();
  renderDuePicker();
}
