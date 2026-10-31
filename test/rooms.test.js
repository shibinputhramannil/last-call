import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES } from '../shared/campaign.js';
import { TRANSITION_MS, ANSWER_COOLDOWN_MS } from '../server/game.js';
import { PUZZLES } from '../server/puzzles/index.js';
import { RoomManager, JOIN_REPLAY_MS, PRESENCE_GRACE_MS, SEAT_RECLAIM_MS, cleanChat, cleanName } from '../server/rooms.js';
import { createSigner } from '../server/signing.js';

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
  systemTexts() {
    return this.all('chat')
      .filter((c) => c.message.kind === 'system')
      .map((c) => c.message.text);
  }
}

/** An in-memory store that behaves like the file store, for restart tests. */
function memoryDisk() {
  const files = new Map();
  return {
    persistent: true,
    files,
    loadAll: () => [...files.values()].map((json) => JSON.parse(json)),
    save: (code, data) => files.set(code, JSON.stringify(data)),
    remove: (code) => files.delete(code),
  };
}

const SIGNER = createSigner('room-test-secret-long-enough-1234');

function setup({ store = null, clockStart = 1_000_000, signer = SIGNER } = {}) {
  const clock = { t: clockStart };
  const manager = new RoomManager({ idleMs: 30 * 60_000, maxMs: 4 * 3_600_000, now: () => clock.t, signer, store });
  const tick = (ms) => (clock.t += ms);
  const { room, seat: host } = manager.create({ name: 'Ada', role: 'caller', mode: 'timed' });
  const hostSocket = new FakeSocket();
  manager.attach(room.code, host.token, hostSocket);
  return { manager, room, host, hostSocket, tick, clock };
}

function addGuest(ctx) {
  const { seat } = ctx.manager.join(ctx.room.code, { name: 'Grace' });
  const socket = new FakeSocket();
  ctx.manager.attach(ctx.room.code, seat.token, socket);
  return { guest: seat, guestSocket: socket };
}

const answerNow = (room) => PUZZLES[room.game.round.type].solution(room.game.round.state);

/** The caller solves the current stage's puzzles. */
function solveStage(ctx) {
  while (ctx.room.game.playing) {
    ctx.tick(TRANSITION_MS + ANSWER_COOLDOWN_MS + 5_000);
    ctx.manager.handle(ctx.room, ctx.room.seats.caller, { t: 'answer', puzzleId: ctx.room.game.round.id, answer: answerNow(ctx.room) });
  }
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

test('welcome carries role-specific state, chat history, campaign progress and a ticket', () => {
  const ctx = setup();
  const welcome = ctx.hostSocket.last('welcome');
  assert.equal(welcome.state.you.role, 'caller');
  assert.equal(welcome.state.room.code, ctx.room.code);
  assert.ok(Array.isArray(welcome.chat));
  assert.equal(welcome.campaign.frontier, STAGES[0].id);
  assert.equal(typeof welcome.progress, 'string');
  assert.equal(typeof welcome.state.ticket, 'string');
  assert.equal(welcome.state.game.phase, 'lobby');
});

test('a wrong token cannot attach', () => {
  const ctx = setup();
  assert.equal(ctx.manager.attach(ctx.room.code, 'not-the-token', new FakeSocket()).error, 'SEAT_LOST');
});

test('a second tab replaces the first', () => {
  const ctx = setup();
  const second = new FakeSocket();
  ctx.manager.attach(ctx.room.code, ctx.host.token, second);
  assert.equal(ctx.hostSocket.last('closed').code, 'REPLACED');
  assert.equal(ctx.host.socket, second);
});

test('a brief drop is quiet: the clock stops, the partner sees "reconnecting", and nothing is posted', () => {
  const ctx = setup();
  const { guest, guestSocket } = addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  const before = ctx.hostSocket.systemTexts().length;
  ctx.tick(10_000);
  ctx.manager.detach(ctx.room, guest, guestSocket);
  assert.equal(ctx.room.game.paused, true);
  const seen = ctx.hostSocket.last('state').state.players.find((p) => p.role === 'operator');
  assert.equal(seen.connection, 'reconnecting');
  ctx.tick(PRESENCE_GRACE_MS - 1_000);
  ctx.manager.sweep();
  ctx.manager.attach(ctx.room.code, guest.token, new FakeSocket());
  assert.equal(ctx.room.game.paused, false);
  assert.equal(ctx.hostSocket.systemTexts().length, before, 'no chat noise for a blip');
  assert.equal(ctx.room.game.activeMs(ctx.clock.t), 10_000, 'the drop cost no time');
});

test('a longer drop is announced once, then the return is announced', () => {
  const ctx = setup();
  const { guest, guestSocket } = addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  ctx.manager.detach(ctx.room, guest, guestSocket);
  ctx.tick(PRESENCE_GRACE_MS + 1);
  ctx.manager.sweep();
  ctx.manager.sweep();
  const texts = ctx.hostSocket.systemTexts();
  assert.equal(texts.filter((t) => /Grace lost the line/.test(t)).length, 1);
  assert.equal(texts.filter((t) => /clock is held/.test(t)).length, 1);
  assert.equal(ctx.hostSocket.last('state').state.players.find((p) => p.role === 'operator').connection, 'offline');
  ctx.manager.attach(ctx.room.code, guest.token, new FakeSocket());
  const after = ctx.hostSocket.systemTexts();
  assert.ok(after.some((t) => /Grace is back on the line/.test(t)));
  assert.ok(after.some((t) => /clock is running/.test(t)));
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

test('a retried join gets back the seat it was given, once; nobody else gets a second seat', () => {
  const ctx = setup();
  const joinId = 'join-attempt-0123456789';
  const first = ctx.manager.join(ctx.room.code, { name: 'Grace', joinId });
  const states = ctx.hostSocket.all('state').length;
  const texts = ctx.hostSocket.systemTexts().length;
  // The reply was lost, the browser timed out, or the page reloaded: the same join again.
  const again = ctx.manager.join(ctx.room.code, { name: 'Grace', joinId });
  assert.equal(again.seat, first.seat);
  assert.equal(again.seat.token, first.seat.token);
  assert.equal(again.replayed, true);
  assert.equal(ctx.hostSocket.all('state').length, states, 'a replay changes nothing the host can see');
  assert.equal(ctx.hostSocket.systemTexts().length, texts);
  assert.equal(ctx.manager.join(ctx.room.code, { name: 'Eve', joinId: 'someone-else-0123456789' }).error, 'FULL');
  assert.equal(ctx.manager.join(ctx.room.code, { name: 'Eve' }).error, 'FULL');
  assert.equal(ctx.room.seatList.length, 2);

  // Nothing in the room's saved state can be used to recover the id.
  assert.ok(!JSON.stringify(ctx.room.toJSON(ctx.clock.t)).includes(joinId));
  // The id only stands for that seat for a while; later it is an ordinary join.
  ctx.tick(JOIN_REPLAY_MS + 1);
  const late = ctx.manager.join(ctx.room.code, { joinId });
  assert.equal(late.replayed, undefined);
  assert.notEqual(late.seat.token, first.seat.token);
});

test('a join retried while the host is away gets its own seat back, never the host’s', () => {
  const ctx = setup();
  const joinId = 'join-attempt-0123456789';
  const { seat } = ctx.manager.join(ctx.room.code, { name: 'Grace', joinId });
  // The host's phone goes to the background; the joiner's first reply was lost.
  ctx.manager.detach(ctx.room, ctx.host, ctx.hostSocket);
  ctx.tick(SEAT_RECLAIM_MS + 5_000);
  const retry = ctx.manager.join(ctx.room.code, { name: 'Grace', joinId });
  assert.equal(retry.seat, seat);
  assert.equal(ctx.room.seats.caller, ctx.host, 'the host keeps their seat');
  assert.ok(ctx.manager.attach(ctx.room.code, ctx.host.token, new FakeSocket()).seat, 'and can come back to it');
});

test('an old join id cannot take back a seat that was handed to someone else', () => {
  const ctx = setup();
  const joinId = 'join-attempt-0123456789';
  const { seat } = ctx.manager.join(ctx.room.code, { name: 'Grace', joinId });
  ctx.tick(SEAT_RECLAIM_MS + 1);
  const taken = ctx.manager.join(ctx.room.code, { name: 'New', joinId: 'newcomer-0123456789ab' });
  assert.notEqual(taken.seat, seat);
  assert.equal(ctx.manager.join(ctx.room.code, { name: 'Grace', joinId }).error, 'FULL');
  assert.equal(ctx.room.seats.operator, taken.seat);
});

test('a reconnecting player returns to their own seat; a newcomer cannot take it meanwhile', () => {
  const ctx = setup();
  const { guest, guestSocket } = addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  const runId = ctx.room.game.run.id;
  ctx.manager.detach(ctx.room, guest, guestSocket);
  ctx.tick(SEAT_RECLAIM_MS - 1_000);
  assert.equal(ctx.manager.join(ctx.room.code, { name: 'Eve' }).error, 'FULL');
  const back = new FakeSocket();
  const again = ctx.manager.attach(ctx.room.code, guest.token, back);
  assert.equal(again.seat, guest);
  assert.equal(back.last('welcome').state.you.role, 'operator');
  assert.equal(back.last('welcome').state.game.runId, runId, 'the same stage carries on');
  assert.equal(ctx.room.seatList.length, 2);
});

test('a socket that lost its seat (another tab, or a reconnection) can no longer act for the player', () => {
  const ctx = setup();
  const { guest } = addGuest(ctx);
  const newer = new FakeSocket();
  ctx.manager.attach(ctx.room.code, ctx.host.token, newer);
  // Late messages from the replaced socket: none of them may act.
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id }, ctx.hostSocket);
  assert.equal(ctx.room.game.playing, false);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'leave' }, ctx.hostSocket);
  assert.equal(ctx.room.seats.caller, ctx.host, 'the seat stays with the live socket');
  assert.equal(ctx.host.socket, newer);
  // The live socket still works.
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id }, newer);
  assert.equal(ctx.room.game.playing, true);
  // After leaving, the old seat object can do nothing either.
  ctx.manager.handle(ctx.room, guest, { t: 'leave' }, guest.socket);
  const runId = ctx.room.game.run.id;
  ctx.manager.handle(ctx.room, guest, { t: 'map', from: runId }, null);
  assert.equal(ctx.room.game.playing, true);
});

test('pressing Play again, or both players pressing it, never restarts a stage in progress', () => {
  const ctx = setup();
  const { guest, guestSocket } = addGuest(ctx);
  const play = (seat) => ctx.manager.handle(ctx.room, seat, { t: 'play', stageId: STAGES[0].id });
  play(ctx.host);
  const runId = ctx.room.game.run.id;
  const round = ctx.room.game.round.id;
  ctx.tick(1_000);
  play(ctx.host);
  play(guest);
  play(ctx.host);
  assert.equal(ctx.room.game.run.id, runId);
  assert.equal(ctx.room.game.round.id, round);
  assert.equal(guestSocket.all('event').filter((e) => e.name === 'stage-started').length, 1);
  assert.equal(ctx.hostSocket.systemTexts().filter((t) => /opened Stage/.test(t)).length, 1);
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

test('roles can be swapped between stages only', () => {
  const ctx = setup();
  const { guest } = addGuest(ctx);
  ctx.manager.handle(ctx.room, guest, { t: 'swap' });
  assert.equal(ctx.host.role, 'operator');
  assert.equal(guest.role, 'caller');
  ctx.manager.handle(ctx.room, guest, { t: 'play', stageId: STAGES[0].id });
  ctx.manager.handle(ctx.room, guest, { t: 'swap' });
  assert.equal(guest.role, 'caller');
});

test('starting a stage needs both players, and an unlocked stage', () => {
  const ctx = setup();
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  assert.equal(ctx.room.game.phase, 'lobby');
  assert.equal(ctx.hostSocket.last('notice').code, 'WAITING');
  addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[5].id });
  assert.equal(ctx.hostSocket.last('notice').code, 'LOCKED');
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: 'no-such-stage' });
  assert.equal(ctx.hostSocket.last('notice').code, 'BAD_REQUEST');
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  assert.equal(ctx.room.game.phase, 'playing');
});

test('stale answers for an earlier puzzle are ignored', () => {
  const ctx = setup();
  addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  ctx.manager.handle(ctx.room, ctx.host, { t: 'answer', puzzleId: 'old.1', answer: {} });
  assert.equal(ctx.hostSocket.last('notice').code, 'STALE');
  assert.equal(ctx.room.game.round.attempts, 0);
});

test('finishing a stage shows a scored result, saves progress, and Continue opens the next stage', () => {
  const ctx = setup();
  const { guestSocket } = addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  solveStage(ctx);
  const game = ctx.room.game;
  assert.equal(game.phase, 'complete', 'three puzzles do not end the game');
  assert.equal(game.result.stars, 3);
  assert.equal(game.result.firstClear, true);
  assert.equal(game.result.nextStageId, STAGES[1].id);
  assert.equal(guestSocket.last('progress').campaign.completed, 1);
  assert.ok(ctx.room.progress.isUnlocked(STAGES[1].id));
  const result = guestSocket.last('state').state.game.result;
  assert.equal(result.label, 'Excellent');
  assert.equal(result.breakdown.length, 4);

  const from = game.result.runId;
  ctx.manager.handle(ctx.room, ctx.room.seats.operator, { t: 'continue', from });
  assert.equal(game.phase, 'playing');
  assert.equal(game.run.stageId, STAGES[1].id);
});

test('both players pressing Continue at once starts the next stage once', () => {
  const ctx = setup();
  addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  solveStage(ctx);
  const from = ctx.room.game.result.runId;
  ctx.manager.handle(ctx.room, ctx.room.seats.caller, { t: 'continue', from });
  const runId = ctx.room.game.run.id;
  ctx.manager.handle(ctx.room, ctx.room.seats.operator, { t: 'continue', from });
  assert.equal(ctx.room.game.run.id, runId, 'the second press is a no-op');
  assert.equal(ctx.room.game.run.stageId, STAGES[1].id);
  // The same for two simultaneous picks on the map: the first wins.
  ctx.manager.handle(ctx.room, ctx.room.seats.operator, { t: 'map', from: runId });
  ctx.manager.handle(ctx.room, ctx.room.seats.caller, { t: 'map', from: runId });
  assert.equal(ctx.room.game.phase, 'lobby');
  ctx.manager.handle(ctx.room, ctx.room.seats.caller, { t: 'play', stageId: STAGES[0].id });
  const first = ctx.room.game.run.id;
  ctx.manager.handle(ctx.room, ctx.room.seats.operator, { t: 'play', stageId: STAGES[1].id });
  assert.equal(ctx.room.game.run.id, first);
  assert.equal(ctx.hostSocket.last('notice')?.code === 'BUSY' || ctx.room.seats.operator.socket.last('notice').code === 'BUSY', true);
});

test('replaying a stage keeps the best score; worse runs do not lower it', () => {
  const ctx = setup();
  addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  solveStage(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  ctx.tick(60 * 60_000); // a very slow replay
  solveStage(ctx);
  assert.equal(ctx.room.game.result.isBest, false);
  assert.equal(ctx.room.progress.get(STAGES[0].id).best, 1000);
  assert.equal(ctx.room.progress.get(STAGES[0].id).stars, 3);
});

test('the campaign ends only after the final stage', () => {
  const ctx = setup();
  addGuest(ctx);
  for (const s of STAGES.slice(0, -1)) ctx.room.progress.record(s.id, { score: 900, stars: 3 });
  const penultimate = STAGES[STAGES.length - 2];
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: penultimate.id });
  solveStage(ctx);
  assert.equal(ctx.room.game.phase, 'complete');
  assert.equal(ctx.room.game.result.campaignComplete, false);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'continue', from: ctx.room.game.result.runId });
  assert.equal(ctx.room.game.run.stageId, STAGES[STAGES.length - 1].id);
  solveStage(ctx);
  assert.equal(ctx.room.game.phase, 'finale');
  assert.equal(ctx.room.game.result.campaignComplete, true);
  assert.equal(ctx.room.game.result.nextStageId, null);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'continue', from: ctx.room.game.result.runId });
  assert.equal(ctx.room.game.phase, 'lobby', 'after the finale, back to the map');
});

test('a timed-out stage can be retried with fresh puzzles', () => {
  const ctx = setup();
  addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  const firstRun = ctx.room.game.run.id;
  ctx.tick(STAGES[0].limitMs + 1);
  ctx.manager.sweep();
  assert.equal(ctx.room.game.phase, 'failed');
  assert.ok(!ctx.room.progress.completed(STAGES[0].id));
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  assert.equal(ctx.room.game.phase, 'playing');
  assert.notEqual(ctx.room.game.run.id, firstRun);
});

test('a joining player brings their signed progress, and both browsers receive the merged save', () => {
  const ctx = setup();
  const saved = SIGNER.sign('progress', { v: 1, s: { '1-1': [2, 700], '1-2': [3, 900] } });
  const { seat } = ctx.manager.join(ctx.room.code, { name: 'Grace', progress: saved });
  assert.ok(ctx.room.progress.isUnlocked('1-3'));
  const update = ctx.hostSocket.last('progress');
  assert.equal(update.campaign.completed, 2);
  assert.deepEqual(SIGNER.verify('progress', update.token).s['1-2'], [3, 900]);
  // A forged save is ignored.
  const forged = createSigner('somebody-elses-secret-key-123456').sign('progress', { v: 1, s: { '10-19': [3, 1000] } });
  ctx.manager.attach(ctx.room.code, seat.token, new FakeSocket(), { progress: forged });
  assert.ok(!ctx.room.progress.completed('10-19'));
});

test('with saved rooms, a server restart resumes the stage, chat and clock exactly', () => {
  const disk = memoryDisk();
  const ctx = setup({ store: disk });
  const { guest } = addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'chat', clientId: 'c1', text: 'Plate one is a bell.' });
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  ctx.tick(30_000);
  const puzzleBefore = ctx.room.game.viewFor('operator', ctx.clock.t).puzzle;
  const activeBefore = ctx.room.game.activeMs(ctx.clock.t);
  ctx.manager.shutdown();
  assert.equal(ctx.hostSocket.last('closed').code, 'RESTARTING');

  const restarted = new RoomManager({ idleMs: 30 * 60_000, maxMs: 4 * 3_600_000, now: () => ctx.clock.t + 60_000, signer: SIGNER, store: disk });
  assert.equal(restarted.restore(), 1);
  const room = restarted.rooms.get(ctx.room.code);
  const a = new FakeSocket();
  const b = new FakeSocket();
  restarted.attach(room.code, ctx.host.token, a);
  assert.equal(room.game.paused, true, 'waits for both players');
  restarted.attach(room.code, guest.token, b);
  assert.equal(room.game.paused, false);
  const welcome = b.last('welcome');
  assert.deepEqual(welcome.state.game.puzzle.view, puzzleBefore.view);
  assert.equal(welcome.state.game.timer.activeMs, activeBefore, 'the downtime was not counted');
  assert.ok(welcome.chat.some((m) => m.clientId === 'c1'));
  // Retried chat from before the restart is still recognised.
  restarted.handle(room, room.seats.caller, { t: 'chat', clientId: 'c1', text: 'Plate one is a bell.' });
  assert.equal(room.chat.filter((m) => m.clientId === 'c1').length, 1);
});

test('without saved rooms, signed tickets rebuild the room after a restart for both players', () => {
  const ctx = setup();
  const { guest, guestSocket } = addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  solveStage(ctx);
  const hostTicket = ctx.hostSocket.last('state').state.ticket;
  const guestTicket = guestSocket.last('state').state.ticket;
  const hostSave = ctx.hostSocket.last('progress').token;

  // A new process: no rooms in memory, same signing secret.
  const fresh = new RoomManager({ idleMs: 30 * 60_000, maxMs: 4 * 3_600_000, now: () => ctx.clock.t + 120_000, signer: SIGNER });
  const a = new FakeSocket();
  const rebuilt = fresh.attach(ctx.room.code, ctx.host.token, a, { ticket: hostTicket, progress: hostSave });
  assert.ok(!rebuilt.error, rebuilt.message);
  assert.equal(rebuilt.seat.role, 'caller');
  assert.equal(a.last('welcome').campaign.completed, 1, 'progress came back from the browser');
  const b = new FakeSocket();
  const partner = fresh.attach(ctx.room.code, guest.token, b, { ticket: guestTicket });
  assert.ok(!partner.error, partner.message);
  assert.equal(partner.seat.role, 'operator');
  assert.equal(b.last('welcome').state.room.code, ctx.room.code);

  // A ticket cannot claim someone else's seat or a different room.
  const other = new RoomManager({ idleMs: 60_000, maxMs: 3_600_000, now: () => ctx.clock.t, signer: SIGNER });
  assert.equal(other.attach(ctx.room.code, 'wrong-token', new FakeSocket(), { ticket: hostTicket }).error, 'ROOM_NOT_FOUND');
  assert.equal(other.attach('ZZZZZZ', ctx.host.token, new FakeSocket(), { ticket: hostTicket }).error, 'ROOM_NOT_FOUND');
  const late = new RoomManager({ idleMs: 60_000, maxMs: 3_600_000, now: () => ctx.clock.t + 5 * 3_600_000, signer: SIGNER });
  assert.equal(late.attach(ctx.room.code, ctx.host.token, new FakeSocket(), { ticket: hostTicket }).error, 'ROOM_NOT_FOUND', 'expired tickets');
});

test('both players reconnecting at nearly the same moment resume one consistent stage', () => {
  const ctx = setup();
  const { guest, guestSocket } = addGuest(ctx);
  ctx.manager.handle(ctx.room, ctx.host, { t: 'play', stageId: STAGES[0].id });
  const runId = ctx.room.game.run.id;
  ctx.manager.detach(ctx.room, ctx.host, ctx.hostSocket);
  ctx.manager.detach(ctx.room, guest, guestSocket);
  ctx.tick(3_000);
  const a = new FakeSocket();
  const b = new FakeSocket();
  ctx.manager.attach(ctx.room.code, guest.token, b);
  ctx.manager.attach(ctx.room.code, ctx.host.token, a);
  assert.equal(ctx.room.game.run.id, runId);
  assert.equal(ctx.room.game.paused, false);
  const sa = a.last('state').state;
  const sb = b.last('state').state;
  assert.equal(sa.rev, sb.rev);
  assert.equal(sa.game.puzzle.id, sb.game.puzzle.id);
  assert.ok(sa.players.every((p) => p.connection === 'online'));
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
