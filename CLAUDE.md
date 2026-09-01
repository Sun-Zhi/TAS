# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

任务分配系统：多角色（admin / assigner / executor）任务派发、执行跟踪与数据大屏。纯 Node.js + Express，前端无构建步骤（原生 JS 经典脚本），数据库使用 Node 内置 `node:sqlite`（Node >= 22.5.0；package.json `engines` 按测试工具链 jsdom 30 的底线声明为 `^22.22.2 || ^24.15.0 || >=26.0.0`，两者以 engines 为准）。代码注释、UI 文案、提交信息、测试断言均使用中文，新代码保持一致。

## 常用命令

```bash
npm start                  # 启动服务（默认 0.0.0.0:3000；工作台 /index.html，大屏 /screen.html）
npm test                   # 依次跑全部回归脚本：auth → utils → theme → reset → task-security → e2e → ui
node scripts/e2e-test.js   # 单独跑某个回归脚本
npm run reset              # 清空数据库与附件、恢复默认账号（需先停服务）
node scripts/seed-demo.js  # 向当前数据库灌入演示任务数据
```

- 无本地 lint/format 配置；CI（`.gitea/workflows/`，Gitea Actions）在每次 push 做 gitleaks 密钥扫描、semgrep SAST、trivy 漏洞扫描（发现即阻断并自动开 Issue）。
- 每个测试脚本自包含：自动创建临时 `DATA_DIR`/`UPLOAD_DIR`，e2e 与 ui-test 还会在空闲端口自行拉起临时服务实例并自动清理，不污染真实 `data/` 目录。
- 首次启动自动 seed admin 账号（口令走 `ADMIN_PASSWORD`，否则随机生成并仅打印一次）。本地开发可加 `ENABLE_DEMO_ACCOUNTS=1`：pm01/pm02（assigner）、dev01/dev02/ops01（executor），口令走 `DEMO_PASSWORD` 或随机打印；生产环境启用演示账号会直接退出。
- `NODE_ENV=production` 时强制要求 `ADMIN_PASSWORD`、`DATA_DIR`、`UPLOAD_DIR`，缺失即退出。其他环境变量见 `server.js` 顶部与 `db.js`（`PORT`、`HOST`、`TRUST_PROXY`、`SECURE_COOKIES` 等）。

## 部署（Windows 生产环境）

- `scripts/deploy-system-update.cmd`（.ps1 同名）：生产部署脚本。自动提权 → 停计划任务 → robocopy 镜像仓库到 `C:\Program Files\TaskAssign\app`（排除 .git/data/uploads/日志）→ 以计划任务 "TaskAssign LAN Server" 重启 → 健康检查。数据目录固定在 `D:\TaskAssignData`。改完代码要上生产就跑这个。
- `scripts/start-lan-server.cmd`：开发/局域网临时起服务（0.0.0.0:3000）。

## 架构

### 后端（server.js + src/）

- `server.js` 入口：CSP 等安全头、统一错误中间件（multer 错误映射为中文 4xx，5xx 不透传内部 message）、优雅关闭。注意：`db.js` 在 require 时就读取 `DATA_DIR`/`UPLOAD_DIR` 并打开数据库——必须先设环境变量再 require 本项目模块。
- `src/db.js`：`node:sqlite` DatabaseSync + WAL。建表用 `CREATE TABLE IF NOT EXISTS`；对已部署旧库做幂等迁移（先 `PRAGMA table_info` 判断列是否存在再 `ALTER TABLE`）——加列时沿用此模式，不要写破坏性迁移。同时含 scrypt 密码哈希（新格式自带参数，兼容旧格式 `scrypt$salt$digest` 并自动升级）。
- `src/auth.js`：会话中间件。凭据为 cookie `ta_token` 或 `x-auth-token` 头；`attachUser` 只挂在 `/api` 下；权限用 `requireLogin` / `requireRole(...roles)`。
- `src/scryptGate.js`：scrypt 全局并发闸门（并发 ≤2、队列 ≤100），防止登录风暴占满 libuv 线程池。新增涉及 scrypt 的接口必须经过它。
- `src/routes/`：
  - `authRoutes.js` → `/api/auth`（登录/登出/me/改密）
  - `userRoutes.js` → `/api/users`（用户管理，含执行者岗位职责 responsibilities）
  - `taskRoutes.js` → `/api/tasks`（核心：任务 CRUD、完成申请/退回流程、附件上传下载；multer 限制 50MB×10 个、扩展名白名单，拒绝 SVG/exe 等）
  - `statsRoutes.js` → `/api/screen`、`/api/overview`、`/api/export`（CSV 导出）
- 读取和写入限流均按“用户 × 端点”使用独立滑动窗口 bucket；被拒绝的请求不计数，过期时间戳由定期清理回收。各 bucket 的阈值在对应路由文件中定义；限流状态 Map 总 key 数上限为 10,000（不是用户数上限，多端点会分别占用 key）。
- 数据可见性：admin 全量；assigner/executor 只能看自己创建或承接的任务。完成流程为 executor 提交 completion-request → assigner 确认（确认前任务仍是 in_progress），可退回（return）给执行者。注意例外：数据大屏 `/api/screen` 是刻意的全局视图，所有已登录角色看到相同的汇总与明细（评审 L1 记录的有意决策，不是越权缺陷）。

### 前端（public/，无构建、无框架）

- 页面：`index.html`（工作台）、`login.html`、`screen.html`（数据大屏）。
- 经典 `<script>` 共享全局作用域，加载顺序固定（见 app.js 头部注释）：`util.js → modal.js → due-picker.js → task-actions.js → users.js → app.js`（工作台主逻辑）；`screen.js` 为大屏；`login.js` 为登录页。
- CSP 为 `script-src 'self'`：**禁止内联脚本与 on* 内联事件处理器**，一律用 `addEventListener` 事件委托（新增前端代码必须遵守，否则浏览器直接拦截）。

## 约定

- 所有文件 `'use strict'`、CommonJS。
- 注释解释"为什么"而非"是什么"（现有代码风格如此，中文）。
- 用户输入在路由层校验；错误消息用中文；5xx 响应不泄露 SQL/路径/堆栈。
- `data/`、`uploads/`、`prompts/`、`*.log` 均已 gitignore，不要提交；根目录的 `*.log`、报告 md 属运行产物。
