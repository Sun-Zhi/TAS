'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync, backup } = require('node:sqlite');

async function main() {
  const [, , sourceArg, destinationArg] = process.argv;
  if (!sourceArg || !destinationArg) {
    throw new Error('Usage: node database-backup.js <source.db> <destination.db>');
  }

  const sourcePath = path.resolve(sourceArg);
  const destinationPath = path.resolve(destinationArg);
  if (sourcePath === destinationPath) throw new Error('Source and destination must differ');
  if (!fs.existsSync(sourcePath)) throw new Error(`Source database not found: ${sourcePath}`);
  if (fs.existsSync(destinationPath)) throw new Error(`Destination already exists: ${destinationPath}`);

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, destinationPath);
  } finally {
    source.close();
  }

  const verified = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    const quickCheck = verified.prepare('PRAGMA quick_check').get().quick_check;
    if (quickCheck !== 'ok') throw new Error(`Backup verification failed: ${quickCheck}`);
    const users = Number(verified.prepare('SELECT COUNT(*) AS count FROM users').get().count);
    const tasks = Number(verified.prepare('SELECT COUNT(*) AS count FROM tasks').get().count);
    process.stdout.write(JSON.stringify({ sourcePath, destinationPath, quickCheck, users, tasks }));
  } finally {
    verified.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
