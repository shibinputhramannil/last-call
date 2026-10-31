import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, QUICK_RECONNECT_MS, STALE_RUN_MS, createAnalytics, dayOf, startOfDay } from '../server/analytics.js';
import { MIGRATIONS, migrate } from '../server/migrations.js';
import { DIALECTS, freshDatabase } from './support/databases.js';

// 2026-10-20 15:00 UTC
const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);
const MIDNIGHT = startOfDay(NOW);
const HOUR = 3_600_000;

function setup(db, extra = {}) {
  const clock = { t: NOW };
  const analytics = createAnalytics({ db, secret: 'analytics-test-secret-123456', now: () => clock.t, ...extra });
  return { analytics, clock };
}

for (const dialect of DIALECTS) {
  test(`[${dialect}] migrations apply once, in order`, async () => {
    const db = await freshDatabase(dialect);
    try {
      assert.deepEqual(await migrate(db), []);
      const rows = await db.all('SELECT version FROM schema_migrations ORDER BY version');
      assert.deepEqual(
        rows.map((r) => Number(r.version)),
        MIGRATIONS.map((m) => m.version),
      );
    } finally {
      await db.close();
    }
  });

  test(`[${dialect}] games, sessions and connections are counted per time range, at the boundaries`, async () => {
    const db = await freshDatabase(dialect);
    const { analytics } = setup(db);
    const ev = (kind, at, fields = {}) => analytics.record({ kind, at, ...fields });
    try {
      // Today (after 00:00 UTC): a full won run and a lost run.
      ev('stage.started', MIDNIGHT, { id: 'run:a:start', run: 'a', session: 's1' });
      ev('stage.won', MIDNIGHT + HOUR, { id: 'run:a:end', run: 'a', session: 's1' });
      ev('stage.started', NOW - HOUR, { id: 'run:b:start', run: 'b', session: 's2' });
      ev('stage.lost', NOW - 30 * 60_000, { id: 'run:b:end', run: 'b', session: 's2' });
      // One second before midnight: yesterday, inside the 7-day window.
      ev('stage.started', MIDNIGHT - 1_000, { id: 'run:c:start', run: 'c', session: 's3' });
      ev('stage.abandoned', MIDNIGHT - 500, { id: 'run:c:end', run: 'c', session: 's3' });
      // The rolling week is [now - 7 days, now]: 1 ms earlier is outside it, inside 30 days.
      ev('stage.started', NOW - 7 * DAY_MS - 1, { id: 'run:d:start', run: 'd', session: 's4' });
      ev('stage.won', NOW - 7 * DAY_MS + HOUR, { id: 'run:d:end', run: 'd', session: 's4' });
      // 31 days ago: outside every range.
      ev('stage.started', NOW - 31 * DAY_MS, { id: 'run:e:start', run: 'e', session: 's5' });
      // A run with no result that started 7 hours ago is abandoned; one that started 1 hour ago is in progress.
      ev('stage.started', NOW - STALE_RUN_MS - HOUR, { id: 'run:f:start', run: 'f', session: 's1' });
      ev('stage.started', NOW - HOUR, { id: 'run:g:start', run: 'g', session: 's1' });
      // Sessions and connections today.
      ev('session.joined', NOW - 2 * HOUR, { session: 's1' });
      ev('session.joined', NOW - 2 * HOUR, { session: 's2' });
      ev('session.dropped', NOW - HOUR, { session: 's1' });
      ev('session.dropped', NOW - HOUR, { session: 's2' });
      ev('session.reconnected', NOW - HOUR + 2_000, { session: 's1', value: 2_000 });
      ev('session.reconnected', NOW - 10 * 60_000, { session: 's2', value: QUICK_RECONNECT_MS + 1 });
      ev('session.drop_long', NOW - HOUR + 9_000, { session: 's2' });
      ev('session.ended', NOW - 5 * 60_000, { session: 's1', value: 20 * 60_000 });
      ev('session.ended', NOW - 4 * 60_000, { session: 's2', value: 10 * 60_000 });
      await analytics.flush();
      await analytics.notePeak(3, 2);

      const m = await analytics.metrics();
      const today = m.ranges.today.games;
      assert.equal(today.started, 4, 'a, b, f and g started today');
      assert.equal(m.ranges.today.from, MIDNIGHT);
      assert.equal(today.won, 1);
      assert.equal(today.lost, 1);
      assert.equal(today.abandoned, 1, 'f is stale');
      assert.equal(today.inProgress, 1, 'g');
      assert.equal(today.completed, 2);
      assert.equal(today.completionRate, 1 / 3);

      const week = m.ranges.week.games;
      assert.equal(week.started, 5, 'a, b, c, f, g (d started just before the week)');
      assert.equal(week.won, 2, 'a, and d ended an hour after the boundary');
      assert.equal(week.abandoned, 2, 'c, and f is stale');
      const month = m.ranges.month.games;
      assert.equal(month.started, 6, 'everything but e');

      const s = m.ranges.today.sessions;
      assert.equal(s.unique, 2);
      assert.equal(s.joined, 2);
      assert.equal(s.ended, 2);
      assert.equal(s.avgDurationMs, 15 * 60_000);
      assert.equal(m.ranges.week.sessions.unique, 4, 's1 to s4 (d’s win is inside the week)');
      assert.equal(m.ranges.month.sessions.unique, 4, 's5 is too old');

      const c = m.ranges.today.connection;
      assert.equal(c.drops, 2);
      assert.equal(c.longDrops, 1);
      assert.equal(c.reconnects, 2);
      assert.equal(c.quickReconnects, 1);
      assert.equal(c.dropsPerSession, 1);
      assert.equal(c.quickRecoveryRate, 0.5);
      assert.equal(m.ranges.today.peak.players, 3);

      const todayRow = m.daily[m.daily.length - 1];
      assert.equal(todayRow.day, dayOf(NOW));
      assert.equal(todayRow.started, 4, 'a, b, f and g started on today’s UTC date');
      assert.equal(m.daily.length, 30);
      assert.equal(m.daily[m.daily.length - 2].started, 1, 'c');
    } finally {
      await db.close();
    }
  });

  test(`[${dialect}] an event written twice, or retried after a failure, is stored once`, async () => {
    const db = await freshDatabase(dialect);
    let failNext = true;
    // A database that fails the first transaction, as a dropped connection would.
    const flaky = {
      ...db,
      async transaction(fn) {
        if (failNext) {
          failNext = false;
          throw new Error('connection reset');
        }
        return db.transaction(fn);
      },
    };
    const { analytics } = setup(flaky);
    try {
      const won = { kind: 'stage.won', at: NOW, id: 'run:x:end', run: 'x' };
      analytics.record(won);
      analytics.record(won);
      assert.equal(analytics.pending(), 1, 'duplicates collapse in the queue');
      await analytics.flush();
      assert.equal(analytics.pending(), 1, 'kept after the failed write');
      await analytics.flush();
      assert.equal(analytics.pending(), 0);
      analytics.record(won); // the same event again later
      await analytics.flush();
      const n = await db.get("SELECT COUNT(*) AS n FROM events WHERE id = 'run:x:end'");
      assert.equal(Number(n.n), 1);
      assert.equal((await analytics.metrics()).ranges.today.games.won, 1);
    } finally {
      await db.close();
    }
  });

  test(`[${dialect}] puzzle completion, wrong answers and hints per machine`, async () => {
    const db = await freshDatabase(dialect);
    const { analytics } = setup(db);
    try {
      for (let i = 0; i < 4; i++) analytics.record({ kind: 'puzzle.shown', at: NOW - i, id: `p${i}:shown`, puzzle: 'dead-line', level: 2 });
      analytics.record({ kind: 'puzzle.solved', at: NOW, id: 'p0:solved', puzzle: 'dead-line', value: 1 });
      analytics.record({ kind: 'puzzle.solved', at: NOW, id: 'p1:solved', puzzle: 'dead-line', value: 3 });
      analytics.record({ kind: 'answer.wrong', at: NOW, id: 'p1:wrong:1', puzzle: 'dead-line' });
      analytics.record({ kind: 'answer.wrong', at: NOW, id: 'p1:wrong:2', puzzle: 'dead-line' });
      analytics.record({ kind: 'hint.read', at: NOW, id: 'p1:hint:caller:1', puzzle: 'dead-line', role: 'caller' });
      analytics.record({ kind: 'puzzle.shown', at: NOW, id: 'q0:shown', puzzle: 'cipher-wheel' });
      await analytics.flush();
      const [cipher, dead] = (await analytics.metrics()).ranges.today.puzzles;
      assert.equal(cipher.type, 'cipher-wheel');
      assert.equal(cipher.completionRate, 0);
      assert.equal(dead.shown, 4);
      assert.equal(dead.solved, 2);
      assert.equal(dead.completionRate, 0.5);
      assert.equal(dead.avgAttempts, 2);
      assert.equal(dead.wrongPerPuzzle, 0.5);
      assert.equal(dead.hintsPerPuzzle, 0.25);
    } finally {
      await db.close();
    }
  });

  test(`[${dialect}] old events roll up into daily totals, then expire`, async () => {
    const db = await freshDatabase(dialect);
    const { analytics, clock } = setup(db, { retentionDays: 40, rollupDays: 400 });
    try {
      const old = NOW - 50 * DAY_MS;
      analytics.record({ kind: 'stage.started', at: old, run: 'o1', session: 'a' });
      analytics.record({ kind: 'stage.started', at: old + 1_000, run: 'o2', session: 'b' });
      analytics.record({ kind: 'stage.won', at: old + 2_000, run: 'o1', session: 'a' });
      analytics.record({ kind: 'session.joined', at: old, session: 'a' });
      analytics.record({ kind: 'stage.started', at: NOW - DAY_MS, run: 'recent' });
      await analytics.flush();
      const { rolledUp } = await analytics.maintain();
      assert.equal(rolledUp, 4);
      assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM events')).n), 1, 'only the recent event is left');
      const started = await db.get("SELECT events, sessions FROM daily_rollups WHERE kind = 'stage.started'");
      assert.equal(Number(started.events), 2);
      assert.equal(Number(started.sessions), 2);
      const history = (await analytics.metrics()).history;
      assert.deepEqual(history, [{ month: dayOf(old).slice(0, 7), started: 2, won: 1, lost: 0, abandoned: 0, sessionsJoined: 1 }]);
      // Running again changes nothing; much later, the totals expire too.
      await analytics.maintain();
      assert.equal(Number((await db.get('SELECT SUM(events) AS n FROM daily_rollups')).n), 4);
      clock.t = NOW + 400 * DAY_MS;
      await analytics.maintain();
      assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM daily_rollups')).n), 0);
    } finally {
      await db.close();
    }
  });
}

test('events are checked: unknown kinds are refused and fields are trimmed', async () => {
  const db = await freshDatabase('sqlite');
  const { analytics } = setup(db);
  try {
    assert.throws(() => analytics.record({ kind: 'chat.sent' }), /unknown analytics event/);
    analytics.record({ kind: 'hint.read', at: NOW, role: 'wizard', stage: 'x'.repeat(50), level: 2.6 });
    await analytics.flush();
    const row = await db.get('SELECT * FROM events');
    assert.equal(row.role, null);
    assert.equal(row.stage.length, 8);
    assert.equal(Number(row.level), 3);
    assert.notEqual(analytics.sessionKey('abc'), 'abc');
    assert.equal(analytics.sessionKey('abc'), analytics.sessionKey('abc'));
    assert.notEqual(analytics.roomKey('ABCDEF', 'seed'), analytics.roomKey('ABCDEF', 'other'));
    assert.ok(!analytics.roomKey('ABCDEF', 'seed').includes('ABCDEF'));
  } finally {
    await db.close();
  }
});
