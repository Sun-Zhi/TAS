/* UI 端到端测试：用 jsdom 加载真实前端页面与脚本，对 12345 端口上的隔离实例
 * 驱动真实用户操作（登录页、工作台启动、创建任务、未登录拦截），并断言渲染结果。
 * 不依赖真实浏览器；fetch / XMLHttpRequest 由 Node 实现并共享 cookie 罐，
 * 因此走的是与浏览器一致的「cookie 会话 + 真实 API」链路。
 *
 * 用法：node scripts/ui-test.js
 * 前置：server.js 已在 127.0.0.1:12345 启动（隔离 DATA_DIR / UPLOAD_DIR）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.UI_BASE || 'http://127.0.0.1:12345';
const PUBLIC = path.join(__dirname, '..', 'public');
const ADMIN_PASSWORD = process.env.UI_ADMIN_PASSWORD || 'AdminTest123';
const DEMO_PASSWORD = process.env.UI_DEMO_PASSWORD || 'DemoTest123';

let pass = 0;
let failed = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra ? `（${extra}）` : ''}`); }
}

/* ---------------- cookie 罐 + fetch / XHR 桥 ---------------- */

function makeJar() {
  // key: cookie name -> value；仅用于同源单实例测试
  const map = new Map();
  return {
    map,
    setFromResponse(res) {
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const pair = sc.split(';')[0];
        const idx = pair.indexOf('=');
        if (idx < 0) continue;
        map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    },
    header() {
      const parts = [];
      for (const [k, v] of map) parts.push(`${k}=${v}`);
      return parts.join('; ');
    },
    has(name) { return map.has(name); },
    clear() { map.clear(); },
  };
}

function resolveUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return BASE + url;
  return new URL(url, BASE).toString();
}

function makeFetch(jar) {
  return async (url, opts = {}) => {
    const abs = resolveUrl(url);
    const headers = { ...(opts.headers || {}) };
    const cookie = jar.header();
    if (cookie) headers['Cookie'] = cookie;
    // Node fetch 的 credentials 选项对 cookie 罐无影响，这里忽略
    const res = await fetch(abs, { ...opts, headers });
    jar.setFromResponse(res);
    return res;
  };
}

// 极简 XMLHttpRequest：仅支持 POST + FormData（应用中的 uploadForm 路径）。
// 把 jsdom 的 FormData 转换为 Node 的 FormData 后走 Node fetch。
function makeXHR(jar) {
  return class XHR {
    constructor() {
      this.status = 0;
      this.responseText = '';
      this.response = null;
      this._reqHeaders = {};
      this._listeners = {};
      this._uploadListeners = {};
      this.withCredentials = false;
      this.timeout = 0;
    }
    open(method, url) { this.method = method; this.url = resolveUrl(url); }
    setRequestHeader(k, v) { this._reqHeaders[k] = v; }
    addEventListener(type, cb) { (this._listeners[type] ||= []).push(cb); }
    removeEventListener(type, cb) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== cb); }
    get upload() { return { addEventListener: (t, cb) => { (this._uploadListeners[t] ||= []).push(cb); } }; }
    _emit(type, ev) { (this._listeners[type] || []).forEach((cb) => cb(ev)); }
    _emitUpload(type, ev) { (this._uploadListeners[type] || []).forEach((cb) => cb(ev)); }
    getResponseHeader(name) {
      return this._resHeaders ? (this._resHeaders.get(name.toLowerCase()) || null) : null;
    }
    abort() { this._aborted = true; this._emit('abort', {}); }
    async send(body) {
      try {
        const headers = { ...this._reqHeaders };
        const cookie = jar.header();
        if (cookie) headers['Cookie'] = cookie;
        let payload = body;
        let total = 0;
        if (body && typeof body.append === 'function' && typeof body.get === 'function') {
          // 判定为 FormData（jsdom）
          const nodeFd = new FormData();
          for (const [k, v] of body.entries()) {
            if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function') {
              const buf = Buffer.from(await v.arrayBuffer());
              nodeFd.append(k, new Blob([buf], { type: v.type || '' }), v.name);
              total += buf.length;
            } else {
              nodeFd.append(k, v);
              total += String(v).length;
            }
          }
          payload = nodeFd;
        }
        // 上传进度（一次性近似）
        if (total > 0) {
          this._emitUpload('progress', { loaded: total, total, percent: 100 });
        }
        this._emitUpload('load', {});
        const res = await fetch(this.url, { method: this.method, body: payload, headers });
        jar.setFromResponse(res);
        this._resHeaders = res.headers;
        this.status = res.status;
        this.responseText = await res.text();
        this.response = this.responseText;
        if (process.env.UI_DEBUG) console.error('  [XHR]', this.method, this.url, '->', res.status, '| body:', this.responseText.slice(0, 200));
        this._emit('load', {});
      } catch (err) {
        this._emit('error', { message: String(err && err.message || err) });
      }
    }
  };
}

/* ---------------- 构建内联脚本的 HTML ---------------- */

function buildHtml(pageFile, scripts) {
  let html = fs.readFileSync(path.join(PUBLIC, pageFile), 'utf8');
  // 去掉外链脚本，改为内联真实脚本内容（保持依赖顺序）
  html = html.replace(/<script src="\/js\/[^"]+"[^>]*><\/script>/g, '');
  const inline = scripts.map((name) => fs.readFileSync(path.join(PUBLIC, 'js', name), 'utf8')).join('\n;\n');
  // 合并为单个 <script> 块：jsdom 不共享跨 <script> 标签的顶层 const/let 作用域，
  // 分开内联会导致「Identifier '$' has already been declared」；用函数替换器避免 $$ 被正则折叠为 $。
  html = html.replace('</body>', () => `<script>\n${inline}\n</script>\n</body>`);
  return html;
}

function newDom(html, jar, { url }) {
  let dom;
  const vc = new VirtualConsole();
  // 屏蔽 jsdom 未实现的导航等噪声；jsdom 不做真实跳转，仅记录「已触发导航」供断言使用
  vc.on('jsdomError', (e) => {
    const msg = String((e && e.message) || e);
    if (/Not implemented: navigation/i.test(msg)) {
      if (dom && dom.window) dom.window.__navigatedTo = 'attempted';
      return;
    }
    // 其它脚本错误打印出来便于排查
    console.error('  [jsdomError]', msg);
  });
  dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = makeFetch(jar);
      window.XMLHttpRequest = makeXHR(jar);
      if (!window.AbortController) window.AbortController = AbortController;
      if (!window.CSS) window.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
      // 记录导航触发标记（jsdom 下 location.href 赋值会触发 Not implemented 导航错误）
      window.__navigatedTo = null;
    },
  });
  return dom;
}

function waitFor(fn, { timeout = 8000, interval = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let val;
      try { val = fn(); } catch { val = false; }
      if (val) return resolve(val);
      if (Date.now() - start > timeout) return reject(new Error('waitFor 超时'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 测试 ---------------- */

async function testLoginPage() {
  console.log('\n【UI-1】登录页');
  const jar = makeJar();
  const html = buildHtml('login.html', ['login.js']);
  const dom = newDom(html, jar, { url: BASE + '/login.html' });
  const { window } = dom;
  const doc = window.document;

  ok(doc.querySelector('#loginForm') !== null, '登录表单已渲染');
  ok(doc.querySelector('#username') !== null && doc.querySelector('#password') !== null, '账号/密码输入框存在');

  // 错误密码
  doc.querySelector('#username').value = 'admin';
  doc.querySelector('#password').value = 'wrong-password';
  doc.querySelector('#loginForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => doc.querySelector('#toast').textContent.includes('错误') || doc.querySelector('#toast').className.includes('show'), { timeout: 6000 });
  const errToast = doc.querySelector('#toast').textContent;
  ok(/账号或密码错误|错误/.test(errToast), '错误密码触发错误提示', errToast);
  ok(doc.querySelector('#submitBtn').disabled === false, '失败后登录按钮恢复可点击');

  // 正确密码
  jar.clear();
  doc.querySelector('#password').value = ADMIN_PASSWORD;
  doc.querySelector('#loginForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => jar.has('ta_token'), { timeout: 8000 });
  ok(jar.has('ta_token'), '正确密码登录成功并获得会话 Cookie');
  ok(window.__navigatedTo === 'attempted', '登录成功触发跳转到工作台', String(window.__navigatedTo));
  dom.window.close();
}

async function testWorkbenchAndCreateTask() {
  console.log('\n【UI-2】工作台启动 + 创建任务');
  const jar = makeJar();
  // 先用真实 fetch 登录拿会话 cookie，注入到工作台实例
  const loginRes = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  jar.setFromResponse(loginRes);
  ok(jar.has('ta_token'), '已为工作台获取管理员会话');

  const html = buildHtml('index.html', ['util.js', 'modal.js', 'due-picker.js', 'task-actions.js', 'users.js', 'app.js']);
  const dom = newDom(html, jar, { url: BASE + '/index.html' });
  const { window } = dom;
  const doc = window.document;

  // 等待 init() 完成：#uName 从 '-' 变为管理员姓名
  await waitFor(() => {
    const u = doc.querySelector('#uName');
    return u && u.textContent && u.textContent !== '-';
  }, { timeout: 10000 });
  ok(doc.querySelector('#uName').textContent === '系统管理员', '工作台渲染当前用户姓名');
  ok(doc.querySelector('#uRole').textContent === '管理员', '渲染用户角色');
  ok(doc.querySelector('#navUsers').style.display !== 'none', '管理员可见「用户管理」入口');

  // 统计卡片渲染
  await waitFor(() => doc.querySelector('#statGrid').children.length > 0, { timeout: 8000 });
  ok(doc.querySelector('#statGrid').children.length >= 6, '统计卡片已渲染', String(doc.querySelector('#statGrid').children.length));

  // 任务接收人下拉已填充（loadAssigneeOptions）
  await waitFor(() => doc.querySelector('#tfAssignee').options.length > 1, { timeout: 8000 });
  ok(doc.querySelector('#tfAssignee').options.length > 1, '执行者下拉已加载');

  // 任务列表区域渲染（可能为空，但应有表格结构或空态）
  await waitFor(() => doc.querySelector('#taskTableWrap').innerHTML.length > 0, { timeout: 8000 });
  ok(true, '任务列表区域已渲染');

  const beforeText = doc.querySelector('#taskTableWrap').innerHTML;

  // 打开「发布新任务」弹窗
  doc.querySelector('#btnNewTask').click();
  await sleep(50);
  ok(doc.querySelector('#taskModal').classList.contains('show'), '点击「发布新任务」弹出任务表单');

  // 填写表单
  const title = 'UI自动化测试任务_' + Date.now();
  doc.querySelector('#tfTitle').value = title;
  const assigneeSel = doc.querySelector('#tfAssignee');
  assigneeSel.value = assigneeSel.options[1].value; // 第一个执行者
  doc.querySelector('#tfDesc').value = '由 jsdom UI 测试创建';
  doc.querySelector('#tfCategory').value = 'UI测试';
  doc.querySelector('#tfPriority').value = 'high';

  // 提交（走 XMLHttpRequest/uploadForm 真实链路）
  doc.querySelector('#btnSaveTask').click();
  // 等待任务创建并刷新列表
  await waitFor(() => doc.querySelector('#taskTableWrap').innerHTML !== beforeText, { timeout: 12000 });

  // 断言：列表中出现了新任务标题，且弹窗已关闭
  ok(doc.querySelector('#taskTableWrap').innerHTML.includes(title), '新建任务出现在任务列表 DOM 中');
  ok(!doc.querySelector('#taskModal').classList.contains('show'), '提交后任务弹窗已关闭');
  ok(doc.querySelector('#toast').className.includes('show'), '提交后出现成功提示 toast');

  // 通过真实 API 确认服务端确实落库
  const tasksRes = await fetch(BASE + '/api/tasks?limit=200', { headers: { Cookie: jar.header() } });
  const tasksData = await tasksRes.json();
  ok(tasksData.tasks.some((t) => t.title === title), '服务端确认新任务已创建', `共 ${tasksData.total} 个任务`);

  dom.window.close();
  return title;
}

async function testExecutorPublishTask() {
  console.log('\n【UI-3】执行者发布任务');
  const jar = makeJar();
  const loginRes = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'dev01', password: DEMO_PASSWORD }),
  });
  jar.setFromResponse(loginRes);
  ok(loginRes.status === 200 && jar.has('ta_token'), '已为执行者工作台获取会话');

  const html = buildHtml('index.html', ['util.js', 'modal.js', 'due-picker.js', 'task-actions.js', 'users.js', 'app.js']);
  const dom = newDom(html, jar, { url: BASE + '/index.html' });
  const { window } = dom;
  const doc = window.document;
  await waitFor(() => doc.querySelector('#uRole').textContent === '任务执行者', { timeout: 10000 });
  ok(doc.querySelector('#btnNewTask').style.display !== 'none', '执行者可见「发布新任务」入口');
  await waitFor(() => doc.querySelector('#tfAssignee').options.length > 1, { timeout: 8000 });
  const options = Array.from(doc.querySelector('#tfAssignee').options);
  const executorOption = options.find((option) => option.dataset.role === 'executor');
  const assignerOption = options.find((option) => option.dataset.role === 'assigner');
  ok(executorOption && assignerOption, '执行者的接收人下拉同时包含执行者和分配者');
  const filterSelect = doc.querySelector('#fAssignee');
  const exportSelect = doc.querySelector('#exAssignee');
  ok(filterSelect.closest('.round-select').style.display !== 'none', '执行者的任务接收人筛选可见');
  ok(!Array.from(filterSelect.options).some((option) => option.textContent.includes('undefined')),
    '任务接收人筛选文案不包含 undefined');
  ok(Array.from(filterSelect.options).some((option) => option.value === assignerOption.value),
    '执行者列表筛选包含分配者接收人');
  doc.querySelector('#btnExport').click();
  ok(exportSelect.disabled === false, '执行者的导出接收人筛选可用');
  ok(Array.from(exportSelect.options).some((option) => option.value === assignerOption.value),
    '执行者导出筛选包含分配者接收人');
  closeModal('#exportModal');

  doc.querySelector('#btnNewTask').click();
  const title = '执行者UI发布任务_' + Date.now();
  doc.querySelector('#tfTitle').value = title;
  doc.querySelector('#tfAssignee').value = assignerOption.value;
  doc.querySelector('#tfDesc').value = '由执行者通过工作台发布给分配者';
  doc.querySelector('#btnSaveTask').click();
  await waitFor(() => doc.querySelector('#taskTableWrap').innerHTML.includes(title), { timeout: 12000 });
  ok(doc.querySelector('#taskTableWrap').innerHTML.includes(title), '执行者发布的任务保留在自己的任务列表中');
  ok(!doc.querySelector('#taskModal').classList.contains('show'), '执行者发布成功后任务弹窗关闭');
  filterSelect.value = assignerOption.value;
  filterSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => doc.querySelector('#taskTableWrap').innerHTML.includes(title), { timeout: 8000 });
  ok(doc.querySelector('#taskTableWrap').innerHTML.includes(title), '执行者按分配者接收人筛选仍能看到自己发布的任务');

  const tasksRes = await fetch(BASE + '/api/tasks?limit=200', { headers: { Cookie: jar.header() } });
  const tasksData = await tasksRes.json();
  ok(tasksData.tasks.some((task) => task.title === title && task.creator_username === 'dev01' &&
    task.assignee_id === Number(assignerOption.value)),
    '真实 API 确认执行者已向所选分配者发布任务');
  dom.window.close();
}

async function testAuthGuard() {
  console.log('\n【UI-4】未登录拦截');
  const jar = makeJar(); // 空 cookie
  const html = buildHtml('index.html', ['util.js', 'modal.js', 'due-picker.js', 'task-actions.js', 'users.js', 'app.js']);
  const dom = newDom(html, jar, { url: BASE + '/index.html' });
  const { window } = dom;
  // init() 中 /api/auth/me 返回 401 → api() 设置 location.href='/login.html'，jsdom 下触发导航标记
  await waitFor(() => window.__navigatedTo === 'attempted', { timeout: 8000 });
  ok(true, '未登录访问工作台触发跳转到登录页');
  dom.window.close();
}

async function testScreenPage() {
  console.log('\n【UI-5】数据大屏页面');
  // 大屏为只读展示页，无需登录即可访问（按当前实现 /api/screen 受 requireLogin 保护，
  // 这里用已登录 cookie 访问，验证页面与脚本可正常加载渲染）。
  const jar = makeJar();
  const loginRes = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  jar.setFromResponse(loginRes);
  const screenHtml = fs.readFileSync(path.join(PUBLIC, 'screen.html'), 'utf8');
  const dom = newDom(screenHtml, jar, { url: BASE + '/screen.html' });
  const { window } = dom;
  const doc = window.document;
  ok(doc.body.textContent.includes('所有角色任务分布'), '大屏显示所有角色任务分布标题');
  // screen.js 异步拉取 /api/screen 并渲染；等待渲染出内容
  try {
    await waitFor(() => {
      const el = doc.querySelector('#screenRoot') || doc.querySelector('[data-screen]') || doc.body;
      return el && /总任务|执行中|已完成/.test(el.textContent || '');
    }, { timeout: 10000 });
    ok(true, '数据大屏页面加载并渲染统计信息');
  } catch {
    ok(false, '数据大屏页面渲染超时');
  }
  dom.window.close();
}

async function testTaskModalOutsideClick() {
  console.log('\n【UI-6】任务弹窗：点击外部不关闭，且关闭按钮仍可用');
  const jar = makeJar();
  const loginRes = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  jar.setFromResponse(loginRes);
  const html = buildHtml('index.html', ['util.js', 'modal.js', 'due-picker.js', 'task-actions.js', 'users.js', 'app.js']);
  const dom = newDom(html, jar, { url: BASE + '/index.html' });
  const { window } = dom;
  const doc = window.document;
  await waitFor(() => {
    const u = doc.querySelector('#uName');
    return u && u.textContent && u.textContent !== '-';
  }, { timeout: 10000 });
  doc.querySelector('#btnNewTask').click();
  await sleep(50);
  const mask = doc.querySelector('#taskModal');
  ok(mask.classList.contains('show'), '点击「发布新任务」弹窗已打开');

  // 回归：点弹窗内部输入框不应被抢焦点（CRITICAL 修复）
  const secondInput = doc.querySelector('#tfDesc');
  if (secondInput) {
    secondInput.focus(); // 模拟用户 mousedown 聚焦到该输入框
    secondInput.dispatchEvent(new window.Event('click', { bubbles: true }));
  }
  await sleep(50);
  ok(secondInput && doc.activeElement === secondInput, '点击/聚焦第二个输入框后焦点保持在该输入框，未被抢回第一个元素');

  // 模拟点击遮罩外部（e.target === mask），断言不被关闭且焦点拉回弹窗内
  mask.dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(50);
  ok(mask.classList.contains('show'), '点击遮罩外部后弹窗仍保持打开（未误关闭）');
  const firstFocusable = mask.querySelector('[autofocus], input:not([type="hidden"]):not([hidden]):not([disabled]), textarea:not([hidden]):not([disabled]), .round-select-trigger:not([hidden]):not([disabled]), button:not([hidden]):not([disabled])');
  ok(firstFocusable && doc.activeElement === firstFocusable, '点击遮罩外部后焦点回到弹窗内首个可聚焦元素');

  // 弹窗内「关闭 / 取消」按钮（data-close）仍可正常关闭
  const closeBtn = mask.querySelector('[data-close]');
  ok(!!closeBtn, '弹窗内存在「关闭/取消」按钮（data-close）');
  closeBtn.click();
  await sleep(50);
  ok(!mask.classList.contains('show'), '点击内部关闭按钮仍可正常关闭弹窗');
  dom.window.close();
}

(async () => {
  console.log('UI 端到端测试（目标：' + BASE + '，隔离实例，不影响生产）\n');
  try {
    await testLoginPage();
    await testWorkbenchAndCreateTask();
    await testExecutorPublishTask();
    await testAuthGuard();
    await testScreenPage();
    await testTaskModalOutsideClick();
  } catch (e) {
    failed++;
    console.error('  [异常]', e.message);
  }
  console.log(`\n${'='.repeat(46)}\n  UI 测试通过 ${pass} 项，失败 ${failed} 项\n${'='.repeat(46)}\n`);
  process.exitCode = failed ? 1 : 0;
})();
