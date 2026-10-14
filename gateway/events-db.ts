// Event writer shared by the gateway daemon (tool calls, lifecycle) and the
// egress proxy (network): assigns `seq` monotonic per run, resuming from
// MAX(seq)+1 so a restart never collides on (run_id, seq).
import { open } from '../lib/db.js';
import type { Db } from '../lib/db.js';

/** The gateway's write handle: `db` is exposed for read-only consumers. */
export interface EventWriter {
  append(runId: string, kind: string, payload: unknown): Promise<number>;
  db: Db;
}

export async function createEventWriter(spec: string): Promise<EventWriter> {
  const db = await open(spec);
  const seqNext = new Map<string, number>();
  async function nextSeq(runId: string): Promise<number> {
    if (!seqNext.has(runId)) {
      // COALESCE always yields a row, so the assertion holds.
      const row = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE run_id = ?')
        .get<{ m: number }>(runId);
      seqNext.set(runId, row!.m + 1);
    }
    const seq = seqNext.get(runId)!;
    seqNext.set(runId, seq + 1);
    return seq;
  }
  async function append(runId: string, kind: string, payload: unknown): Promise<number> {
    const seq = await nextSeq(runId);
    await db.prepare('INSERT INTO events (run_id, seq, kind, payload, ts) VALUES (?, ?, ?, ?, ?)')
      .run(runId, seq, kind, JSON.stringify(payload), new Date().toISOString());
    return seq;
  }
  return { append, db };
}
