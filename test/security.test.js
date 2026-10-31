import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { silentLogger } from '../server/logger.js';
import { validateMessage, validateRoomBody } from '../server/validate.js';

const config = { trustProxy: false, allowedOrigins: [], roomIdleMs: 30 * 60_000, roomMaxMs: 4 * 3_600_000 };
let app;
let base;

before(async () => {
  app = createApp(config, { log: silentLogger });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const post = (path, body, headers = {}, at = base) =>
  fetch(at + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** A separate server, for tests that use up per-address limits. */
async function fresh() {
  const own = createApp(config, { log: silentLogger });
  await new Promise((resolve) => own.server.listen(0, '127.0.0.1', resolve));
  return { own, at: `http://127.0.0.1:${own.server.address().port}` };
}

/** Opens a socket, sends hello, and resolves with the first welcome or closed message. */
function hello(fields, at = base) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(at.replace('http', 'ws') + '/ws');
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', ...fields })));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'welcome' || m.t === 'closed') {
        resolve({ ws, msg: m });
      }
    });
    ws.on('error', reject);
  });
}

test('WebSocket messages are reduced to known fields with checked types and sizes', () => {
  assert.deepEqual(validateMessage({ t: 'chat', clientId: 'abc-1', text: 'hi', extra: 'dropped' }), { t: 'chat', clientId: 'abc-1', text: 'hi' });
  assert.deepEqual(validateMessage({ t: 'answer', puzzleId: 'run.1', answer: '1234' }), { t: 'answer', puzzleId: 'run.1', answer: '1234' });
  assert.ok(validateMessage({ t: 'answer', puzzleId: 'run.1', answer: { 3: 'A', 7: 'B' } }));
  assert.ok(validateMessage({ t: 'answer', puzzleId: 'run.1', answer: ['Carver', 'Ellis'] }));
  assert.ok(validateMessage({ t: 'hello', code: 'ABCDEF', token: 'abcdefghijklmnopqrstuv', sid: 'abcdefghijklmnopqrstuv' }));
  const bad = [
    null,
    [],
    'chat',
    { t: 'nope' },
    { t: '__proto__' },
    { t: 'constructor' },
    { t: 'toString' },
    { t: 'chat', clientId: '<script>', text: 'x' },
    { t: 'chat', clientId: 'a', text: 'x'.repeat(2_001) },
    { t: 'chat', clientId: 'a', text: { toString: 'x' } },
    { t: 'answer', puzzleId: 'p', answer: 'x'.repeat(65) },
    { t: 'answer', puzzleId: 'p', answer: Array.from({ length: 13 }, () => 'A') },
    { t: 'answer', puzzleId: 'p', answer: { 1: 'ABC' } },
    { t: 'answer', puzzleId: 'p', answer: 42 },
    { t: 'answer', puzzleId: 'p' },
    { t: 'mode', mode: 'godmode' },
    { t: 'play', stageId: 1 },
    { t: 'ping', id: 1.5 },
    { t: 'hello', code: 'ABCDEF', token: 'x' },
    { t: 'hello', code: 'ABCDEF', token: 'abcdefghijklmnop', ticket: 'not a token' },
    { t: 'hello', code: 'ABCDEF', token: 'abcdefghijklmnop', sid: 'short' },
  ];
  for (const m of bad) assert.equal(validateMessage(m), null, JSON.stringify(m));
  assert.deepEqual(validateRoomBody({ name: 42, role: ['caller'], progress: 'x' }), { name: null, role: null, mode: null, progress: null });
});

test('malformed or unknown messages from a seated player get a refusal, not a crash', async () => {
  const host = await (await post('/api/rooms', { role: 'caller', mode: 'untimed' })).json();
  const { ws, msg } = await hello({ code: host.code, token: host.token });
  assert.equal(msg.t, 'welcome');
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(d)));
  ws.send(JSON.stringify({ t: 'answer', puzzleId: 'x', answer: { nested: { deep: true } } }));
  ws.send('not json');
  ws.send(JSON.stringify({ t: 'chat', clientId: 'ok-1', text: 'still works' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(got.some((m) => m.t === 'notice' && m.code === 'BAD_REQUEST'));
  assert.ok(got.some((m) => m.t === 'chat' && m.message.text === 'still works'));
  ws.close();
});

test('oversized WebSocket messages close the connection', async () => {
  const host = await (await post('/api/rooms', { role: 'caller', mode: 'untimed' })).json();
  const { ws } = await hello({ code: host.code, token: host.token });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.send(JSON.stringify({ t: 'chat', clientId: 'big', text: 'x'.repeat(20_000) }));
  assert.equal(await closed, 1009);
});

test('repeated failed seat attempts from one address are refused for a while', async () => {
  const { own, at } = await fresh();
  try {
    const host = await (await post('/api/rooms', { role: 'caller', mode: 'untimed' }, {}, at)).json();
    for (let i = 0; i < 20; i++) {
      const { ws, msg } = await hello({ code: host.code, token: `wrong-token-${String(i).padStart(4, '0')}` }, at);
      assert.equal(msg.code, 'SEAT_LOST');
      ws.close();
    }
    const { ws, msg } = await hello({ code: host.code, token: host.token }, at);
    assert.equal(msg.code, 'RATE_LIMITED', 'even the right token waits once the limit is reached');
    ws.close();
  } finally {
    await own.close();
  }
});

test('without TRUST_PROXY, forwarded-IP headers are ignored', async () => {
  const { own, at } = await fresh();
  try {
    const spoof = (ip) => post('/api/rooms', { role: 'caller', mode: 'timed' }, { 'x-forwarded-for': ip, 'cf-connecting-ip': ip }, at);
    // The limit is per real address: claiming a different address each time does not reset it.
    const statuses = [];
    for (let i = 0; i < 9; i++) statuses.push((await spoof(`198.51.100.${i}`)).status);
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 201, 201, 201, 429]);
  } finally {
    await own.close();
  }
});

test('responses carry security headers, ask not to be indexed, and never leak internals', async () => {
  const page = await fetch(`${base}/`);
  for (const [h, expected] of [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'no-referrer'],
    ['x-robots-tag', 'noindex'],
    ['cross-origin-opener-policy', 'same-origin'],
  ]) {
    assert.equal(page.headers.get(h), expected, h);
  }
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
  assert.equal((await fetch(`${base}/js/main.js`)).headers.get('x-robots-tag'), 'noindex');

  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /User-agent: \*\s+Allow: \//, 'crawlers may enter, so they can read the noindex tag');
  assert.ok(!/Disallow: \//.test(robots));

  const bad = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"broken' });
  assert.equal(bad.status, 400);
  const text = await bad.text();
  assert.ok(!/at |\.js:|stack|SyntaxError/.test(text), 'no stack traces or parser errors');
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  assert.equal((await fetch(`${base}/server/app.js`)).status, 404, 'server code is never served');
  assert.equal((await fetch(`${base}/admin/assets/dashboard.js`)).status, 404, 'no admin without a database and account');
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/js/main.js.map`)).status, 404, 'no source maps');
});
