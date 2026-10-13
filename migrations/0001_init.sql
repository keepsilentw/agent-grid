-- agent-grid core schema.
-- Dialect target: SQLite (WAL) for phase 1; keep to the Postgres-friendly
-- subset so phase 3 migration is a driver swap + data copy:
--   TEXT ids (app-generated uuid), RFC3339 UTC timestamps as TEXT,
--   JSON payloads as TEXT (json_extract in SQLite, ::jsonb in Postgres).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A unit of work submitted by a human. One task may fork into threads later.
CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  goal       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'created'
             CHECK (status IN ('created', 'running', 'awaiting_approval',
                               'done', 'failed', 'cancelled')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One execution attempt of a task inside a disposable sandbox.
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks (id),
  thread_id   TEXT,                       -- phase 2: fork/merge lineage
  sandbox_id  TEXT,
  agent_kind  TEXT NOT NULL,              -- claude | codex
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'awaiting_approval',
                                'succeeded', 'failed', 'cancelled')),
  started_at  TEXT,
  ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs (task_id);

-- Append-only full event stream: the single write path for the tool gateway.
-- Every consumer (audit replay, approval, billing, anomaly detection) is a
-- reader of this table.
CREATE TABLE IF NOT EXISTS events (
  run_id  TEXT NOT NULL REFERENCES runs (id),
  seq     INTEGER NOT NULL,               -- monotonic per run, assigned by gateway
  kind    TEXT NOT NULL,                  -- lifecycle | tool_call | llm_request
                                          -- | file_change | network | approval
  payload TEXT NOT NULL,                  -- JSON object
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (run_id, seq)
);

-- Outputs handed back to the human: diff, test report, etc.
CREATE TABLE IF NOT EXISTS artifacts (
  id      TEXT PRIMARY KEY,
  run_id  TEXT NOT NULL REFERENCES runs (id),
  kind    TEXT NOT NULL,                  -- diff | report | log
  content TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (run_id);
