// Tenant resolution by name with implicit creation (no admin UI in the
// prototype). Returns the tenant id.
const { randomUUID } = require('node:crypto');

async function resolveTenant(db, name) {
  const n = name || 'default';
  const existing = await db.prepare('SELECT id FROM tenants WHERE name = ?').get(n);
  if (existing) return existing.id;
  const id = randomUUID();
  await db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run(id, n);
  return id;
}

module.exports = { resolveTenant };
