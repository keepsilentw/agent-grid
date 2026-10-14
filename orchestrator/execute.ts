// Shared execution flow for one run: realtime gateway -> agent in sandbox ->
// artifact capture -> diff pre-review -> offline fallback -> status
// transitions. Used by run.ts (fresh task) and fork.ts (lineage fork).
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classify } from '../gateway/classifier.js';
import { getCACertPath } from '../gateway/proxy.js';
import { errMessage } from '../lib/errors.js';
import type { Db } from '../lib/db.js';
import type { ApprovalPayload, RunStatus, TaskStatus } from '../lib/types.js';

// Root of the runnable tree -- dist/ once built. The helper entry points
// (hook, daemon, collect) and the sandbox recipe resolve from here, which is
// why the build copies the non-TypeScript assets into dist/
// (scripts/copy-assets.mjs).
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const IMAGE = 'agent-grid-sandbox:latest';
// Gateway/db infrastructure kept out of diffs and fork copies.
const EXCLUDE_PATHSPEC = [':(exclude).agent-grid', ':(exclude)agent.db', ':(exclude)agent.db-*'];

/** A run already inserted with status=running, plus the engine it should use. */
export interface ExecuteRunOptions {
  db: Db;
  dbPath: string;
  taskId: string;
  runId: string;
  agent: string;
  engine: string;
  workspace: string;
  goal: string;
  /** '1' (default) starts the realtime daemon; '0' is phase-1 offline mode. */
  gatewayPref?: string;
  /** '0' | '1' overrides policy.json's semantic switch; null keeps it. */
  semantic?: string | null;
  isolate?: string;
}

export interface ExecuteRunResult {
  code: number;
  runStatus: RunStatus;
  taskStatus: TaskStatus;
}

/** A live per-run gateway daemon. */
interface Gateway {
  proc: ChildProcess;
  url: string;
}

// Local engine: settings fragment pointing at the compiled hook next to us.
function localSettings(workspace: string): string {
  const hook = path.join(REPO_ROOT, 'gateway', 'hook.js');
  const cmd = (kind: string): string => `node ${hook} ${kind}`;
  const settings = {
    // Inherit nothing from the user's defaultMode (auto classifier denies
    // Bash nondeterministically); the gateway policy chain is the gate here.
    permissions: { defaultMode: 'bypassPermissions' },
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('pre_tool_use') }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('post_tool_use') }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('stop') }] }],
    },
  };
  const dir = path.join(workspace, '.agent-grid');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hooks-settings.local.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

// Realtime gateway: one daemon per run on an ephemeral port (tool-call
// policy AND egress proxy share the process). Resolves null if the daemon
// fails to start -- the run then falls back to offline mode, no proxying.
function startDaemon({ dbPath, runId, goal, semantic }: {
  dbPath: string; runId: string; goal: string; semantic: string | null;
}): Promise<Gateway | null> {
  const args = [path.join(REPO_ROOT, 'gateway', 'daemon.js'),
    '--db', dbPath, '--port', '0', '--goal', goal, '--run', runId];
  if (semantic !== null) args.push('--semantic', semantic);
  const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(null), 5000);
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d;
      const m = buf.match(/gateway listening on (\d+)/);
      if (m) { clearTimeout(timer); resolve({ proc, url: `http://127.0.0.1:${m[1]}` }); }
    });
    proc.on('exit', () => { clearTimeout(timer); resolve(null); });
  });
}

// Egress-proxy env for the agent process. NO_PROXY must cover the hook's
// callback to the gateway and the model backend, or the run dies on its own
// traffic. Both cases: gateway URL and ANTHROPIC_BASE_URL host.
function proxyEnv(engine: string, gatewayUrl: string | null | undefined): Record<string, string> {
  if (!gatewayUrl) return {};
  const url = engine === 'docker'
    ? gatewayUrl.replace('127.0.0.1', 'host.docker.internal')
    : gatewayUrl;
  const noProxy = ['127.0.0.1', 'localhost'];
  if (engine === 'docker') noProxy.push('host.docker.internal');
  try { noProxy.push(new URL(process.env.ANTHROPIC_BASE_URL ?? '').hostname); } catch { /* unset */ }
  // Trust the gateway CA so TLS interception of credential-bearing hosts
  // validates for curl/git (SSL_CERT_FILE) and node (NODE_EXTRA_CA_CERTS).
  const env: Record<string, string> = {
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url,
    http_proxy: url, https_proxy: url, all_proxy: url,
    NO_PROXY: noProxy.join(','), no_proxy: noProxy.join(','),
  };
  try {
    const ca = getCACertPath();
    if (fs.existsSync(ca)) {
      env.SSL_CERT_FILE = ca;
      env.NODE_EXTRA_CA_CERTS = ca;
    }
  } catch { /* CA not generated yet; interception will fall back */ }
  return env;
}

/** Run the agent CLI for this run (docker sandbox, or local for dev/debug). */
function runAgent({ agent, engine, workspace, runId, goal, gatewayUrl, isolate = '0' }: {
  agent: string; engine: string; workspace: string; runId: string; goal: string;
  gatewayUrl?: string | null; isolate?: string;
}): number {
  const sink = path.join(workspace, '.agent-grid', 'events.jsonl');
  const netEnv = proxyEnv(engine, gatewayUrl);
  if (engine === 'docker') {
    const built = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
    if (built.status !== 0) {
      const b = spawnSync('docker', ['build', '-t', IMAGE, '-f',
        path.join(REPO_ROOT, 'sandbox', 'Dockerfile'), REPO_ROOT], { stdio: 'inherit' });
      if (b.status !== 0) return b.status ?? 1;
    }
    // Stronger isolation (phase 3): internal network with no external
    // routing; egress only via the host proxy. UNTESTED -- docker runs are
    // pending environment availability; reachability of host.docker.internal
    // from an --internal network is the open assumption.
    let netArgs: string[] = [];
    if (isolate === '1') {
      spawnSync('docker', ['network', 'create', '--internal', 'agent-grid-internal'],
        { stdio: 'ignore' });
      netArgs = ['--network', 'agent-grid-internal'];
    }
    const gwArgs = gatewayUrl ? [
      '-e', `GATEWAY_URL=${gatewayUrl.replace('127.0.0.1', 'host.docker.internal')}`,
      '-e', `RUN_ID=${runId}`,
      '--add-host', 'host.docker.internal:host-gateway',
      ...Object.entries(netEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ] : [];
    const r = spawnSync('docker', ['run', '--rm', '--name', `agent-grid-${runId}`,
      '-e', `AGENT_KIND=${agent}`, ...gwArgs, ...netArgs, '-v', `${workspace}:/workspace`,
      IMAGE, goal], { stdio: 'inherit' });
    return r.status ?? 1;
  }
  // local engine: dev/debug only
  fs.mkdirSync(path.dirname(sink), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_KIND: agent, EVENT_SINK: sink, ...netEnv };
  if (gatewayUrl) { env.GATEWAY_URL = gatewayUrl; env.RUN_ID = runId; }
  if (agent === 'claude') {
    // Newer CLI builds gate --dangerously-skip-permissions behind an explicit
    // --allow- flag; without it the skip is silently ignored and the session
    // falls back to the user's defaultMode (auto classifier denies Bash).
    const r = spawnSync('claude', ['-p', goal,
      '--allow-dangerously-skip-permissions',
      '--dangerously-skip-permissions',
      '--permission-mode', 'bypassPermissions',
      '--settings', localSettings(workspace)],
      { cwd: workspace, env, stdio: 'inherit' });
    return r.status ?? 1;
  }
  const r = spawnSync('codex', ['exec', '--full-auto', goal],
    { cwd: workspace, env, stdio: 'inherit' });
  return r.status ?? 1;
}

// Execute one already-inserted run (status running) to its terminal state.
export async function executeRun({
  db, dbPath, taskId, runId, agent, engine, workspace, goal,
  gatewayPref = '1', semantic = null, isolate = '0',
}: ExecuteRunOptions): Promise<ExecuteRunResult> {
  const now = (): string => new Date().toISOString();

  // A stale sink from a previous run would be re-collected and collide on
  // (run_id, seq); previous events are already in the DB.
  const sink = path.join(workspace, '.agent-grid', 'events.jsonl');
  fs.rmSync(sink, { force: true });

  // Realtime gateway (phase 2): daemon is the sole `events` writer while live.
  const gateway = gatewayPref === '1'
    ? await startDaemon({ dbPath, runId, goal, semantic })
    : null;
  if (gateway) console.log(`gateway: ${gateway.url}`);
  else if (gatewayPref === '1') console.error('gateway failed to start; falling back to offline mode');

  const code = runAgent({ agent, engine, workspace, runId, goal, gatewayUrl: gateway?.url, isolate });

  // Artifacts: best-effort git diff of the workspace.
  // add -N marks untracked files as intent-to-add so new files show up in diff.
  spawnSync('git', ['-C', workspace, 'add', '-N', '.', ...EXCLUDE_PATHSPEC], { stdio: 'ignore' });
  const diff = spawnSync('git', ['-C', workspace, 'diff', 'HEAD', '--', '.', ...EXCLUDE_PATHSPEC],
    { encoding: 'utf8' });
  let hasDiff = false;
  if (diff.status === 0 && diff.stdout.trim()) {
    await db.prepare('INSERT INTO artifacts (id, run_id, kind, content) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), runId, 'diff', diff.stdout);
    hasDiff = true;
    console.log('artifact: diff captured');
  }

  // Diff pre-review (phase 2): classify before the human sees it; record via
  // the daemon so it stays the sole writer. The human is still the final gate.
  if (gateway && hasDiff && semantic !== '0') {
    const v = await classify({ goal, tool: 'diff-review', input: diff.stdout });
    const payload: ApprovalPayload = { stage: 'pre_human', risk: v.risk, reason: v.reason };
    await fetch(`${gateway.url}/v1/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: runId, kind: 'approval', payload }),
    }).catch((e) => console.error(`pre-review event failed: ${errMessage(e)}`));
    console.log(`diff pre-review: ${v.risk} — ${v.reason}`);
  }

  // Status transitions: a successful run with a diff awaits human approval;
  // without a diff it succeeds directly. Failure is terminal.
  let runStatus: RunStatus;
  let taskStatus: TaskStatus;
  if (code !== 0) {
    runStatus = 'failed';
    taskStatus = 'failed';
    await db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run(runStatus, now(), runId);
  } else if (hasDiff) {
    runStatus = 'awaiting_approval';
    taskStatus = 'awaiting_approval';
    await db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(runStatus, runId);
  } else {
    runStatus = 'succeeded';
    taskStatus = 'done';
    await db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run(runStatus, now(), runId);
  }
  await db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(taskStatus, taskId);

  // Offline fallback: collect JSONL written when the daemon was unreachable
  // (or gateway=0). Realtime events are already in the DB via the daemon.
  if (fs.existsSync(sink)) {
    const c = spawnSync(process.execPath,
      [path.join(REPO_ROOT, 'gateway', 'collect.js'), runId, sink, dbPath],
      { stdio: 'inherit' });
    if (c.status !== 0) console.error('event collection failed');
  }
  if (gateway) gateway.proc.kill();

  console.log(`run ${runId} ${runStatus}; task ${taskId} ${taskStatus}`);
  return { code, runStatus, taskStatus };
}

export { IMAGE, EXCLUDE_PATHSPEC, REPO_ROOT };
