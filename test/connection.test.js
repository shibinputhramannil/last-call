// The browser's connection layer (public/js/net.js), run in Node with a fake
// WebSocket and mocked timers. These pin down the causes of the old repeated
// "connection lost" reports: duplicate sockets, close reasons leaking from one
// socket to the next, and false "dead line" verdicts after a page was asleep.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all = [];
  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    FakeSocket.all.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  receive(msg) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }));
  }
}

globalThis.WebSocket = FakeSocket;
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
globalThis.location = { protocol: 'http:', host: 'localhost:3000' };

const { Connection } = await import('../public/js/net.js');

let conn;
let states;
let mockTimers;

beforeEach((t) => {
  FakeSocket.all = [];
  mockTimers = t.mock.timers;
  mockTimers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  conn = new Connection({ code: 'ABCDEF', token: 'tok', hello: () => ({ ticket: 't1' }) });
  states = [];
  conn.addEventListener('status', (e) => states.push(e.detail));
});

afterEach(() => conn.stop());

const latest = () => FakeSocket.all[FakeSocket.all.length - 1];
/** Advances the clock a second at a time, as real time would (one big jump fires every timer at the end time). */
function advance(ms) {
  for (let t = 0; t < ms; t += 1_000) mockTimers.tick(Math.min(1_000, ms - t));
}
function welcome(ws = latest()) {
  ws.open();
  ws.receive({ t: 'welcome', state: {}, chat: [] });
}

test('says hello with the seat and the latest ticket, and opens on welcome', () => {
  conn.connect();
  latest().open();
  assert.deepEqual(latest().sent[0], { t: 'hello', code: 'ABCDEF', token: 'tok', ticket: 't1' });
  assert.equal(conn.state, 'connecting');
  latest().receive({ t: 'welcome' });
  assert.equal(conn.state, 'open');
});

test('never opens a second socket while one is connecting or saying hello', () => {
  conn.connect();
  conn.reconnectNow();
  globalThis.window.dispatchEvent(new Event('online'));
  globalThis.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(FakeSocket.all.length, 1);
  latest().open(); // open, hello sent, no welcome yet
  conn.reconnectNow();
  globalThis.window.dispatchEvent(new Event('online'));
  assert.equal(FakeSocket.all.length, 1);
});

test('a close reason from an old socket never leaks into the next one', () => {
  conn.connect();
  const first = latest();
  welcome(first);
  first.close(); // a blip
  assert.equal(conn.state, 'reconnecting');
  advance(1_000);
  const second = latest();
  assert.notEqual(second, first);
  welcome(second);
  // A late message on the dead socket is ignored, so it cannot poison the new one.
  first.receive({ t: 'closed', code: 'REPLACED', message: 'old' });
  second.close(); // another ordinary blip
  assert.equal(conn.state, 'reconnecting', 'still reconnecting, not stopped as "open in another tab"');
});

test('terminal reasons stop reconnecting; a restart keeps trying', () => {
  conn.connect();
  welcome();
  latest().receive({ t: 'closed', code: 'RESTARTING', message: 'restarting' });
  latest().close();
  assert.equal(conn.state, 'reconnecting');
  assert.equal(states[states.length - 1].restarting, true);
  advance(5_000);
  const next = latest();
  next.open();
  next.receive({ t: 'closed', code: 'ROOM_CLOSED', message: 'gone' });
  next.close();
  assert.equal(conn.state, 'closed');
  const count = FakeSocket.all.length;
  advance(60_000);
  assert.equal(FakeSocket.all.length, count, 'no more attempts after a terminal reason');
});

test('retries back off, first almost at once, then up to fifteen seconds', () => {
  conn.connect();
  const delays = [];
  for (let i = 0; i < 8; i++) {
    latest().close();
    delays.push(conn.retryAt - Date.now());
    mockTimers.tick(conn.retryAt - Date.now() + 1);
  }
  assert.ok(delays[0] <= 400, `first retry ${delays[0]} ms`);
  assert.ok(delays[3] > delays[1]);
  assert.ok(Math.max(...delays) <= 15_000 * 1.25);
});

test('a socket that stops answering pings is replaced; one that answers is kept', () => {
  conn.connect();
  welcome();
  const ws = latest();
  advance(15_000);
  const ping = ws.sent.find((m) => m.t === 'ping');
  assert.ok(ping, 'an app-level ping went out');
  ws.receive({ t: 'pong', id: ping.id });
  advance(15_000);
  assert.equal(conn.state, 'open');
  assert.equal(latest(), ws);

  // Now the line goes silent.
  advance(30_000);
  assert.notEqual(conn.state, 'open', 'a silent socket is abandoned');
  assert.equal(ws.readyState, FakeSocket.CLOSED);
});

test('after the page was asleep, the line is re-tested rather than judged dead', () => {
  conn.connect();
  welcome();
  const ws = latest();
  conn.sendPing();
  // Simulate a frozen tab: no ticks for a minute, then one tick.
  conn.lastTick = Date.now() - 60_000;
  conn.probe.sentAt = Date.now() - 60_000;
  conn.onTick();
  assert.equal(conn.state, 'open', 'not dropped on waking');
  assert.equal(ws.sent.filter((m) => m.t === 'ping').length, 2, 'a fresh probe was sent');
  ws.receive({ t: 'pong', id: conn.probe.id });
  assert.equal(conn.probe, null);
});
