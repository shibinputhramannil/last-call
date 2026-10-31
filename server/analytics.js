import { createHmac, randomUUID } from 'node:crypto';
import { silentLogger } from './logger.js';

// Anonymous gameplay history for the admin dashboard.
//
// Privacy: events never contain chat, names, room codes (which are invite
// tokens), seat tokens or puzzle answers. A player's browser session and a
// room appear only as keyed hashes (HMAC with a server secret), so stored
// keys cannot be matched back to a browser or turned into a room code.
//
// Idempotency: every event has an id, deterministic where the event is
// naturally unique ("run X won"), and is inserted with ON CONFLICT DO NOTHING,
// so a retried write or a repeated event is stored once.

export const EVENT_KINDS = Object.freeze([
  'room.opened',
  'room.rebuilt',
  'room.closed',
  'session.joined',
  'session.reconnected',
  'session.dropped',
  'session.drop_long',
  'session.ended',
  'stage.started',
  'stage.won',
  'stage.lost',
  'stage.abandoned',
  'puzzle.shown',
  'puzzle.solved',
  'answer.wrong',
  'hint.read',
]);
const KINDS = new Set(EVENT_KINDS);

export const DAY_MS = 86_400_000;
/** A run with no outcome this long after it started (e.g. lost to a server restart) counts as abandoned. */
export const STALE_RUN_MS = 6 * 3_600_000;
/** A reconnect within this long counts as a quick recovery (the same grace the partner sees). */
export const QUICK_RECONNECT_MS = 8_000;
const MAX_QUEUE = 20_000;

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const startOfDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

const text = (v, max = 64) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const ratio = (a, b) => (b > 0 ? a / b : null);

export function createAnalytics({
  db,
  secret,
  now = () => Date.now(),
  log = silentLogger,
  retentionDays = 90,
  rollupDays = 730,
}) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('analytics needs a secret of at least 16 characters');
  const key = (purpose, value) => createHmac('sha256', secret).update(`${purpose}\0${value}`).digest('base64url').slice(0, 16);
  const queue = new Map();
  let flushing = null;
  let warnedFull = false;
  let todayPeak = { day: null, players: 0, rooms: 0 };

  function record(event) {
    if (!KINDS.has(event.kind)) throw new Error(`unknown analytics event ${event.kind}`);
    const at = int(event.at) ?? now();
    const row = {
      id: text(event.id, 120) || randomUUID(),
      kind: event.kind,
      at,
      day: dayOf(at),
      session_key: text(event.session, 32),
      room_key: text(event.room, 32),
      run_key: text(event.run, 32),
      stage: text(event.stage, 8),
      puzzle: text(event.puzzle, 24),
      level: int(event.level),
      role: event.role === 'caller' || event.role === 'operator' ? event.role : null,
      value: int(event.value),
    };
    if (queue.size >= MAX_QUEUE) {
      if (!warnedFull) log.warn('analytics queue full; dropping the oldest events until the database answers');
      warnedFull = true;
      queue.delete(queue.keys().next().value);
    }
    if (!queue.has(row.id)) queue.set(row.id, row);
  }

  async function writeRows(rows) {
    await db.transaction(async (tx) => {
      for (const r of rows) {
        await tx.run(
          `INSERT INTO events (id, kind, at, day, session_key, room_key, run_key, stage, puzzle, level, role, value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          [r.id, r.kind, r.at, r.day, r.session_key, r.room_key, r.run_key, r.stage, r.puzzle, r.level, r.role, r.value],
        );
      }
    });
  }

  /** Writes queued events. On failure they stay queued and are retried on the next flush. */
  async function flush() {
    if (flushing) return flushing;
    if (queue.size === 0) return;
    const rows = [...queue.values()];
    queue.clear();
    flushing = writeRows(rows)
      .then(() => {
        warnedFull = false;
      })
      .catch((err) => {
        log.warn('could not store analytics events; will retry', { err: err.message, events: rows.length });
        for (const r of rows.reverse()) if (!queue.has(r.id) && queue.size < MAX_QUEUE) queue.set(r.id, r);
      })
      .finally(() => {
        flushing = null;
      });
    return flushing;
  }

  /** Records the day's highest concurrent player count (written only when it rises). */
  async function notePeak(players, rooms) {
    const t = now();
    const day = dayOf(t);
    if (todayPeak.day !== day) todayPeak = { day, players: 0, rooms: 0 };
    if (players <= todayPeak.players && rooms <= todayPeak.rooms) return;
    todayPeak = { day, players: Math.max(players, todayPeak.players), rooms: Math.max(rooms, todayPeak.rooms) };
    try {
      await db.run(
        `INSERT INTO daily_peaks (day, players, rooms, at) VALUES (?, ?, ?, ?)
         ON CONFLICT (day) DO UPDATE SET
           players = CASE WHEN excluded.players > daily_peaks.players THEN excluded.players ELSE daily_peaks.players END,
           rooms = CASE WHEN excluded.rooms > daily_peaks.rooms THEN excluded.rooms ELSE daily_peaks.rooms END,
           at = excluded.at`,
        [day, todayPeak.players, todayPeak.rooms, t],
      );
    } catch (err) {
      log.warn('could not store the daily peak', { err: err.message });
    }
  }

  // ---- Reading ---------------------------------------------------------------

  async function range(from, to) {
    const t = now();
    const counts = Object.fromEntries(
      (await db.all('SELECT kind, COUNT(*) AS n, COALESCE(SUM(value), 0) AS total FROM events WHERE at >= ? AND at < ? GROUP BY kind', [from, to])).map((r) => [
        r.kind,
        { n: Number(r.n), total: Number(r.total) },
      ]),
    );
    const c = (kind) => counts[kind]?.n ?? 0;
    const total = (kind) => counts[kind]?.total ?? 0;
    const unique = await db.get('SELECT COUNT(DISTINCT session_key) AS n FROM events WHERE at >= ? AND at < ? AND session_key IS NOT NULL', [from, to]);
    const quick = await db.get("SELECT COUNT(*) AS n FROM events WHERE kind = 'session.reconnected' AND at >= ? AND at < ? AND value <= ?", [
      from,
      to,
      QUICK_RECONNECT_MS,
    ]);
    const unfinished = (cond) =>
      db.get(
        `SELECT COUNT(*) AS n FROM events s WHERE s.kind = 'stage.started' AND s.at >= ? AND s.at < ? AND ${cond}
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_key = s.run_key AND e.kind IN ('stage.won', 'stage.lost', 'stage.abandoned'))`,
        [from, to, t - STALE_RUN_MS],
      );
    const stale = Number((await unfinished('s.at < ?')).n);
    const open = Number((await unfinished('s.at >= ?')).n);
    const peak = await db.get('SELECT COALESCE(MAX(players), 0) AS players, COALESCE(MAX(rooms), 0) AS rooms FROM daily_peaks WHERE day >= ? AND day <= ?', [
      dayOf(from),
      dayOf(to - 1),
    ]);
    const puzzleRows = await db.all(
      'SELECT puzzle, kind, COUNT(*) AS n, COALESCE(SUM(value), 0) AS total FROM events WHERE at >= ? AND at < ? AND puzzle IS NOT NULL GROUP BY puzzle, kind',
      [from, to],
    );
    const puzzles = new Map();
    for (const r of puzzleRows) {
      const p = puzzles.get(r.puzzle) || { type: r.puzzle, shown: 0, solved: 0, wrong: 0, hints: 0, attempts: 0 };
      const n = Number(r.n);
      if (r.kind === 'puzzle.shown') p.shown += n;
      if (r.kind === 'puzzle.solved') {
        p.solved += n;
        p.attempts += Number(r.total);
      }
      if (r.kind === 'answer.wrong') p.wrong += n;
      if (r.kind === 'hint.read') p.hints += n;
      puzzles.set(r.puzzle, p);
    }

    const won = c('stage.won');
    const lost = c('stage.lost');
    const abandoned = c('stage.abandoned') + stale;
    const drops = c('session.dropped');
    return {
      from,
      to,
      games: {
        started: c('stage.started'),
        completed: won + lost,
        won,
        lost,
        abandoned,
        inProgress: open,
        completionRate: ratio(won, won + lost + abandoned),
      },
      sessions: {
        unique: Number(unique.n),
        joined: c('session.joined'),
        ended: c('session.ended'),
        avgDurationMs: c('session.ended') ? Math.round(total('session.ended') / c('session.ended')) : null,
      },
      connection: {
        drops,
        longDrops: c('session.drop_long'),
        reconnects: c('session.reconnected'),
        quickReconnects: Number(quick.n),
        dropsPerSession: ratio(drops, c('session.joined')),
        quickRecoveryRate: ratio(Number(quick.n), drops),
      },
      peak: { players: Number(peak.players), rooms: Number(peak.rooms) },
      puzzles: [...puzzles.values()]
        .map((p) => ({
          ...p,
          completionRate: ratio(p.solved, p.shown),
          avgAttempts: p.solved ? p.attempts / p.solved : null,
          hintsPerPuzzle: ratio(p.hints, p.shown),
          wrongPerPuzzle: ratio(p.wrong, p.shown),
        }))
        .sort((a, b) => a.type.localeCompare(b.type)),
    };
  }

  async function daily(days = 30) {
    const t = now();
    const first = startOfDay(t) - (days - 1) * DAY_MS;
    const rows = await db.all(
      `SELECT day, kind, COUNT(*) AS n FROM events WHERE at >= ? AND kind IN ('stage.started', 'stage.won', 'stage.lost', 'stage.abandoned') GROUP BY day, kind`,
      [first],
    );
    const sess = await db.all('SELECT day, COUNT(DISTINCT session_key) AS n FROM events WHERE at >= ? AND session_key IS NOT NULL GROUP BY day', [first]);
    const out = Array.from({ length: days }, (_, i) => ({ day: dayOf(first + i * DAY_MS), started: 0, won: 0, lost: 0, abandoned: 0, sessions: 0 }));
    const byDay = new Map(out.map((d) => [d.day, d]));
    for (const r of rows) {
      const d = byDay.get(r.day);
      if (d) d[r.kind.slice(6)] = Number(r.n);
    }
    for (const r of sess) if (byDay.has(r.day)) byDay.get(r.day).sessions = Number(r.n);
    return out;
  }

  /** Older history from the daily rollups, per month. */
  async function history() {
    const rows = await db.all(
      `SELECT substr(day, 1, 7) AS month, kind, SUM(events) AS n FROM daily_rollups
       WHERE kind IN ('stage.started', 'stage.won', 'stage.lost', 'stage.abandoned', 'session.joined') GROUP BY substr(day, 1, 7), kind ORDER BY month`,
    );
    const months = new Map();
    for (const r of rows) {
      const m = months.get(r.month) || { month: r.month, started: 0, won: 0, lost: 0, abandoned: 0, sessionsJoined: 0 };
      const key = r.kind === 'session.joined' ? 'sessionsJoined' : r.kind.slice(6);
      m[key] = Number(r.n);
      months.set(r.month, m);
    }
    return [...months.values()];
  }

  async function metrics() {
    const t = now();
    const to = t + 1;
    return {
      generatedAt: t,
      timezone: 'UTC',
      ranges: {
        today: await range(startOfDay(t), to),
        week: await range(t - 7 * DAY_MS, to),
        month: await range(t - 30 * DAY_MS, to),
      },
      daily: await daily(30),
      history: await history(),
    };
  }

  /** The most recently seen anonymous browser sessions. */
  async function activity({ limit = 25, days = 30 } = {}) {
    const rows = await db.all(
      `SELECT session_key, MIN(at) AS first_seen, MAX(at) AS last_seen, COUNT(*) AS events FROM events
       WHERE session_key IS NOT NULL AND at >= ? GROUP BY session_key ORDER BY last_seen DESC LIMIT ?`,
      [now() - days * DAY_MS, Math.min(100, limit)],
    );
    const out = [];
    for (const r of rows) {
      const last = await db.get('SELECT kind, role, stage FROM events WHERE session_key = ? ORDER BY at DESC LIMIT 1', [r.session_key]);
      const stages = await db.get("SELECT COUNT(*) AS n FROM events WHERE kind = 'session.joined' AND session_key = ?", [r.session_key]);
      out.push({
        id: r.session_key,
        firstSeen: Number(r.first_seen),
        lastSeen: Number(r.last_seen),
        events: Number(r.events),
        rooms: Number(stages.n),
        lastEvent: last?.kind ?? null,
        role: last?.role ?? null,
        stage: last?.stage ?? null,
      });
    }
    return out;
  }

  /** Rolls up events older than the retention period into daily totals, then deletes them. */
  async function maintain() {
    const t = now();
    const cutoff = dayOf(t - retentionDays * DAY_MS);
    const rollupCutoff = dayOf(t - rollupDays * DAY_MS);
    return db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO daily_rollups (day, kind, puzzle, events, value_sum, sessions)
         SELECT day, kind, puzzle_key, n, total, sess FROM (
           SELECT day, kind, COALESCE(puzzle, '') AS puzzle_key, COUNT(*) AS n, COALESCE(SUM(value), 0) AS total, COUNT(DISTINCT session_key) AS sess
           FROM events WHERE day < ? GROUP BY day, kind, COALESCE(puzzle, '')
         ) AS grouped WHERE true
         ON CONFLICT (day, kind, puzzle) DO UPDATE SET
           events = daily_rollups.events + excluded.events,
           value_sum = daily_rollups.value_sum + excluded.value_sum,
           sessions = daily_rollups.sessions + excluded.sessions`,
        [cutoff],
      );
      const removed = await tx.run('DELETE FROM events WHERE day < ?', [cutoff]);
      await tx.run('DELETE FROM daily_rollups WHERE day < ?', [rollupCutoff]);
      await tx.run('DELETE FROM daily_peaks WHERE day < ?', [rollupCutoff]);
      return { rolledUp: removed.changes };
    });
  }

  return {
    retentionDays,
    rollupDays,
    sessionKey: (browserSession) => (browserSession ? key('session', browserSession) : null),
    roomKey: (code, seed) => key('room', `${code}:${seed}`),
    record,
    flush,
    notePeak,
    metrics,
    range,
    activity,
    maintain,
    pending: () => queue.size,
  };
}
