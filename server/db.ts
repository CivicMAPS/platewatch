import pg from 'pg';
import migration001 from './migrations/001_init.sql?raw';
import migration002 from './migrations/002_safety.sql?raw';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/** Migrations bundled into the server (in order). */
const MIGRATIONS: { id: string; sql: string }[] = [
  { id: '001_init', sql: migration001 },
  { id: '002_safety', sql: migration002 },
];

// timestamptz → epoch-ms numbers are produced in SQL where needed; keep Date objects otherwise.
export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function migrate(db: Db): Promise<string[]> {
  const c = await db.connect();
  try {
    await c.query('select pg_advisory_lock(727101)');
    await c.query('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query<{ id: string }>('select id from schema_migrations')).rows.map((r) => r.id));
    const applied: string[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await c.query('begin');
      try {
        await c.query(m.sql);
        await c.query('insert into schema_migrations (id) values ($1)', [m.id]);
        await c.query('commit');
        applied.push(m.id);
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
    return applied;
  } finally {
    await c.query('select pg_advisory_unlock(727101)').catch(() => undefined);
    c.release();
  }
}

export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
