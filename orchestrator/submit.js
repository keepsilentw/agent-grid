#!/usr/bin/env node
// Queue a task without executing it (phase 3 runner pooling): inserts a task
// with status=created and a params snapshot; orchestrator/dispatcher.js picks
// it up. The immediate path stays in run.js.
//
// Usage: node submit.js --goal "..." [--tenant name] [--workspace DIR]
//                       [--agent claude|codex] [--engine docker|local]
//                       [--gateway 0|1] [--semantic 0|1] [--db agent.db]
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { open } = require('../lib/db.js');
const { resolveTenant } = require('./tenant.js');

function usage() {
  console.error('usage: node submit.js --goal "..." [--tenant name] [--workspace DIR] [--agent claude|codex] [--engine docker|local] [--gateway 0|1] [--semantic 0|1] [--db agent.db]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    tenant: 'default', workspace: process.cwd(), agent: 'claude',
    engine: 'local', gateway: '1', semantic: null, db: 'agent.db',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = (argv[i] || '').replace(/^--/, '');
    const val = argv[i + 1];
    if (key === 'goal') args.goal = val;
    else if (['tenant', 'workspace', 'agent', 'engine', 'gateway', 'semantic', 'db'].includes(key)) args[key] = val;
    else usage();
  }
  if (!args.goal || argv.length % 2 !== 0) usage();
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await open(args.db);
  const params = {
    workspace: path.resolve(args.workspace), agent: args.agent,
    engine: args.engine, gateway: args.gateway, semantic: args.semantic,
  };
  const taskId = randomUUID();
  const tenantId = await resolveTenant(db, args.tenant);
  await db.prepare('INSERT INTO tasks (id, goal, status, tenant_id, params) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, args.goal, 'created', tenantId, JSON.stringify(params));
  console.log(`queued task ${taskId} (tenant ${args.tenant})`);
  await db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
