-- Phase 3 (multi-tenancy): tenants table plus tasks.tenant_id. Runs/events/
-- artifacts inherit tenancy via task. NOT idempotent (plain ALTER) -- apply
-- once, like 0002.
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO tenants (id, name) VALUES ('default', 'default');

ALTER TABLE tasks ADD COLUMN tenant_id TEXT REFERENCES tenants (id);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks (tenant_id);
