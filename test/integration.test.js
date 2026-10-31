import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { silentLogger } from '../server/logger.js';
import { PUZZLES } from '../server/puzzles/index.js';

const answerFor = (room) => PUZZLES[room.game.round.type].solution(room.game.round.state);

const config = {
  trustProxy: false,
  allowedOrigins: [],
  roomIdleMs: 30 * 60_000,
  roomMaxMs: 4 * 3_600_000,
};
let app;
let base;

before(async () => {
  app = createApp(config, { log: silentLogger });
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

test('the page carries absolute share-preview tags in its first response, for the game and for invites', async () => {
  const page = await (await fetch(base + '/')).text();
  const meta = (html, prop) => html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`))?.[1];
  assert.equal(meta(page, 'og:title'), 'Last Call: a two-player telephone mystery');
  assert.match(meta(page, 'og:description'), /trapped|manual/i);
  assert.match(meta(page, 'og:image'), /^http:\/\/127\.0\.0\.1:\d+\/og\/last-call-poster-v1\.jpg$/);
  assert.equal(meta(page, 'og:image:width'), '1200');
  assert.equal(meta(page, 'og:image:height'), '630');
  assert.ok(meta(page, 'og:image:alt').length > 20);
  assert.equal(meta(page, 'og:url'), `${base}/`);
  assert.equal(meta(page, 'twitter:card'), 'summary_large_image');
  assert.ok(!page.includes('{{'), 'every placeholder is filled');
  const poster = await fetch(meta(page, 'og:image'));
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('content-type'), 'image/jpeg');
  assert.ok(Number(poster.headers.get('content-length')) < 300_000, 'small enough for WhatsApp');

  const invite = await (await fetch(base + '/?room=k7q-m3x')).text();
  assert.equal(meta(invite, 'og:url'), `${base}/?room=K7QM3X`);
  assert.match(meta(invite, 'og:title'), /K7Q-M3X/);
  assert.equal(meta(invite, 'og:image'), meta(page, 'og:image'), 'invites share the game poster');
  const junk = await (await fetch(base + '/?room=%22%3E%3Cscript%3E')).text();
  assert.ok(!junk.includes('"><script>'), 'query strings are never echoed raw');
  assert.equal(meta(junk, 'og:url'), `${base}/`);
});

test('an invite shows a loading screen in the first response, before any script runs', async () => {
  const page = await (await fetch(base + '/?room=k7q-m3x')).text();
  const connect = page.match(/<section id="screen-connect"[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(connect, 'the loading screen is in the page');
  assert.ok(!/<section id="screen-connect"[^>]*\bhidden\b/.test(page), 'and visible from the first paint');
  assert.match(connect[1], /Room K7Q-M3X/);
  assert.match(connect[1], /href=""[^>]*>Reload the page/, 'a way out even if no script ever runs');
  for (const id of ['screen-story', 'shell']) assert.match(page, new RegExp(`id="${id}"[^>]*\\bhidden\\b`), `${id} starts hidden`);
  assert.match(await (await fetch(base + '/')).text(), /<h1 id="connect-title"[^>]*>Opening the line</);

  // Nothing from another host can hold up the first paint.
  assert.match(page, /<link\s+id="font-css"\s+rel="stylesheet"\s+media="print"/);
  // boot.js runs before the modules, to report a load failure on that screen.
  assert.ok(page.indexOf('src="/js/boot.js" defer') > 0 && page.indexOf('src="/js/boot.js"') < page.indexOf('src="/js/main.js"'));
  const boot = await fetch(base + '/js/boot.js');
  assert.equal(boot.status, 200);
  assert.match(boot.headers.get('content-type'), /javascript/);
});

test('every module the game imports is preloaded, so the page never waits on an import waterfall', async () => {
  const page = await (await fetch(base + '/')).text();
  const preloaded = new Set([...page.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]));
  const graph = new Set();
  const visit = async (url) => {
    const source = await (await fetch(base + url)).text();
    for (const [, spec] of source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const dep = new URL(spec, base + url).pathname;
      if (graph.has(dep)) continue;
      graph.add(dep);
      await visit(dep);
    }
  };
  await visit('/js/main.js');
  assert.deepEqual([...preloaded].sort(), [...graph].sort());
});

test('a retried join gets the same seat back; another player still finds the room full', async () => {
  const created = await (await post('/api/rooms', { name: 'Ada', role: 'caller', mode: 'untimed' })).json();
  const joinId = 'integration-join-0123456789';
  const first = await post(`/api/rooms/${created.code}/join`, { name: 'Grace', joinId });
  const firstBody = await first.json();
  const again = await post(`/api/rooms/${created.code}/join`, { name: 'Grace', joinId });
  const againBody = await again.json();
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(againBody.token, firstBody.token);
  assert.equal(againBody.role, 'operator');
  assert.ok(!JSON.stringify(firstBody).includes(joinId), 'the join id is never sent back');
  assert.equal((await post(`/api/rooms/${created.code}/join`, { name: 'Eve', joinId: 'someone-else-0123456789' })).status, 409);
  assert.equal((await post(`/api/rooms/${created.code}/join`, { name: 'Eve' })).status, 409);

  // The seat works, and the host hears of exactly one new partner.
  const host = connect(created.code, created.token);
  await host.opened;
  await host.waitFor((m) => m.t === 'welcome');
  const guest = connect(created.code, firstBody.token);
  await guest.opened;
  assert.equal((await guest.waitFor((m) => m.t === 'welcome')).state.you.role, 'operator');
  await host.waitFor((m) => m.t === 'chat' && /Grace joined as the Operator/.test(m.message.text));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(host.received.filter((m) => m.t === 'chat' && /joined as the Operator/.test(m.message.text)).length, 1);
  await guest.close();
  await host.close();
});

test('two players can create, join, chat, play a whole stage, continue, and reconnect', async () => {
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
  const opWelcome = await operator.waitFor((m) => m.t === 'welcome');
  assert.equal(opWelcome.campaign.frontier, '1-1');

  operator.send({ t: 'chat', clientId: 'op-1', text: 'Describe the first plate.' });
  const heard = await caller.waitFor((m) => m.t === 'chat' && m.message.clientId === 'op-1');
  assert.equal(heard.message.role, 'operator');
  assert.equal(heard.message.name, 'Grace');
  const ack = await operator.waitFor((m) => m.t === 'chat' && m.message.clientId === 'op-1');
  assert.equal(ack.message.id, heard.message.id, 'the sender gets the same message back as its acknowledgement');

  caller.send({ t: 'ping', id: 7 });
  assert.equal((await caller.waitFor((m) => m.t === 'pong')).id, 7);

  caller.send({ t: 'play', stageId: '1-1' });
  await operator.waitFor((m) => m.t === 'state' && m.state.game.phase === 'playing');
  const room = app.rooms.rooms.get(host.code);

  const firstId = room.game.round.id;
  operator.send({ t: 'answer', puzzleId: firstId, answer: answerFor(room) });
  await operator.waitFor((m) => m.t === 'notice' && m.code === 'NOT_ALLOWED');

  caller.send({ t: 'answer', puzzleId: firstId, answer: answerFor(room) });
  const solved = await operator.waitFor((m) => m.t === 'answer-result');
  assert.equal(solved.correct, true);
  assert.equal(solved.stageComplete, false);
  await caller.waitFor((m) => m.t === 'state' && m.state.game.puzzleIndex === 1);

  // The operator drops mid-stage and comes back: same puzzle, same chat, same clock.
  const before = room.game.viewFor('operator', Date.now()).puzzle;
  await operator.close();
  await caller.waitFor((m) => m.t === 'state' && m.state.players.some((p) => p.connection === 'reconnecting'));
  const again = connect(host.code, guest.token);
  const welcome = await again.waitFor((m) => m.t === 'welcome');
  assert.equal(welcome.state.you.role, 'operator');
  assert.equal(welcome.state.game.puzzle.id, before.id);
  assert.deepEqual(welcome.state.game.puzzle.view, before.view);
  assert.ok(welcome.chat.some((m) => m.clientId === 'op-1'));
  assert.ok(!welcome.chat.some((m) => /lost the line/.test(m.text || '')), 'a short drop is not announced');

  // Finish the stage.
  for (let i = 1; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    caller.send({ t: 'answer', puzzleId: room.game.round.id, answer: answerFor(room) });
    await again.waitFor((m) => m.t === 'answer-result' && m.puzzleId.endsWith(`.${i + 1}`));
  }
  const done = await again.waitFor((m) => m.t === 'state' && m.state.game.phase === 'complete');
  assert.equal(done.state.game.result.stars, 3);
  const save = await caller.waitFor((m) => m.t === 'progress' && m.campaign.completed === 1);
  assert.equal(typeof save.token, 'string');

  // Neither browser ever received the other role's private data or an answer.
  const callerJson = JSON.stringify(caller.received);
  const operatorJson = JSON.stringify(again.received);
  assert.ok(!callerJson.includes('"blocks"') && !callerJson.includes('"directory"'));
  assert.ok(!operatorJson.includes('"plates"') && !operatorJson.includes('"lines"') && !operatorJson.includes('"columns"'));
  assert.ok(!callerJson.includes('"answer"') && !operatorJson.includes('"answer"'));

  again.send({ t: 'continue', from: done.state.game.result.runId });
  const next = await caller.waitFor((m) => m.t === 'state' && m.state.game.phase === 'playing' && m.state.game.stageId === '1-2');
  assert.equal(next.state.game.puzzleIndex, 0);

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
