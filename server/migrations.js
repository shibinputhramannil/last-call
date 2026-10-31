// Database schema, applied in order and recorded in schema_migrations. Never
// edit a released migration: add a new one with the next version number.
// Statements must run on both SQLite and PostgreSQL (see server/db.js).

export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: 'gameplay events, daily peaks and rollups',
    up: [
      // One row per anonymous gameplay event. `id` makes repeated writes of
      // the same event harmless. Keys are HMACs: never room codes or tokens.
      `CREATE TABLE events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        at BIGINT NOT NULL,
        day TEXT NOT NULL,
        session_key TEXT,
        room_key TEXT,
        run_key TEXT,
        stage TEXT,
        puzzle TEXT,
        level INTEGER,
        role TEXT,
        value BIGINT
      )`,
      'CREATE INDEX events_kind_at ON events (kind, at)',
      'CREATE INDEX events_at ON events (at)',
      'CREATE INDEX events_session_at ON events (session_key, at)',
      'CREATE INDEX events_run ON events (run_key)',
      // The most players connected at once, per UTC day.
      `CREATE TABLE daily_peaks (
        day TEXT PRIMARY KEY,
        players INTEGER NOT NULL,
        rooms INTEGER NOT NULL,
        at BIGINT NOT NULL
      )`,
      // Events older than the retention period, summarised per day.
      `CREATE TABLE daily_rollups (
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        puzzle TEXT NOT NULL,
        events BIGINT NOT NULL,
        value_sum BIGINT NOT NULL,
        sessions BIGINT NOT NULL,
        PRIMARY KEY (day, kind, puzzle)
      )`,
    ],
  },
  {
    version: 2,
    name: 'admin sessions, audit log and admin state',
    up: [
      // Only a SHA-256 hash of each session cookie is stored. When a session
      // rotates its cookie, the previous hash stays valid for a few seconds
      // (prev_until) so requests already in flight don't fail.
      `CREATE TABLE admin_sessions (
        id_hash TEXT PRIMARY KEY,
        prev_hash TEXT,
        prev_until BIGINT,
        handle TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        csrf TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        rotated_at BIGINT NOT NULL,
        last_seen BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        revoked_at BIGINT,
        ip TEXT,
        user_agent TEXT
      )`,
      'CREATE INDEX admin_sessions_expires ON admin_sessions (expires_at)',
      'CREATE INDEX admin_sessions_prev ON admin_sessions (prev_hash)',
      `CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        at BIGINT NOT NULL,
        actor TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        ip TEXT,
        detail TEXT
      )`,
      'CREATE INDEX audit_log_at ON audit_log (at)',
      `CREATE TABLE admin_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ],
  },
]);

/** Applies pending migrations, each in its own transaction. Returns the versions applied. */
export async function migrate(db, { now = () => Date.now() } = {}) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)');
  const done = new Set((await db.all('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.transaction(async (tx) => {
      for (const sql of m.up) await tx.run(sql);
      await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, now()]);
    });
    applied.push(m.version);
  }
  return applied;
}
