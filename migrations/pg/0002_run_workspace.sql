-- Phase 2 (thread forking). NOT idempotent -- apply once (like 0002 for
-- SQLite).
ALTER TABLE runs ADD COLUMN workspace TEXT;
