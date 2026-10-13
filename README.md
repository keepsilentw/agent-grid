# agent-grid

云端全托管 Agent 工作流的原型：控制面（编排、策略、审批、审计）与执行面（一次性沙箱 + 受限工具网关）分离。Agent 内核不自研，复用 Claude Code / Codex CLI 的非交互模式。

## 当前状态

本地可验证范围全部完成（阶段 1/2 + 阶段 3 的多租户、异常检测、线程 merge、reject 回滚、Runner 调度器、Postgres 双后端）。docker 引擎接线完成但未实测。架构详见 `docs/architecture.md`。

## 目录结构

| 目录 | 职责 |
|---|---|
| `migrations/` | sqlite 版 0001-0004；`migrations/pg/` 为同逻辑 schema 的 PG 方言 DDL |
| `lib/db.js` | 统一 async DB 层（sqlite / pg 双驱动） |
| `gateway/` | 工具网关：hook、daemon（策略链 + 出口代理 + events 唯一写入）、proxy（白名单 + CA 凭据注入）、classifier、anomaly、collect、policy.json |
| `orchestrator/` | run / fork / merge / approve / submit / dispatcher CLI + 共享执行流 execute.js + tenant |
| `sandbox/` | 一次性容器配方（未实测） |
| `web/` | 审批台 + 异常页（零依赖 node:http） |

## 常用命令

```bash
# 建库
sqlite3 agent.db < migrations/0001_init.sql
sqlite3 agent.db < migrations/0002_run_workspace.sql   # 以下均非幂等，各应用一次
sqlite3 agent.db < migrations/0003_tenant.sql
sqlite3 agent.db < migrations/0004_task_params.sql

# Postgres（等价 DDL 在 migrations/pg/）
psql "$PG_URL" -f migrations/pg/0001_init.sql   # ... 0002-0004 同理

# 立即执行（local 引擎用于开发调试）
node orchestrator/run.js --goal "..." --engine local --tenant team-a --workspace /path/to/repo --db agent.db

# 排队 + 并发调度（Runner 池化）
node orchestrator/submit.js --goal "..." --workspace /path/to/repo --db agent.db
node orchestrator/dispatcher.js --db agent.db --concurrency 2

# 分叉 / 合并 / 审批
node orchestrator/fork.js <run_id> --goal "..." --db agent.db
node orchestrator/merge.js <fork_run_id> --db agent.db
node orchestrator/approve.js <run_id> approve|reject --db agent.db

# 异常检测 / 审批台（/anomalies 为异常页）
node gateway/anomaly.js --db agent.db [--json] [--stale-hours 24]
node web/server.js --db agent.db --port 8787
```

所有 `--db` 同时接受 sqlite 文件路径与 `postgres://` 连接串。网关开关：`--gateway 0`（离线模式）、`--semantic 0`（只跑规则引擎）、`--isolate 1`（docker internal 网络，未实测）。

## 设计要点

- 数据库双后端：`lib/db.js` 统一 async API，PG 侧改写 `?` 占位符与 `json_extract`；schema 逻辑结构两边逐列一致
- `events` 为追加式全事件流，主键 `(run_id, seq)`，per-run gateway daemon 是唯一写入路径（tool_call / network / approval 事件）；离线回落 collect 从 `MAX(seq)+1` 续排
- 状态机由 CHECK 约束钉死；批准时 workspace git commit 作为基线，驳回时回滚到 HEAD
- 出网经 per-run 代理：域名白名单（HTTP + CONNECT）；凭据注入对**有规则的域**做 TLS 拦截（CA 在 `~/.config/agent-grid/ca/`），其余 HTTPS 直通不解密
- 用户全局 deny 权限规则优先于 bypass 模式，依然生效

## 路线

1. 阶段 1（最小闭环）— 已完成
2. 阶段 2（管控）— 已完成
3. 阶段 3 本地可验证范围 — 已完成；docker 实测与云上 Runner 待环境
