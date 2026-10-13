#!/usr/bin/env node
// Gateway (control-plane) side: after a run exits, read the JSONL event sink
// left in the workspace and append rows to `events`. The gateway is the sole
// writer of `events`; `seq` is assigned here, monotonic per run.
//
// Usage: node collect.js <run_id> <events.jsonl> [agent.db|postgres://...]
const fs = require('node:fs');
const { open } = require('../lib/db.js');

const [runId, sinkPath, dbSpec = 'agent.db'] = process.argv.slice(2);
if (!runId || !sinkPath) {
  console.error('usage: node collect.js <run_id> <events.jsonl> [db spec]');
  process.exit(2);
}

// Map hook-level kinds onto the schema's event kinds:
//   pre/post_tool_use -> tool_call, stop -> lifecycle.
// Unknown kinds are stored as-is rather than dropped.
function schemaKind(ev) {
  switch (ev.kind) {
    case 'pre_tool_use':
    case 'post_tool_use':
      return 'tool_call';
    case 'stop':
      return 'lifecycle';
    default:
      return ev.kind;
  }
}

async function main() {
  const lines = fs
    .readFileSync(sinkPath, 'utf8')
    .split('\n')
    .filter(Boolean);

  const db = await open(dbSpec);
  // Resume after whatever the realtime daemon already wrote: offline-fallback
  // lines may follow partial realtime events for the same run.
  let seq = (await db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE run_id = ?').get(runId)).m;
  let count = 0;
  for (const line of lines) {
    const ev = JSON.parse(line);
    seq += 1;
    count += 1;
    await db.prepare('INSERT INTO events (run_id, seq, kind, payload, ts) VALUES (?, ?, ?, ?, ?)')
      .run(runId, seq, schemaKind(ev), JSON.stringify(ev), ev.ts);
  }
  console.log(`collected ${count} events for run ${runId} (seq ends at ${seq})`);
  await db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
