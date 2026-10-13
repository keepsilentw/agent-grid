# agent-grid

云端全托管 Agent 工作流的原型：控制面（编排、策略、审批、审计）与执行面（一次性沙箱 + 受限工具网关）分离。Agent 内核不自研，复用 Claude Code / Codex CLI 的非交互模式。

## 当前状态

仅完成骨架与数据库 schema，尚无可运行代码。

## 目录结构

| 目录 | 职责 |
|---|---|
| `migrations/` | SQLite schema（`0001_init.sql`：tasks / runs / events / artifacts 四张表，已验证可执行） |
| `gateway/` | 工具网关 + 审批门（待实现） |
| `orchestrator/` | 任务/线程/run 编排与沙箱生命周期（待实现） |
| `sandbox/` | 一次性容器配方（待实现） |
| `web/` | 任务台（待实现） |

## 设计要点

- 数据库第 1/2 阶段用 SQLite（WAL），schema 保持 Postgres 兼容子集，第 3 阶段只换驱动
- `events` 为追加式全事件流，主键 `(run_id, seq)`，工具网关是唯一写入路径
- `runs.status` 用 CHECK 约束钉死状态机：pending / running / awaiting_approval / succeeded / failed / cancelled

## 路线

1. 阶段 1（最小闭环）：任务进 → 一次性沙箱内跑 agent → diff 交回人工审批 → 全程事件落库
2. 阶段 2（管控）：网络白名单、凭据代理、语义审批、线程分叉
3. 阶段 3（规模化）：多租户、更强隔离、异常检测、云 Runner 池化
