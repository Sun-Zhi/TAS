/* 清空数据库与附件，恢复默认账号。用法：npm run reset */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const uploadDir = path.join(root, 'uploads');

for (const f of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) {
  if (f.startsWith('app.db')) fs.rmSync(path.join(dataDir, f), { force: true });
}
for (const f of fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : []) {
  fs.rmSync(path.join(uploadDir, f), { force: true });
}
console.log('已重置数据库与附件，下次启动将重新创建默认账号。');
