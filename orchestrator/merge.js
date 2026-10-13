#!/usr/bin/env node
// Thread merge (phase 3): bring a fork run's changes back into the thread
// root workspace and commit them there. The command itself is the human
// acceptance action (it is only run after the fork's diff was reviewed):
// applying + committing to the root is the merge, mirroring what approve.js
// does for a normal run. The fork run moves to succeeded/done if it was
// awaiting approval; thread lineage rows are untouched.
//
// Usage: node orchestrator/merge.js <fork_run_id> [--db agent.db]
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { open } = require('../lib/db.js');

function usage() {
  console.error('usage: node orchestrator/merge.js <fork_run_id> [--db agent.db]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const forkId = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--db'));
const dbFlag = argv.indexOf('--db');
const dbPath = dbFlag >= 0 ? argv[dbFlag + 1] : 'agent.db';
if (!forkId || forkId.startsWith('--')) usage();

const git = (cwd, args, opts = {}) =>
  spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...opts });

async function main() {
  const db = await open(dbPath);
  const fork = await db.prepare('SELECT * FROM runs WHERE id = ?').get(forkId);
  if (!fork) { console.error(`run ${forkId} not found`); process.exit(2); }
  if (!fork.thread_id || fork.thread_id === fork.id) {
    console.error('run is not a fork (no thread lineage)');
    process.exit(2);
  }
  if (!['awaiting_approval', 'succeeded'].includes(fork.status)) {
    console.error(`cannot merge from run in status ${fork.status}`);
    process.exit(2);
  }
  const root = await db.prepare('SELECT * FROM runs WHERE id = ?').get(fork.thread_id);
  if (!root || !root.workspace) { console.error('root run/workspace not found'); process.exit(2); }
  if (!fork.workspace) { console.error('fork run has no workspace'); process.exit(2); }

  // 1. Baseline: fork.js commits "fork baseline from run <src>" in the copy.
  const baseline = git(fork.workspace,
    ['log', '--format=%H', '--fixed-strings', '-1', '--grep=fork baseline from run ']).stdout.trim();
  if (!baseline) { console.error('fork baseline commit not found'); process.exit(2); }

  // 2. Snapshot the fork's current state (tracked + untracked, infra excluded)
  //    so one diff captures everything.
  const exclude = [':(exclude).agent-grid', ':(exclude)agent.db', ':(exclude)agent.db-*'];
  git(fork.workspace, ['add', '-A', '--', '.', ...exclude]);
  git(fork.workspace, ['-c', 'user.email=agent-grid@local', '-c', 'user.name=agent-grid',
    'commit', '-qm', 'merge snapshot']);
  const patch = git(fork.workspace, ['diff', `${baseline}..HEAD`]).stdout;
  if (!patch.trim()) { console.error('fork has no changes to merge'); process.exit(2); }

  // 3. Apply onto the root workspace. --3way surfaces conflicts instead of
  //    silently half-applying.
  const apply = git(root.workspace, ['apply', '--3way', '-'], { input: patch });
  if (apply.status !== 0) {
    console.error(`apply failed (conflict?):\n${apply.stderr}`);
    process.exit(2);
  }

  // 4. Commit in the root ONLY the paths the patch touches -- a blanket
  //    add -A would sweep unrelated uncommitted changes into the merge.
  const paths = [...patch.matchAll(/^diff --git a\/.* b\/(.+)$/gm)]
    .map((m) => m[1]);
  if (paths.length === 0) { console.error('could not parse patch paths'); process.exit(2); }
  // apply --3way already staged the patched files; commit by pathspec picks
  // the working-tree state of exactly these paths.
  const commit = git(root.workspace, ['-c', 'user.email=agent-grid@local', '-c', 'user.name=agent-grid',
    'commit', '-qm', `merge thread ${fork.thread_id} from run ${fork.id}`,
    '--', ...paths]);
  if (commit.status !== 0) {
    console.error(`commit failed: ${commit.stderr}`);
    process.exit(2);
  }

  // 5. Record the merged patch as an artifact on the fork run; if the fork
  //    still awaits approval, close it out -- merge was the acceptance.
  await db.prepare('INSERT INTO artifacts (id, run_id, kind, content) VALUES (?, ?, ?, ?)')
    .run(crypto.randomUUID(), fork.id, 'diff', patch);
  if (fork.status === 'awaiting_approval') {
    const now = new Date().toISOString();
    await db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run('succeeded', now, fork.id);
    await db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', fork.task_id);
  }
  console.log(`merged run ${fork.id} -> root ${root.id} (thread ${fork.thread_id})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
