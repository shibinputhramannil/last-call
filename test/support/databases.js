// Databases for the tests: SQLite in memory always, and PostgreSQL when
// TEST_DATABASE_URL points at a disposable test database (CI provides one).
// Each test file passes its own schema name, because files run in parallel.
// That schema is wiped before use, so never point this at real data.

import { openDatabase } from '../../server/db.js';
import { migrate } from '../../server/migrations.js';

export const DIALECTS = ['sqlite', ...(process.env.TEST_DATABASE_URL ? ['postgres'] : [])];

export async function freshDatabase(dialect, { schema = 'analytics_tests' } = {}) {
  if (dialect === 'sqlite') {
    const db = await openDatabase({});
    await migrate(db);
    return db;
  }
  const setup = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await setup.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  await setup.close();
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = await openDatabase({ url: url.toString() });
  await migrate(db);
  return db;
}
