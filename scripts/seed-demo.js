/* 生成演示任务数据：node scripts/seed-demo.js */
'use strict';
const { db, nowISO } = require('../src/db');

const H = 3600_000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

const U = {};
for (const u of db.prepare('SELECT id, username FROM users').all()) U[u.username] = u.id;

// [标题, 类别, 优先级, 创建者, 执行者, 创建于(小时前), 完成于(小时前 或 null), 说明]
const DATA = [
  ['官网首页改版视觉稿评审', '需求开发', 'high', 'pm01', 'dev01', 96, 88, '视觉稿已通过评审并归档'],
  ['支付回调超时问题排查', '线上问题', 'urgent', 'pm01', 'dev02', 72, 68.5, '定位为第三方网关抖动，已加重试'],
  ['用户中心接口性能优化', '需求开发', 'high', 'pm01', 'dev01', 68, 44, '接口 P95 从 820ms 降至 210ms'],
  ['季度服务器安全巡检', '运维巡检', 'normal', 'pm02', 'ops01', 60, 52, '巡检报告已上传'],
  ['促销活动落地页开发', '需求开发', 'normal', 'pm02', 'dev02', 50, 26, '已上线并通过验收'],
  ['数据库慢查询治理', '技术优化', 'high', 'pm01', 'dev01', 46, 30, '新增 6 个索引，慢查询下降 82%'],
  ['客服工单系统对接联调', '需求开发', 'normal', 'pm02', 'ops01', 40, 20, '联调完成，已进入灰度'],
  ['月度运营数据报表输出', '数据报表', 'low', 'pm02', 'ops01', 30, 22, '报表已发送至运营群'],
  ['App 启动崩溃修复', '线上问题', 'urgent', 'pm01', 'dev02', 26, 24, '已发布 hotfix 版本'],

  ['订单模块重构方案设计', '技术优化', 'high', 'pm01', 'dev01', 20, null, ''],
  ['会员积分规则调整开发', '需求开发', 'normal', 'pm02', 'dev02', 14, null, ''],
  ['CDN 带宽异常告警跟进', '线上问题', 'urgent', 'pm01', 'ops01', 9, null, ''],
  ['新版权限体系需求梳理', '需求开发', 'normal', 'pm02', 'dev01', 6, null, ''],
  ['测试环境资源清理', '运维巡检', 'low', 'pm02', 'ops01', 3, null, ''],
  ['埋点数据校验脚本编写', '数据报表', 'normal', 'pm01', 'dev02', 1.5, null, ''],
];

const exists = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
if (exists > 0) {
  console.log(`当前已有 ${exists} 个任务，跳过演示数据生成（如需重来请先执行 npm run reset）。`);
  process.exit(0);
}

const insTask = db.prepare(
  `INSERT INTO tasks (title, description, category, priority, status, creator_id, assignee_id, due_at, created_at, completed_at, result_note)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insLog = db.prepare(
  'INSERT INTO task_logs (task_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)'
);

let n = 0;
for (const [title, cat, pri, creator, assignee, createdH, doneH, note] of DATA) {
  const createdAt = iso(createdH * H);
  const completedAt = doneH == null ? null : iso(doneH * H);
  const status = doneH == null ? 'in_progress' : 'completed';
  // 部分执行中任务设置已过期的截止时间，用于演示逾期
  const dueAt = doneH == null && (n % 4 === 2) ? iso(2 * H) : iso(-24 * H);

  const info = insTask.run(
    title, `${title}——由 ${creator} 派发，请按验收标准完成后标记。`, cat, pri, status,
    U[creator], U[assignee], dueAt, createdAt, completedAt, note
  );
  const tid = Number(info.lastInsertRowid);
  insLog.run(tid, U[creator], 'create', '任务已创建并派发', createdAt);
  if (completedAt) {
    const ms = new Date(completedAt) - new Date(createdAt);
    const min = Math.floor(ms / 60000);
    const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    const txt = (d ? `${d}天` : '') + (h ? `${h}小时` : '') + (m || (!d && !h) ? `${m}分` : '');
    insLog.run(tid, U[assignee], 'complete', `标记完成，耗时 ${txt}`, completedAt);
  }
  n++;
}

console.log(`已生成 ${n} 个演示任务（${DATA.filter((d) => d[6] == null).length} 个执行中 / ${DATA.filter((d) => d[6] != null).length} 个已完成）。`);
