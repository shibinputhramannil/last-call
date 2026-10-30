import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, SEAT_RECLAIM_MS, cleanChat, cleanName } from '../server/rooms.js';

class FakeSocket {
  constructor() {
    this.sent = [];
    this.closed = null;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
  last(t) {
    return [...this.sent].reverse().find((m) => m.t === t);
  }
  all(t) {
    return this.sent.filter((m) => m.t === t);
  }
}

function setup() {
  let clock = 1_000_000;
  const manager = new RoomManager({ idleMs: 30 * 60_000, maxMs: 4 * 3_600_000, now: () => clock });
  const tick = (ms) => (clock += ms);
  const { room, seat: host } = manager.create({ name: 'Ada', role: 'caller', mode: 'timed' });
  const hostSocket = new FakeSocket();
  manager.attach(room.code, host.token, hostSocket);
  return { manager, room, host, hostSocket, tick };
}

function addGuest(ctx) {
  const { seat } = ctx.manager.join(ctx.room.code, { name: 'Grace' });
  const socket = new FakeSocket();
  ctx.manager.attach(ctx.room.code, seat.token, socket);
  return { guest: seat, guestSocket: socket };
}

test('names and chat are sanitised', () => {
  const rtlOverride = String.fromCodePoint(0x202e);
  assert.equal(cleanName(`  Ada${String.fromCodePoint(0)}   Lovelace${rtlOverride}  `), 'Ada Lovelace');
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName('x'.repeat(50)).length, 20);
  assert.equal(cleanChat(' hi\r\n\n\n\nthere\u0007 '), 'hi\n\nthere');
});

test('create, look up, join and fill a room', () => {
  const ctx = setup();
  assert.equal(ctx.manager.lookup(ctx.room.code).status, 'open');
  assert.equal(ctx.manager.lookup(ctx.room.code).role, 'operator');
  const { guest } = addGuest(ctx);
  assert.equal(guest.role, 'operator');
  assert.equal(ctx.manager.lookup(ctx.room.code).status, 'full');
  assert.equal(ctx.manager.join(ctx.room.code, {}).error, 'FULL');
  assert.equal(ctx.manager.join('ZZZZZZ', {}).error, 'NOT_FOUND');
});

test('welcome carries role-specific state and chat history', () => {
  const ctx = setup();
  const welcome = ctx.hostSocket.last('welcome');
  assert.equal(welcome.state.you.role, 'caller');
  assert.equal(welcome.state.room.code, ctx.room.code);
  assert.ok(Array.isArray(welcome.chat));
});

test('a wrong token cannot attach', () => {
  const ctx = setup();
  const result = ctx.manager.attach(ctx.room.code, 'not-the-token', new FakeSocket());
  assert.equal(result.error, 'SEAT_LOST');
});

test('a second tab replaces the first', () => {
  const ctx = setup();
  const second = new FakeSocket();
  ctx.manager.attach(ctx.room.code, ctx.host.token, second);
  assert.equal(ctx.hostSocket.last('closed').code, 'REPLACED');
  assert.equal(ctx.host.socket, second);
});

test('disconnects pause the game and reconnects resume it', () => {
  const ctx = setup();
  const { guest, guestSocket } = addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'start' });
  assert.equal(ctx.room.game.status, 'playing');
  ctx.manager.detach(ctx.room, guest, guestSocket);
  assert.equal(ctx.room.game.paused, true);
  const before = ctx.room.game.remaining(0);
  ctx.tick(60_000);
  assert.equal(ctx.room.game.elapsed(ctx.manager.now()), ctx.room.game.elapsedMs);
  ctx.manager.attach(ctx.room.code, guest.token, new FakeSocket());
  assert.equal(ctx.room.game.paused, false);
  assert.ok(ctx.room.game.remaining(ctx.manager.now()) <= before);
});

test('an abandoned seat can be reclaimed with the code after a grace period', () => {
  const ctx = setup();
  const { guest, guestSocket } = addGuest(ctx);
  ctx.manager.detach(ctx.room, guest, guestSocket);
  assert.equal(ctx.manager.join(ctx.room.code, {}).error, 'FULL', 'not yet');
  ctx.tick(SEAT_RECLAIM_MS + 1);
  const { seat } = ctx.manager.join(ctx.room.code, { name: 'New' });
  assert.equal(seat.role, 'operator');
  assert.equal(ctx.manager.attach(ctx.room.code, guest.token, new FakeSocket()).error, 'SEAT_LOST');
});

test('chat is delivered once even when retried, and empty or flooding messages fail clearly', () => {
  const ctx = setup();
  const { guestSocket } = addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'chat', clientId: 'm1', text: 'hello?' });
  ctx.manager.handle(ctx.room, ctx.host, { t: 'chat', clientId: 'm1', text: 'hello?' });
  const delivered = guestSocket.all('chat').filter((c) => c.message.kind === 'player');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message.role, 'caller');
  assert.equal(delivered[0].message.name, 'Ada');
  assert.equal(ctx.hostSocket.all('chat').filter((c) => c.message.clientId === 'm1').length, 2, 'retry is re-acknowledged');

  ctx.manager.handle(ctx.room, ctx.host, { t: 'chat', clientId: 'm2', text: '   ' });
  assert.equal(ctx.hostSocket.last('chat-error').retryable, false);

  for (let i = 0; i < 10; i++) ctx.manager.handle(ctx.room, ctx.host, { t: 'chat', clientId: `f${i}`, text: 'spam' });
  const flood = ctx.hostSocket.last('chat-error');
  assert.equal(flood.retryable, true);
  assert.ok(flood.retryInMs > 0);
});

test('roles can be swapped in the lobby only', () => {
  const ctx = setup();
  const { guest } = addGuest(ctx);
  ctx.manager.handle(ctx.room, guest, { t: 'swap' });
  assert.equal(ctx.host.role, 'operator');
  assert.equal(guest.role, 'caller');
  ctx.manager.handle(ctx.room, guest, { t: 'start' });
  ctx.manager.handle(ctx.room, guest, { t: 'swap' });
  assert.equal(guest.role, 'caller');
});

test('starting needs both players connected', () => {
  const ctx = setup();
  ctx.manager.handle(ctx.room, ctx.host, { t: 'start' });
  assert.equal(ctx.room.game.status, 'lobby');
  assert.equal(ctx.hostSocket.last('notice').code, 'WAITING');
});

test('stale answers for an earlier puzzle are ignored', () => {
  const ctx = setup();
  addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'start' });
  ctx.manager.handle(ctx.room, ctx.host, { t: 'answer', puzzleId: 'patch-bay', answer: {} });
  assert.equal(ctx.hostSocket.last('notice').code, 'STALE');
  assert.equal(ctx.room.game.round.attempts, 0);
});

test('idle rooms expire and leave a tombstone that explains why', () => {
  const ctx = setup();
  ctx.manager.detach(ctx.room, ctx.host, ctx.hostSocket);
  ctx.tick(31 * 60_000);
  ctx.manager.sweep();
  assert.equal(ctx.manager.rooms.size, 0);
  const lookup = ctx.manager.lookup(ctx.room.code);
  assert.equal(lookup.status, 'expired');
  assert.match(lookup.message, /30 minutes/);
  assert.equal(ctx.manager.join(ctx.room.code, {}).error, 'EXPIRED');
  assert.equal(ctx.manager.attach(ctx.room.code, ctx.host.token, new FakeSocket()).error, 'ROOM_CLOSED');
});

test('rooms close at their maximum age even when in use, telling connected players', () => {
  const ctx = setup();
  ctx.tick(4 * 3_600_000 + 1);
  ctx.manager.sweep();
  assert.equal(ctx.hostSocket.last('closed').code, 'ROOM_CLOSED');
  assert.equal(ctx.hostSocket.closed.code, 4000);
});

test('leaving frees the seat; the last player leaving closes the room', () => {
  const ctx = setup();
  const { guest } = addGuest(ctx);
  ctx.manager.handle(ctx.room, guest, { t: 'leave' });
  assert.equal(ctx.room.seats.operator, null);
  assert.equal(ctx.manager.lookup(ctx.room.code).status, 'open');
  ctx.manager.handle(ctx.room, ctx.host, { t: 'leave' });
  assert.equal(ctx.manager.lookup(ctx.room.code).status, 'expired');
});
