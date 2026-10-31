import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createAnalytics } from '../server/analytics.js';
import { createApp } from '../server/app.js';
import { base32Decode, hashPassword, newTotpSecret, totpCode, TOTP_STEP_MS, verifyPassword, verifyTotp } from '../server/auth.js';
import { COOKIE, truncateIp } from '../server/admin.js';
import { silentLogger } from '../server/logger.js';
import { PUZZLES } from '../server/puzzles/index.js';
import { DIALECTS, freshDatabase } from './support/databases.js';

const PASSWORD = 'a-long-and-unguessable-test-password';
const USER = 'superadmin';
const SECRET = newTotpSecret();
const HASH = await hashPassword(PASSWORD, { N: 2 ** 14 });

const baseConfig = { trustProxy: false, allowedOrigins: [], roomIdleMs: 30 * 60_000, roomMaxMs: 4 * 3_600_000 };
const adminConfig = { username: USER, passwordHash: HASH, totpSecret: SECRET, mfa: 'required', sessionHours: 8, idleMinutes: 30 };

/** A server with a database, statistics and the admin dashboard, on a clock the test controls. */
async function start(dialect = 'sqlite', { admin = adminConfig } = {}) {
  const db = await freshDatabase(dialect, { schema: 'admin_tests' });
  const clock = { t: Date.now() };
  const analytics = createAnalytics({ db, secret: 'admin-test-analytics-secret', now: () => clock.t });
  const app = createApp({ ...baseConfig, admin }, { log: silentLogger, db, analytics, adminOptions: { now: () => clock.t, failDelayMs: 0 } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const stop = async () => {
    await app.close();
    await db.close();
  };
  return { app, db, analytics, clock, base, stop };
}

const code = (clock, offsetSteps = 0) => totpCode(base32Decode(SECRET), Math.floor(clock.t / TOTP_STEP_MS) + offsetSteps);

function login(ctx, { username = USER, password = PASSWORD, otp = code(ctx.clock), origin = ctx.base } = {}) {
  return fetch(`${ctx.base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ username, password, code: otp }),
  });
}

/** Signs in and returns the session cookie ("name=value") and the CSRF token. */
async function signIn(ctx) {
  ctx.clock.t += TOTP_STEP_MS; // each sign-in needs a fresh code
  const res = await login(ctx);
  assert.equal(res.status, 200, await res.clone().text());
  const cookie = res.headers.getSetCookie()[0].split(';')[0];
  const session = await (await get(ctx, '/admin/api/session', cookie)).json();
  return { cookie, csrf: session.csrf, setCookie: res.headers.getSetCookie()[0] };
}

const get = (ctx, path, cookie) => fetch(ctx.base + path, { headers: cookie ? { cookie } : {} });
const post = (ctx, path, { cookie, csrf, origin = ctx.base, body = {} } = {}) =>
  fetch(ctx.base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });

const ADMIN_APIS = ['/admin/api/session', '/admin/api/overview', '/admin/api/activity', '/admin/api/admin-sessions', '/admin/api/audit', '/admin/assets/dashboard.js'];

test('passwords are hashed with scrypt and checked in constant time; TOTP codes follow RFC 6238', async () => {
  assert.match(HASH, /^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
  assert.ok(!HASH.includes(PASSWORD));
  assert.equal(await verifyPassword(PASSWORD, HASH), true);
  assert.equal(await verifyPassword(`${PASSWORD}x`, HASH), false);
  assert.equal(await verifyPassword(PASSWORD, 'scrypt$2$1$1$x$y'), false, 'weak or malformed hashes are refused');
  await assert.rejects(hashPassword('short'));
  // RFC 6238 test vector (SHA-1, T = 59 s).
  const rfcKey = Buffer.from('12345678901234567890');
  assert.equal(totpCode(rfcKey, 1), '287082');
  const t = Date.UTC(2026, 0, 1);
  const now = totpCode(base32Decode(SECRET), Math.floor(t / TOTP_STEP_MS));
  assert.notEqual(verifyTotp(SECRET, now, t), null);
  assert.notEqual(verifyTotp(SECRET, now, t + TOTP_STEP_MS), null, 'one step of clock drift is allowed');
  assert.equal(verifyTotp(SECRET, now, t + 3 * TOTP_STEP_MS), null);
  assert.equal(verifyTotp(SECRET, 'abcdef', t), null);
  assert.equal(truncateIp('203.0.113.77'), '203.0.113.0/24');
  assert.equal(truncateIp('::ffff:198.51.100.9'), '198.51.100.0/24');
  assert.equal(truncateIp('2001:db8:abcd:12::1'), '2001:db8:abcd::/48');
});

test('without an admin account configured, /admin does not exist', async () => {
  const ctx = await start('sqlite', { admin: { username: null, passwordHash: null } });
  try {
    for (const p of ['/admin', '/admin/', '/admin/login', ...ADMIN_APIS]) assert.equal((await get(ctx, p)).status, 404, p);
    assert.equal((await login(ctx)).status, 404);
  } finally {
    await ctx.stop();
  }
  const noMfa = await start('sqlite', { admin: { ...adminConfig, totpSecret: null } });
  try {
    assert.equal((await get(noMfa, '/admin')).status, 404, 'MFA is required unless explicitly turned off');
  } finally {
    await noMfa.stop();
  }
});

for (const dialect of DIALECTS) {
  test(`[${dialect}] signed-out visitors get the sign-in page and nothing else`, async () => {
    const ctx = await start(dialect);
    try {
      const page = await get(ctx, '/admin');
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Sign in/);
      assert.ok(!html.includes('dashboard.js') && !html.includes('players connected'), 'no dashboard for signed-out visitors');
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
      for (const p of ADMIN_APIS) {
        const res = await get(ctx, p);
        assert.equal(res.status, 401, p);
        assert.ok(!(await res.text()).includes('players'), p);
      }
      for (const p of ['/admin/api/logout', '/admin/api/admin-sessions/revoke', '/admin/api/admin-sessions/revoke-others']) {
        assert.equal((await post(ctx, p)).status, 401, p);
      }
      assert.equal((await get(ctx, '/admin/../admin/api/overview')).status, 401);
      assert.equal((await get(ctx, '/admin/api/overview', `${COOKIE}=${'A'.repeat(43)}`)).status, 401, 'a made-up cookie is refused');
      assert.equal((await get(ctx, '/admin/secret-backdoor')).status, 404);
    } finally {
      await ctx.stop();
    }
  });

  test(`[${dialect}] sign-in needs the username, password and a fresh one-time code`, async () => {
    const ctx = await start(dialect);
    try {
      const generic = /Sign-in failed/;
      const wrongPassword = await login(ctx, { password: 'nope-nope-nope-nope' });
      assert.equal(wrongPassword.status, 401);
      assert.match((await wrongPassword.json()).message, generic);
      assert.equal((await login(ctx, { username: 'admin' })).status, 401, 'same answer for an unknown username');
      assert.equal((await login(ctx, { otp: '000000' })).status, 401);
      assert.equal((await login(ctx, { otp: code(ctx.clock, 5) })).status, 401, 'a code from the future');
      assert.equal((await login(ctx, { origin: 'https://evil.example' })).status, 403, 'cross-site sign-in is refused');

      ctx.clock.t += 15 * 60_000; // the per-IP limit refills
      const ok = await login(ctx);
      assert.equal(ok.status, 200);
      const setCookie = ok.headers.getSetCookie()[0];
      assert.match(setCookie, new RegExp(`^${COOKIE.replace('-', '\\-')}=[\\w-]{43}; `));
      for (const attr of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=28800']) assert.ok(setCookie.includes(attr), attr);
      assert.ok(!setCookie.includes('Domain='), '__Host- cookies never set a domain');
      assert.ok(!JSON.stringify(await ok.json()).includes(setCookie.split(';')[0].split('=')[1]), 'the session id is only in the cookie');

      assert.equal((await login(ctx)).status, 401, 'the same code cannot be used twice');

      const entries = await ctx.db.all('SELECT action, outcome, detail, ip FROM audit_log ORDER BY at');
      assert.ok(entries.some((e) => e.outcome === 'success'));
      assert.ok(entries.filter((e) => e.outcome === 'failed').length >= 4);
      const auditText = JSON.stringify(entries);
      assert.ok(!auditText.includes(PASSWORD) && !auditText.includes('nope-nope') && !auditText.includes(setCookie.split(';')[0].split('=')[1]));
      assert.ok(entries.every((e) => e.ip === null || e.ip.endsWith('/24') || e.ip.endsWith('/48')), 'only network prefixes are kept');
    } finally {
      await ctx.stop();
    }
  });

  test(`[${dialect}] repeated sign-in attempts are rate-limited`, async () => {
    const ctx = await start(dialect);
    try {
      for (let i = 0; i < 5; i++) assert.equal((await login(ctx, { password: 'wrong-wrong-wrong' })).status, 401);
      const blocked = await login(ctx);
      assert.equal(blocked.status, 429, 'even the right password is refused while limited');
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
      const audit = await ctx.db.all("SELECT outcome FROM audit_log WHERE outcome = 'rate_limited'");
      assert.equal(audit.length, 1);
    } finally {
      await ctx.stop();
    }
  });

  test(`[${dialect}] a signed-in admin can read the dashboard; changes need the CSRF token and this site's origin`, async () => {
    const ctx = await start(dialect);
    try {
      const { cookie, csrf } = await signIn(ctx);
      const page = await get(ctx, '/admin', cookie);
      assert.match(await page.text(), /dashboard\.js/);
      for (const p of ADMIN_APIS) assert.equal((await get(ctx, p, cookie)).status, 200, p);
      const overview = await (await get(ctx, '/admin/api/overview', cookie)).json();
      assert.equal(typeof overview.live.players, 'number');
      assert.equal(overview.storage.persistent, dialect === 'postgres');

      assert.equal((await post(ctx, '/admin/api/logout', { cookie })).status, 403, 'no CSRF token');
      assert.equal((await post(ctx, '/admin/api/logout', { cookie, csrf: 'x'.repeat(32) })).status, 403, 'wrong CSRF token');
      assert.equal((await post(ctx, '/admin/api/logout', { cookie, csrf, origin: 'https://evil.example' })).status, 403, 'other origin');
      assert.equal((await post(ctx, '/admin/api/logout', { cookie, csrf, origin: null })).status, 403, 'no origin at all');
      const out = await post(ctx, '/admin/api/logout', { cookie, csrf });
      assert.equal(out.status, 200);
      assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
      assert.equal((await get(ctx, '/admin/api/overview', cookie)).status, 401, 'signed out means signed out');
      const actions = (await ctx.db.all('SELECT action, outcome FROM audit_log')).map((e) => `${e.action}:${e.outcome}`);
      assert.ok(actions.includes('logout:success') && actions.includes('request:csrf_rejected'));
    } finally {
      await ctx.stop();
    }
  });

  test(`[${dialect}] sessions expire when idle and at the absolute limit`, async () => {
    const ctx = await start(dialect);
    try {
      const idle = await signIn(ctx);
      ctx.clock.t += 31 * 60_000;
      assert.equal((await get(ctx, '/admin/api/session', idle.cookie)).status, 401, 'idle for over 30 minutes');

      let { cookie } = await signIn(ctx);
      for (let i = 0; i < 24; i++) {
        ctx.clock.t += 20 * 60_000; // active every 20 minutes for 8 hours
        const res = await get(ctx, '/admin/api/session', cookie);
        if (i < 23) assert.equal(res.status, 200, `still valid after ${(i + 1) * 20} minutes`);
        else assert.equal(res.status, 401, 'past the 8-hour limit');
        const rotated = res.headers.getSetCookie()[0];
        if (rotated) cookie = rotated.split(';')[0];
      }
    } finally {
      await ctx.stop();
    }
  });

  test(`[${dialect}] session cookies rotate, and the old cookie stops working shortly after`, async () => {
    const ctx = await start(dialect);
    try {
      const { cookie } = await signIn(ctx);
      ctx.clock.t += 16 * 60_000;
      const res = await get(ctx, '/admin/api/session', cookie);
      assert.equal(res.status, 200);
      const fresh = res.headers.getSetCookie()[0];
      assert.ok(fresh, 'a new cookie after 15 minutes');
      const next = fresh.split(';')[0];
      assert.notEqual(next, cookie);
      assert.equal((await get(ctx, '/admin/api/session', cookie)).status, 200, 'requests already in flight still succeed');
      ctx.clock.t += 31_000;
      assert.equal((await get(ctx, '/admin/api/session', cookie)).status, 401, 'the old cookie expires');
      assert.equal((await get(ctx, '/admin/api/session', next)).status, 200);
    } finally {
      await ctx.stop();
    }
  });

  test(`[${dialect}] an admin can revoke other sessions, and revoked sessions fail`, async () => {
    const ctx = await start(dialect);
    try {
      const a = await signIn(ctx);
      const b = await signIn(ctx);
      const c = await signIn(ctx);
      const { sessions } = await (await get(ctx, '/admin/api/admin-sessions', a.cookie)).json();
      assert.equal(sessions.length, 3);
      assert.equal(sessions.filter((s) => s.current).length, 1);
      assert.ok(sessions.every((s) => /^[\w-]{12}$/.test(s.handle)));
      const bHandle = (await (await get(ctx, '/admin/api/admin-sessions', b.cookie)).json()).sessions.find((s) => s.current).handle;
      assert.equal((await post(ctx, '/admin/api/admin-sessions/revoke', { cookie: a.cookie, csrf: a.csrf, body: { handle: bHandle } })).status, 200);
      assert.equal((await get(ctx, '/admin/api/overview', b.cookie)).status, 401, 'revoked');
      assert.equal((await post(ctx, '/admin/api/admin-sessions/revoke-others', { cookie: a.cookie, csrf: a.csrf })).status, 200);
      assert.equal((await get(ctx, '/admin/api/overview', c.cookie)).status, 401);
      assert.equal((await get(ctx, '/admin/api/overview', a.cookie)).status, 200, 'the current session stays');
      assert.equal((await post(ctx, '/admin/api/admin-sessions/revoke', { cookie: a.cookie, csrf: a.csrf, body: { handle: '<script>' } })).status, 404);
    } finally {
      await ctx.stop();
    }
  });
}

test('players cannot reach admin data, and nothing private reaches admin or public endpoints', async () => {
  const ctx = await start('sqlite');
  const post_ = (path, body) => fetch(ctx.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // Two players play part of a stage, chat, and read a hint.
    const host = await (await post_('/api/rooms', { name: 'Ada Lovelace', role: 'caller', mode: 'untimed' })).json();
    const guest = await (await post_(`/api/rooms/${host.code}/join`, { name: 'Grace Hopper' })).json();
    const sockets = [];
    const open = (token, sid) =>
      new Promise((resolve) => {
        const ws = new WebSocket(ctx.base.replace('http', 'ws') + '/ws');
        const got = [];
        ws.on('message', (d) => got.push(JSON.parse(d)));
        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', code: host.code, token, sid })));
        sockets.push(ws);
        const wait = () => (got.some((m) => m.t === 'welcome') ? resolve({ ws, got }) : setTimeout(wait, 10));
        wait();
      });
    const caller = await open(host.token, 'browserSessionAAAAAAAA');
    const operator = await open(guest.token, 'browserSessionBBBBBBBB');
    operator.ws.send(JSON.stringify({ t: 'chat', clientId: 'c1', text: 'The secret plate is the trident' }));
    caller.ws.send(JSON.stringify({ t: 'play', stageId: '1-1' }));
    await new Promise((r) => setTimeout(r, 200));
    const room = ctx.app.rooms.rooms.get(host.code);
    const answer = PUZZLES[room.game.round.type].solution(room.game.round.state);
    operator.ws.send(JSON.stringify({ t: 'hint', puzzleId: room.game.round.id }));
    caller.ws.send(JSON.stringify({ t: 'answer', puzzleId: room.game.round.id, answer }));
    await new Promise((r) => setTimeout(r, 300));

    // A player's credentials never open the admin area.
    for (const cookie of [`${COOKIE}=${host.token}`, `${COOKIE}=${guest.token}`, `seat=${host.token}`]) {
      assert.equal((await get(ctx, '/admin/api/overview', cookie)).status, 401);
    }
    caller.ws.send(JSON.stringify({ t: 'admin', action: 'overview' }));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(caller.got.some((m) => m.t === 'notice' && m.code === 'BAD_REQUEST'), 'unknown WebSocket messages are refused');
    assert.ok(!JSON.stringify(caller.got).includes('peakSinceStart'));

    // The admin sees counts, never the private data.
    const { cookie } = await signIn(ctx);
    const overview = await (await get(ctx, '/admin/api/overview', cookie)).json();
    assert.equal(overview.live.players, 2);
    assert.equal(overview.metrics.ranges.today.games.started, 1);
    assert.equal(overview.metrics.ranges.today.sessions.unique, 2);
    const dl = overview.metrics.ranges.today.puzzles.find((p) => p.type === room.game.run.rounds[0].type);
    assert.equal(dl.solved, 1);
    assert.equal(dl.hints, 1);
    const activity = await (await get(ctx, '/admin/api/activity', cookie)).json();
    assert.equal(activity.sessions.length, 2);
    assert.ok(activity.sessions.every((s) => s.online));
    const audit = await (await get(ctx, '/admin/api/audit', cookie)).json();
    const stored = JSON.stringify(await ctx.db.all('SELECT * FROM events')) + JSON.stringify(await ctx.db.all('SELECT * FROM audit_log'));
    const seen = JSON.stringify([overview, activity, audit]) + stored;
    const secrets = [host.code, host.token, guest.token, 'Ada Lovelace', 'Grace Hopper', 'secret plate', 'browserSessionAAAAAAAA', JSON.stringify(answer)];
    for (const s of secrets) assert.ok(!seen.includes(s), `leaked: ${s}`);

    // Public endpoints stay minimal.
    const health = await (await fetch(`${ctx.base}/healthz`)).json();
    assert.deepEqual(health, { status: 'ok' });
    const page = await fetch(`${ctx.base}/`);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex');
    assert.equal(page.headers.get('set-cookie'), null, 'the game sets no cookies');
    const html = await page.text();
    assert.match(html, /<meta name="robots" content="noindex" \/>/);
    assert.match(html, /<meta property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/og\/last-call-poster-v1\.jpg" \/>/, 'previews still work');
    assert.ok(!html.includes('google-site-verification'), 'no empty verification tag');
    for (const ws of sockets) ws.close();
  } finally {
    await ctx.stop();
  }
});
