/* UI 端到端测试：用 jsdom 加载真实前端页面与脚本，驱动真实用户操作（登录页、
 * 工作台启动、创建任务、未登录拦截），并断言渲染结果。
 * 不依赖真实浏览器；fetch / XMLHttpRequest 由 Node 实现并共享 cookie 罐，
 * 因此走的是与浏览器一致的「cookie 会话 + 真实 API」链路。
 *
 * 自包含：临时目录放隔离 DATA_DIR/UPLOAD_DIR，探测空闲端口后自行拉起 server.js，
 * 跑完杀实例并删除临时目录，不污染真实 data/、不占用固定端口。
 * 用法：node scripts/ui-test.js（或随 npm test 一并运行）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

// 脚本为自己拉起测试实例：临时目录（跑完即删）+ 空闲端口，凭据走环境变量覆盖
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'taskassign-ui-'));
const PUBLIC = path.join(__dirname, '..', 'public');
const ADMIN_PASSWORD = process.env.UI_ADMIN_PASSWORD || 'AdminTest123';
const DEMO_PASSWORD = process.env.UI_DEMO_PASSWORD || 'DemoTest123';
// 测试进程选择「test」环境：父进程随后会直接打开临时库（灌批量数据验证导出截断），
// 若不显式固定 NODE_ENV，外层 shell 的 NODE_ENV=production 会让 auth 生产 fail-closed
// 或 db 的演示账号拒绝逻辑在父进程启动时直接退出（评审 P2）。
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.join(TEST_ROOT, 'data');
process.env.UPLOAD_DIR = path.join(TEST_ROOT, 'uploads');
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.ENABLE_DEMO_ACCOUNTS = '1';
process.env.DEMO_PASSWORD = DEMO_PASSWORD;
const { db } = require('../src/db');
let PORT;
let BASE;
let server;
let serverOutput = '';

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
  // 外链样式同样内联成 <style>：jsdom 不加载外部资源（未开启 resources: usable），
  // 不内联 CSS 就无法证明「样式外置后 .hidden 等类真正生效」——只断言类名是空洞的。
  html = html.replace(
    /<link rel="stylesheet" href="\/css\/([A-Za-z0-9_.-]+)(?:\?[^"']*)?">/g,
    (match, file) => `<style>\n${fs.readFileSync(path.join(PUBLIC, 'css', file), 'utf8')}\n</style>`
  );
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
      // jsdom 未实现 URL.createObjectURL：导出的 blob 下载依赖它，补最小桩
      if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:jsdom-test';
      if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};
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

/* ---------------- 测试实例启停（与 e2e-test.js 同一模式） ---------------- */

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 200; port++) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.unref();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`从 ${startPort} 起连续 200 个端口均被占用，无法启动测试服务`);
}

async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATA_DIR: path.join(TEST_ROOT, 'data'),
      UPLOAD_DIR: path.join(TEST_ROOT, 'uploads'),
      ADMIN_PASSWORD,
      ENABLE_DEMO_ACCOUNTS: '1',
      DEMO_PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  // 轮询静态资源直至响应 200：比等启动横幅更稳，也能把提前退出尽早暴露成可读错误
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`测试服务提前退出\n${serverOutput}`);
    try {
      const response = await fetch(`${BASE}/index.html`);
      if (response.ok) return;
    } catch {
      // 服务尚未启动，继续等
    }
    await sleep(100);
  }
  throw new Error(`测试服务启动超时\n${serverOutput}`);
}

async function stopServer() {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
  // 父进程为灌批量数据也打开了临时库：先关连接否则 Windows 下句柄占用导致删目录 EPERM
  // （与 task-security-regression.js 收尾同模式）
  try { db.close(); } catch { /* 未打开或已关闭则忽略 */ }
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
}

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
  // 显隐已从 style 属性改为 hidden 工具类（CSP 禁止内联 style，安全评审 M4）
  ok(!doc.querySelector('#navUsers').classList.contains('hidden'), '管理员可见「用户管理」入口');
  // 外置样式已随 buildHtml 内联进测试 DOM：断言 computed style 而非只查类名，
  // 证明 .hidden 工具类在样式外置（CSP style-src 'self'）的前提下真的把元素隐藏
  const navUsersStyle = window.getComputedStyle(doc.querySelector('#navUsers'));
  ok(navUsersStyle.display !== 'none', '管理员「用户管理」入口 CSS 计算可见', navUsersStyle.display);
  const usersViewStyle = window.getComputedStyle(doc.querySelector('#view-users'));
  ok(usersViewStyle.display === 'none', '未激活的视图被 .hidden 工具类实际隐藏', usersViewStyle.display);

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
  ok(!doc.querySelector('#btnNewTask').classList.contains('hidden'), '执行者可见「发布新任务」入口');
  // 同一套 CSS 断言：执行者的「用户管理」入口应是类与 computed style 双隐藏
  ok(window.getComputedStyle(doc.querySelector('#navUsers')).display === 'none',
    '执行者不可见「用户管理」入口（hidden 类 + CSS 计算一致）');
  ok(window.getComputedStyle(doc.querySelector('#btnNewTask')).display !== 'none',
    '执行者「发布新任务」按钮 CSS 计算可见');
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
  // closeModal 是 jsdom 窗口内的全局函数，需经 window 引用（Node 侧不存在）
  dom.window.closeModal('#exportModal');

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
  // 用 buildHtml 内联 theme.js/screen.js 与 style.css/screen.css：此前直接喂原始
  // screen.html，外链脚本与 CSS 都不会被 jsdom 加载，原「渲染统计信息」断言
  // 命中的其实是静态 HTML 里的字符串，screen.css 从未被验证（评审 P2）。
  const html = buildHtml('screen.html', ['theme.js', 'screen.js']);
  const dom = newDom(html, jar, { url: BASE + '/screen.html' });
  const { window } = dom;
  const doc = window.document;
  ok(doc.body.textContent.includes('所有角色任务分布'), '大屏显示所有角色任务分布标题');
  // screen.css 已内联为 <style>：验证样式表真实载入（.screen 规则存在）
  const hasScreenCss = Array.from(doc.styleSheets).some((sheet) =>
    Array.from(sheet.cssRules || []).some((rule) => rule.selectorText === '.screen')
  );
  ok(hasScreenCss, '外置样式 screen.css 已内联加载（.screen 规则存在）');
  // screen.js 通过桥接 fetch 真实拉取 /api/screen 渲染 KPI 与列表计数
  await waitFor(() => doc.querySelector('#kpis').children.length > 0, { timeout: 10000 });
  ok(true, '数据大屏页面加载并渲染统计信息');
  const runCount = doc.querySelector('#cntRun').textContent;
  ok(/^\d+ 条$/.test(runCount), '大屏渲染「执行中」列表计数', String(runCount));
  dom.window.close();
}

async function testExportFlow() {
  console.log('\n【UI-7】导出 CSV（fetch 下载 + 截断提示）');
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

  // 路径一：常规导出（任务量小）→ fetch + blob 下载，提示「已开始导出」
  doc.querySelector('#btnExport').click();
  await sleep(50);
  doc.querySelector('#btnDoExport').click();
  await waitFor(() => /导出/.test(doc.querySelector('#toast').textContent || ''), { timeout: 10000 });
  ok(doc.querySelector('#toast').textContent.includes('已开始导出'),
    '常规导出走 fetch + blob 下载并提示成功', doc.querySelector('#toast').textContent);
  ok(!doc.querySelector('#exportModal').classList.contains('show'), '导出后弹窗关闭');

  // 路径二：超过 10000 行 → 服务端只下发部分数据，页面必须据 X-Export-Truncated
  // 明确提示可能截断（评审 P1），用户不能再拿到不完整文件却不知情。
  // 数据直接灌进本测试的隔离临时库，不影响真实 data/。
  const adminId = db.prepare('SELECT id FROM users WHERE username = ?').get('admin').id;
  const bulkTs = new Date().toISOString();
  db.prepare('BEGIN').run();
  const insert = db.prepare(
    'INSERT INTO tasks (title, description, category, priority, status, creator_id, assignee_id, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < 10001; i++) insert.run(`导出上限测试_${i}`, '', '批量测试', 'normal', 'in_progress', adminId, adminId, bulkTs);
  db.prepare('COMMIT').run();

  doc.querySelector('#btnExport').click();
  await sleep(50);
  doc.querySelector('#btnDoExport').click();
  await waitFor(() => /上限/.test(doc.querySelector('#toast').textContent || ''), { timeout: 15000 });
  ok(doc.querySelector('#toast').textContent.includes('上限'),
    '超过 10000 行时导出提示可能被截断（读取 X-Export-Truncated）', doc.querySelector('#toast').textContent);
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
  PORT = await findFreePort(32000 + (process.pid % 1000));
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`UI 端到端测试（实例：${BASE}，隔离实例，跑完自动清理）\n`);
  try {
    await startServer();
    await testLoginPage();
    await testWorkbenchAndCreateTask();
    await testExecutorPublishTask();
    await testAuthGuard();
    await testScreenPage();
    await testTaskModalOutsideClick();
    await testExportFlow();
  } catch (e) {
    failed++;
    console.error('  [异常]', e.message);
  } finally {
    await stopServer();
  }
  console.log(`\n${'='.repeat(46)}\n  UI 测试通过 ${pass} 项，失败 ${failed} 项\n${'='.repeat(46)}\n`);
  process.exitCode = failed ? 1 : 0;
})();
