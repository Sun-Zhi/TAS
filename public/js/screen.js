/* ============ 数据大屏 ============ */
'use strict';

/* $ / esc 复用 util.js（screen.html 先加载 util.js）。
 * 下面的 fmt / elapsed / PRI / ROLE 是大屏故意的紧凑变体（省年份、"时"代替"小时"、
 * 短角色名），与工作台 util.js 的全称版行为不同，请勿为"去重"而合并。 */
const PRI = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const ROLE = { admin: '管理员', assigner: '分配者', executor: '执行者' };

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

/* 页面级错误提示：刷新失败时在页头显示，大屏不能只把错误写进控制台 */
function showScreenError(message) {
  const el = $('#scrError');
  el.textContent = message;
  el.hidden = false;
}
function clearScreenError() {
  const el = $('#scrError');
  el.textContent = '';
  el.hidden = true;
}

/* 数据加载 */
let screenLoadInFlight = false;
// 429 退避状态：被限流时把 10 秒轮询逐级拉长（20s→40s→60s 封顶），
// 不与限流窗口硬顶、恢复后回到原速。滑窗限流本身会自愈（被拒不计数、
// 旧计数随时间溢出），退避只是让系统更快平静并省掉限流期间的无效轮询。
let refreshDelayMs = 10000;

function nextRefreshDelay() {
  // 多块大屏可能共用一个账号；加入小幅抖动，避免成功或退避后再次同相请求。
  return Math.round(refreshDelayMs * (0.8 + Math.random() * 0.4));
}

/* 返回 true 表示本轮被 429 限流，null 表示跳过，其余情况返回 false */
async function load() {
  // 上一轮请求未完成时直接跳过本轮，避免轮询请求堆积重入
  if (screenLoadInFlight) return null;
  screenLoadInFlight = true;
  let data;
  try {
    const res = await fetch('/api/screen', { credentials: 'same-origin' });
    if (res.status === 401) { location.href = '/login.html'; return false; }
    if (!res.ok) {
      // 保留页面上次成功加载的数据，只提示刷新失败
      if (res.status === 429) {
        // 429 = 超过限流阈值：这是多屏等场景下的临时状态且会自行恢复，
        // 明确告知用户「稍后自动恢复」，与普通加载失败区分开
        showScreenError('数据刷新失败（请求过于频繁，稍后自动恢复）');
        console.error('大屏数据加载被限流（HTTP 429）');
        return true;
      }
      showScreenError('数据刷新失败，页面显示的是上次成功加载的数据');
      console.error('大屏数据加载失败，HTTP', res.status);
      return false;
    }
    data = await res.json();
  } catch (error) {
    showScreenError('数据刷新失败，页面显示的是上次成功加载的数据');
    console.error('大屏数据加载失败', error);
    return false;
  } finally {
    screenLoadInFlight = false;
  }

  try {
    if (!data || !data.summary || !Array.isArray(data.running) || !Array.isArray(data.done) ||
      !Array.isArray(data.trend) || !Array.isArray(data.categories)) {
      throw new Error('大屏响应数据格式无效');
    }
    clearScreenError();
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
        <div class="mt">发布者 ${esc(t.creator_name)}　·　接收人 ${esc(t.assignee_name)}（${esc(ROLE[t.assignee_role] || t.assignee_role)}）　·　派发 ${fmt(t.created_at)}　·　${PRI[t.priority]}优先级</div>
      </div>
      <div class="rt"><div class="big ${t.overdue ? 'tone-late' : 'tone-run'}">${elapsed(t.created_at)}</div>
        <div class="t-sub-xs">已进行</div></div>
    </div>`).join('') : '<div class="blank">当前没有执行中的任务</div>';

  /* 已完成 */
  $('#cntDone').textContent = `${data.done.length} 条`;
  $('#listDone').innerHTML = data.done.length ? data.done.map((t) => `
    <div class="item done">
      <div class="id">T${String(t.id).padStart(4, '0')}</div>
      <div class="body">
        <div class="tt">${esc(t.title)}<span class="chip">${esc(t.category)}</span></div>
        <div class="mt">发布者 ${esc(t.creator_name)}　·　接收人 ${esc(t.assignee_name)}（${esc(ROLE[t.assignee_role] || t.assignee_role)}）　·　完成 ${fmt(t.completed_at)}</div>
      </div>
      <div class="rt"><div class="big tone-done">${esc(t.duration_text)}</div>
        <div class="t-sub-xs">执行耗时</div></div>
    </div>`).join('') : '<div class="blank">暂无已完成任务</div>';

  /* 所有角色任务接收分布 */
  const recipients = data.recipients || data.executors || [];
  const maxTotal = Math.max(1, ...recipients.map((e) => e.total));
  $('#listRank').innerHTML = recipients.length ? recipients.map((e, i) => `
    <div class="rank">
      <div class="no ${i < 3 ? 't' + (i + 1) : ''}">${i + 1}</div>
      <div class="nm" title="${esc(e.name)} · ${esc(ROLE[e.role] || e.role)}">${esc(e.name)}<small> · ${esc(ROLE[e.role] || e.role)}</small></div>
      <div class="track">
        <i class="d"></i>
        <i class="r"></i>
      </div>
      <div class="nums"><b>${e.done}</b>/${e.total}　${e.rate}%</div>
    </div>`).join('') : '<div class="blank">暂无数据</div>';
  // CSP 已禁止 style 属性：动态百分比在渲染后经 CSSOM 写入（element.style 赋值不受 style-src 限制）
  $('#listRank').querySelectorAll('.rank').forEach((row, i) => {
    const e = recipients[i];
    row.querySelector('.track i.d').style.width = `${(e.done / maxTotal) * 100}%`;
    row.querySelector('.track i.r').style.width = `${(e.running / maxTotal) * 100}%`;
  });

  /* 趋势 */
  const maxTrend = Math.max(1, ...data.trend.map((d) => Math.max(d.created, d.done)));
  $('#trend').innerHTML = data.trend.map((d) => `
    <div class="col">
      <div class="bars">
        <i class="c" title="新建 ${d.created}"></i>
        <i class="d" title="完成 ${d.done}"></i>
      </div>
      <div class="lb">${esc(d.date)}</div>
    </div>`).join('');
  $('#trend').querySelectorAll('.col').forEach((col, i) => {
    const d = data.trend[i];
    col.querySelector('.bars i.c').style.height = `${(d.created / maxTrend) * 100}%`;
    col.querySelector('.bars i.d').style.height = `${(d.done / maxTrend) * 100}%`;
  });

  /* 类别 */
  const maxCat = Math.max(1, ...data.categories.map((c) => c.total));
  $('#listCat').innerHTML = data.categories.length ? data.categories.map((c) => `
    <div class="cat">
      <div class="nm" title="${esc(c.category)}">${esc(c.category)}</div>
      <div class="track"><i></i></div>
      <div class="nums">${c.done}/${c.total}</div>
    </div>`).join('') : '<div class="blank">暂无数据</div>';
  $('#listCat').querySelectorAll('.cat').forEach((row, i) => {
    row.querySelector('.track i').style.width = `${(data.categories[i].total / maxCat) * 100}%`;
  });
  } catch (error) {
    showScreenError('数据刷新失败，页面显示的是上次成功加载的数据');
    console.error('大屏数据渲染失败', error);
    return false;
  }
  return false;
}

load().catch((error) => console.error('大屏首次加载失败', error));
// 递归 setTimeout 轮询：上一轮完成后才调度下一轮，避免固定间隔下的请求堆积。
// 本轮被 429 限流则把间隔加倍（10s→20s→40s→60s 封顶），成功后回到 10 秒原速。
function scheduleScreenRefresh() {
  setTimeout(async () => {
    try {
      const limited = await load();
      if (limited === true) refreshDelayMs = Math.min(refreshDelayMs * 2, 60000);
      else if (limited === false) refreshDelayMs = 10000;
      // 本轮跳过时保持当前退避级别，避免在途请求造成退避错误重置。
    } catch (error) {
      // 即使渲染或页面环境异常，也必须继续轮询，避免一次坏响应永久停止刷新。
      console.error('大屏轮询失败', error);
      refreshDelayMs = 10000;
    } finally {
      scheduleScreenRefresh();
    }
  }, nextRefreshDelay());
}
scheduleScreenRefresh();

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
