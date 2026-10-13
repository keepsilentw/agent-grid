#!/usr/bin/env node
// Thread forking (phase 2): create a new task/run whose workspace is a copy
// of a parent run's workspace, sharing the parent's thread lineage. The copy
// gets a baseline commit so the child's diff contains only its own changes.
// Merge of parallel threads is not implemented.
//
// Usage:
//   node orchestrator/fork.js <run_id> --goal "..." [--agent claude|codex]
//                             [--engine docker|local] [--workspace DIR] [--db agent.db]
//                             [--gateway 0|1] [--semantic 0|1]
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { open } = require('../lib/db.js');
const { executeRun } = require('./execute.js');
const { resolveTenant } = require('./tenant.js');

function usage() {
  console.error('usage: node orchestrator/fork.js <run_id> --goal "..." [--agent claude|codex] [--engine docker|local] [--workspace DIR] [--db agent.db] [--gateway 0|1] [--semantic 0|1]');
  process.exit(2);
}

function parseArgs(argv) {
  const [parentRunId, ...rest] = argv;
  const args = {
    parentRunId,
    agent: 'claude', engine: 'local', workspace: null, db: 'agent.db',
    gateway: '1', semantic: null, tenant: null, // null = inherit parent's tenant
  };
  for (let i = 0; i < rest.length; i += 2) {
    const key = (rest[i] || '').replace(/^--/, '');
    const val = rest[i + 1];
    if (key === 'goal') args.goal = val;
    else if (['agent', 'engine', 'workspace', 'db', 'gateway', 'semantic', 'tenant'].includes(key)) args[key] = val;
    else usage();
  }
  if (!parentRunId || parentRunId.startsWith('--') || !args.goal || rest.length % 2 !== 0) usage();
  return args;
}

function copyWorkspace(src, dst) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await open(args.db);

  const parent = await db.prepare('SELECT * FROM runs WHERE id = ?').get(args.parentRunId);
  if (!parent) { console.error(`run ${args.parentRunId} not found`); process.exit(2); }
  if (!['succeeded', 'awaiting_approval'].includes(parent.status)) {
    console.error(`cannot fork from run in status ${parent.status}; need succeeded or awaiting_approval`);
    process.exit(2);
  }
  if (!parent.workspace) {
    console.error(`run ${args.parentRunId} has no recorded workspace (predates migration 0002?)`);
    process.exit(2);
  }

  const now = () => new Date().toISOString();
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

  const parentTenant = (await db.prepare('SELECT tenant_id FROM tasks WHERE id = ?').get(parent.task_id))?.tenant_id;
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
