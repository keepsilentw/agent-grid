#!/usr/bin/env node
// Anomaly detection (phase 3): a pure READER of `events` + `runs` -- never
// writes. Findings are computed on demand (audit CLI, web board).
//
// CLI: node anomaly.js [--db agent.db|postgres://...] [--json] [--stale-hours N]
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../lib/db.js');

const policy = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'policy.json'), 'utf8')
);
const credRe = new RegExp(
  (policy.deny_rules.find((r) => r.name === 'credential-file-read') || {}).pattern || '(?!)'
);

// findings(db, {staleHours}) -> [{rule, severity, run_id, task_id, detail, ts}]
async function findings(db, { staleHours = 24 } = {}) {
  const out = [];
  const withTask = async (runId) =>
    (await db.prepare('SELECT task_id FROM runs WHERE id = ?').get(runId))?.task_id ?? null;
  const push = async (rule, severity, runId, detail, ts) =>
    out.push({ rule, severity, run_id: runId, task_id: await withTask(runId), detail, ts });

  // 1. deny_burst: >= 3 denied tool calls in one run (agent flailing or
  //    prompt-attack attempts).
  for (const r of await db.prepare(`
    SELECT run_id, COUNT(*) AS n, MAX(ts) AS ts FROM events
    WHERE kind = 'tool_call' AND json_extract(payload, '$.phase') = 'denied'
    GROUP BY run_id HAVING COUNT(*) >= 3`).all()) {
    await push('deny_burst', 'high', r.run_id, `${r.n} denied tool calls`, r.ts);
  }

  // 2. network_scan: >= 2 distinct denied hosts in one run (probing).
  for (const r of await db.prepare(`
    SELECT run_id, COUNT(DISTINCT json_extract(payload, '$.host')) AS hosts, MAX(ts) AS ts
    FROM events
    WHERE kind = 'network' AND json_extract(payload, '$.phase') = 'denied'
    GROUP BY run_id HAVING COUNT(DISTINCT json_extract(payload, '$.host')) >= 2`).all()) {
    await push('network_scan', 'high', r.run_id, `${r.hosts} distinct denied hosts`, r.ts);
  }

  // 3. credential_probe: tool input touches credential files, whether or not
  //    the gateway blocked it. Regex shared with policy.json.
  for (const r of await db.prepare(`
    SELECT run_id, ts, payload FROM events
    WHERE kind = 'tool_call' AND json_extract(payload, '$.phase') = 'pre'`).all()) {
    if (credRe.test(JSON.stringify(JSON.parse(r.payload).tool_input ?? ''))) {
      await push('credential_probe', 'high', r.run_id, 'tool input references credential files', r.ts);
    }
  }

  // 4. high_risk_diff: pre-human review rated the diff high risk.
  for (const r of await db.prepare(`
    SELECT run_id, ts, json_extract(payload, '$.reason') AS reason FROM events
    WHERE kind = 'approval' AND json_extract(payload, '$.risk') = 'high'`).all()) {
    await push('high_risk_diff', 'high', r.run_id, `pre-review: ${r.reason || 'high risk'}`, r.ts);
  }

  // 5. silent_run: run recorded no events at all (capture broken or agent
  //    never acted).
  for (const r of await db.prepare(`
    SELECT r.id AS run_id, r.started_at AS ts FROM runs r
    LEFT JOIN events e ON e.run_id = r.id
    WHERE e.run_id IS NULL`).all()) {
    await push('silent_run', 'medium', r.run_id, 'run has zero events', r.ts);
  }

  // 6. stale_approval: stuck in awaiting_approval beyond the threshold.
  const cutoff = new Date(Date.now() - staleHours * 3600 * 1000).toISOString();
  for (const r of await db.prepare(`
    SELECT id AS run_id, started_at AS ts FROM runs
    WHERE status = 'awaiting_approval' AND COALESCE(started_at, '') < ?`).all(cutoff)) {
    await push('stale_approval', 'low', r.run_id, `awaiting approval over ${staleHours}h`, r.ts);
  }

  out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return out;
}

module.exports = { findings };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const dbSpec = flag('--db', 'agent.db');
  const staleHours = Number(flag('--stale-hours', '24'));
  (async () => {
    const db = await open(dbSpec);
    const res = await findings(db, { staleHours });
    if (argv.includes('--json')) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.length === 0) {
      console.log('no anomalies');
    } else {
      for (const f of res) {
        console.log(`[${f.severity}] ${f.rule} run=${f.run_id} ${f.detail} @${f.ts}`);
      }
    }
    await db.close();
  })().catch((e) => { console.error(e); process.exit(1); });
}
