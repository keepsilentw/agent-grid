#!/usr/bin/env node
// Human approval of a run in awaiting_approval: approve -> run succeeded,
// task done (workspace committed as the new baseline); reject -> run failed,
// task failed (rejected changes rolled back from the workspace).
//
// CLI:  node dist/orchestrator/approve.js <run_id> <approve|reject> [--db ...]
// Also required as a module by web/server.ts and merge.ts flows.
import { spawnSync } from 'node:child_process';
import { open } from '../lib/db.js';
import type { Db } from '../lib/db.js';
import { errMessage } from '../lib/errors.js';
import type { RunStatus, TaskStatus } from '../lib/types.js';

/** The two human decisions a run can take. */
export type DecisionKind = 'approve' | 'reject';

export interface ApprovalResult {
  runId: string;
  taskId: string;
  runStatus: RunStatus;
  taskStatus: TaskStatus;
}

// On approve, commit the workspace so accepted changes become the baseline
// for later runs and forks (otherwise diffs accumulate run over run).
function commitWorkspace(workspace: string, runId: string): void {
  const exclude = [':(exclude).agent-grid', ':(exclude)agent.db', ':(exclude)agent.db-*'];
  spawnSync('git', ['-C', workspace, 'add', '-A', '--', '.', ...exclude], { stdio: 'ignore' });
  spawnSync('git', ['-C', workspace,
    '-c', 'user.email=agent-grid@local', '-c', 'user.name=agent-grid',
    'commit', '-qm', `approve run ${runId}`], { stdio: 'ignore' });
}

// On reject, discard the rejected changes: restore the workspace to HEAD
// (tracked files and staged/intent-to-add state), then remove untracked
// files -- gateway/db infrastructure excluded.
function rollbackWorkspace(workspace: string): void {
  // reset/restore run WITHOUT excludes so stale intent-to-add entries on
  // infra files are unstaged too; clean then removes untracked files but
  // its excludes keep gateway/db infrastructure on disk.
  const exclude = [':(exclude).agent-grid', ':(exclude)agent.db', ':(exclude)agent.db-*'];
  spawnSync('git', ['-C', workspace, 'reset', '-q'], { stdio: 'ignore' });
  spawnSync('git', ['-C', workspace, 'restore', '--worktree', '--staged', '--', '.'],
    { stdio: 'ignore' });
  spawnSync('git', ['-C', workspace, 'clean', '-fd', '--', '.', ...exclude], { stdio: 'ignore' });
}

export async function approveRun(db: Db, runId: string, decision: DecisionKind): Promise<ApprovalResult> {
  const run = await db.prepare('SELECT id, task_id, status, workspace FROM runs WHERE id = ?')
    .get<{ id: string; task_id: string; status: RunStatus; workspace: string | null }>(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== 'awaiting_approval') {
    throw new Error(`run ${runId} is ${run.status}, expected awaiting_approval`);
  }
  const now = new Date().toISOString();
  const [runStatus, taskStatus]: [RunStatus, TaskStatus] =
    decision === 'approve' ? ['succeeded', 'done'] : ['failed', 'failed'];
  await db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?')
    .run(runStatus, now, runId);
  await db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(taskStatus, run.task_id);
  if (run.workspace) {
    if (decision === 'approve') commitWorkspace(run.workspace, runId);
    else rollbackWorkspace(run.workspace);
  }
  return { runId, taskId: run.task_id, runStatus, taskStatus };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const [runId, decisionArg] = argv.filter((a) => !a.startsWith('--'));
  const dbFlag = argv.indexOf('--db');
  const dbSpec = dbFlag >= 0 ? (argv[dbFlag + 1] ?? 'agent.db') : 'agent.db';

  if (!runId || (decisionArg !== 'approve' && decisionArg !== 'reject')) {
    console.error('usage: node dist/orchestrator/approve.js <run_id> <approve|reject> [--db spec]');
    process.exit(2);
  }
  const decision: DecisionKind = decisionArg;
  (async () => {
    const db = await open(dbSpec);
    try {
      const r = await approveRun(db, runId, decision);
      console.log(`run ${r.runId} ${r.runStatus}; task ${r.taskId} ${r.taskStatus}`);
    } catch (e) {
      console.error(`${errMessage(e)} (${dbSpec})`);
      process.exitCode = 2;
    }
    await db.close();
  })().catch((e) => { console.error(e); process.exit(1); });
}
