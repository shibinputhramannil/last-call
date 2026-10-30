import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { createLogger, silentLogger } from '../server/logger.js';

const baseConfig = {
  trustProxy: false,
  allowedOrigins: [],
  roomIdleMs: 30 * 60_000,
  roomMaxMs: 4 * 3_600_000,
};

async function start(config = baseConfig) {
  const app = createApp(config, { log: silentLogger });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

const post = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('health check reports status, rooms and connected players', async () => {
  const { app, base } = await start();
  try {
    const res = await fetch(base + '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.rooms, 0);
    assert.equal(body.players, 0);
    assert.equal(typeof body.uptimeSeconds, 'number');

    const head = await fetch(base + '/healthz', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await app.close();
  }
});

test('graceful shutdown drains, tells players why, and closes everything', async () => {
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
  assert.equal((await (await fetch(base + '/healthz')).json()).players, 1);

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
  assert.equal(notice.code, 'ROOM_CLOSED');
  assert.match(notice.message, /restarting/);
  await done;
  assert.equal(app.server.listening, false);
  assert.equal(app.isDraining(), true);
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
