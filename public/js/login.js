/* ============ 登录页逻辑 ============ */
'use strict';

const $ = (s) => document.querySelector(s);

function toast(msg, type) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + (type || '');
  // 与 util.js 保持一致：清除上一个定时器，避免连续提示被提前隐藏
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = ''), 2800);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#submitBtn');
  btn.disabled = true; btn.textContent = '登录中...';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#username').value.trim(), password: $('#password').value }),
    });
    // 网关/服务器异常时可能返回 HTML 错误页而非 JSON，直接 res.json() 会抛 SyntaxError
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) throw new Error((data && data.error) || '服务器响应异常，请稍后再试');
    location.href = '/index.html';
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false; btn.textContent = '登 录';
  }
});
