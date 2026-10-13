-- Phase 3 (runner pooling): submission snapshot for queued tasks.
-- params JSON: { workspace, agent, engine, gateway, semantic }.
-- NOT idempotent (plain ALTER) -- apply once, like 0002/0003.
ALTER TABLE tasks ADD COLUMN params TEXT;
