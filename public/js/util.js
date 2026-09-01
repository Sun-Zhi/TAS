/* ============ 通用工具：DOM/请求/格式化/共享状态 ============ */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const ROLE_TEXT = { admin: '管理员', assigner: '任务分配者', executor: '任务执行者' };
const PRI_TEXT = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const state = {
  me: null,
  tasks: [],
  taskTotal: 0,
  taskHasMore: false,
  loadingMore: false,
  tasksPage: 0,
  taskAssignees: [],
  users: [],
  responsibilityUsers: [],
  filters: { status: '', assignee_id: '', category: '', q: '' },
  pendingFiles: [],
  selectedIds: new Set(),
};

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

/** 本地时间 → 带时区偏移的 ISO 字符串（YYYY-MM-DDTHH:mm:ss±HH:MM）。
 *  无偏移的字符串会被服务器按「服务器本地时区」解析，跨时区部署时会产生偏差。 */
function toLocalISO(date) {
  const p = (n) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

const API_TIMEOUT_MS = 30000;

function apiError(message, status, code) {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  if (code) error.code = code;
  return error;
}

/** 判断某个 api() 抛出的错误是否为「未登录，api() 已在跳转登录页」：
 *  调用方无需再为这种错误弹 toast，跳转期间的报错只会让用户看到一闪而过的误导提示。 */
function isAuthRedirectError(error) {
  return Boolean(error) && (error.code === 'AUTH_REQUIRED' || error.status === 401);
}

async function api(url, options = {}) {
  const { timeoutMs = API_TIMEOUT_MS, signal, ...requestOptions } = options;
  const opt = { credentials: 'same-origin', ...requestOptions };
  if (opt.body && !(opt.body instanceof FormData)) {
    opt.headers = { 'Content-Type': 'application/json', ...(opt.headers || {}) };
    opt.body = typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body);
  }

  const controller = new AbortController();
  let timeout;
  let timedOut = false;
  const abortWithCaller = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortWithCaller, { once: true });
  }
  if (timeoutMs > 0) timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  opt.signal = controller.signal;
  try {
    const res = await fetch(url, opt);
    if (res.status === 401) {
      location.href = '/login.html';
      throw apiError('未登录', 401, 'AUTH_REQUIRED');
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const message = data && typeof data.error === 'string' ? data.error : '请求失败';
      throw apiError(message, res.status, data && data.code);
    }
    return data;
  } catch (error) {
    // 只有内部超时触发的 abort 才提示「超时」；调用方自己传入 signal 主动取消时，
    // 保留原生 AbortError 抛给调用方自行判断（例如用户主动取消筛选请求，不应显示成超时）。
    if (error && error.name === 'AbortError' && timedOut) throw apiError('请求超时，请稍后重试', 408, 'REQUEST_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abortWithCaller);
  }
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
