#!/usr/bin/env node
// Claude Code hook side of the tool gateway. Runs INSIDE the sandbox.
//
// Modes (env-driven, per run):
//   GATEWAY_URL set  -> realtime: POST to the control-plane daemon and apply
//                       its verdict (PreToolUse may deny the tool call).
//   GATEWAY_URL unset -> offline: append one JSONL line to $EVENT_SINK;
//                       the control-plane collector ingests after the run.
//
// Usage (as configured in hooks-settings.json):
//   node dist/gateway/hook.js <pre_tool_use|post_tool_use|stop>   # JSON on stdin
import fs from 'node:fs';
import path from 'node:path';
import { errMessage } from '../lib/errors.js';
import type { Decision, HookEvent } from '../lib/types.js';

const kind = process.argv[2] || 'unknown';
const GATEWAY_URL = process.env.GATEWAY_URL;
const RUN_ID = process.env.RUN_ID;
const SINK = process.env.EVENT_SINK || '/workspace/.agent-grid/events.jsonl';
// PreToolUse waits out the classifier (claude -p); stay under Claude Code's
// 60s hook timeout.
const TIMEOUT_MS = kind === 'pre_tool_use' ? 55000 : 3000;

/** The subset of Claude Code's hook payload this gateway records. */
interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (d: Buffer) => (raw += d));
    process.stdin.on('end', () => resolve(raw));
  });
}

function normalize(hookInput: HookInput): HookEvent {
  return {
    kind,
    ts: new Date().toISOString(),
    hook_event_name: hookInput.hook_event_name,
    session_id: hookInput.session_id,
    tool_name: hookInput.tool_name,
    tool_input: hookInput.tool_input,
    tool_response: hookInput.tool_response,
  };
}

async function realtime(ev: HookEvent): Promise<void> {
  if (kind === 'pre_tool_use') {
    const r = await fetch(`${GATEWAY_URL}/v1/tool_call`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        run_id: RUN_ID, session_id: ev.session_id,
        tool_name: ev.tool_name, tool_input: ev.tool_input,
      }),
    });
    const verdict = await r.json() as Decision;
    if (verdict.decision === 'deny') {
      // permissionDecision deny surfaces the reason to the agent, which
      // must then re-plan around the blocked call.
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      }));
    }
    return;
  }
  await fetch(`${GATEWAY_URL}/v1/event`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      run_id: RUN_ID,
      kind: kind === 'post_tool_use' ? 'tool_call' : 'lifecycle',
      payload: { ...ev, phase: kind === 'post_tool_use' ? 'post' : kind },
    }),
  }).catch(() => {}); // best-effort: never block the agent on bookkeeping
}

function offline(ev: HookEvent): void {
  fs.mkdirSync(path.dirname(SINK), { recursive: true });
  fs.appendFileSync(SINK, JSON.stringify(ev) + '\n');
}

(async () => {
  const raw = await readStdin();
  let hookInput: HookInput = {};
  try { hookInput = JSON.parse(raw) as HookInput; } catch { /* record that the hook fired */ }
  const ev = normalize(hookInput);
  if (GATEWAY_URL && RUN_ID) {
    try {
      await realtime(ev);
    } catch (e) {
      // Gateway unreachable: fall back to the sink so the event is not lost.
      offline(ev);
      if (kind === 'pre_tool_use') {
        console.error(`gateway unreachable (${errMessage(e)}); allowing`);
      }
    }
  } else {
    offline(ev);
  }
  process.exit(0);
})();
