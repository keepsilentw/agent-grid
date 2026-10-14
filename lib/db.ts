// Unified async DB access for both backends (phase 3 Postgres switch):
//   open('agent.db')                 -> sqlite (node:sqlite), promise-wrapped
//   open('postgres://...')           -> pg
// API: prepare(sql) -> { get(...p), all(...p), run(...p) }  (all async)
//      exec(sql), close()
//
// PG translation (only our own fixed SQL patterns are supported):
//   - sequential `?` placeholders -> $1..$n
//   - json_extract(expr, '$.key')  -> (expr::json->>'key')
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementResultingChanges } from 'node:sqlite';
import pg from 'pg';

/** Default row shape; callers pass a narrower type argument where it matters. */
export type Row = Record<string, unknown>;

/** Outcome of a write statement. PG reports only `changes` (its rowCount). */
export interface WriteResult {
  changes: number | bigint;
}

/** Promise-wrapped prepared statement. */
export interface Statement {
  get<T = Row>(...params: unknown[]): Promise<T | undefined>;
  all<T = Row>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<WriteResult>;
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function isPg(spec: string): boolean {
  return /^(postgres|postgresql):\/\//.test(spec);
}

function translateJson(sql: string): string {
  return sql.replace(/json_extract\(([^,()]+),\s*'(\$[^']*)'\)/g, (m, expr: string, p: string) => {
    const key = p.startsWith('$.') ? p.slice(2) : p;
    return `(${expr}::json->>'${key}')`;
  });
}

function placeholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function sqliteWrap(spec: string): Db {
  const raw = new DatabaseSync(spec);
  return {
    prepare(sql: string): Statement {
      const stmt = raw.prepare(sql);
      // Our own call sites pass null | number | bigint | string; the cast is
      // the single place where that assumption is asserted.
      const bind = (params: unknown[]): SQLInputValue[] => params as SQLInputValue[];
      return {
        get: async <T>(...p: unknown[]) => stmt.get(...bind(p)) as T | undefined,
        all: async <T>(...p: unknown[]) => stmt.all(...bind(p)) as T[],
        run: async (...p: unknown[]) => stmt.run(...bind(p)),
      };
    },
    exec: async (sql: string) => { raw.exec(sql); },
    close: async () => { raw.close(); },
  };
}

async function pgWrap(spec: string): Promise<Db> {
  // COUNT(*) and other int8s come back as strings by default; our code does
  // numeric comparisons on them.
  pg.types.setTypeParser(20, (v) => Number(v));
  const client = new pg.Client({ connectionString: spec });
  await client.connect();
  return {
    prepare(sql: string): Statement {
      const q = placeholders(translateJson(sql));
      return {
        get: async <T>(...p: unknown[]) => (await client.query(q, p)).rows[0] as T | undefined,
        all: async <T>(...p: unknown[]) => (await client.query(q, p)).rows as T[],
        run: async (...p: unknown[]) => {
          const r = await client.query(q, p);
          return { changes: r.rowCount ?? 0 };
        },
      };
    },
    exec: async (sql: string) => { await client.query(sql); },
    close: async () => { await client.end(); },
  };
}

export async function open(spec: string): Promise<Db> {
  return isPg(spec) ? pgWrap(spec) : sqliteWrap(spec);
}
