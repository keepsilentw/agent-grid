#!/usr/bin/env node
// Queue a task without executing it (phase 3 runner pooling): inserts a task
// with status=created and a params snapshot; orchestrator/dispatcher.ts picks
// it up. The immediate path stays in run.ts.
//
// Usage: node dist/orchestrator/submit.js --goal "..." [--tenant name] [--workspace DIR]
//                       [--agent claude|codex] [--engine docker|local]
//                       [--gateway 0|1] [--semantic 0|1] [--db agent.db]
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { open } from '../lib/db.js';
import { resolveTenant } from './tenant.js';
import type { RunParams } from '../lib/types.js';

interface SubmitArgs {
  goal: string;
  tenant: string;
  workspace: string;
  agent: string;
  engine: string;
  gateway: string;
  semantic: string | null;
  db: string;
}

/** Everything the CLI can set except `--goal`, which the usage check pins. */
type SubmitFlags = Omit<SubmitArgs, 'goal'>;

/** Flags that take a value; every other flag is `--goal` or a usage error. */
const VALUE_FLAGS = ['tenant', 'workspace', 'agent', 'engine', 'gateway', 'semantic', 'db'] as const;
type ValueFlag = typeof VALUE_FLAGS[number];

function isValueFlag(key: string): key is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(key);
}

function usage(): never {
  console.error('usage: node dist/orchestrator/submit.js --goal "..." [--tenant name] [--workspace DIR] [--agent claude|codex] [--engine docker|local] [--gateway 0|1] [--semantic 0|1] [--db agent.db]');
  process.exit(2);
}

function parseArgs(argv: string[]): SubmitArgs {
  const flags: SubmitFlags = {
    tenant: 'default', workspace: process.cwd(), agent: 'claude',
    engine: 'local', gateway: '1', semantic: null, db: 'agent.db',
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
  const db = await open(args.db);
  const params: RunParams = {
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
