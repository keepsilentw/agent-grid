#!/usr/bin/env node
// Orchestrator driver: one task -> one run -> disposable sandbox ->
// realtime gateway (phase 2) or offline event collection (phase 1 fallback).
// Single-process script; a long-running orchestrator service is a later phase.
// Execution flow lives in execute.js (shared with fork.js).
//
// Usage:
//   node orchestrator/run.js --goal "..." [--agent claude|codex]
//                            [--engine docker|local] [--workspace DIR] [--db agent.db]
//                            [--gateway 0|1] [--semantic 0|1]
//
// engine=docker (default): runs the sandbox image (sandbox/run.sh recipe).
// engine=local: runs the agent CLI on this machine -- dev/debug only, no isolation.
// gateway=1 (default): starts a realtime gateway daemon for this run; hooks
// POST tool calls to it and apply allow/deny verdicts. gateway=0: phase-1
// offline mode, hooks append JSONL and collect.js ingests after the run.
// semantic=0|1 overrides policy.json's semantic switch (forwarded to daemon).
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { open, isPg } = require('../lib/db.js');
const { executeRun } = require('./execute.js');
const { resolveTenant } = require('./tenant.js');

function usage() {
  console.error('usage: node orchestrator/run.js --goal "..." [--agent claude|codex] [--engine docker|local] [--workspace DIR] [--db agent.db] [--gateway 0|1] [--semantic 0|1]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    agent: 'claude', engine: 'docker', workspace: process.cwd(), db: 'agent.db',
    gateway: '1', semantic: null, tenant: 'default', isolate: '0',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = (argv[i] || '').replace(/^--/, '');
    const val = argv[i + 1];
    if (key === 'goal') args.goal = val;
    else if (['agent', 'engine', 'workspace', 'db', 'gateway', 'semantic', 'tenant', 'isolate'].includes(key)) args[key] = val;
    else usage();
  }
  if (!args.goal || argv.length % 2 !== 0) usage();
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace);
  const db = await open(args.db);
  const hasSchema = isPg(args.db)
    ? (await db.prepare("SELECT to_regclass('tasks') AS t").get()).t !== null
    : !!(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'tasks'").get());
  if (!hasSchema) {
    console.error(`no schema in ${args.db}; run migrations (migrations/ for sqlite, migrations/pg/ for postgres)`);
    process.exit(2);
  }

  const now = () => new Date().toISOString();
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
