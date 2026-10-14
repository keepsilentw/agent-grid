#!/usr/bin/env node
// Realtime gateway daemon (control plane): the sole writer of `events` while
// a run is live. Sandbox hooks POST here; the daemon records the event,
// evaluates the policy chain, and returns an allow/deny verdict. The egress
// proxy shares this process (see proxy.ts attachProxy).
//
// Usage: node dist/gateway/daemon.js [--db agent.db|--db postgres://...] [--port 0]
//        [--goal "..."] [--run <run_id>]
//   POST /v1/tool_call {run_id, session_id, tool_name, tool_input}
//        -> writes kind=tool_call (phase=pre), responds {decision, reason}
//   POST /v1/event {run_id, kind, payload}
//        -> writes the event, responds {seq}
// Prints "gateway listening on <port>" on stdout once ready (--port 0 picks
// an ephemeral port; run.ts parses this line).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createEventWriter } from './events-db.js';
import { attachProxy, loadCredentials } from './proxy.js';
import { classify } from './classifier.js';
import { errMessage } from '../lib/errors.js';
import type { Decision, DenyRule, Policy } from '../lib/types.js';

const argv = process.argv.slice(2);
/** Value of `--<name>`; `dflt` when the flag is absent or has no value. */
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? dflt) : dflt;
};
/** Value of an optional `--<name>` flag; null when absent. */
const flagOrNull = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? '') : null;
};
const dbPath = flag('--db', 'agent.db');
const port = Number(flag('--port', '0'));
const goal = flag('--goal', '');
// --run: run id for egress-proxy network events (one daemon per run).
const runId = flag('--run', '');
const credFile = flag('--credentials',
  path.join(os.homedir(), '.config', 'agent-grid', 'credentials.json'));
// --semantic 0|1 overrides policy.json (used by tests / phased rollout).
const semanticOverride = flagOrNull('--semantic');

const policy = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'policy.json'), 'utf8')
) as Policy;
/** A deny rule with its pattern compiled once at startup. */
type CompiledRule = DenyRule & { re: RegExp };
const denyRules: CompiledRule[] = policy.deny_rules.map((r): CompiledRule | null => {
  try { return { ...r, re: new RegExp(r.pattern) }; }
  catch { return null; }
}).filter((r): r is CompiledRule => r !== null);

// Policy chain, short-circuiting: deny rules first (free), then the
// semantic classifier. medium/high are blocked when semantic is enabled.
async function decide(toolName: string, toolInput: string): Promise<Decision> {
  const haystack = `${toolName}\n${toolInput}`;
  for (const r of denyRules) {
    if (r.re.test(haystack)) {
      return { decision: 'deny', reason: `policy rule ${r.name} matched`, rule: r.name };
    }
  }
  const semanticOn = semanticOverride !== null
    ? semanticOverride === '1'
    : !!policy.semantic?.enabled;
  if (semanticOn) {
    const v = await classify({ goal, tool: toolName, input: toolInput });
    const block = policy.semantic?.block_on || ['medium', 'high'];
    if (block.includes(v.risk)) {
      return { decision: 'deny', reason: `semantic risk ${v.risk}: ${v.reason}`, risk: v.risk };
    }
    return { decision: 'allow', reason: `semantic risk ${v.risk}: ${v.reason}`, risk: v.risk };
  }
  return { decision: 'allow', reason: 'no rule matched; semantic disabled' };
}

/** Request bodies of the two hook endpoints. */
interface ToolCallBody {
  run_id?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
}
interface EventBody {
  run_id?: string;
  kind?: string;
  payload?: unknown;
}

function readBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d: Buffer) => (b += d));
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}') as T); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function main(): Promise<void> {
  // Single event writer for the whole gateway process (tool calls,
  // lifecycle, network decisions).
  const { append: appendEvent } = await createEventWriter(dbPath);

  const server = http.createServer(async (req, res) => {
    const send = (code: number, obj: unknown): void => {
      if (res.headersSent) return; // proxy handler already answered this request
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // Absolute-form targets are proxied requests -- handled by attachProxy's
    // own 'request' listener; never answer them here.
    if (/^https?:\/\//i.test(req.url || '')) return;
    try {
      if (req.method === 'POST' && req.url === '/v1/tool_call') {
        const b = await readBody<ToolCallBody>(req);
        if (!b.run_id || !b.tool_name) return send(400, { error: 'run_id and tool_name required' });
        await appendEvent(b.run_id, 'tool_call', {
          phase: 'pre', session_id: b.session_id,
          tool_name: b.tool_name, tool_input: b.tool_input,
        });
        const verdict = await decide(b.tool_name, JSON.stringify(b.tool_input ?? ''));
        if (verdict.decision === 'deny') {
          await appendEvent(b.run_id, 'tool_call', {
            phase: 'denied', session_id: b.session_id,
            tool_name: b.tool_name, reason: verdict.reason,
          });
        }
        return send(200, verdict);
      }
      if (req.method === 'POST' && req.url === '/v1/event') {
        const b = await readBody<EventBody>(req);
        if (!b.run_id || !b.kind) return send(400, { error: 'run_id and kind required' });
        return send(200, { seq: await appendEvent(b.run_id, b.kind, b.payload ?? {}) });
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: errMessage(e) });
    }
  });

  // Egress proxy rides the same http server (CONNECT + absolute-form), so
  // the gateway stays a single process and the single event writer.
  attachProxy(server, {
    writer: { append: appendEvent },
    runId,
    allow: policy.network?.allow || [],
    credentials: loadCredentials(credFile),
  });

  server.listen(port, () => {
    const addr = server.address() as AddressInfo;
    console.log(`gateway listening on ${addr.port}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
