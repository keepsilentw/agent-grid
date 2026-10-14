# agent-grid

云端全托管 Agent 工作流的原型：控制面（编排、策略、审批、审计）与执行面（一次性沙箱 + 受限工具网关）分离。Agent 内核不自研，复用 Claude Code / Codex CLI 的非交互模式。

## 当前状态

本地可验证范围全部完成（阶段 1/2 + 阶段 3 的多租户、异常检测、线程 merge、reject 回滚、Runner 调度器、Postgres 双后端）。docker 引擎接线完成但未实测。架构详见 `docs/architecture.md`。

源码为 TypeScript（ESM），用 `tsc` 编译到 `dist/`——**先构建再运行**：`pnpm run build`，然后 `node dist/orchestrator/run.js`。要求 Node ≥ 24.2（`import.meta.main`）。包管理器是 **pnpm**；日常入口也收在 `Makefile`（`make help`）。

## 目录结构

| 目录 | 职责 |
|---|---|
| `migrations/` | sqlite 版 0001-0004；`migrations/pg/` 为同逻辑 schema 的 PG 方言 DDL |
| `lib/` | `db.ts` 统一 async DB 层（sqlite / pg 双驱动）、`types.ts` 共享领域类型、`errors.ts` |
| `gateway/` | 工具网关：hook、daemon（策略链 + 出口代理 + events 唯一写入）、proxy（白名单 + CA 凭据注入）、classifier、anomaly、collect、policy.json |
| `orchestrator/` | run / fork / merge / approve / submit / dispatcher CLI + 共享执行流 execute.ts + tenant |
| `sandbox/` | 一次性容器配方（未实测） |
| `web/` | 审批台 + 异常页（零依赖 node:http） |
| `dist/` | `tsc` 产物（`pnpm run build` / `make build` 生成，已 gitignore）；运行入口都在这里 |
| `scripts/` | 构建辅助：`copy-assets.mjs` 把 `tsc` 产不出的非 TS 资产拷进 dist |
| `Makefile` | 常用入口：install / build / db / run / queue / dispatch / approve / fork / merge / web / anomaly |

## 常用命令

```bash
# 安装依赖 + 构建（包管理器是 pnpm，锁文件 pnpm-lock.yaml；产物在 dist/）
pnpm install
pnpm run build         # tsc + 把 policy.json / hooks-settings.json / sandbox/ 拷进 dist
pnpm run typecheck     # 只做类型检查，不发文件

# 以上及下面的常用入口也都有 make 封装（make help 查看全部，含可重复执行的 make db）
# 建库（原始命令；0002-0004 非幂等，各应用一次）
sqlite3 agent.db < migrations/0001_init.sql
sqlite3 agent.db < migrations/0002_run_workspace.sql
sqlite3 agent.db < migrations/0003_tenant.sql
sqlite3 agent.db < migrations/0004_task_params.sql

# Postgres（等价 DDL 在 migrations/pg/）
psql "$PG_URL" -f migrations/pg/0001_init.sql   # ... 0002-0004 同理

# 立即执行（local 引擎用于开发调试）
node dist/orchestrator/run.js --goal "..." --engine local --tenant team-a --workspace /path/to/repo --db agent.db

# 排队 + 并发调度（Runner 池化）
node dist/orchestrator/submit.js --goal "..." --workspace /path/to/repo --db agent.db
node dist/orchestrator/dispatcher.js --db agent.db --concurrency 2

# 分叉 / 合并 / 审批
node dist/orchestrator/fork.js <run_id> --goal "..." --db agent.db
node dist/orchestrator/merge.js <fork_run_id> --db agent.db
node dist/orchestrator/approve.js <run_id> approve|reject --db agent.db

# 异常检测 / 审批台（/anomalies 为异常页）
node dist/gateway/anomaly.js --db agent.db [--json] [--stale-hours 24]
node dist/web/server.js --db agent.db --port 8787
```

所有 `--db` 同时接受 sqlite 文件路径与 `postgres://` 连接串。网关开关：`--gateway 0`（离线模式）、`--semantic 0`（只跑规则引擎）、`--isolate 1`（docker internal 网络，未实测）。等价入口：`make run GOAL="..." WORKSPACE=dir`、`make approve RUN=<run_id> DECISION=reject`、`make fork|merge|queue|dispatch|web|anomaly`（变量覆盖见 Makefile 头部注释）。

## 设计要点

- 包管理用 **pnpm**（`packageManager` 字段固定版本；锁文件 `pnpm-lock.yaml`，不用 package-lock）；`Makefile` 汇总常用命令，CI/手动均可直接用 `pnpm run ...`
- 源码为 TypeScript（ESM），`tsc` 编译到 `dist/`，运行走编译产物（`node dist/...`）；相对导入写的是编译后的 `.js` 扩展名（nodenext 会解析回 `.ts` 源）。`tsc` 无法产出的非 TS 资产（`gateway/*.json`、`sandbox/`）由 `scripts/copy-assets.mjs` 拷进 `dist/`，所以 `dist/` 自带可运行；入口判断用 `import.meta.main`，目录内路径用 `import.meta.dirname`
- 数据库双后端：`lib/db.ts` 统一 async API，PG 侧改写 `?` 占位符与 `json_extract`；schema 逻辑结构两边逐列一致
- `events` 为追加式全事件流，主键 `(run_id, seq)`，per-run gateway daemon 是唯一写入路径（tool_call / network / approval 事件）；离线回落 collect 从 `MAX(seq)+1` 续排
- 状态机由 CHECK 约束钉死；批准时 workspace git commit 作为基线，驳回时回滚到 HEAD
- 出网经 per-run 代理：域名白名单（HTTP + CONNECT）；凭据注入对**有规则的域**做 TLS 拦截（CA 在 `~/.config/agent-grid/ca/`），其余 HTTPS 直通不解密
- 用户全局 deny 权限规则优先于 bypass 模式，依然生效

## 路线

1. 阶段 1（最小闭环）— 已完成
2. 阶段 2（管控）— 已完成
3. 阶段 3 本地可验证范围 — 已完成；docker 实测与云上 Runner 待环境
