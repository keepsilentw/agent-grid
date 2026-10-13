-- Phase 3 (multi-tenancy). tenants seed uses ON CONFLICT instead of
-- INSERT OR IGNORE. NOT idempotent (ALTER) -- apply once.
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'utc',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
INSERT INTO tenants (id, name) VALUES ('default', 'default')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE tasks ADD COLUMN tenant_id TEXT REFERENCES tenants (id);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks (tenant_id);
