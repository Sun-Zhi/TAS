/* 密码哈希回归：node scripts/auth-regression.js
 * 覆盖本次登录改造涉及的哈希格式解析、旧格式兼容与异步校验，
 * 防止哈希解析/升级逻辑被误改破坏存量账号登录。 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'taskassign-auth-'));
process.env.DATA_DIR = path.join(TEST_ROOT, 'data');
process.env.UPLOAD_DIR = path.join(TEST_ROOT, 'uploads');
process.env.ENABLE_DEMO_ACCOUNTS = '0';

const {
  db, hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync,
  isLegacyHash, parseStoredHash, DUMMY_HASH, DUMMY_HASH_LEGACY,
} = require('../src/db');
const { validatePassword } = require('../src/utils');
const authRoutes = require('../src/routes/authRoutes');

let pass = 0;
let fail = 0;

function ok(condition, label, extra = '') {
  if (condition) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? `: ${extra}` : ''}`); }
}

// 按历史参数（Node scrypt 默认 N=16384）构造旧格式哈希 scrypt$salt$digest
const LEGACY_OPTS = { N: 16384, r: 8, p: 1 };
function legacyHash(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(plain, salt, 64, LEGACY_OPTS).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

const NEW_HASH_PATTERN = /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/;

/** 用独立临时库跑一次种子初始化（ADMIN_PASSWORD 与 DEMO_PASSWORD 故意相同），
 * 返回 { admin, demo, demoShared }：验证管理员哈希与演示哈希隔离、演示账号间复用哈希 */
function probeSeedHashes() {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskassign-seed-'));
    const dbPath = JSON.stringify(path.join(__dirname, '..', 'src', 'db.js'));
    const script = `
      const { db } = require(${dbPath});
      const rows = db.prepare('SELECT username, password FROM users ORDER BY username').all();
      const demo = rows.filter((row) => row.username !== 'admin');
      console.log(JSON.stringify({
        admin: (rows.find((row) => row.username === 'admin') || {}).password || '',
        demo: (demo[0] || {}).password || '',
        demoShared: demo.length > 1 && demo.every((row) => row.password === demo[0].password),
      }));
      db.close();
    `;
    const child = spawn(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        DATA_DIR: path.join(dir, 'data'),
        UPLOAD_DIR: path.join(dir, 'uploads'),
        ADMIN_PASSWORD: 'same-secret-for-both',
        DEMO_PASSWORD: 'same-secret-for-both',
        ENABLE_DEMO_ACCOUNTS: '1',
        // 演示账号在生产环境会被拒绝启动，显式指定避免继承生产环境变量
        NODE_ENV: 'test',
      },
    });
    let output = '';
    let stderrOutput = '';
    let settled = false;
    // spawn 失败或子进程挂起时保证 Promise 有结局并清理临时目录，避免测试进程无限等待
    const failProbe = (error) => {
      if (settled) return;
      settled = true;
      fs.rmSync(dir, { recursive: true, force: true });
      reject(error);
    };
    const timer = setTimeout(() => failProbe(new Error('种子探针超时')), 30000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { stderrOutput += chunk; });
    child.on('error', (error) => failProbe(error));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      fs.rmSync(dir, { recursive: true, force: true });
      if (code !== 0) {
        reject(new Error(`种子探针进程退出码 ${code}${stderrOutput ? `: ${stderrOutput.slice(0, 300)}` : ''}`));
        return;
      }
      try {
        resolve(JSON.parse(output.trim()));
      } catch {
        reject(new Error('种子探针输出解析失败'));
      }
    });
  });
}

async function main() {
  console.log('\n密码哈希回归');

  console.log('\n【1】哈希格式解析');
  const newHash = hashPassword('auth-regression-password');
  const parsedNew = parseStoredHash(newHash);
  ok(parsedNew && !parsedNew.legacy &&
    parsedNew.opts.N === 2 ** 17 && parsedNew.opts.r === 8 && parsedNew.opts.p === 1,
  '新格式哈希解析为 N=2^17 / r=8 / p=1 且非 legacy');
  const parsedLegacy = parseStoredHash(legacyHash('auth-regression-password'));
  ok(parsedLegacy && parsedLegacy.legacy && parsedLegacy.opts.N === 16384,
    '旧格式哈希解析为 legacy 且按 N=16384 校验');
  ok(parseStoredHash('plaintext') === null, '非 scrypt 前缀存储解析为 null');
  ok(parseStoredHash('scrypt$16383$8$1$salt$digest') === null, '6 段但 N 非 2 的幂被拒绝');
  ok(parseStoredHash('scrypt$$') === null, '缺 salt/digest 被拒绝');
  ok(parseStoredHash('scrypt$-1$8$1$salt$digest') === null, '非法数值参数被拒绝');

  console.log('\n【2】旧格式识别');
  ok(isLegacyHash(legacyHash('x')), '旧格式哈希 isLegacyHash 为 true');
  ok(!isLegacyHash(hashPassword('x')), '新格式哈希 isLegacyHash 为 false');
  ok(!isLegacyHash('garbage'), '非法存储 isLegacyHash 为 false');

  console.log('\n【3】同步哈希与校验');
  ok(NEW_HASH_PATTERN.test(newHash), '新哈希为 scrypt$N$r$p$salt$digest 格式');
  ok(verifyPassword('auth-regression-password', newHash), '新格式哈希可校验正确密码');
  ok(!verifyPassword('wrong-password', newHash), '新格式哈希拒绝错误密码');
  ok(!verifyPassword('auth-regression-password', 'garbage'), '非法存储校验返回 false 不抛错');
  const legacy = legacyHash('legacy-password');
  ok(verifyPassword('legacy-password', legacy), '旧格式哈希仍可校验（存量账号登录不受影响）');
  ok(!verifyPassword('wrong-password', legacy), '旧格式哈希拒绝错误密码');

  console.log('\n【4】异步哈希（请求路径外的密码升级）');
  const asyncHash = await hashPasswordAsync('async-password');
  ok(NEW_HASH_PATTERN.test(asyncHash), '异步哈希格式与同步一致', asyncHash);
  ok(verifyPassword('async-password', asyncHash), '异步哈希可被校验');
  ok(await verifyPasswordAsync('auth-regression-password', newHash), '异步校验正确密码为 true');
  ok(!(await verifyPasswordAsync('wrong-password', newHash)), '异步校验错误密码为 false');
  ok(!(await verifyPasswordAsync('legacy-password', 'garbage')), '异步校验非法存储为 false 不抛错');
  ok(await verifyPasswordAsync('legacy-password', legacy), '异步校验支持旧格式哈希');

  console.log('\n【5】登录 scrypt 全局预算');
  authRoutes.__test.resetScryptGateMetrics();
  const gateResults = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    authRoutes.__test.runWithScryptGate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return index;
    })
  ));
  const gateState = authRoutes.__test.getScryptGateState();
  ok(gateResults.length === 8 && gateState.active === 0 && gateState.queued === 0,
    'scrypt 队列可全部完成且不遗留任务');
  ok(gateState.maxObserved <= 2, '所有排队任务共享最大 2 个并发预算');

  authRoutes.__test.resetScryptGateMetrics();
  await Promise.all(Array.from({ length: 4 }, () =>
    authRoutes.__test.verifyLoginPassword('legacy-password', { password: legacy })
  ));
  const legacyGateState = authRoutes.__test.getScryptGateState();
  ok(legacyGateState.maxObserved <= 2 && legacyGateState.active === 0,
    '旧格式真实校验和 dummy 校验同样受全局预算限制');

  authRoutes.__test.resetScryptGateMetrics();
  await Promise.all(Array.from({ length: 4 }, () =>
    authRoutes.__test.verifyLoginPassword('wrong-password', { password: newHash })
  ));
  const newGateState = authRoutes.__test.getScryptGateState();
  ok(newGateState.maxObserved <= 2 && newGateState.active === 0,
    '新格式账号校验同样执行两次受闸门保护的 scrypt');

  console.log('\n【6】预置 dummy hash（登录防枚举）');
  ok(NEW_HASH_PATTERN.test(DUMMY_HASH) && parseStoredHash(DUMMY_HASH)?.opts.N === 2 ** 17,
    'DUMMY_HASH 为合法新格式（预置生成，启动无需真实 scrypt）');
  ok(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(DUMMY_HASH_LEGACY),
    'DUMMY_HASH_LEGACY 为合法旧格式');
  ok(!(await verifyPasswordAsync('any-password', DUMMY_HASH)), 'DUMMY_HASH 校验任意口令均返回 false');
  ok(!(await verifyPasswordAsync('any-password', DUMMY_HASH_LEGACY)), 'DUMMY_HASH_LEGACY 校验任意口令均返回 false');

  console.log('\n【7】种子初始化哈希隔离');
  const seedHashes = await probeSeedHashes();
  ok(seedHashes && seedHashes.admin !== seedHashes.demo,
    'ADMIN_PASSWORD 与演示口令相同时，管理员与演示账号哈希不同');
  ok(seedHashes && seedHashes.demoShared,
    '演示账号共享口令时复用同一条哈希（省启动 scrypt）');

  console.log('\n【8】密码强度校验');
  ok(validatePassword('short') !== null, '少于 8 位被拒绝');
  ok(validatePassword('        ') !== null, '纯空白密码被拒绝');
  ok(validatePassword('12345678') !== null, '纯数字密码被拒绝');
  ok(validatePassword('abcdefgh') !== null, '纯字母密码被拒绝');
  ok(validatePassword('a1'.repeat(65)) !== null, '超过 128 位被拒绝');
  ok(validatePassword(12345678) !== null, '非字符串密码被拒绝');
  ok(validatePassword('abc12345') === null, '字母+数字 8 位密码通过');
  ok(validatePassword('密码Pass123') === null, '含中文的合规密码通过');

  console.log(`\n${'='.repeat(48)}\n  通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(48)}\n`);
  if (fail) throw new Error(`密码哈希回归失败 ${fail} 项`);
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    db.close();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
})();
