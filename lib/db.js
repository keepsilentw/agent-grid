// Unified async DB access for both backends (phase 3 Postgres switch):
//   open('agent.db')                 -> sqlite (node:sqlite), promise-wrapped
//   open('postgres://...')           -> pg
// API: prepare(sql) -> { get(...p), all(...p), run(...p) }  (all async)
//      exec(sql), close()
//
// PG translation (only our own fixed SQL patterns are supported):
//   - sequential `?` placeholders -> $1..$n
//   - json_extract(expr, '$.key')  -> (expr::json->>'key')
const { DatabaseSync } = require('node:sqlite');

function isPg(spec) {
  return /^(postgres|postgresql):\/\//.test(spec);
}

function translateJson(sql) {
  return sql.replace(/json_extract\(([^,()]+),\s*'(\$[^']*)'\)/g, (m, expr, p) => {
    const key = p.startsWith('$.') ? p.slice(2) : p;
    return `(${expr}::json->>'${key}')`;
  });
}

function placeholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function sqliteWrap(spec) {
  const raw = new DatabaseSync(spec);
  return {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        get: async (...p) => stmt.get(...p),
        all: async (...p) => stmt.all(...p),
        run: async (...p) => stmt.run(...p),
      };
    },
    exec: async (sql) => raw.exec(sql),
    close: async () => raw.close(),
  };
}

async function pgWrap(spec) {
  const pg = require('pg');
  // COUNT(*) and other int8s come back as strings by default; our code does
  // numeric comparisons on them.
  pg.types.setTypeParser(20, (v) => Number(v));
  const client = new pg.Client({ connectionString: spec });
  await client.connect();
  return {
    prepare(sql) {
      const q = placeholders(translateJson(sql));
      return {
        get: async (...p) => (await client.query(q, p)).rows[0],
        all: async (...p) => (await client.query(q, p)).rows,
        run: async (...p) => {
          const r = await client.query(q, p);
          return { changes: r.rowCount };
        },
      };
    },
    exec: async (sql) => { await client.query(sql); },
    close: async () => { await client.end(); },
  };
}

async function open(spec) {
  return isPg(spec) ? pgWrap(spec) : sqliteWrap(spec);
}

module.exports = { open, isPg };
