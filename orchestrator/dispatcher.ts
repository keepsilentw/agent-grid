#!/usr/bin/env node
// Runner pooling (phase 3): long-running dispatcher that claims queued tasks
// (status=created from submit.ts) and executes them through executeRun with
// bounded concurrency. The runner interface IS executeRun's engine param
// (local today; docker/Cloud become available when their environments do).
//
// Usage: node dist/orchestrator/dispatcher.js [--db agent.db] [--concurrency 2] [--poll-ms 1000]
// SIGINT/SIGTERM: stop claiming, finish in-flight runs, then exit.
import { randomUUID } from 'node:crypto';
import { open } from '../lib/db.js';
import type { Db } from '../lib/db.js';
import { executeRun } from './execute.js';
import { errMessage } from '../lib/errors.js';
import type { RunParams, TaskRow } from '../lib/types.js';

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? dflt) : dflt;
};
const dbPath = flag('--db', 'agent.db');
const concurrency = Number(flag('--concurrency', '2'));
const pollMs = Number(flag('--poll-ms', '1000'));

/** The columns `claim` needs off a queued task row. */
type ClaimedTask = Pick<TaskRow, 'id' | 'goal' | 'params'>;

let db: Db;
let stopping = false;
const inFlight = new Set<Promise<void>>();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1); // second signal: force quit
    stopping = true;
    console.log(`dispatcher: stop requested, ${inFlight.size} run(s) in flight`);
  });
}

// Claim by conditional UPDATE: only one dispatcher wins a task even if two
// processes race (changes === 1 means we claimed it).
async function claim(limit: number): Promise<ClaimedTask[]> {
  const out: ClaimedTask[] = [];
  const candidates = await db.prepare(
    "SELECT id, goal, params FROM tasks WHERE status = 'created' ORDER BY created_at LIMIT ?"
  ).all<ClaimedTask>(limit);
  for (const t of candidates) {
    const r = await db.prepare(
      "UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'created'").run(t.id);
    if (r.changes === 1) out.push(t);
  }
  return out;
}

async function runTask(t: ClaimedTask): Promise<void> {
  const params: Partial<RunParams> = t.params ? JSON.parse(t.params) as RunParams : {};
  const runId = randomUUID();
  const workspace = params.workspace || process.cwd();
  await db.prepare('INSERT INTO runs (id, task_id, agent_kind, status, started_at, workspace) VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, t.id, params.agent || 'claude', 'running', new Date().toISOString(), workspace);
  console.log(`dispatcher: task ${t.id} run ${runId}`);
  try {
    await executeRun({
      db, dbPath, taskId: t.id, runId,
      agent: params.agent || 'claude', engine: params.engine || 'local',
      workspace, goal: t.goal,
      gatewayPref: params.gateway ?? '1', semantic: params.semantic ?? null,
    });
  } catch (e) {
    console.error(`dispatcher: run ${runId} crashed: ${errMessage(e)}`);
    const now = new Date().toISOString();
    await db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run('failed', now, runId);
    await db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('failed', t.id);
  }
}

async function loop(): Promise<void> {
  while (!stopping) {
    const slots = concurrency - inFlight.size;
    if (slots > 0) {
      for (const t of await claim(slots)) {
        const p = runTask(t).finally(() => { inFlight.delete(p); });
        inFlight.add(p);
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  console.log('dispatcher: draining...');
  await Promise.allSettled([...inFlight]);
  console.log('dispatcher: stopped');
  process.exit(0);
}

(async () => {
  db = await open(dbPath);
  console.log(`dispatcher: up (db=${dbPath}, concurrency=${concurrency})`);
  await loop();
})().catch((e) => { console.error(e); process.exit(1); });
