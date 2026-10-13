#!/usr/bin/env node
// Human approval of a run in awaiting_approval: approve -> run succeeded,
// task done (workspace committed as the new baseline); reject -> run failed,
// task failed (rejected changes rolled back from the workspace).
//
// CLI:  node orchestrator/approve.js <run_id> <approve|reject> [--db ...]
// Also required as a module by web/server.js and merge.js flows.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { open } = require('../lib/db.js');

// On approve, commit the workspace so accepted changes become the baseline
// for later runs and forks (otherwise diffs accumulate run over run).
function commitWorkspace(workspace, runId) {
  const exclude = [':(exclude).agent-grid', ':(exclude)agent.db', ':(exclude)agent.db-*'];
  spawnSync('git', ['-C', workspace, 'add', '-A', '--', '.', ...exclude], { stdio: 'ignore' });
  spawnSync('git', ['-C', workspace,
    '-c', 'user.email=agent-grid@local', '-c', 'user.name=agent-grid',
    'commit', '-qm', `approve run ${runId}`], { stdio: 'ignore' });
}

// On reject, discard the rejected changes: restore the workspace to HEAD
// (tracked files and staged/intent-to-add state), then remove untracked
// files -- gateway/db infrastructure excluded.
function rollbackWorkspace(workspace) {
  // reset/restore run WITHOUT excludes so stale intent-to-add entries on
  // infra files are unstaged too; clean then removes untracked files but
  // its excludes keep gateway/db infrastructure on disk.
  const exclude = [':(exclude).agent-grid', ':(exclude)agent.db', ':(exclude)agent.db-*'];
  spawnSync('git', ['-C', workspace, 'reset', '-q'], { stdio: 'ignore' });
  spawnSync('git', ['-C', workspace, 'restore', '--worktree', '--staged', '--', '.'],
    { stdio: 'ignore' });
  spawnSync('git', ['-C', workspace, 'clean', '-fd', '--', '.', ...exclude], { stdio: 'ignore' });
}

async function approveRun(db, runId, decision) {
  const run = await db.prepare('SELECT id, task_id, status, workspace FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== 'awaiting_approval') {
    throw new Error(`run ${runId} is ${run.status}, expected awaiting_approval`);
  }
  const now = new Date().toISOString();
  const [runStatus, taskStatus] =
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

module.exports = { approveRun };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const [runId, decision] = argv.filter((a) => !a.startsWith('--')).slice(0, 2);
  const dbFlag = argv.indexOf('--db');
  const dbSpec = dbFlag >= 0 ? argv[dbFlag + 1] : 'agent.db';

  if (!runId || !['approve', 'reject'].includes(decision)) {
    console.error('usage: node orchestrator/approve.js <run_id> <approve|reject> [--db spec]');
    process.exit(2);
  }
  (async () => {
    const db = await open(dbSpec);
    try {
      const r = await approveRun(db, runId, decision);
      console.log(`run ${r.runId} ${r.runStatus}; task ${r.taskId} ${r.taskStatus}`);
    } catch (e) {
      console.error(`${e.message} (${dbSpec})`);
      process.exitCode = 2;
    }
    await db.close();
  })().catch((e) => { console.error(e); process.exit(1); });
}
