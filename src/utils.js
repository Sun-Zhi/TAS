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

/** 仅 1/true/yes 视为启用；'0'、空字符串、空格等其他值一律视为关闭 */
function isTruthyEnv(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

const PASSWORD_MIN_LEN = 8;
const PASSWORD_MAX_LEN = 128;

/** 密码强度校验：合法返回 null，否则返回中文错误提示。
 *  规则：8-128 位字符串、不能全为空白、至少包含一个字母和一个数字。 */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LEN) return '密码至少 8 位';
  if (password.length > PASSWORD_MAX_LEN) return `密码不能超过 ${PASSWORD_MAX_LEN} 位`;
  if (!password.trim()) return '密码不能全为空白';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码需同时包含字母和数字';
  return null;
}

module.exports = {
  humanDuration, taskDuration, toCSV, fmtLocal,
  PRIORITY_TEXT, STATUS_TEXT, ROLE_TEXT, isTruthyEnv,
  validatePassword,
};
