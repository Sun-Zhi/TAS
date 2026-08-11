'use strict';

/** 毫秒 -> "2天3小时15分" */
function humanDuration(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return '';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d) parts.push(`${d}天`);
  if (h) parts.push(`${h}小时`);
  if (m || parts.length === 0) parts.push(`${m}分`);
  return parts.join('');
}

/** 任务耗时（创建 -> 完成），未完成返回 null */
function taskDuration(task) {
  if (task.status !== 'completed' || !task.completed_at) return null;
  const ms = new Date(task.completed_at).getTime() - new Date(task.created_at).getTime();
  return ms >= 0 ? ms : 0;
}

const CSV_HEADERS = [
  '任务编号', '任务标题', '任务类别', '优先级', '状态',
  '执行者', '执行者账号', '所属部门', '创建者',
  '创建时间', '要求完成时间', '完成时间', '耗时', '附件数', '任务描述', '完成说明',
];

function csvEscape(value) {
  let s = value == null ? '' : String(value);
  // 防止 Excel/WPS 将用户输入解释为公式（CSV Injection）。
  if (/^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCSV(rows) {
  const lines = [CSV_HEADERS.join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  // BOM 保证 Excel 正确识别 UTF-8
  return '\uFEFF' + lines.join('\r\n');
}

function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const PRIORITY_TEXT = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const STATUS_TEXT = { in_progress: '执行中', completed: '已完成' };
const ROLE_TEXT = { admin: '管理员', assigner: '任务分配者', executor: '任务执行者' };

module.exports = {
  humanDuration, taskDuration, toCSV, fmtLocal,
  PRIORITY_TEXT, STATUS_TEXT, ROLE_TEXT,
};
