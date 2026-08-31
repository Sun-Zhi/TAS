/* 主题切换回归测试：用 node:vm 加载真实的 public/js/theme.js，
 * 以可编程的 document / localStorage / matchMedia 桩驱动浏览器行为，
 * 覆盖：四套主题值、系统明暗回退、非法偏好回退、持久化与恢复跟随系统、
 * 跟随系统状态下的系统明暗联动、主题弹层交互，以及 CSS 四套令牌、
 * WCAG AA 对比度与三页面集成契约。
 * 自包含：不启动服务器、不读写真实数据目录。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const THEME_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'theme.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const PAGES = ['index.html', 'login.html', 'screen.html'].map((file) => ({
  file,
  html: fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'),
}));

const ALL_THEMES = ['dark', 'enterprise', 'mist', 'warm'];
const STORAGE_KEY = 'taskassign-theme';

/* ---------- 极简 DOM 桩：满足 theme.js 的弹层构建、事件委托与状态刷新 ---------- */

function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    attrs: {},
    listeners: {},
    className: '',
    hidden: false,
    _html: '',
    type: '',
    // theme.js 通过 innerHTML 构建弹层；桩仅存字符串，供契约断言检查内容
    get innerHTML() { return el._html; },
    set innerHTML(value) { el._html = String(value); },
    classList: {
      add(...names) { const set = new Set(el.className.split(/\s+/).filter(Boolean)); names.forEach((n) => set.add(n)); el.className = [...set].join(' '); },
      remove(...names) { const set = new Set(el.className.split(/\s+/).filter(Boolean)); names.forEach((n) => set.delete(n)); el.className = [...set].join(' '); },
      toggle(n, force) { const set = new Set(el.className.split(/\s+/).filter(Boolean)); const on = force === undefined ? !set.has(n) : Boolean(force); if (on) set.add(n); else set.delete(n); el.className = [...set].join(' '); return on; },
      contains(n) { return el.className.split(/\s+/).includes(n); },
    },
    setAttribute(name, value) { el.attrs[name] = String(value); },
    getAttribute(name) { return name in el.attrs ? el.attrs[name] : null; },
    hasAttribute(name) { return name in el.attrs; },
    appendChild(child) { child.__parent = el; el.children.push(child); return child; },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    focus() { el.attrs._focused = '1'; },
    // 沿父链向上查找，覆盖「点击弹层内部不关闭」的正向分支
    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === el) return true;
        cur = cur.__parent;
      }
      return false;
    },
    closest(selector) {
      if (selector === '[data-theme-value]' && el.getAttribute('data-theme-value')) return el;
      if (selector === '[data-theme-system]' && el.getAttribute('data-theme-system')) return el;
      return null;
    },
    // 仅支持 .class 匹配：theme.js 对弹层只使用 .theme-option 这一种选择器
    querySelectorAll(selector) {
      const cls = typeof selector === 'string' && selector.startsWith('.') ? selector.slice(1) : null;
      if (!cls) return [];
      const found = [];
      const walk = (node) => node.children.forEach((c) => {
        if (c.classList.contains(cls)) found.push(c);
        walk(c);
      });
      walk(el);
      return found;
    },
    querySelector(selector) { return el.querySelectorAll(selector)[0] || null; },
  };
  return el;
}

/* 创建一个已执行 theme.js 的沙箱：boot 逻辑在脚本求值时立即运行。
 * stored：预置的 localStorage 偏好；prefersDark：系统是否深色。 */
function makeSandbox({ stored = null, prefersDark = false } = {}) {
  const mediaListeners = new Set();
  const winListeners = {};
  const media = {
    matches: prefersDark,
    addEventListener(type, fn) { if (type === 'change') mediaListeners.add(fn); },
    removeEventListener(type, fn) { mediaListeners.delete(fn); },
  };
  const documentElement = makeEl('html');
  const body = makeEl('body');
  const docListeners = {};
  const documentMock = {
    readyState: 'loading',
    documentElement,
    body,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    // 沙箱不提供 [data-theme-mount]，走 body 兜底挂载路径
    querySelector: () => null,
    createElement: makeEl,
  };
  const storageMap = new Map();
  const storage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => { storageMap.set(k, String(v)); },
    removeItem: (k) => { storageMap.delete(k); },
  };
  if (stored !== null) storage.setItem(STORAGE_KEY, stored);
  const sandbox = {
    document: documentMock,
    localStorage: storage,
    matchMedia: () => media,
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    // window 级事件（resize 等）：theme.js 的弹层重定位监听
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = winListeners[type] || [];
      const i = list.indexOf(fn);
      if (i > -1) list.splice(i, 1);
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(THEME_JS, sandbox, { filename: 'public/js/theme.js' });
  return {
    sandbox, media, mediaListeners, winListeners, documentElement, body, docListeners, storage, storageMap,
    fireMediaChange() { mediaListeners.forEach((fn) => fn()); },
    fireDocEvent(type, event) { (docListeners[type] || []).forEach((fn) => fn(event)); },
    run(expression) { return vm.runInContext(expression, sandbox); },
  };
}

function currentTheme(box) {
  return box.documentElement.getAttribute('data-theme');
}

function pressEsc(box) {
  box.fireDocEvent('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
}

/* ---------- 1. 四套主题值与存储键 ---------- */

{
  const box = makeSandbox();
  // vm 上下文里的数组属于另一个 realm，拷贝为主 realm 数组后再比较
  assert.deepEqual(Array.from(box.run('THEME_VALUES')), ALL_THEMES, '主题值固定为 dark/enterprise/mist/warm');
  assert.equal(box.run('THEME_STORAGE_KEY'), STORAGE_KEY, 'localStorage 键为 taskassign-theme');
}

/* ---------- 2. resolveTheme：合法偏好优先，非法/缺省回退系统 ---------- */

{
  const box = makeSandbox();
  assert.equal(box.run(`resolveTheme('mist', true)`), 'mist', '合法偏好不受系统影响');
  assert.equal(box.run(`resolveTheme('warm', false)`), 'warm');
  assert.equal(box.run(`resolveTheme(null, true)`), 'dark', '无偏好 + 系统深色 → dark');
  assert.equal(box.run(`resolveTheme(null, false)`), 'enterprise', '无偏好 + 系统浅色 → enterprise');
  assert.equal(box.run(`resolveTheme('nonsense', true)`), 'dark', '非法偏好按无偏好处理');
  assert.equal(box.run(`resolveTheme('nonsense', false)`), 'enterprise');
  assert.equal(box.run(`resolveTheme('<script>', false)`), 'enterprise', '注入类非法值同样回退');
}

/* ---------- 3. readStoredTheme：只接受合法值 ---------- */

{
  const box = makeSandbox();
  assert.equal(box.run(`readStoredTheme(localStorage)`), null, '未保存时返回 null');
  assert.equal(box.run(`readStoredTheme({ getItem: () => 'mist' })`), 'mist');
  assert.equal(box.run(`readStoredTheme({ getItem: () => 'hacker' })`), null, '非法存储值视为未保存');
}

/* ---------- 4. boot：data-theme 在脚本求值时立即落位 ---------- */

{
  const light = makeSandbox({ prefersDark: false });
  assert.equal(currentTheme(light), 'enterprise', '浅色系统回退 enterprise');
  assert.equal(light.mediaListeners.size, 1, '跟随系统状态注册系统明暗监听');

  const dark = makeSandbox({ prefersDark: true });
  assert.equal(currentTheme(dark), 'dark', '深色系统回退 dark');

  const stored = makeSandbox({ stored: 'mist', prefersDark: true });
  assert.equal(currentTheme(stored), 'mist', '已保存的合法偏好优先于系统');

  const bad = makeSandbox({ stored: 'hacker', prefersDark: false });
  assert.equal(currentTheme(bad), 'enterprise', '非法存储偏好回退系统（浅色 → enterprise）');
  assert.equal(currentTheme(makeSandbox({ stored: 'hacker', prefersDark: true })), 'dark', '非法存储偏好回退系统（深色 → dark）');

  const noListener = makeSandbox({ stored: 'warm', prefersDark: false });
  assert.equal(noListener.mediaListeners.size, 0, '已有明确偏好时不再监听系统变化');

  const brokenBox = makeSandbox({ prefersDark: true });
  brokenBox.storage.getItem = () => { throw new Error('隐私模式禁用存储'); };
  assert.equal(currentTheme(brokenBox), 'dark', 'localStorage 不可用时按无偏好回退，不崩溃');
}

/* ---------- 5. selectTheme：持久化 + 应用，非法输入与写入失败要稳 ---------- */

{
  const box = makeSandbox({ prefersDark: false });
  box.run(`selectTheme('warm')`);
  assert.equal(box.storageMap.get(STORAGE_KEY), 'warm', '明确选择写入 localStorage');
  assert.equal(currentTheme(box), 'warm', '选择立即生效');
  assert.equal(box.mediaListeners.size, 1, '监听器保留（由偏好守卫跳过），行为上不再受系统影响');
  box.media.matches = true;
  box.fireMediaChange();
  assert.equal(currentTheme(box), 'warm', '明确选择后系统明暗变化不再影响主题');

  const invalid = makeSandbox();
  invalid.run(`selectTheme('hacker')`);
  assert.equal(invalid.storageMap.has(STORAGE_KEY), false, '非法主题不写入存储');
  assert.equal(currentTheme(invalid), 'enterprise', '非法主题不改变当前主题');

  const readonly = makeSandbox();
  readonly.storage.setItem = () => { throw new Error('写入失败'); };
  assert.doesNotThrow(() => readonly.run(`selectTheme('mist')`), '存储写入失败不抛错');
  assert.equal(currentTheme(readonly), 'mist', '写入失败时主题本次会话仍然生效');
}

/* ---------- 6. followSystemTheme：删除偏好并回到系统联动 ---------- */

{
  const box = makeSandbox({ stored: 'mist', prefersDark: false });
  assert.equal(currentTheme(box), 'mist');
  box.run(`followSystemTheme()`);
  assert.equal(box.storageMap.has(STORAGE_KEY), false, '恢复跟随系统时删除存储键');
  assert.equal(currentTheme(box), 'enterprise', '按当前系统（浅色）回退');
  box.media.matches = true;
  box.fireMediaChange();
  assert.equal(currentTheme(box), 'dark', '恢复后重新跟随系统明暗变化');
}

/* ---------- 7. 弹层交互 ---------- */

{
  const box = makeSandbox({ prefersDark: false });
  const initHandlers = box.docListeners.DOMContentLoaded || [];
  assert.equal(initHandlers.length, 1, 'readyState=loading 时通过 DOMContentLoaded 初始化弹层');

  initHandlers[0]();
  const btn = box.body.children.find((c) => c.getAttribute('aria-label') === '切换主题');
  assert.ok(btn, '挂载调色盘按钮');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', '按钮初始 aria-expanded=false');
  assert.equal(btn.getAttribute('aria-haspopup'), 'true', '弹出关系用 aria-haspopup 声明（非 dialog 语义）');

  const popup = box.body.children.find((c) => c.className.includes('theme-popup'));
  assert.ok(popup, '挂载主题弹层');
  assert.equal(popup.hidden, true, '弹层初始隐藏');
  assert.equal(popup.getAttribute('role'), null, '弹层不冒充对话框（无焦点陷阱，语义由 radiogroup 承担）');
  for (const t of ALL_THEMES) {
    assert.ok(popup._html.includes(`data-theme-value="${t}"`), `弹层包含主题选项 ${t}`);
  }
  assert.ok(popup._html.includes('data-theme-system'), '弹层包含恢复跟随系统操作');
  assert.ok(popup._html.includes('跟随系统'), '跟随系统操作有中文文案');
  assert.ok(popup._html.includes('企业蓝'), '弹层展示主题中文名');

  // 打开
  btn.listeners.click[0]({ target: btn });
  assert.equal(popup.hidden, false, '点击按钮展开弹层');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');

  // Esc 关闭，焦点回到按钮
  delete btn.attrs._focused;
  pressEsc(box);
  assert.equal(popup.hidden, true, 'Esc 关闭弹层');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(btn.attrs._focused, '1', '关闭后焦点回到调色盘按钮');

  // 点击外部关闭
  btn.listeners.click[0]({ target: btn });
  assert.equal(popup.hidden, false);
  box.fireDocEvent('click', { target: box.body });
  assert.equal(popup.hidden, true, '点击弹层外部关闭');

  // 点击主题选项：选择 + 持久化 + 关闭
  btn.listeners.click[0]({ target: btn });
  const warmOption = makeEl('button');
  warmOption.setAttribute('data-theme-value', 'warm');
  popup.listeners.click[0]({ target: warmOption });
  assert.equal(box.storageMap.get(STORAGE_KEY), 'warm', '点击选项持久化主题');
  assert.equal(currentTheme(box), 'warm', '点击选项立即应用主题');
  assert.equal(popup.hidden, true, '选择后关闭弹层');

  // 点击「跟随系统」：删除偏好 + 回退系统
  btn.listeners.click[0]({ target: btn });
  const sysOption = makeEl('button');
  sysOption.setAttribute('data-theme-system', '1');
  popup.listeners.click[0]({ target: sysOption });
  assert.equal(box.storageMap.has(STORAGE_KEY), false, '跟随系统删除存储键');
  assert.equal(currentTheme(box), 'enterprise', '回退到系统主题（浅色 → enterprise）');

  // 再次打开弹层时 Esc 之后仍可正常开关（状态机不残留）
  btn.listeners.click[0]({ target: btn });
  assert.equal(popup.hidden, false);
  pressEsc(box);
  assert.equal(popup.hidden, true);
}

/* ---------- 7b. 弹层选中态刷新：.on 高亮与 aria-checked 跟随偏好 ---------- */

{
  const box = makeSandbox({ prefersDark: false });
  box.docListeners.DOMContentLoaded[0]();
  const popup = box.body.children.find((c) => c.className.includes('theme-popup'));
  const themeOpts = Object.fromEntries(ALL_THEMES.map((t) => {
    const opt = makeEl('button');
    opt.className = 'theme-option'; // 与真实弹层 HTML 一致，供 .theme-option 选择器命中
    opt.setAttribute('data-theme-value', t);
    opt.setAttribute('aria-checked', 'false'); // 与真实弹层 HTML 一致：初始未选中
    popup.appendChild(opt);
    return [t, opt];
  }));
  const sysOpt = makeEl('button');
  sysOpt.className = 'theme-option';
  sysOpt.setAttribute('data-theme-system', '1');
  sysOpt.setAttribute('aria-checked', 'false');
  popup.appendChild(sysOpt);

  const assertOnlyOn = (expected) => {
    for (const t of ALL_THEMES) {
      const on = themeOpts[t].classList.contains('on');
      assert.equal(on, t === expected, `主题选项 ${t} 高亮状态为 ${t === expected}`);
      assert.equal(themeOpts[t].getAttribute('aria-checked'), t === expected ? 'true' : 'false', `主题选项 ${t} aria-checked`);
    }
    assert.equal(sysOpt.classList.contains('on'), expected === null, `跟随系统选项高亮为 ${expected === null}`);
    assert.equal(sysOpt.getAttribute('aria-checked'), expected === null ? 'true' : 'false', `跟随系统选项 aria-checked`);
  };

  box.run(`refreshThemePopupState()`);
  assertOnlyOn(null);
  box.run(`selectTheme('mist')`);
  assertOnlyOn('mist');
  box.run(`followSystemTheme()`);
  assertOnlyOn(null);
  box.run(`selectTheme('dark')`);
  assertOnlyOn('dark');

  // 打开弹层时焦点落在当前选中项（键盘可达 + radiogroup 惯例）
  delete themeOpts.dark.attrs._focused;
  const btn2 = box.body.children.find((c) => c.getAttribute('aria-label') === '切换主题');
  btn2.listeners.click[0]({ target: btn2 });
  assert.equal(popup.hidden, false);
  assert.equal(themeOpts.dark.attrs._focused, '1', '展开弹层后焦点落到当前选中项（dark）');

  // 恢复跟随系统后再展开：焦点落到「跟随系统」选项，而非固定首项
  box.fireDocEvent('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(popup.hidden, true, 'Esc 先收起弹层');
  box.run(`followSystemTheme()`);
  delete sysOpt.attrs._focused;
  delete themeOpts.dark.attrs._focused;
  btn2.listeners.click[0]({ target: btn2 });
  assert.equal(popup.hidden, false);
  assert.equal(sysOpt.attrs._focused, '1', '无偏好时展开焦点落到「跟随系统」选项');
}

/* ---------- 7c. 点击弹层内部不关闭（守卫正向分支） ---------- */

{
  const box = makeSandbox({ prefersDark: false });
  box.docListeners.DOMContentLoaded[0]();
  const popup = box.body.children.find((c) => c.className.includes('theme-popup'));
  const btn = box.body.children.find((c) => c.getAttribute('aria-label') === '切换主题');
  btn.listeners.click[0]({ target: btn });
  assert.equal(popup.hidden, false);

  const inner = makeEl('span');
  popup.appendChild(inner);
  box.fireDocEvent('click', { target: inner });
  assert.equal(popup.hidden, false, '点击弹层内部元素不关闭');

  box.fireDocEvent('click', { target: btn });
  assert.equal(popup.hidden, false, '点击调色盘按钮本身不关闭（由按钮自己的开关逻辑处理）');
}

/* ---------- 7d. 弹层键盘导航：radiogroup 方向键移动并即时选中 ---------- */

{
  const box = makeSandbox({ prefersDark: false });
  box.docListeners.DOMContentLoaded[0]();
  const popup = box.body.children.find((c) => c.className.includes('theme-popup'));
  // 模拟真实弹层的五个选项，顺序与 THEME_VALUES + 「跟随系统」一致
  const opts = [...ALL_THEMES, 'system'].map((t) => {
    const opt = makeEl('button');
    opt.className = 'theme-option';
    if (t === 'system') opt.setAttribute('data-theme-system', '1');
    else opt.setAttribute('data-theme-value', t);
    popup.appendChild(opt);
    return opt;
  });
  const keydownHandlers = popup.listeners.keydown;
  assert.equal(keydownHandlers.length, 1, '弹层注册方向键导航处理');
  const fireKey = (key) => keydownHandlers[0]({ key, preventDefault() {} });
  const focusAt = (i) => { box.sandbox.document.activeElement = i < 0 ? undefined : opts[i]; };
  const clearFocus = () => opts.forEach((o) => delete o.attrs._focused);

  box.run('refreshThemePopupState()');
  assert.equal(opts[4].getAttribute('tabindex'), '0', '无偏好时「跟随系统」持有 roving tabindex');
  assert.equal(opts[0].getAttribute('tabindex'), '-1', '未选中选项 tabindex=-1');

  focusAt(-1); // 焦点不在选项上时 ArrowDown 落到第一个
  clearFocus();
  fireKey('ArrowDown');
  assert.equal(opts[0].attrs._focused, '1', 'ArrowDown 聚焦第一个选项');
  assert.equal(currentTheme(box), 'dark', '方向键移动即选中（selection follows focus）');
  assert.equal(box.storageMap.get(STORAGE_KEY), 'dark', '键盘选中同样持久化');
  assert.equal(opts[0].getAttribute('tabindex'), '0', 'roving tabindex 跟随选中项');
  assert.equal(opts[4].getAttribute('tabindex'), '-1');

  focusAt(0);
  clearFocus();
  fireKey('ArrowDown');
  assert.equal(opts[1].attrs._focused, '1', 'ArrowDown 移到下一项');
  assert.equal(currentTheme(box), 'enterprise', '下一项（企业蓝）即时生效');

  focusAt(1);
  clearFocus();
  fireKey('End');
  assert.equal(opts[4].attrs._focused, '1', 'End 跳到最后一项');
  assert.equal(box.storageMap.has(STORAGE_KEY), false, '键盘选中「跟随系统」删除偏好');

  focusAt(4);
  clearFocus();
  fireKey('ArrowDown');
  assert.equal(opts[0].attrs._focused, '1', '末项向下循环回首项');

  focusAt(0);
  clearFocus();
  fireKey('ArrowUp');
  assert.equal(opts[4].attrs._focused, '1', '首项向上循环回末项');

  focusAt(4);
  clearFocus();
  fireKey('Home');
  assert.equal(opts[0].attrs._focused, '1', 'Home 跳到首项');

  // 窗口缩放时重新定位弹层（监听注册在 window 上）
  assert.equal(box.winListeners.resize.length, 1, '注册窗口缩放重定位监听');
}

/* ---------- 8. CSS 契约：四套令牌块 + color-scheme ---------- */

function themeBlock(css, theme) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].includes(`[data-theme="${theme}"]`)) return m[2];
  }
  return null;
}
function tokenOf(block, name) {
  const m = block.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6}|rgba?\\([^)]*\\))\\s*;`));
  return m ? m[1] : null;
}
function hexTokenOf(block, name) {
  const value = tokenOf(block, name);
  assert.ok(value && /^#[0-9a-fA-F]{6}$/.test(value), `--${name} 需为 6 位十六进制以便对比度校验（实际：${value}）`);
  return value;
}

const REQUIRED_TOKENS = [
  'bg', 'panel', 'panel-solid', 'border', 'border-strong',
  'text', 'text-sub', 'text-mute',
  'primary', 'primary2', 'primary-dark',
  'success', 'warn', 'danger',
  'accent-fg', 'on-accent', 'success-fg', 'danger-fg', 'purple-fg', 'amber-fg',
];

const THEME_BLOCKS = {};
for (const t of ALL_THEMES) {
  const block = themeBlock(STYLE_CSS, t);
  assert.ok(block, `style.css 存在 [data-theme="${t}"] 令牌块`);
  THEME_BLOCKS[t] = block;
  for (const name of REQUIRED_TOKENS) {
    assert.ok(tokenOf(block, name), `[data-theme="${t}"] 定义 --${name}（6 位十六进制）`);
  }
  const scheme = block.match(/color-scheme\s*:\s*(dark|light)/);
  assert.ok(scheme, `[data-theme="${t}"] 声明 color-scheme`);
  assert.equal(scheme[1], t === 'dark' ? 'dark' : 'light', `${t} 的 color-scheme 与明暗一致`);
}

/* ---------- 8b. 令牌完整性：被引用（无兜底）的令牌每套主题都必须有定义 ----------
 * 必需令牌不靠手工维护清单，而是从 style.css、三个页面与全部前端 JS 中
 * 实际出现的 var(--xxx) 反推；带兜底值的 var(--x, fallback) 允许缺省。 */

const ROOT_BLOCK = (() => {
  // 去掉注释后解析：文件头注释会让首个 :root 的选择器文本混入注释内容
  const css = STYLE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].trim() === ':root') return m[2]; // 结构令牌所在的共享 :root 块
  }
  return null;
})();
const THEME_DEFINED = Object.fromEntries(ALL_THEMES.map((t) => {
  const names = new Set();
  const re = /--([a-zA-Z0-9-]+)\s*:/g;
  let m;
  for (const block of [ROOT_BLOCK, THEME_BLOCKS[t]]) {
    while ((m = re.exec(block))) names.add(m[1]);
  }
  return [t, names];
}));

const USED_SOURCES = [
  ['style.css', STYLE_CSS],
  ...PAGES.map(({ file, html }) => [file, html]),
  ...fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js'))
    .map((f) => [path.join('public', 'js', f), fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8')]),
];
const USED_TOKENS = new Set();
for (const [, text] of USED_SOURCES) {
  const re = /var\(\s*--([a-zA-Z0-9-]+)\s*([,)])/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[2] === ')') USED_TOKENS.add(m[1]); // 无兜底 → 硬依赖
  }
}
assert.ok(USED_TOKENS.size > 40, `引用令牌清单非空（实际 ${USED_TOKENS.size} 个），扫描未被跳过`);
for (const t of ALL_THEMES) {
  for (const name of USED_TOKENS) {
    assert.ok(
      THEME_DEFINED[t].has(name),
      `[data-theme="${t}"] 或共享 :root 缺少被引用的令牌 --${name}`,
    );
  }
}

/* ---------- 9. 对比度：普通文字至少 WCAG AA（4.5:1） ---------- */

function srgb(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  const n = hex.replace('#', '');
  return 0.2126 * srgb(parseInt(n.slice(0, 2), 16)) +
    0.7152 * srgb(parseInt(n.slice(2, 4), 16)) +
    0.0722 * srgb(parseInt(n.slice(4, 6), 16));
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function assertAA(fgName, fgHex, bgName, bgHex, label, min = 4.5) {
  const ratio = contrast(fgHex, bgHex);
  assert.ok(ratio >= min, `${label}：${fgName} 于 ${bgName} 对比度 ${ratio.toFixed(2)} ≥ ${min}`);
}

for (const t of ALL_THEMES) {
  const b = THEME_BLOCKS[t];
  const bg = hexTokenOf(b, 'bg');
  const panel = hexTokenOf(b, 'panel-solid');
  const text = hexTokenOf(b, 'text');
  assertAA('--text', text, '--bg', bg, `${t} 正文/背景`);
  assertAA('--text', text, '--panel-solid', panel, `${t} 正文/表面`);
  assertAA('--text-sub', hexTokenOf(b, 'text-sub'), '--panel-solid', panel, `${t} 次要文字/表面`);
  assertAA('--accent-fg', hexTokenOf(b, 'accent-fg'), '--panel-solid', panel, `${t} 强调文字/表面`);
  if (t === 'dark') continue; // 深色主题保持原有视觉特征，只校验正文可读性
  // 三套浅色主题额外校验：弱化文字与主色按钮上的白字
  assertAA('--text-mute', hexTokenOf(b, 'text-mute'), '--panel-solid', panel, `${t} 弱化文字/表面`);
  assertAA('白字', '#ffffff', '--primary', hexTokenOf(b, 'primary'), `${t} 主按钮`);
  assertAA('白字', '#ffffff', '--primary-dark', hexTokenOf(b, 'primary-dark'), `${t} 主按钮渐变深端`);
  // 状态色与 -fg 变体在面板底色上的 AA 校验（拦截 H1 类回归：
  // --success 仅 3.30，小号文字必须用达标的 --success-fg；--success 本身
  // 只允许出现在大号文字/填充场景，不纳入本循环）
  for (const name of ['success-fg', 'danger-fg', 'amber-fg', 'purple-fg', 'warn', 'danger']) {
    assertAA(`--${name}`, hexTokenOf(b, name), '--panel-solid', panel, `${t} 状态色/表面`);
  }
  // 徽章/提示实际渲染在半透明色底上（rgba(--x-rgb, α) 叠加面板），
  // 复合底色比纯面板更"重"，仅对 --panel-solid 断言会给出虚假达标信号
  // （复审 M1 根因：badge.done 等实测 4.2x）。按 alpha 合成出真实底色后再断言。
  const rawTokenOf = (name) => {
    const m = b.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
    assert.ok(m, `[data-theme="${t}"] 定义 --${name}`);
    return m[1].trim();
  };
  // rgb 三元组按 alpha 与白面板合成；rgba() 自带 alpha 时优先用自带值（如 surface-hover）
  const compositeBg = (rgbText, fallbackAlpha) => {
    const nums = rgbText.match(/[\d.]+/g).map(Number);
    const alpha = nums.length >= 4 ? nums[3] : fallbackAlpha;
    return '#' + nums.slice(0, 3)
      .map((c) => Math.round(alpha * c + (1 - alpha) * 255).toString(16).padStart(2, '0'))
      .join('');
  };
  const TINTED_TEXT = [
    ['badge.running', 'accent-fg', 'accent-rgb', 0.16],
    ['badge.done', 'success-fg', 'success-rgb', 0.14],
    ['badge.overdue', 'danger-fg', 'danger-rgb', 0.14],
    ['badge.pending', 'purple-fg', 'purple-rgb', 0.16],
    ['badge.returned', 'amber-fg', 'amber-rgb', 0.16],
    ['badge.gray', 'text-mute', 'surface-hover', 0.10],
    ['toast.ok', 'success-fg', 'success-rgb', 0.16],
    ['toast.err', 'danger-fg', 'danger-rgb', 0.16],
    ['rank.no（大屏）', 'accent-fg', 'accent-rgb', 0.15],
  ];
  for (const [label, fgName, rgbName, alpha] of TINTED_TEXT) {
    const fg = hexTokenOf(b, fgName);
    const tinted = compositeBg(rawTokenOf(rgbName), alpha);
    assertAA(`--${fgName}`, fg, `${rgbName}@${alpha}`, tinted, `${t} ${label}（合成底）`);
  }
}

/* ---------- 10. 页面集成契约：theme.js 必须先于样式执行 ---------- */

for (const { file, html } of PAGES) {
  const themeIdx = html.indexOf('/js/theme.js?v=');
  assert.ok(themeIdx > -1, `${file} 引入 theme.js 并带版本号`);
  assert.match(html, /\/js\/theme\.js\?v=\d{8}-\d+/, `${file} 的 theme.js 带缓存版本号`);
  const linkIdx = html.indexOf('rel="stylesheet"');
  const styleIdx = html.indexOf('<style>');
  const anchor = linkIdx > -1 ? linkIdx : styleIdx;
  assert.ok(anchor > -1, `${file} 存在样式入口`);
  assert.ok(themeIdx < anchor, `${file} 中 theme.js 先于样式加载，避免首帧闪屏`);
  const cssRef = html.match(/\/css\/style\.css\?v=\d{8}-\d+/);
  assert.ok(cssRef, `${file} 引用带版本号的 style.css`);
}

/* ---------- 11. 前端 JS 禁止内联十六进制颜色 ----------
 * 内联颜色无法随主题切换：为深色背景设计的亮色（如 #fbbf24）在浅色
 * 主题的白底上对比度不足 2:1，几乎不可读。必须改用语义令牌。 */

for (const [file, text] of USED_SOURCES.filter(([f]) => f.startsWith(path.join('public', 'js')))) {
  const hit = text.match(/(?:color|background|border[a-z-]*)\s*:\s*#[0-9a-fA-F]{3,8}/);
  assert.ok(!hit, `${file} 含内联十六进制颜色（${hit && hit[0]}），请改用 var(--令牌)`);
}

console.log('theme regression: ok');
