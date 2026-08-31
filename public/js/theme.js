/* ============ 共享主题：四套主题切换（dark / enterprise / mist / warm） ============
 * 本脚本必须在各页面的样式表之前加载：boot 阶段立即写入 html[data-theme]，
 * 样式表应用时令牌已就位，避免首帧闪屏。
 * 偏好保存在当前浏览器（localStorage），不按账号跨设备同步；
 * 无已保存偏好时跟随系统：系统深色 → dark，系统浅色 → enterprise。
 * 纯逻辑函数（resolveTheme / readStoredTheme 等）不接触 DOM，
 * 由 scripts/theme-regression.js 在 node:vm 沙箱中直接驱动验证。 */
'use strict';

const THEME_STORAGE_KEY = 'taskassign-theme';
const THEME_VALUES = ['dark', 'enterprise', 'mist', 'warm'];
const THEME_TEXT = { dark: '深色科技', enterprise: '企业蓝', mist: '青灰轻盈', warm: '暖白橙' };

const themeMedia = (typeof window.matchMedia === 'function')
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;
let systemListenerAttached = false;
let themeTriggerEl = null;
let themePopupEl = null;

function isValidTheme(value) {
  return THEME_VALUES.includes(value);
}

/* 根据保存的偏好与系统明暗解析实际主题；偏好非法视为未保存。
 * 形参命名避开同名函数 systemPrefersDark，防止遮蔽导致误调用时抛错 */
function resolveTheme(preference, systemDark) {
  if (isValidTheme(preference)) return preference;
  return systemDark ? 'dark' : 'enterprise';
}

function systemPrefersDark() {
  return themeMedia ? themeMedia.matches === true : false;
}

function readStoredTheme(storage) {
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return isValidTheme(value) ? value : null;
  } catch {
    // 隐私模式等场景下存储不可用，按无偏好处理
    return null;
  }
}

function storeTheme(storage, theme) {
  storage.setItem(THEME_STORAGE_KEY, theme);
}

function clearStoredTheme(storage) {
  storage.removeItem(THEME_STORAGE_KEY);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

/* 跟随系统状态下监听系统明暗变化；用户明确选择后由偏好守卫跳过，
 * 恢复跟随系统时无需重新注册。 */
function attachSystemThemeListener() {
  if (systemListenerAttached || !themeMedia) return;
  systemListenerAttached = true;
  const onChange = () => {
    if (readStoredTheme(localStorage)) return;
    applyTheme(resolveTheme(null, themeMedia.matches));
  };
  // 旧 Safari 只有 addListener
  if (typeof themeMedia.addEventListener === 'function') themeMedia.addEventListener('change', onChange);
  else if (typeof themeMedia.addListener === 'function') themeMedia.addListener(onChange);
}

/* boot：样式表加载前确定主题并落位 */
(function initTheme() {
  const stored = readStoredTheme(localStorage);
  applyTheme(resolveTheme(stored, systemPrefersDark()));
  if (!stored) attachSystemThemeListener();
})();

/* 用户明确选择某套主题：持久化 + 立即生效；写入失败只影响下次访问 */
function selectTheme(theme) {
  if (!isValidTheme(theme)) return;
  try {
    storeTheme(localStorage, theme);
  } catch {
    // 存储不可用时本次会话仍然生效
  }
  applyTheme(theme);
  refreshThemePopupState();
}

/* 恢复跟随系统：删除偏好并按当前系统明暗立即回退 */
function followSystemTheme() {
  try {
    clearStoredTheme(localStorage);
  } catch {
    // 删除失败不阻碍回退
  }
  attachSystemThemeListener();
  applyTheme(resolveTheme(null, systemPrefersDark()));
  refreshThemePopupState();
}

/* ---------------- 右上角调色盘按钮 + 主题弹层 ---------------- */

function refreshThemePopupState() {
  if (!themePopupEl) return;
  const stored = readStoredTheme(localStorage);
  themePopupEl.querySelectorAll('.theme-option').forEach((opt) => {
    const isSystem = opt.hasAttribute('data-theme-system');
    const active = isSystem ? !stored : opt.getAttribute('data-theme-value') === stored;
    opt.classList.toggle('on', active);
    opt.setAttribute('aria-checked', active ? 'true' : 'false');
    // roving tabindex：单选组同一时刻只保留一个可 Tab 聚焦项，其余交给方向键
    opt.setAttribute('tabindex', active ? '0' : '-1');
  });
}

function placeThemePopup() {
  // 桩环境（回归测试）没有 getBoundingClientRect，跳过定位即可
  if (!themeTriggerEl || typeof themeTriggerEl.getBoundingClientRect !== 'function') return;
  const rect = themeTriggerEl.getBoundingClientRect();
  themePopupEl.style.top = `${rect.bottom + 8}px`;
  themePopupEl.style.left = 'auto';
  // clientWidth 不含纵向滚动条：innerWidth 含滚动条，会让 fixed 定位右缘左偏一个滚动条宽度
  themePopupEl.style.right = `${document.documentElement.clientWidth - rect.right}px`;
}

function openThemePopup() {
  themePopupEl.hidden = false;
  themeTriggerEl.setAttribute('aria-expanded', 'true');
  refreshThemePopupState();
  placeThemePopup();
  // radiogroup 惯例：展开时焦点落在当前选中项（而非固定首项）
  const opts = Array.from(themePopupEl.querySelectorAll('.theme-option'));
  const checked = opts.find((o) => o.getAttribute('aria-checked') === 'true') || opts[0];
  if (checked) checked.focus();
}

function closeThemePopup(restoreFocus) {
  themePopupEl.hidden = true;
  themeTriggerEl.setAttribute('aria-expanded', 'false');
  // 仅键盘路径（Esc）把焦点拉回按钮；点击外部关闭时不抢焦点
  if (restoreFocus) themeTriggerEl.focus();
}

function buildThemeSwatch(extraClass) {
  return `<span class="theme-swatch ${extraClass}" aria-hidden="true"><i></i><i></i><i></i></span>`;
}

function initThemeSwitcher() {
  // 各页面可在主题按钮位置放置 [data-theme-mount] 挂载点；没有则固定悬浮在右上角
  const mount = document.querySelector('[data-theme-mount]');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-switch-btn' + (mount ? '' : ' theme-switch-btn-fab');
  btn.setAttribute('aria-label', '切换主题');
  btn.setAttribute('title', '切换主题');
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span class="theme-switch-ico" aria-hidden="true">◐</span>';
  themeTriggerEl = btn;
  (mount || document.body).appendChild(btn);

  const popup = document.createElement('div');
  popup.className = 'theme-popup';
  // 不用 role="dialog"：弹层无焦点陷阱、Tab 可离开，对话框语义与实际行为不符；
  // 选项语义由内部 role="radiogroup" 承担，按钮用 aria-haspopup="true" 声明弹出关系
  popup.hidden = true;
  popup.innerHTML = `
    <div class="theme-popup-title">界面主题</div>
    <div class="theme-options" role="radiogroup" aria-label="主题列表">
      ${THEME_VALUES.map((t) => `
        <button type="button" class="theme-option" role="radio" aria-checked="false" data-theme-value="${t}">
          ${buildThemeSwatch(`theme-swatch-${t}`)}
          <span class="theme-option-name">${THEME_TEXT[t]}</span>
          <span class="theme-option-check" aria-hidden="true">✓</span>
        </button>`).join('')}
      <button type="button" class="theme-option" role="radio" aria-checked="false" data-theme-system="1">
        ${buildThemeSwatch('theme-swatch-system')}
        <span class="theme-option-name">跟随系统</span>
        <span class="theme-option-check" aria-hidden="true">✓</span>
      </button>
    </div>`;
  themePopupEl = popup;
  document.body.appendChild(popup);

  btn.addEventListener('click', () => {
    if (popup.hidden) openThemePopup();
    else closeThemePopup(false);
  });

  popup.addEventListener('click', (e) => {
    // 恢复跟随系统：删除偏好并按当前系统明暗回退
    if (e.target.closest('[data-theme-system]')) {
      followSystemTheme();
      closeThemePopup(false);
      return;
    }
    const opt = e.target.closest('[data-theme-value]');
    if (!opt) return;
    selectTheme(opt.getAttribute('data-theme-value'));
    closeThemePopup(false);
  });

  // WAI-ARIA radiogroup 键盘模式：方向键在选项间移动并即时选中（selection follows focus）
  popup.addEventListener('keydown', (e) => {
    const opts = Array.from(themePopupEl.querySelectorAll('.theme-option'));
    if (!opts.length) return;
    const current = opts.indexOf(document.activeElement);
    let next;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = current < 0 ? 0 : (current + 1) % opts.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = current < 0 ? opts.length - 1 : (current - 1 + opts.length) % opts.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = opts.length - 1;
    else return;
    e.preventDefault();
    const opt = opts[next];
    opt.focus();
    if (opt.hasAttribute('data-theme-system')) followSystemTheme();
    else selectTheme(opt.getAttribute('data-theme-value'));
  });

  document.addEventListener('click', (e) => {
    if (!themePopupEl || themePopupEl.hidden) return;
    if (themeTriggerEl.contains(e.target) || themePopupEl.contains(e.target)) return;
    closeThemePopup(false);
  });

  document.addEventListener('keydown', (e) => {
    if (!themePopupEl || themePopupEl.hidden) return;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeThemePopup(true);
  });

  // 窗口缩放时弹层重新贴住按钮（placeThemePopup 在桩环境下自动跳过）
  window.addEventListener('resize', () => {
    if (themePopupEl && !themePopupEl.hidden) placeThemePopup();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initThemeSwitcher);
else initThemeSwitcher();
