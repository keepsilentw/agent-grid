// Tenant resolution by name with implicit creation (no admin UI in the
// prototype). Returns the tenant id.
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';

export async function resolveTenant(db: Db, name: string | null | undefined): Promise<string> {
  const n = name || 'default';
  const existing = await db.prepare('SELECT id FROM tenants WHERE name = ?').get<{ id: string }>(n);
  if (existing) return existing.id;
  const id = randomUUID();
  await db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run(id, n);
  return id;
}
