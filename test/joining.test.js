// The browser side of joining a room (public/js/net.js requests and
// public/js/store.js), run in Node with a fake fetch and fake storage. These pin
// down why an invite could leave a player stuck: requests that never timed out,
// retries that could take a second seat, and blocked site data that stopped the
// game from starting at all.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** A Storage-like object; `failWrites` imitates a full or read-only store. */
function fakeStorage() {
  const data = new Map();
  return {
    data,
    failWrites: false,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem(k, v) {
      if (this.failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k),
  };
}

// Site data is either available (fake storage) or blocked, where merely
// reading window.localStorage throws, as in browsers set to block cookies.
const site = { blocked: false, local: fakeStorage(), session: fakeStorage() };
const denied = (name) => new DOMException(`Failed to read the '${name}' property from 'Window': Access is denied for this document.`, 'SecurityError');
for (const [name, key] of [
  ['localStorage', 'local'],
  ['sessionStorage', 'session'],
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      if (site.blocked) throw denied(name);
      return site[key];
    },
  });
}

const store = await import('../public/js/store.js');
const { api, isTransient, request, retrying } = await import('../public/js/net.js');

beforeEach(() => {
  site.blocked = false;
  site.local = fakeStorage();
  site.session = fakeStorage();
});

// ---- Storage ----------------------------------------------------------------------

test('blocked site data never stops the game: everything still works for the life of the page', () => {
  site.blocked = true;
  assert.doesNotThrow(() => store.loadPrefs());
  assert.equal(store.loadPrefs().audio.muted, false);
  assert.equal(store.getSeat('ABCDEF'), null);
  store.saveSeat('ABCDEF', 'seat-token-1', 'operator');
  assert.equal(store.getSeat('ABCDEF').token, 'seat-token-1', 'kept in memory, so reconnecting still works');
  store.saveTicket('ABCDEF', 'ticket-1');
  assert.equal(store.getSeat('ABCDEF').ticket, 'ticket-1');
  store.forgetSeat('ABCDEF');
  assert.equal(store.getSeat('ABCDEF'), null);
  const sid = store.browserSessionId();
  assert.match(sid, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(store.browserSessionId(), sid);
  assert.doesNotThrow(() => store.savePending('ABCDEF', [{ clientId: 'c1', text: 'hi', ts: 1 }]));
  assert.equal(store.loadPending('ABCDEF').length, 1);
});

test('a store that refuses writes (full) still returns what was just saved', () => {
  site.local.failWrites = true;
  store.saveSeat('KQMXRT', 'seat-token-2', 'caller');
  assert.equal(store.getSeat('KQMXRT').token, 'seat-token-2');
});

test('the opening story plays on a fresh visit, and not on a reload, reconnection or return to the room', () => {
  // A new tab: a fresh visit.
  assert.equal(store.startVisit(), true);
  // A reload or reconnection keeps the tab's session storage, so it is the same visit.
  assert.equal(store.startVisit(), false);
  assert.equal(store.startVisit(), false);
  // Closing the tab (session storage gone) and coming back is a fresh visit again,
  // whatever an older build left in local storage.
  site.session = fakeStorage();
  site.local.setItem('lastcall:opening-seen', 'true');
  assert.equal(store.startVisit(), true);
  assert.equal(site.local.getItem('lastcall:opening-seen'), null, 'the old "seen it" flag is cleared');
  // With site data blocked, it still counts once per page.
  site.blocked = true;
  assert.equal(store.startVisit(), true);
  assert.equal(store.startVisit(), false);
});

test('a join attempt keeps one id, across reloads of the tab, until its seat is saved', () => {
  const id = store.joinAttemptId('ABCDEF');
  assert.match(id, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(store.joinAttemptId('ABCDEF'), id, 'every retry sends the same id');
  assert.equal(JSON.parse(site.session.getItem('lastcall:join:ABCDEF')), id, 'kept in this tab’s session, so a reload keeps it');
  assert.equal(site.local.getItem('lastcall:join:ABCDEF'), null, 'never shared with other tabs');
  assert.notEqual(store.joinAttemptId('KQMXRT'), id, 'each room has its own');
  store.saveSeat('ABCDEF', 'seat-token-3', 'operator');
  assert.notEqual(store.joinAttemptId('ABCDEF'), id, 'a later join is a new attempt');
});

// ---- Requests ---------------------------------------------------------------------

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Replaces fetch with a script of answers; records every call. */
function scriptFetch(answers) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(options) : next;
  };
  return calls;
}

test('a request that hangs gives up with a clear message that can be retried', async () => {
  const calls = scriptFetch([
    ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
  ]);
  const res = await request('/api/rooms/ABCDEF', { timeoutMs: 30 });
  assert.equal(calls.length, 1);
  assert.equal(res.error, 'TIMEOUT');
  assert.match(res.message, /waking up/);
  assert.ok(isTransient(res));
});

test('passing failures are retried; a definite answer from the server is not', async () => {
  const offline = { ok: false, status: 0, error: 'UNREACHABLE' };
  assert.ok(isTransient(offline));
  for (const status of [502, 503, 504]) assert.ok(isTransient({ ok: false, status }));
  for (const status of [400, 404, 409, 410, 429, 500]) assert.ok(!isTransient({ ok: false, status }), String(status));
  assert.ok(!isTransient({ ok: true, status: 200 }));

  // A proxy's HTML error page while the server restarts reads as "unavailable", not a crash.
  scriptFetch([new Response('<html>502 Bad Gateway</html>', { status: 502 })]);
  const proxied = await api.lookup('ABCDEF');
  assert.equal(proxied.error, 'UNAVAILABLE');
  assert.ok(isTransient(proxied));
});

test('a join retried through a network error and a restart carries the same join id every time', async () => {
  const calls = scriptFetch([
    new TypeError('Failed to fetch'),
    new Response('<html>Service Unavailable</html>', { status: 503 }),
    json(200, { code: 'ABCDEF', token: 'seat-token', role: 'operator' }),
  ]);
  const retries = [];
  const body = { name: 'Grace', progress: null, joinId: 'join-attempt-0123456789' };
  const res = await retrying(() => api.join('ABCDEF', body), { wait: async () => {}, onRetry: (r) => retries.push(r.delayMs) });
  assert.equal(res.ok, true);
  assert.equal(res.data.token, 'seat-token');
  assert.equal(calls.length, 3);
  assert.deepEqual(new Set(calls.map((c) => c.body.joinId)), new Set(['join-attempt-0123456789']));
  assert.ok(calls.every((c) => c.options.method === 'POST' && c.url === '/api/rooms/ABCDEF/join'));
  assert.deepEqual(retries, [1_000, 2_000], 'backs off between attempts');
});

test('a full, unknown, closed or rate-limited room is answered at once, without retrying', async () => {
  for (const [status, error] of [
    [409, 'FULL'],
    [404, 'NOT_FOUND'],
    [410, 'EXPIRED'],
    [429, 'RATE_LIMITED'],
  ]) {
    const calls = scriptFetch([json(status, { error, message: `${error} message` })]);
    const res = await retrying(() => api.join('ABCDEF', { joinId: 'join-attempt-0123456789' }), { wait: async () => {} });
    assert.equal(calls.length, 1, error);
    assert.equal(res.error, error);
    assert.equal(res.message, `${error} message`, 'the server’s explanation reaches the player');
  }
});

test('retrying gives up after its delays, and stops at once when cancelled', async () => {
  const calls = scriptFetch(Array.from({ length: 10 }, () => new TypeError('Failed to fetch')));
  const res = await retrying(() => api.lookup('ABCDEF'), { delays: [1, 1, 1], wait: async () => {} });
  assert.equal(calls.length, 4);
  assert.equal(res.ok, false);

  let cancelled = false;
  const more = scriptFetch(Array.from({ length: 10 }, () => new TypeError('Failed to fetch')));
  await retrying(() => api.lookup('ABCDEF'), {
    wait: async () => {
      cancelled = true;
    },
    cancelled: () => cancelled,
  });
  assert.equal(more.length, 1, 'no request after the player moved on');
});
