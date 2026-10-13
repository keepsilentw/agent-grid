-- Phase 2 (thread forking): record each run's workspace directory so a later
-- run can fork from it. NOT idempotent -- apply once (plain ALTER, no
-- IF NOT EXISTS in SQLite).
ALTER TABLE runs ADD COLUMN workspace TEXT;
