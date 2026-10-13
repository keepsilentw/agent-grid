// Event writer shared by the gateway daemon (tool calls, lifecycle) and the
// egress proxy (network): assigns `seq` monotonic per run, resuming from
// MAX(seq)+1 so a restart never collides on (run_id, seq).
const { open } = require('../lib/db.js');

async function createEventWriter(spec) {
  const db = await open(spec);
  const seqNext = new Map();
  async function nextSeq(runId) {
    if (!seqNext.has(runId)) {
      const row = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE run_id = ?').get(runId);
      seqNext.set(runId, row.m + 1);
    }
    const seq = seqNext.get(runId);
    seqNext.set(runId, seq + 1);
    return seq;
  }
  async function append(runId, kind, payload) {
    const seq = await nextSeq(runId);
    await db.prepare('INSERT INTO events (run_id, seq, kind, payload, ts) VALUES (?, ?, ?, ?, ?)')
      .run(runId, seq, kind, JSON.stringify(payload), new Date().toISOString());
    return seq;
  }
  return { append, db };
}

module.exports = { createEventWriter };
