// Shared control-plane types: row shapes of the schema (migrations/0001-0004),
// the gateway policy file, and the payloads that cross module boundaries.
// One module so gateway, orchestrator and web agree on a single definition
// instead of each re-declaring the shapes they read.

/** Semantic-classifier risk rating; policy.json's `block_on` decides what is denied. */
export type Risk = 'low' | 'medium' | 'high';

/** `tasks.status` CHECK constraint (0001_init.sql). */
export type TaskStatus =
  | 'created'
  | 'running'
  | 'awaiting_approval'
  | 'done'
  | 'failed'
  | 'cancelled';

/** `runs.status` CHECK constraint (0001_init.sql). */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** Row of `tasks` (0001 + tenant_id from 0003 + params from 0004). */
export interface TaskRow {
  id: string;
  goal: string;
  status: TaskStatus;
  created_by: string | null;
  created_at: string;
  tenant_id: string | null;
  params: string | null;
}

/** Row of `runs` (0001 + workspace from 0002). */
export interface RunRow {
  id: string;
  task_id: string;
  thread_id: string | null;
  sandbox_id: string | null;
  agent_kind: string;
  status: RunStatus;
  started_at: string | null;
  ended_at: string | null;
  workspace: string | null;
}

/** Row of `events`: the append-only stream (kind/payload are free-form TEXT). */
export interface EventRow {
  run_id: string;
  seq: number;
  kind: string;
  payload: string;
  ts: string;
}

/** Row of `artifacts` (diff, report, log). */
export interface ArtifactRow {
  id: string;
  run_id: string;
  kind: string;
  content: string;
  ts: string;
}

/** Task row joined with its tenant name, as the web board selects it. */
export type TaskWithTenant = TaskRow & { tenant: string | null };

/** Snapshot of the submit CLI args stored in `tasks.params` (migration 0004). */
export interface RunParams {
  workspace: string;
  agent: string;
  engine: string;
  gateway: string;
  semantic: string | null;
}

/** One entry of policy.json's `deny_rules` (rule engine, evaluated first). */
export interface DenyRule {
  name: string;
  pattern: string;
}

/** gateway/policy.json. */
export interface Policy {
  deny_rules: DenyRule[];
  semantic?: { enabled?: boolean; block_on?: Risk[] };
  network?: { allow?: string[] };
}

/** One entry of ~/.config/agent-grid/credentials.json's `rules` array. */
export interface CredentialRule {
  host: string;
  path_prefix?: string;
  headers?: Record<string, string>;
}

/** Verdict of the semantic classifier (gateway/classifier.ts). */
export interface Verdict {
  risk: Risk;
  reason: string;
}

/** Response of the gateway daemon's /v1/tool_call endpoint. */
export interface Decision {
  decision: 'allow' | 'deny';
  reason: string;
  rule?: string;
  risk?: Risk;
}

/** One anomaly finding (gateway/anomaly.ts), rendered by the web board. */
export interface Finding {
  rule: string;
  severity: Risk;
  run_id: string;
  task_id: string | null;
  detail: string;
  ts: string | null;
}

/** Approval event payload: the diff pre-review written by execute.ts. */
export interface ApprovalPayload {
  stage?: string;
  risk?: Risk;
  reason?: string;
}

/** Normalized hook event: written by gateway/hook.ts, to the daemon or the sink. */
export interface HookEvent {
  kind: string;
  ts: string;
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}
