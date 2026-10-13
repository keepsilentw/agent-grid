#!/usr/bin/env node
// Realtime gateway daemon (control plane): the sole writer of `events` while
// a run is live. Sandbox hooks POST here; the daemon records the event,
// evaluates the policy chain, and returns an allow/deny verdict. The egress
// proxy shares this process (see proxy.js attachProxy).
//
// Usage: node daemon.js [--db agent.db|--db postgres://...] [--port 0]
//        [--goal "..."] [--run <run_id>]
//   POST /v1/tool_call {run_id, session_id, tool_name, tool_input}
//        -> writes kind=tool_call (phase=pre), responds {decision, reason}
//   POST /v1/event {run_id, kind, payload}
//        -> writes the event, responds {seq}
// Prints "gateway listening on <port>" on stdout once ready (--port 0 picks
// an ephemeral port; run.js parses this line).
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEventWriter } = require('./events-db.js');
const { attachProxy, loadCredentials } = require('./proxy.js');
const { classify } = require('./classifier.js');

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const dbPath = flag('--db', 'agent.db');
const port = Number(flag('--port', '0'));
const goal = flag('--goal', '');
// --run: run id for egress-proxy network events (one daemon per run).
const runId = flag('--run', '');
const credFile = flag('--credentials',
  path.join(os.homedir(), '.config', 'agent-grid', 'credentials.json'));
// --semantic 0|1 overrides policy.json (used by tests / phased rollout).
const semanticOverride = flag('--semantic', null);

const policy = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'policy.json'), 'utf8')
);
const denyRules = policy.deny_rules.map((r) => {
  try { return { ...r, re: new RegExp(r.pattern) }; }
  catch { return null; }
}).filter(Boolean);

// Policy chain, short-circuiting: deny rules first (free), then the
// semantic classifier. medium/high are blocked when semantic is enabled.
async function decide(toolName, toolInput) {
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
    const block = policy.semantic.block_on || ['medium', 'high'];
    if (block.includes(v.risk)) {
      return { decision: 'deny', reason: `semantic risk ${v.risk}: ${v.reason}`, risk: v.risk };
    }
    return { decision: 'allow', reason: `semantic risk ${v.risk}: ${v.reason}`, risk: v.risk };
  }
  return { decision: 'allow', reason: 'no rule matched; semantic disabled' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function main() {
  // Single event writer for the whole gateway process (tool calls,
  // lifecycle, network decisions).
  const { append: appendEvent } = await createEventWriter(dbPath);

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      if (res.headersSent) return; // proxy handler already answered this request
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // Absolute-form targets are proxied requests -- handled by attachProxy's
    // own 'request' listener; never answer them here.
    if (/^https?:\/\//i.test(req.url || '')) return;
    try {
      if (req.method === 'POST' && req.url === '/v1/tool_call') {
        const b = await readBody(req);
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
        const b = await readBody(req);
        if (!b.run_id || !b.kind) return send(400, { error: 'run_id and kind required' });
        return send(200, { seq: await appendEvent(b.run_id, b.kind, b.payload ?? {}) });
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: e.message });
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
    console.log(`gateway listening on ${server.address().port}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
