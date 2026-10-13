-- Phase 3 (runner pooling): submission snapshot. NOT idempotent -- apply
-- once.
ALTER TABLE tasks ADD COLUMN params TEXT;
