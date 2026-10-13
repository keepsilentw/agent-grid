-- agent-grid core schema (Postgres dialect). Logical schema is identical to
-- migrations/0001_init.sql: TEXT ids, RFC3339 UTC timestamps as TEXT, JSON
-- payloads as TEXT (queries cast with ::json via lib/db.js translation).
-- Apply: psql "$PG_URL" -f migrations/pg/0001_init.sql

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  goal       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'created'
             CHECK (status IN ('created', 'running', 'awaiting_approval',
                               'done', 'failed', 'cancelled')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'utc',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks (id),
  thread_id   TEXT,
  sandbox_id  TEXT,
  agent_kind  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'awaiting_approval',
                                'succeeded', 'failed', 'cancelled')),
  started_at  TEXT,
  ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs (task_id);

CREATE TABLE IF NOT EXISTS events (
  run_id  TEXT NOT NULL REFERENCES runs (id),
  seq     INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id      TEXT PRIMARY KEY,
  run_id  TEXT NOT NULL REFERENCES runs (id),
  kind    TEXT NOT NULL,
  content TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (run_id);
