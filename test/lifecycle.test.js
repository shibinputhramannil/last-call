import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { createLogger, silentLogger } from '../server/logger.js';
import { createSigner } from '../server/signing.js';
import { createStore } from '../server/store.js';

const baseConfig = {
  trustProxy: false,
  allowedOrigins: [],
  roomIdleMs: 30 * 60_000,
  roomMaxMs: 4 * 3_600_000,
};

async function start(config = baseConfig, options = {}) {
  const app = createApp(config, { log: silentLogger, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

const post = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the public health check says only whether the server is up', async () => {
  const { app, base } = await start();
  try {
    const res = await fetch(base + '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { status: 'ok' }, 'no player counts or uptime for the public');

    const head = await fetch(base + '/healthz', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await app.close();
  }
});

test('graceful shutdown drains, tells players it is restarting, and closes everything', async () => {
  const { app, base } = await start();
  const host = await (await post(base, '/api/rooms', { role: 'caller', mode: 'timed' })).json();
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ t: 'hello', code: host.code, token: host.token }));
  await new Promise((resolve) => {
    const check = () => (messages.some((m) => m.t === 'welcome') ? resolve() : setTimeout(check, 10));
    check();
  });
  assert.equal(app.rooms.stats().players, 1);

  const closed = new Promise((resolve) => ws.once('close', resolve));
  const done = app.shutdown({ flushMs: 300 });

  // While draining: the load balancer is told to stop sending traffic, and no new rooms open.
  const health = await fetch(base + '/healthz', { headers: { connection: 'close' } });
  assert.equal(health.status, 503);
  assert.equal((await health.json()).status, 'draining');
  const create = await post(base, '/api/rooms', { role: 'caller', mode: 'timed' });
  assert.equal(create.status, 503);
  assert.match((await create.json()).message, /restarting/);

  await closed;
  const notice = messages.find((m) => m.t === 'closed');
  assert.equal(notice.code, 'RESTARTING', 'not terminal: browsers keep reconnecting');
  assert.match(notice.message, /restarting/);
  await done;
  assert.equal(app.server.listening, false);
  assert.equal(app.isDraining(), true);
});

/** Joins a fresh room over WebSocket and resolves once welcomed. */
async function joinRoom(base) {
  const host = await (await post(base, '/api/rooms', { role: 'caller', mode: 'untimed' })).json();
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ t: 'hello', code: host.code, token: host.token }));
  await new Promise((resolve) => ws.on('message', (d) => JSON.parse(d.toString()).t === 'welcome' && resolve()));
  return ws;
}

test('connections that go silent are dropped even if WebSocket pings are answered for them', async () => {
  // Some proxies answer protocol pings on the client's behalf, so silence is what counts.
  const { app, base } = await start(baseConfig, { heartbeatMs: 40, silenceLimitMs: 200 });
  try {
    const silent = await joinRoom(base);
    const chatty = await joinRoom(base);
    const pinger = setInterval(() => chatty.send(JSON.stringify({ t: 'ping' })), 50);
    const started = Date.now();
    await new Promise((resolve) => silent.once('close', resolve));
    assert.ok(Date.now() - started < 1_000, 'silent socket closed promptly');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(chatty.readyState, WebSocket.OPEN, 'a client that keeps pinging stays connected');
    clearInterval(pinger);
    assert.equal(app.rooms.stats().players, 1);
    chatty.close();
  } finally {
    await app.close();
  }
});

test('rate limits use the configured client-IP header behind a trusted proxy', async () => {
  const { app, base } = await start({ ...baseConfig, trustProxy: true, clientIpHeader: 'cf-connecting-ip' });
  const create = (ip) =>
    fetch(base + '/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, 'x-forwarded-for': `${ip}, 10.0.0.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ role: 'caller', mode: 'timed' }),
    });
  try {
    // A rotating proxy address in X-Forwarded-For must not reset the limit.
    for (let i = 0; i < 8; i++) assert.equal((await create('203.0.113.5')).status, 201);
    assert.equal((await create('203.0.113.5')).status, 429);
    assert.equal((await create('203.0.113.6')).status, 201, 'a different player is not affected');
  } finally {
    await app.close();
  }
});

test('HSTS is only sent for HTTPS requests behind a trusted proxy', async () => {
  const { app, base } = await start({ ...baseConfig, trustProxy: true });
  try {
    const plain = await fetch(base + '/');
    assert.equal(plain.headers.get('strict-transport-security'), null);
    const secure = await fetch(base + '/', { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(secure.headers.get('strict-transport-security'), /max-age=/);
  } finally {
    await app.close();
  }
});

test('the logger writes one readable line per event and respects the level', () => {
  const lines = [];
  const sink = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const log = createLogger('info', sink);
  log.debug('hidden');
  log.info('room opened', { room: 'ABCDEF', mode: 'timed' });
  log.error('request failed', { err: new Error('boom') });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT.* INFO {2}room opened room=ABCDEF mode=timed$/);
  assert.match(lines[1], /ERROR request failed err=".*boom/);
});

/** Opens a socket, says hello, and resolves once welcomed or turned away. */
async function hello(base, code, token, extra = {}) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ t: 'hello', code, token, ...extra }));
  await new Promise((resolve) => {
    const check = () => (messages.some((m) => m.t === 'welcome' || m.t === 'closed') ? resolve() : setTimeout(check, 10));
    check();
  });
  return { ws, messages, welcome: messages.find((m) => m.t === 'welcome'), closed: messages.find((m) => m.t === 'closed') };
}

test('with DATA_DIR, rooms, chat and stage progress survive a full server restart', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'lastcall-'));
  const signer = createSigner('lifecycle-secret-0123456789abcdef');
  try {
    const first = await start({ ...baseConfig, dataDir }, { store: createStore({ dataDir }), signer });
    const host = await (await post(first.base, '/api/rooms', { name: 'Ada', role: 'caller', mode: 'untimed' })).json();
    const guest = await (await post(first.base, `/api/rooms/${host.code}/join`, { name: 'Grace' })).json();
    const a = await hello(first.base, host.code, host.token);
    const b = await hello(first.base, host.code, guest.token);
    a.ws.send(JSON.stringify({ t: 'chat', clientId: 'keep-me', text: 'Still there?' }));
    a.ws.send(JSON.stringify({ t: 'play', stageId: '1-1' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const puzzle = first.app.rooms.rooms.get(host.code).game.viewFor('operator', Date.now()).puzzle;
    await first.app.shutdown({ flushMs: 50 });

    const second = await start({ ...baseConfig, dataDir }, { store: createStore({ dataDir }), signer });
    try {
      const a2 = await hello(second.base, host.code, host.token);
      const b2 = await hello(second.base, host.code, guest.token);
      assert.ok(a2.welcome, a2.closed?.message);
      assert.equal(b2.welcome.state.game.phase, 'playing');
      assert.equal(b2.welcome.state.game.puzzle.id, puzzle.id);
      assert.deepEqual(b2.welcome.state.game.puzzle.view, puzzle.view);
      assert.ok(b2.welcome.chat.some((m) => m.clientId === 'keep-me'));
      a2.ws.close();
      b2.ws.close();
    } finally {
      await second.app.close();
    }
    a.ws.close();
    b.ws.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('without DATA_DIR, a restarted server rebuilds the room from the players’ signed tickets', async () => {
  const signer = createSigner('ticket-secret-0123456789abcdefgh');
  const first = await start(baseConfig, { signer });
  const host = await (await post(first.base, '/api/rooms', { role: 'caller', mode: 'timed' })).json();
  const guest = await (await post(first.base, `/api/rooms/${host.code}/join`, {})).json();
  const a = await hello(first.base, host.code, host.token);
  const b = await hello(first.base, host.code, guest.token);
  const ticketA = a.welcome.state.ticket;
  const ticketB = b.welcome.state.ticket;
  const save = a.welcome.progress;
  await first.app.shutdown({ flushMs: 50 });

  const second = await start(baseConfig, { signer });
  try {
    const a2 = await hello(second.base, host.code, host.token, { ticket: ticketA, progress: save });
    const b2 = await hello(second.base, host.code, guest.token, { ticket: ticketB });
    assert.ok(a2.welcome, a2.closed?.message);
    assert.ok(b2.welcome, b2.closed?.message);
    assert.equal(b2.welcome.state.you.role, 'operator');
    assert.ok(b2.welcome.state.players.every((p) => p.present));
    const lost = await hello(second.base, 'ZZZZZZ', host.token, { ticket: ticketA });
    assert.equal(lost.closed.code, 'ROOM_NOT_FOUND');
    a2.ws.close();
    b2.ws.close();
    lost.ws.close();
  } finally {
    await second.app.close();
  }
});
