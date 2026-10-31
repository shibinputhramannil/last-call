import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * A small SQL layer over two engines, so the same queries run everywhere:
 *
 * - PostgreSQL (DATABASE_URL), for hosts without a persistent disk, such as
 *   Render's free web plan with a managed Postgres database.
 * - SQLite, built into Node (node:sqlite): a file in DATA_DIR on hosts with a
 *   disk, or in memory when nothing is configured (history then lasts only
 *   until the server restarts, and the admin dashboard says so).
 *
 * Queries use `?` placeholders and a portable subset of SQL (ON CONFLICT
 * upserts, COUNT DISTINCT, CASE, substr). Every method is async.
 */
export async function openDatabase({ url = null, file = null, log } = {}) {
  if (url) return openPostgres(url, log);
  return openSqlite(file);
}

async function openSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const memory = !file;
  if (!memory) mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(memory ? ':memory:' : file);
  raw.exec('PRAGMA foreign_keys = ON');
  if (!memory) raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');

  const ops = {
    async run(sql, params = []) {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    async all(sql, params = []) {
      return raw.prepare(sql).all(...params);
    },
    async get(sql, params = []) {
      return raw.prepare(sql).get(...params) ?? null;
    },
  };

  // One connection: transactions take a lock so other callers cannot slip
  // statements into an open transaction between awaits.
  let lock = Promise.resolve();
  const locked = (fn) => {
    const result = lock.then(fn, fn);
    lock = result.catch(() => {});
    return result;
  };

  return {
    dialect: 'sqlite',
    persistent: !memory,
    label: memory ? 'in memory (not persisted)' : `SQLite file ${path.basename(file)}`,
    run: (sql, params) => locked(() => ops.run(sql, params)),
    all: (sql, params) => locked(() => ops.all(sql, params)),
    get: (sql, params) => locked(() => ops.get(sql, params)),
    exec: (sql) => locked(async () => raw.exec(sql)),
    transaction: (fn) =>
      locked(async () => {
        raw.exec('BEGIN');
        try {
          const result = await fn(ops);
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        }
      }),
    async close() {
      await lock;
      raw.close();
    },
  };
}

/** `?` placeholders to PostgreSQL's `$1, $2…`. Our SQL never contains a literal question mark. */
const numbered = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

async function openPostgres(url, log) {
  const { default: pg } = await import('pg');
  // BIGINT and NUMERIC come back as strings by default; our values fit in a double.
  pg.types.setTypeParser(20, (v) => (v == null ? null : Number(v)));
  pg.types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  });
  // An idle client losing its connection must not crash the game.
  pool.on('error', (err) => log?.warn('database connection error', { err: err.message }));

  const bind = (q) => ({
    async run(sql, params = []) {
      const r = await q.query(numbered(sql), params);
      return { changes: r.rowCount ?? 0 };
    },
    async all(sql, params = []) {
      return (await q.query(numbered(sql), params)).rows;
    },
    async get(sql, params = []) {
      return (await q.query(numbered(sql), params)).rows[0] ?? null;
    },
  });
  const ops = bind(pool);
  let host = 'PostgreSQL';
  try {
    host = `PostgreSQL on ${new URL(url).hostname}`;
  } catch {
    // keep the generic label; never echo the URL (it holds the password)
  }

  return {
    dialect: 'postgres',
    persistent: true,
    label: host,
    ...ops,
    exec: (sql) => pool.query(sql).then(() => undefined),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(bind(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
