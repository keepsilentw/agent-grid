#!/usr/bin/env node
// Thread forking (phase 2): create a new task/run whose workspace is a copy
// of a parent run's workspace, sharing the parent's thread lineage. The copy
// gets a baseline commit so the child's diff contains only its own changes.
// Merge of parallel threads is not implemented here -- see merge.ts.
//
// Usage:
//   node dist/orchestrator/fork.js <run_id> --goal "..." [--agent claude|codex]
//                             [--engine docker|local] [--workspace DIR] [--db agent.db]
//                             [--gateway 0|1] [--semantic 0|1]
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { open } from '../lib/db.js';
import { executeRun } from './execute.js';
import { resolveTenant } from './tenant.js';
import type { RunRow } from '../lib/types.js';

interface ForkArgs {
  parentRunId: string;
  goal: string;
  agent: string;
  engine: string;
  workspace: string | null;
  db: string;
  gateway: string;
  semantic: string | null;
  tenant: string | null;
}

/** Everything the CLI can set except the positional id and `--goal`. */
type ForkFlags = Omit<ForkArgs, 'parentRunId' | 'goal'>;

/** Flags that take a value; every other flag is `--goal` or a usage error. */
const VALUE_FLAGS = ['agent', 'engine', 'workspace', 'db', 'gateway', 'semantic', 'tenant'] as const;
type ValueFlag = typeof VALUE_FLAGS[number];

function isValueFlag(key: string): key is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(key);
}

function usage(): never {
  console.error('usage: node dist/orchestrator/fork.js <run_id> --goal "..." [--agent claude|codex] [--engine docker|local] [--workspace DIR] [--db agent.db] [--gateway 0|1] [--semantic 0|1]');
  process.exit(2);
}

function parseArgs(argv: string[]): ForkArgs {
  const [parentRunId, ...rest] = argv;
  const flags: ForkFlags = {
    agent: 'claude', engine: 'local', workspace: null, db: 'agent.db',
    gateway: '1', semantic: null, tenant: null, // null = inherit parent's tenant
  };
  let goal: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const key = (rest[i] ?? '').replace(/^--/, '');
    const val = rest[i + 1];
    if (val === undefined) usage();
    if (key === 'goal') goal = val;
    else if (isValueFlag(key)) flags[key] = val;
    else usage();
  }
  if (!parentRunId || parentRunId.startsWith('--') || !goal || rest.length % 2 !== 0) usage();
  return { ...flags, parentRunId, goal };
}

function copyWorkspace(src: string, dst: string): void {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => {
      const base = path.basename(p);
      return base !== '.agent-grid' && base !== 'agent.db' && !base.startsWith('agent.db-');
    },
  });
  // Baseline commit: the child's diff must contain only its own changes.
  spawnSync('git', ['-C', dst, 'add', '-A'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dst,
    '-c', 'user.email=agent-grid@local', '-c', 'user.name=agent-grid',
    'commit', '-qm', `fork baseline from run ${src}`], { stdio: 'ignore' });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await open(args.db);

  const parent = await db.prepare('SELECT * FROM runs WHERE id = ?')
    .get<RunRow>(args.parentRunId);
  if (!parent) { console.error(`run ${args.parentRunId} not found`); process.exit(2); }
  if (parent.status !== 'succeeded' && parent.status !== 'awaiting_approval') {
    console.error(`cannot fork from run in status ${parent.status}; need succeeded or awaiting_approval`);
    process.exit(2);
  }
  if (!parent.workspace) {
    console.error(`run ${args.parentRunId} has no recorded workspace (predates migration 0002?)`);
    process.exit(2);
  }

  const now = (): string => new Date().toISOString();
  const taskId = randomUUID();
  const runId = randomUUID();
  // First run of a lineage uses its own id as the thread id; backfill the
  // parent so the thread page includes the root run.
  const threadId = parent.thread_id || parent.id;
  if (!parent.thread_id) {
    await db.prepare('UPDATE runs SET thread_id = ? WHERE id = ?').run(threadId, parent.id);
  }
  const workspace = path.resolve(
    args.workspace || `${parent.workspace}-fork-${runId.slice(0, 8)}`
  );

  if (fs.existsSync(workspace)) { console.error(`workspace ${workspace} already exists`); process.exit(2); }
  copyWorkspace(parent.workspace, workspace);
  console.log(`forked workspace ${parent.workspace} -> ${workspace}`);

  const parentTenant = (await db.prepare('SELECT tenant_id FROM tasks WHERE id = ?')
    .get<{ tenant_id: string | null }>(parent.task_id))?.tenant_id;
  const tenantId = args.tenant
    ? await resolveTenant(db, args.tenant)
    : (parentTenant || await resolveTenant(db, 'default'));
  await db.prepare('INSERT INTO tasks (id, goal, status, tenant_id) VALUES (?, ?, ?, ?)')
    .run(taskId, args.goal, 'running', tenantId);
  await db.prepare('INSERT INTO runs (id, task_id, thread_id, agent_kind, status, started_at, workspace) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(runId, taskId, threadId, args.agent, 'running', now(), workspace);
  console.log(`task ${taskId} run ${runId} thread ${threadId} (fork of ${parent.id})`);

  const r = await executeRun({
    db, dbPath: args.db, taskId, runId,
    agent: args.agent, engine: args.engine, workspace, goal: args.goal,
    gatewayPref: args.gateway, semantic: args.semantic,
  });
  process.exit(r.code === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
