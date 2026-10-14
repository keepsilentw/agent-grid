#!/usr/bin/env node
// Orchestrator driver: one task -> one run -> disposable sandbox ->
// realtime gateway (phase 2) or offline event collection (phase 1 fallback).
// Single-process script; a long-running orchestrator service is a later phase.
// Execution flow lives in execute.ts (shared with fork.ts).
//
// Usage:
//   node dist/orchestrator/run.js --goal "..." [--agent claude|codex]
//                            [--engine docker|local] [--workspace DIR] [--db agent.db]
//                            [--gateway 0|1] [--semantic 0|1]
//
// engine=docker (default): runs the sandbox image (sandbox/run.sh recipe).
// engine=local: runs the agent CLI on this machine -- dev/debug only, no isolation.
// gateway=1 (default): starts a realtime gateway daemon for this run; hooks
// POST tool calls to it and apply allow/deny verdicts. gateway=0: phase-1
// offline mode, hooks append JSONL and collect.ts ingests after the run.
// semantic=0|1 overrides policy.json's semantic switch (forwarded to daemon).
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { open, isPg } from '../lib/db.js';
import { executeRun } from './execute.js';
import { resolveTenant } from './tenant.js';

interface RunArgs {
  goal: string;
  agent: string;
  engine: string;
  workspace: string;
  db: string;
  gateway: string;
  semantic: string | null;
  tenant: string;
  isolate: string;
}

/** Everything the CLI can set except `--goal`, which the usage check pins. */
type RunFlags = Omit<RunArgs, 'goal'>;

/** Flags that take a value; every other flag is `--goal` or a usage error. */
const VALUE_FLAGS = ['agent', 'engine', 'workspace', 'db', 'gateway', 'semantic', 'tenant', 'isolate'] as const;
type ValueFlag = typeof VALUE_FLAGS[number];

function isValueFlag(key: string): key is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(key);
}

function usage(): never {
  console.error('usage: node dist/orchestrator/run.js --goal "..." [--agent claude|codex] [--engine docker|local] [--workspace DIR] [--db agent.db] [--gateway 0|1] [--semantic 0|1]');
  process.exit(2);
}

function parseArgs(argv: string[]): RunArgs {
  const flags: RunFlags = {
    agent: 'claude', engine: 'docker', workspace: process.cwd(), db: 'agent.db',
    gateway: '1', semantic: null, tenant: 'default', isolate: '0',
  };
  let goal: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const key = (argv[i] ?? '').replace(/^--/, '');
    const val = argv[i + 1];
    if (val === undefined) usage();
    if (key === 'goal') goal = val;
    else if (isValueFlag(key)) flags[key] = val;
    else usage();
  }
  if (!goal || argv.length % 2 !== 0) usage();
  return { ...flags, goal };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace);
  const db = await open(args.db);
  const hasSchema = isPg(args.db)
    ? (await db.prepare("SELECT to_regclass('tasks') AS t").get<{ t: string | null }>())?.t !== null
    : !!(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'tasks'").get<{ name: string }>());
  if (!hasSchema) {
    console.error(`no schema in ${args.db}; run migrations (migrations/ for sqlite, migrations/pg/ for postgres)`);
    process.exit(2);
  }

  const now = (): string => new Date().toISOString();
  const taskId = randomUUID();
  const runId = randomUUID();

  const tenantId = await resolveTenant(db, args.tenant);
  await db.prepare('INSERT INTO tasks (id, goal, status, tenant_id) VALUES (?, ?, ?, ?)')
    .run(taskId, args.goal, 'running', tenantId);
  await db.prepare('INSERT INTO runs (id, task_id, agent_kind, status, started_at, workspace) VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, taskId, args.agent, 'running', now(), workspace);
  console.log(`task ${taskId} run ${runId} (${args.agent}/${args.engine})`);

  const r = await executeRun({
    db, dbPath: args.db, taskId, runId,
    agent: args.agent, engine: args.engine, workspace, goal: args.goal,
    gatewayPref: args.gateway, semantic: args.semantic, isolate: args.isolate,
  });
  process.exit(r.code === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
