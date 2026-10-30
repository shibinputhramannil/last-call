import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';

const config = {
  trustProxy: false,
  allowedOrigins: [],
  roomIdleMs: 30 * 60_000,
  roomMaxMs: 4 * 3_600_000,
};
let app;
let base;

before(async () => {
  app = createApp(config, { log: { error() {}, warn() {} } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.close());

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Minimal client that records every message it receives. */
function connect(code, token, origin) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', origin ? { origin } : {});
  const received = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    received.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'hello', code, token }));
      resolve();
    });
    ws.once('error', reject);
  });
  return {
    ws,
    received,
    opened,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor(match, timeout = 3_000) {
      const found = received.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timed out waiting for message')), timeout).unref();
      });
    },
    close: () => new Promise((resolve) => (ws.readyState === WebSocket.CLOSED ? resolve() : (ws.once('close', resolve), ws.close()))),
  };
}

test('serves the page with a strict content security policy', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const traversal = await fetch(base + '/..%2f..%2fpackage.json');
  assert.equal(traversal.status, 404);
});

test('invalid and unknown codes give clear errors', async () => {
  const bad = await fetch(base + '/api/rooms/OOPS');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).message, /6 characters/);
  const missing = await post('/api/rooms/ABCDEF/join', {});
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).message, /No room has that code/);
});

test('cross-site WebSocket connections are refused', async () => {
  const client = connect('ABCDEF', 'x', 'https://evil.example');
  await assert.rejects(client.opened);
});

test('two players can create, join, chat, play, and reconnect', async () => {
  const created = await post('/api/rooms', { name: 'Ada', role: 'caller', mode: 'timed' });
  assert.equal(created.status, 201);
  const host = await created.json();
  assert.match(host.code, /^[A-HJ-KMNP-Z2-9]{6}$/);

  const lookup = await (await fetch(`${base}/api/rooms/${host.code.slice(0, 3)}-${host.code.slice(3)}`)).json();
  assert.equal(lookup.status, 'open');
  assert.equal(lookup.role, 'operator');

  const joined = await post(`/api/rooms/${host.code}/join`, { name: 'Grace' });
  const guest = await joined.json();
  assert.equal(guest.role, 'operator');

  const caller = connect(host.code, host.token);
  const operator = connect(host.code, guest.token);
  await caller.waitFor((m) => m.t === 'welcome');
  await operator.waitFor((m) => m.t === 'welcome');

  operator.send({ t: 'chat', clientId: 'op-1', text: 'Describe the first plate.' });
  const heard = await caller.waitFor((m) => m.t === 'chat' && m.message.clientId === 'op-1');
  assert.equal(heard.message.role, 'operator');
  assert.equal(heard.message.name, 'Grace');

  caller.send({ t: 'start' });
  await caller.waitFor((m) => m.t === 'state' && m.state.game.status === 'playing');
  await operator.waitFor((m) => m.t === 'state' && m.state.game.status === 'playing');

  const room = app.rooms.rooms.get(host.code);
  const secret = room.game.round.state;

  operator.send({ t: 'answer', puzzleId: 'dead-line', answer: secret.answer });
  await operator.waitFor((m) => m.t === 'notice' && m.code === 'NOT_ALLOWED');

  caller.send({ t: 'answer', puzzleId: 'dead-line', answer: secret.answer });
  const solved = await operator.waitFor((m) => m.t === 'answer-result');
  assert.equal(solved.correct, true);
  await caller.waitFor((m) => m.t === 'state' && m.state.game.puzzle?.id === 'patch-bay');

  // Neither browser ever received the other role's private data or an answer.
  const callerJson = JSON.stringify(caller.received);
  const operatorJson = JSON.stringify(operator.received);
  assert.ok(!callerJson.includes('"directory"') && !callerJson.includes('"digit"'));
  assert.ok(!callerJson.includes('"grid"') && !callerJson.includes('"routes"'));
  assert.ok(!operatorJson.includes('"plates"') && !operatorJson.includes('"lines"'));
  assert.ok(!operatorJson.includes('"answer"') && !callerJson.includes('"answer":"'));

  // The operator drops: the clock pauses. They come back and see the history.
  await operator.close();
  await caller.waitFor((m) => m.t === 'state' && m.state.game.timer.running === false);
  const again = connect(host.code, guest.token);
  const welcome = await again.waitFor((m) => m.t === 'welcome');
  assert.equal(welcome.state.you.role, 'operator');
  assert.ok(welcome.chat.some((m) => m.clientId === 'op-1'));
  await caller.waitFor((m) => m.t === 'state' && m.state.game.timer.running === true);

  await caller.close();
  await again.close();
});

test('a bad seat token is turned away with an explanation', async () => {
  const host = await (await post('/api/rooms', { role: 'operator', mode: 'untimed' })).json();
  const intruder = connect(host.code, 'forged-token');
  const closed = await intruder.waitFor((m) => m.t === 'closed');
  assert.equal(closed.code, 'SEAT_LOST');
  await intruder.close();
});
