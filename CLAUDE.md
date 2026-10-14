# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

云端全托管 Agent 工作流原型：控制面（编排、策略、审批、审计）与执行面（一次性沙箱 + 受限工具网关）分离。Agent 内核不自研，复用 Claude Code / Codex CLI 的非交互模式。当前 `gateway/`、`orchestrator/`、`web/` 已实现并在 local 引擎上全链路验证，`sandbox/` 配方与接线完成但未实测（详见 `docs/architecture.md`）。

## 常用命令

```bash
pnpm install           # 包管理器是 pnpm（勿用 npm）；devDeps：typescript / @types/node / @types/pg
pnpm run build         # tsc -> dist/，并把非 TS 资产拷进去（scripts/copy-assets.mjs）
pnpm run typecheck     # 只做类型检查，不发文件
# 以上及常用流程也有 make 封装：make help 看全部目标（make db / run / web / anomaly ...）

# 应用 schema（0001 幂等；0002-0004 为 ALTER，非幂等，各应用一次）
sqlite3 agent.db < migrations/0001_init.sql
sqlite3 agent.db < migrations/0002_run_workspace.sql
sqlite3 agent.db < migrations/0003_tenant.sql
sqlite3 agent.db < migrations/0004_task_params.sql

# Postgres 等价 DDL（逻辑 schema 与 sqlite 版逐列一致）
psql "$PG_URL" -f migrations/pg/0001_init.sql   # 0002-0004 同理

# 常用入口（详见 README；均指编译产物）
node dist/orchestrator/run.js --goal "..." --engine local --db agent.db
node dist/web/server.js --db agent.db
```

`--db` 同时接受 sqlite 路径与 `postgres://` 连接串（`lib/db.ts`）。

源码是 TypeScript，`tsc` 编译到 `dist/`：**改了源码要先 `pnpm run build`**，运行入口一律是 `dist/` 下的 `.js`（`node dist/orchestrator/run.js`），不是 `.ts`。`tsc` 不产出 `gateway/policy.json`、`gateway/hooks-settings.json`、`sandbox/` 这类非 TS 资产，由 `scripts/copy-assets.mjs` 拷进 `dist/`（`execute.ts` 会拉起 `dist/gateway/daemon.js`，运行时这些文件必须与代码同处）。包管理统一用 **pnpm**（锁文件 `pnpm-lock.yaml`，`packageManager` 字段固定版本）；`Makefile` 汇总了 install/build/db/run/approve/fork/merge/queue/dispatch/web/anomaly 等入口。

## 架构约定

- **语言与构建**：全部源码为 TypeScript + ESM，`tsconfig.json` 编译到 `dist/`（`rootDir: .`，产物与源码同构）；相对导入写显式 `.js`（`module: nodenext` 会解析回 `.ts`），入口判断用 `import.meta.main`、目录内路径用 `import.meta.dirname`。包管理器是 pnpm，不要引入 npm 的 package-lock；运行只跑 `dist/`，改了源码必须重新 build。运行时要求 Node ≥ 24.2
- **数据库**：双后端已就位——`lib/db.ts` 统一 async API，sqlite 走 `node:sqlite`，`postgres://` 走 `pg`（`?`→`$n`、`json_extract`→`::json->>` 由包装层改写）。schema 保持 Postgres 兼容子集——TEXT 自增 id 由应用生成 uuid、RFC3339 UTC 时间戳存 TEXT、JSON 存 TEXT；两边 DDL 分别在 `migrations/` 与 `migrations/pg/`，必须同步修改。
- **`events` 是追加式全事件流**，主键 `(run_id, seq)`，`seq` 由工具网关单调分配；工具网关是唯一写入路径，审计回放、审批、计费、异常检测全部是该表的读取方。任何新消费方不得直接写 `events`。
- **状态机由 CHECK 约束钉死**：`tasks.status` 为 created/running/awaiting_approval/done/failed/cancelled；`runs.status` 为 pending/running/awaiting_approval/succeeded/failed/cancelled。新增状态必须改 schema，不允许应用层绕过。
- **运行模型**：task 是人提交的工作单元，run 是它在一次性沙箱中的一次执行尝试（`agent_kind` 为 claude 或 codex）；`thread_id` 是阶段 2 的分叉/合并血缘，阶段 1 留空。产物（diff、报告、日志）写 `artifacts`，交回人工审批。
