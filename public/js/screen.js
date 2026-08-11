/* ============ 数据大屏 ============ */
'use strict';

const $ = (s) => document.querySelector(s);
const PRI = { low: '低', normal: '普通', high: '高', urgent: '紧急' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function elapsed(fromISO) {
  const min = Math.floor((Date.now() - new Date(fromISO).getTime()) / 60000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d) return `${d}天${h}时`;
  if (h) return `${h}时${m}分`;
  return `${m}分`;
}

/* 时钟 */
function tick() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('#clkTime').textContent = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  $('#clkDate').textContent = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} 周${week}`;
}
setInterval(tick, 1000);
tick();

/* 数据加载 */
async function load() {
  let data;
  try {
    const res = await fetch('/api/screen', { credentials: 'same-origin' });
    if (res.status === 401) { location.href = '/login.html'; return; }
    data = await res.json();
  } catch {
    return;
  }

  const s = data.summary;
  $('#kpis').innerHTML = `
    <div class="kpi"><div class="k">任务总数</div><div class="v">${s.total}</div><div class="d">今日新建 ${s.created_today}</div></div>
    <div class="kpi c2"><div class="k">执行中</div><div class="v">${s.running}</div><div class="d">进行中的任务</div></div>
    <div class="kpi c3"><div class="k">已完成</div><div class="v">${s.done}</div><div class="d">今日完成 ${s.done_today}</div></div>
    <div class="kpi c4"><div class="k">已逾期</div><div class="v">${s.overdue}</div><div class="d">超出要求完成时间</div></div>
    <div class="kpi c1"><div class="k">任务完成率</div><div class="v">${s.complete_rate}<small>%</small></div><div class="d">完成 / 总数</div></div>
    <div class="kpi c1"><div class="k">平均执行耗时</div><div class="v small">${esc(s.avg_duration_text)}</div><div class="d">最快 ${esc(s.fastest_duration_text)}</div></div>`;

  /* 执行中 */
  $('#cntRun').textContent = `${data.running.length} 条`;
  $('#listRun').innerHTML = data.running.length ? data.running.map((t) => `
    <div class="item pri-${t.priority}">
      <div class="id">T${String(t.id).padStart(4, '0')}</div>
      <div class="body">
        <div class="tt">${esc(t.title)}${t.overdue ? '<span class="chip late">逾期</span>' : ''}<span class="chip">${esc(t.category)}</span></div>
        <div class="mt">执行人 ${esc(t.assignee_name)}　·　派发 ${fmt(t.created_at)}　·　${PRI[t.priority]}优先级</div>
      </div>
      <div class="rt"><div class="big ${t.overdue ? 'tone-late' : 'tone-run'}">${elapsed(t.created_at)}</div>
        <div style="color:#7d93b8;font-size:11px">已进行</div></div>
    </div>`).join('') : '<div class="blank">当前没有执行中的任务</div>';

  /* 已完成 */
  $('#cntDone').textContent = `${data.done.length} 条`;
  $('#listDone').innerHTML = data.done.length ? data.done.map((t) => `
    <div class="item done">
      <div class="id">T${String(t.id).padStart(4, '0')}</div>
      <div class="body">
        <div class="tt">${esc(t.title)}<span class="chip">${esc(t.category)}</span></div>
        <div class="mt">执行人 ${esc(t.assignee_name)}　·　完成 ${fmt(t.completed_at)}</div>
      </div>
      <div class="rt"><div class="big tone-done">${esc(t.duration_text)}</div>
        <div style="color:#7d93b8;font-size:11px">执行耗时</div></div>
    </div>`).join('') : '<div class="blank">暂无已完成任务</div>';

  /* 执行者分布 */
  const maxTotal = Math.max(1, ...data.executors.map((e) => e.total));
  $('#listRank').innerHTML = data.executors.length ? data.executors.map((e, i) => `
    <div class="rank">
      <div class="no ${i < 3 ? 't' + (i + 1) : ''}">${i + 1}</div>
      <div class="nm" title="${esc(e.name)}">${esc(e.name)}</div>
      <div class="track">
        <i class="d" style="width:${(e.done / maxTotal) * 100}%"></i>
        <i class="r" style="width:${(e.running / maxTotal) * 100}%"></i>
      </div>
      <div class="nums"><b>${e.done}</b>/${e.total}　${e.rate}%</div>
    </div>`).join('') : '<div class="blank">暂无数据</div>';

  /* 趋势 */
  const maxTrend = Math.max(1, ...data.trend.map((d) => Math.max(d.created, d.done)));
  $('#trend').innerHTML = data.trend.map((d) => `
    <div class="col">
      <div class="bars">
        <i class="c" style="height:${(d.created / maxTrend) * 100}%" title="新建 ${d.created}"></i>
        <i class="d" style="height:${(d.done / maxTrend) * 100}%" title="完成 ${d.done}"></i>
      </div>
      <div class="lb">${d.date}</div>
    </div>`).join('');

  /* 类别 */
  const maxCat = Math.max(1, ...data.categories.map((c) => c.total));
  $('#listCat').innerHTML = data.categories.length ? data.categories.map((c) => `
    <div class="cat">
      <div class="nm" title="${esc(c.category)}">${esc(c.category)}</div>
      <div class="track"><i style="width:${(c.total / maxCat) * 100}%"></i></div>
      <div class="nums">${c.done}/${c.total}</div>
    </div>`).join('') : '<div class="blank">暂无数据</div>';
}

load();
setInterval(load, 10000);

/* 列表自动滚动播放 */
function autoScroll(el, speed = 0.35) {
  let paused = false;
  el.addEventListener('mouseenter', () => (paused = true));
  el.addEventListener('mouseleave', () => (paused = false));
  let acc = 0;
  setInterval(() => {
    if (paused) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 4) return;
    acc += speed;
    if (acc >= 1) { el.scrollTop += Math.floor(acc); acc = 0; }
    if (el.scrollTop >= max - 1) el.scrollTop = 0;
  }, 40);
}
autoScroll(document.getElementById('listRun'));
autoScroll(document.getElementById('listDone'));
