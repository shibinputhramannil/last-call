import { MAX_CHAT_LENGTH, MAX_NAME_LENGTH, MODES, ROLES } from '../shared/constants.js';
import { chapterOf, nextStage, stageById } from '../shared/campaign.js';
import { Game } from './game.js';
import { silentLogger } from './logger.js';
import { Progress } from './progress.js';
import { newId, newRoomCode, newSeatToken, tokensMatch } from './random.js';
import { RateLimiter } from './rateLimit.js';
import { fingerprint } from './signing.js';

const CHAT_HISTORY = 200;
const RECENT_CLIENT_IDS = 60;
/** A disconnected seat can be taken over by someone joining with the code after this long. */
export const SEAT_RECLAIM_MS = 20_000;
/**
 * A drop shorter than this is never announced: the partner sees a quiet
 * "reconnecting" state, and nothing is posted in the chat. (The stage clock
 * still stops at once, so nobody loses time to the network.)
 */
export const PRESENCE_GRACE_MS = 8_000;
const TOMBSTONE_MS = 12 * 3_600_000;
const MAX_TOMBSTONES = 20_000;
const ROOM_FORMAT = 1;

const ROLE_LABEL = { caller: 'Caller', operator: 'Operator' };
const STAR_TEXT = (n) => '★'.repeat(n) + '☆'.repeat(3 - n);

// Control characters, zero-width characters and bidi overrides (newlines are kept).
const STRIP_RANGES = [[0x00, 0x09], [0x0b, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]];
const stripUnsafe = (text) =>
  Array.from(text)
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return !STRIP_RANGES.some(([lo, hi]) => c >= lo && c <= hi);
    })
    .join('');

export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = stripUnsafe(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name || null;
}

export function cleanChat(raw) {
  if (typeof raw !== 'string') return '';
  return stripUnsafe(raw.replace(/\r\n?/g, '\n').replace(/\t/g, ' '))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CLOSE_MESSAGES = {
  IDLE: (cfg) =>
    `This room closed after ${Math.round(cfg.idleMs / 60_000)} minutes with nobody on the line. Your campaign progress is saved in your browser: open a new room to carry on.`,
  MAX_AGE: (cfg) =>
    `This room reached its ${Math.round(cfg.maxMs / 3_600_000)}-hour limit and closed. Your campaign progress is saved in your browser: open a new room to carry on.`,
  EMPTY: () => 'Both players left, so this room closed. Open a new room to play again.',
};

class Seat {
  constructor(role, name, now, token = newSeatToken()) {
    this.role = role;
    this.name = name;
    this.token = token;
    this.socket = null;
    this.everConnected = false;
    this.lastSeenAt = now;
    this.droppedAt = null;
    this.dropAnnounced = false;
    this.recentClientIds = new Map();
    this.chatLimiter = new RateLimiter({ capacity: 6, perMs: 8_000 });
    this.typingLimiter = new RateLimiter({ capacity: 1, perMs: 1_500 });
  }

  get displayName() {
    return this.name || ROLE_LABEL[this.role];
  }

  get connected() {
    return this.socket != null;
  }

  /** online, reconnecting (a short drop, within the grace period) or offline. */
  connection(now) {
    if (this.socket) return 'online';
    if (this.droppedAt != null && !this.dropAnnounced && now - this.droppedAt < PRESENCE_GRACE_MS) return 'reconnecting';
    return 'offline';
  }

  toJSON() {
    return { role: this.role, name: this.name, token: this.token, everConnected: this.everConnected, lastSeenAt: this.lastSeenAt };
  }
}

export class Room {
  constructor(code, mode, now, { seed = newId(9), createdAt = now } = {}) {
    this.code = code;
    this.mode = mode;
    this.seed = seed;
    this.createdAt = createdAt;
    this.lastActiveAt = now;
    this.seats = { caller: null, operator: null };
    this.chat = [];
    this.nextMessageId = 1;
    this.rev = 0;
    this.heldAnnounced = false;
    this.progress = new Progress();
    this.game = new Game({ mode });
    this.onChange = null;
    this.signTicket = null;
  }

  get seatList() {
    return ROLES.map((r) => this.seats[r]).filter(Boolean);
  }

  seatByToken(token) {
    return this.seatList.find((s) => tokensMatch(s.token, token)) || null;
  }

  bothConnected() {
    return ROLES.every((r) => this.seats[r]?.connected);
  }

  send(seat, msg) {
    if (!seat?.socket) return;
    try {
      seat.socket.send(JSON.stringify(msg));
    } catch {
      // The socket's own close handler will clean up.
    }
  }

  broadcast(msg, except = null) {
    for (const seat of this.seatList) if (seat !== except) this.send(seat, msg);
  }

  snapshotFor(seat, now) {
    return {
      rev: this.rev,
      serverNow: now,
      room: { code: this.code, mode: this.mode },
      you: { role: seat.role, name: seat.displayName },
      ticket: this.signTicket ? this.signTicket(seat) : null,
      players: ROLES.map((role) => {
        const s = this.seats[role];
        return {
          role,
          name: s ? s.displayName : null,
          present: Boolean(s),
          connected: Boolean(s?.connected),
          connection: s ? s.connection(now) : null,
          you: s === seat,
        };
      }),
      game: this.game.viewFor(seat.role, now),
    };
  }

  broadcastState(now) {
    this.rev++;
    for (const seat of this.seatList) this.send(seat, { t: 'state', state: this.snapshotFor(seat, now) });
    this.onChange?.(this);
  }

  addMessage(entry, now) {
    const message = { id: String(this.nextMessageId++), ts: now, ...entry };
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.broadcast({ t: 'chat', message });
    this.onChange?.(this);
    return message;
  }

  system(text, now) {
    return this.addMessage({ kind: 'system', text }, now);
  }

  toJSON(now) {
    return {
      format: ROOM_FORMAT,
      code: this.code,
      mode: this.mode,
      seed: this.seed,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      nextMessageId: this.nextMessageId,
      heldAnnounced: this.heldAnnounced,
      chat: this.chat,
      progress: this.progress.toJSON(),
      seats: Object.fromEntries(ROLES.map((r) => [r, this.seats[r]?.toJSON() ?? null])),
      game: this.game.toJSON(now),
    };
  }

  static fromJSON(data, now) {
    if (data?.format !== ROOM_FORMAT || !MODES.includes(data.mode)) return null;
    const room = new Room(data.code, data.mode, now, { seed: data.seed, createdAt: data.createdAt });
    room.nextMessageId = data.nextMessageId;
    room.heldAnnounced = Boolean(data.heldAnnounced);
    room.chat = Array.isArray(data.chat) ? data.chat.slice(-CHAT_HISTORY) : [];
    room.progress = Progress.from(data.progress);
    room.game = Game.fromJSON(data.game);
    room.game.mode = data.mode;
    for (const role of ROLES) {
      const s = data.seats?.[role];
      if (!s || typeof s.token !== 'string') continue;
      const seat = new Seat(role, s.name, now, s.token);
      seat.everConnected = Boolean(s.everConnected);
      seat.lastSeenAt = now;
      for (const m of room.chat) if (m.kind === 'player' && m.role === role && m.clientId) seat.recentClientIds.set(m.clientId, m);
      room.seats[role] = seat;
    }
    return room;
  }
}

export class RoomManager {
  constructor({
    idleMs,
    maxMs,
    maxRooms = 5_000,
    narrator = null,
    signer = null,
    store = null,
    log = silentLogger,
    now = () => Date.now(),
  }) {
    this.cfg = { idleMs, maxMs };
    this.maxRooms = maxRooms;
    this.narrator = narrator;
    this.signer = signer;
    this.store = store;
    this.log = log;
    this.now = now;
    this.rooms = new Map();
    this.tombstones = new Map();
    this.dirty = new Set();
  }

  // ---- Persistence ------------------------------------------------------------

  /** Wires a room to persistence and ticket signing. */
  adopt(room) {
    room.onChange = (r) => this.dirty.add(r.code);
    if (this.signer) {
      room.signTicket = (seat) =>
        this.signer.sign('ticket', {
          c: room.code,
          r: seat.role,
          s: room.seed,
          m: room.mode,
          n: seat.name,
          h: fingerprint(seat.token),
          t: room.createdAt,
        });
    }
    this.rooms.set(room.code, room);
    this.dirty.add(room.code);
    return room;
  }

  /** Reloads rooms saved before a restart. Players reconnect into them as if after a short drop. */
  restore() {
    if (!this.store?.persistent) return 0;
    const now = this.now();
    let count = 0;
    for (const data of this.store.loadAll()) {
      const room = Room.fromJSON(data, now);
      if (!room || this.rooms.has(room.code)) continue;
      if (now - room.createdAt > this.cfg.maxMs) {
        this.store.remove(room.code);
        continue;
      }
      this.adopt(room);
      room.system('The game server restarted. Everything was saved: play carries on as soon as you are both back on the line.', now);
      count++;
    }
    if (count) this.log.info('rooms restored', { rooms: count });
    return count;
  }

  /** Writes rooms that changed since the last flush. */
  flush() {
    if (!this.store?.persistent || this.dirty.size === 0) return;
    const now = this.now();
    for (const code of this.dirty) {
      const room = this.rooms.get(code);
      try {
        if (room) this.store.save(code, room.toJSON(now));
      } catch (err) {
        this.log.error('could not save room', { room: code, err });
      }
    }
    this.dirty.clear();
  }

  // ---- Signed browser saves ----------------------------------------------------

  progressToken(room) {
    return this.signer ? this.signer.sign('progress', room.progress.toJSON()) : null;
  }

  /** Merges a browser's signed progress into the room. Returns true if it added anything. */
  absorbProgress(room, token) {
    if (!token || !this.signer) return false;
    const data = this.signer.verify('progress', token);
    return data ? room.progress.merge(Progress.from(data)) : false;
  }

  sendProgress(room, only = null) {
    const msg = { t: 'progress', campaign: room.progress.view(), token: this.progressToken(room) };
    for (const seat of room.seatList) if (!only || seat === only) room.send(seat, msg);
  }

  // ---- HTTP-facing operations -------------------------------------------------

  create({ name, role, mode, progress = null }) {
    if (!ROLES.includes(role)) return { error: 'BAD_REQUEST', message: 'Choose to play as the Caller or the Operator.' };
    if (!MODES.includes(mode)) return { error: 'BAD_REQUEST', message: 'Choose timed or untimed.' };
    if (this.rooms.size >= this.maxRooms) {
      return { error: 'BUSY', message: 'The exchange is full right now. Try again in a few minutes.' };
    }
    let code;
    do code = newRoomCode();
    while (this.rooms.has(code) || this.tombstones.has(code));
    const now = this.now();
    const room = this.adopt(new Room(code, mode, now));
    this.absorbProgress(room, progress);
    const seat = new Seat(role, cleanName(name), now);
    room.seats[role] = seat;
    this.log.info('room opened', { room: code, mode, rooms: this.rooms.size });
    return { room, seat };
  }

  /** Counts for the health check. */
  stats() {
    let players = 0;
    for (const room of this.rooms.values()) players += room.seatList.filter((s) => s.connected).length;
    return { rooms: this.rooms.size, players };
  }

  lookup(code) {
    const room = this.rooms.get(code);
    if (!room) {
      const tomb = this.tombstones.get(code);
      if (tomb) return { status: 'expired', message: CLOSE_MESSAGES[tomb.reason](this.cfg) };
      return { status: 'not_found' };
    }
    const open = this.openSeat(room);
    const host = room.seatList.find((s) => s.connected) || room.seatList[0];
    return {
      status: open ? 'open' : 'full',
      mode: room.mode,
      role: open?.role ?? null,
      hostName: host ? host.displayName : null,
    };
  }

  /** The seat a new joiner would get: an empty one, or one abandoned long enough. */
  openSeat(room) {
    const now = this.now();
    for (const role of ROLES) if (!room.seats[role]) return { role, reclaim: false };
    for (const role of ROLES) {
      const s = room.seats[role];
      if (!s.connected && now - s.lastSeenAt > SEAT_RECLAIM_MS) return { role, reclaim: true };
    }
    return null;
  }

  join(code, { name, progress = null }) {
    const found = this.lookup(code);
    if (found.status === 'not_found') return { error: 'NOT_FOUND' };
    if (found.status === 'expired') return { error: 'EXPIRED', message: found.message };
    const room = this.rooms.get(code);
    const open = this.openSeat(room);
    if (!open) return { error: 'FULL' };
    const now = this.now();
    const seat = new Seat(open.role, cleanName(name), now);
    room.seats[open.role] = seat;
    room.lastActiveAt = now;
    if (open.reclaim) room.system(`A new ${ROLE_LABEL[open.role]} is taking over the line.`, now);
    if (this.absorbProgress(room, progress)) this.sendProgress(room);
    room.broadcastState(now);
    return { room, seat };
  }

  // ---- Socket lifecycle -------------------------------------------------------

  /**
   * After a restart without saved rooms, a player's signed ticket rebuilds the
   * room under the same code. Progress comes back from the players' browsers.
   */
  restoreFromTicket(code, token, ticket, now) {
    const t = this.verifyTicket(code, token, ticket, now);
    if (!t || this.rooms.size >= this.maxRooms) return null;
    const room = this.adopt(new Room(code, t.m, now, { seed: t.s, createdAt: t.t }));
    const seat = new Seat(t.r, cleanName(t.n), now, token);
    seat.everConnected = true;
    room.seats[t.r] = seat;
    room.system('The game server restarted, so this room was rebuilt. Your campaign progress is safe; a stage that was in progress starts again.', now);
    this.log.info('room rebuilt from ticket', { room: code, rooms: this.rooms.size });
    return room;
  }

  verifyTicket(code, token, ticket, now) {
    if (!this.signer || !ticket) return null;
    const t = this.signer.verify('ticket', ticket);
    if (!t || t.c !== code || t.h !== fingerprint(token) || !ROLES.includes(t.r) || !MODES.includes(t.m)) return null;
    if (typeof t.t !== 'number' || now - t.t > this.cfg.maxMs) return null;
    return t;
  }

  attach(code, token, socket, { ticket = null, progress = null } = {}) {
    const now = this.now();
    let room = this.rooms.get(code);
    if (!room) {
      const tomb = this.tombstones.get(code);
      if (tomb) return { error: 'ROOM_CLOSED', message: CLOSE_MESSAGES[tomb.reason](this.cfg) };
      room = this.restoreFromTicket(code, token, ticket, now);
      if (!room) {
        return {
          error: 'ROOM_NOT_FOUND',
          message: 'This room no longer exists. It may have expired, or the server restarted. Your campaign progress is saved in this browser: open a new room to carry on.',
        };
      }
    }
    let seat = room.seatByToken(token);
    if (!seat) {
      // The partner of a rebuilt room: their ticket proves they held the other seat.
      const t = this.verifyTicket(code, token, ticket, now);
      if (t && t.s === room.seed && !room.seats[t.r]) {
        seat = new Seat(t.r, cleanName(t.n), now, token);
        seat.everConnected = true;
        room.seats[t.r] = seat;
      }
    }
    if (!seat) {
      return {
        error: 'SEAT_LOST',
        message: 'Your place in this room was given to someone else after you were away. Join again with the room code if a seat is free.',
      };
    }
    if (seat.socket && seat.socket !== socket) {
      const old = seat.socket;
      seat.socket = null;
      try {
        old.send(JSON.stringify({ t: 'closed', code: 'REPLACED', message: 'You opened this room in another tab or device.' }));
        old.close(4001, 'replaced');
      } catch {
        // already gone
      }
    }
    const returning = seat.everConnected;
    const wasAnnounced = seat.dropAnnounced;
    seat.socket = socket;
    seat.everConnected = true;
    seat.lastSeenAt = now;
    seat.droppedAt = null;
    seat.dropAnnounced = false;
    room.lastActiveAt = now;
    const gained = this.absorbProgress(room, progress);

    room.send(seat, {
      t: 'welcome',
      state: room.snapshotFor(seat, now),
      chat: room.chat,
      campaign: room.progress.view(),
      progress: this.progressToken(room),
    });
    if (gained) this.sendProgress(room);
    if (!returning) room.system(`${seat.displayName} joined as the ${ROLE_LABEL[seat.role]}.`, now);
    else if (wasAnnounced) room.system(`${seat.displayName} is back on the line.`, now);
    if (room.game.paused && room.bothConnected() && room.game.resume(now) && room.heldAnnounced) {
      room.system('Both lines are open again. The clock is running.', now);
    }
    if (room.bothConnected()) room.heldAnnounced = false;
    room.broadcastState(now);
    return { room, seat };
  }

  detach(room, seat, socket) {
    if (seat.socket !== socket) return; // already replaced by a newer connection
    const now = this.now();
    seat.socket = null;
    seat.lastSeenAt = now;
    seat.droppedAt = now;
    seat.dropAnnounced = false;
    room.lastActiveAt = now;
    if (!this.rooms.has(room.code)) return;
    // Stop the clock at once, but say nothing yet: most drops are brief.
    room.game.pause(now);
    room.broadcastState(now);
  }

  /** Announces drops that outlasted the grace period. */
  announceDrops(room, now) {
    for (const seat of room.seatList) {
      if (seat.connected || seat.droppedAt == null || seat.dropAnnounced || now - seat.droppedAt < PRESENCE_GRACE_MS) continue;
      seat.dropAnnounced = true;
      room.system(`${seat.displayName} lost the line.`, now);
      if (room.game.playing && !room.heldAnnounced) {
        room.heldAnnounced = true;
        room.system('The clock is held until both players are back.', now);
      }
      room.broadcastState(now);
    }
  }

  closeRoom(room, reason) {
    const message = CLOSE_MESSAGES[reason](this.cfg);
    for (const seat of room.seatList) {
      if (!seat.socket) continue;
      const socket = seat.socket;
      seat.socket = null;
      try {
        socket.send(JSON.stringify({ t: 'closed', code: 'ROOM_CLOSED', message }));
        socket.close(4000, 'room closed');
      } catch {
        // ignore
      }
    }
    this.rooms.delete(room.code);
    this.dirty.delete(room.code);
    try {
      this.store?.remove(room.code);
    } catch (err) {
      this.log.error('could not remove saved room', { room: room.code, err });
    }
    this.tombstones.set(room.code, { reason, at: this.now() });
    this.log.info('room closed', { room: room.code, reason: reason.toLowerCase(), rooms: this.rooms.size });
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value;
      this.tombstones.delete(oldest);
    }
  }

  /** Expires idle/old rooms, announces long drops, ends timed stages, saves changes. Call every second. */
  sweep() {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (now - room.createdAt > this.cfg.maxMs) {
        this.closeRoom(room, 'MAX_AGE');
        continue;
      }
      if (!room.seatList.some((s) => s.connected) && now - room.lastActiveAt > this.cfg.idleMs) {
        this.closeRoom(room, 'IDLE');
        continue;
      }
      this.announceDrops(room, now);
      if (room.game.checkTimeout(now)) {
        room.system('The stage clock ran out and the line went dead. Try the stage again: the puzzles will be new.', now);
        this.narrate(room, { event: 'lost' });
        room.broadcastState(now);
      }
    }
    for (const [code, tomb] of this.tombstones) {
      if (now - tomb.at > TOMBSTONE_MS) this.tombstones.delete(code);
    }
    this.flush();
  }

  /**
   * Server shutdown: save every room, then tell players the server is
   * restarting. Their browsers keep reconnecting and pick the room back up
   * from saved state or their signed tickets.
   */
  shutdown() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      room.game.pause(now);
      this.dirty.add(room.code);
      for (const seat of room.seatList) {
        if (!seat.socket) continue;
        const socket = seat.socket;
        seat.socket = null;
        try {
          socket.send(JSON.stringify({ t: 'closed', code: 'RESTARTING', message: 'The game server is restarting. Reconnecting automatically…' }));
          socket.close(1012, 'restarting');
        } catch {
          // ignore
        }
      }
    }
    this.flush();
  }

  // ---- Client messages --------------------------------------------------------

  handle(room, seat, msg) {
    const now = this.now();
    room.lastActiveAt = now;
    switch (msg.t) {
      case 'ping':
        return room.send(seat, { t: 'pong', id: typeof msg.id === 'number' ? msg.id : null });
      case 'chat':
        return this.onChat(room, seat, msg, now);
      case 'typing':
        if (seat.typingLimiter.take('t', 1, now) === 0) {
          room.broadcast({ t: 'typing', role: seat.role }, seat);
        }
        return;
      case 'play':
        return this.onPlay(room, seat, stageById(msg.stageId), now);
      case 'continue':
        return this.onContinue(room, seat, msg, now);
      case 'map':
        return this.onMap(room, seat, msg, now);
      case 'swap':
        return this.onSwap(room, seat, now);
      case 'mode':
        return this.onMode(room, seat, msg, now);
      case 'answer':
        return this.onAnswer(room, seat, msg, now);
      case 'hint':
        return this.onHint(room, seat, msg, now);
      case 'leave':
        return this.onLeave(room, seat, now);
      default:
        return this.notice(room, seat, 'UNKNOWN', 'The exchange did not understand that request.');
    }
  }

  notice(room, seat, code, message, extra = {}) {
    room.send(seat, { t: 'notice', code, message, ...extra });
  }

  onChat(room, seat, msg, now) {
    const clientId = typeof msg.clientId === 'string' && /^[\w-]{1,40}$/.test(msg.clientId) ? msg.clientId : null;
    if (!clientId) return this.notice(room, seat, 'BAD_REQUEST', 'That message was malformed.');
    const previous = seat.recentClientIds.get(clientId);
    if (previous) {
      // A retry of a message we already delivered: confirm it again, don't duplicate it.
      return room.send(seat, { t: 'chat', message: previous });
    }
    const text = cleanChat(msg.text);
    const fail = (message, retryable, extra = {}) => room.send(seat, { t: 'chat-error', clientId, message, retryable, ...extra });
    if (!text) return fail('Messages cannot be empty.', false);
    if (text.length > MAX_CHAT_LENGTH) return fail(`Messages can be up to ${MAX_CHAT_LENGTH} characters.`, false);
    const wait = seat.chatLimiter.take('c', 1, now);
    if (wait > 0) return fail('You are sending messages too quickly.', true, { retryInMs: wait });

    const message = room.addMessage({ kind: 'player', clientId, role: seat.role, name: seat.displayName, text }, now);
    seat.recentClientIds.set(clientId, message);
    if (seat.recentClientIds.size > RECENT_CLIENT_IDS) {
      seat.recentClientIds.delete(seat.recentClientIds.keys().next().value);
    }
  }

  onPlay(room, seat, stage, now) {
    const game = room.game;
    if (!stage) return this.notice(room, seat, 'BAD_REQUEST', 'That stage does not exist.');
    if (game.playing) {
      // Both players pressing at once: the first press wins, the second is a no-op.
      if (game.run.stageId === stage.id) return;
      return this.notice(room, seat, 'BUSY', `Your partner already started Stage ${game.run.stageId}.`);
    }
    if (!room.progress.isUnlocked(stage.id)) return this.notice(room, seat, 'LOCKED', 'Finish the stage before this one to unlock it.');
    if (!room.bothConnected()) {
      return this.notice(room, seat, 'WAITING', 'You need both a Caller and an Operator on the line to start a stage.');
    }
    game.startStage(stage, now);
    room.heldAnnounced = false;
    room.system(`${seat.displayName} opened Stage ${stage.id}: ${stage.title}.`, now);
    room.broadcast({ t: 'event', name: 'stage-started', stageId: stage.id });
    room.broadcastState(now);
  }

  onContinue(room, seat, msg, now) {
    const game = room.game;
    // Only from a finished stage, and only once: a second press refers to an old result.
    if (!['complete', 'finale'].includes(game.phase) || msg.from !== game.result?.runId) return;
    const next = game.phase === 'complete' ? nextStage(game.stage) : null;
    if (!next) {
      game.toLobby();
      return room.broadcastState(now);
    }
    this.onPlay(room, seat, next, now);
  }

  onMap(room, seat, msg, now) {
    const game = room.game;
    if (game.phase === 'lobby') return;
    const current = game.playing ? game.run.id : game.result?.runId;
    if (msg.from !== current) return;
    if (game.playing) room.system(`${seat.displayName} left Stage ${game.run.stageId} for the stage map.`, now);
    game.toLobby();
    room.heldAnnounced = false;
    room.broadcastState(now);
  }

  onSwap(room, seat, now) {
    if (room.game.playing) return this.notice(room, seat, 'NOT_LOBBY', 'Roles can only be swapped between stages.');
    const { caller, operator } = room.seats;
    room.seats.caller = operator;
    room.seats.operator = caller;
    if (room.seats.caller) room.seats.caller.role = 'caller';
    if (room.seats.operator) room.seats.operator.role = 'operator';
    room.system(`${seat.displayName} swapped roles.`, now);
    room.broadcastState(now);
  }

  onMode(room, seat, msg, now) {
    if (room.game.playing || !MODES.includes(msg.mode) || msg.mode === room.mode) return;
    room.mode = msg.mode;
    room.game.mode = msg.mode;
    room.system(
      msg.mode === 'timed'
        ? `${seat.displayName} turned the stage countdown on.`
        : `${seat.displayName} turned the stage countdown off. Take as long as you need.`,
      now,
    );
    room.broadcastState(now);
  }

  onAnswer(room, seat, msg, now) {
    const game = room.game;
    const result = game.submitAnswer(seat.role, msg.puzzleId, msg.answer, now);
    if (!result.ok) return this.notice(room, seat, result.code, result.message, { retryInMs: result.retryInMs });

    if (result.correct && result.stageComplete) {
      const stage = game.stage;
      const outcome = room.progress.record(stage.id, game.result);
      const next = nextStage(stage);
      Object.assign(game.result, {
        ...outcome,
        nextStageId: next?.id ?? null,
        chapterComplete: stage.finale,
        campaignComplete: game.phase === 'finale',
      });
      room.broadcast({ t: 'answer-result', correct: true, puzzleId: result.puzzleId, solvedTitle: result.solvedTitle, stageComplete: true });
      room.system(
        `Stage ${stage.id} restored: ${STAR_TEXT(game.result.stars)} ${game.result.label}, ${game.result.score} points${outcome.isBest && !outcome.firstClear ? ' (a new best)' : ''}.`,
        now,
      );
      if (stage.finale) room.system(`Chapter ${stage.chapter} complete: ${chapterOf(stage).title}.`, now);
      this.sendProgress(room);
      this.narrate(room, { event: game.phase === 'finale' ? 'won' : 'stage', title: stage.title });
    } else if (result.correct) {
      room.broadcast({ t: 'answer-result', correct: true, puzzleId: result.puzzleId, solvedTitle: result.solvedTitle, stageComplete: false });
      room.system(`${result.solvedTitle} solved.`, now);
    } else {
      room.broadcast({ t: 'answer-result', correct: false, puzzleId: result.puzzleId, penaltyMs: result.penaltyMs, feedback: result.feedback });
      const parts = ['Wrong. The exchange did not answer.'];
      if (result.feedback) parts.push(`${result.feedback.matched} of ${result.feedback.total} ${result.feedback.unit} held.`);
      if (result.penaltyMs) parts.push(`The countdown lost ${result.penaltyMs / 1000} seconds.`);
      room.system(parts.join(' '), now);
      if (result.lost) {
        room.system('The stage clock ran out and the line went dead. Try the stage again: the puzzles will be new.', now);
        this.narrate(room, { event: 'lost' });
      }
    }
    room.broadcastState(now);
  }

  onHint(room, seat, msg, now) {
    const result = room.game.requestHint(seat.role, msg.puzzleId, now);
    if (!result.ok) {
      if (result.code === 'STALE' || result.code === 'NOT_PLAYING') return;
      return this.notice(room, seat, result.code, result.message, { retryInMs: result.retryInMs });
    }
    room.system(`${seat.displayName} read hint ${result.tier} of 3 in their ${seat.role === 'caller' ? 'notes' : 'manual'}.`, now);
    room.broadcastState(now);
  }

  onLeave(room, seat, now) {
    const socket = seat.socket;
    seat.socket = null;
    room.seats[seat.role] = null;
    if (socket) {
      try {
        socket.send(JSON.stringify({ t: 'closed', code: 'LEFT', message: 'You left the room.' }));
        socket.close(4002, 'left');
      } catch {
        // ignore
      }
    }
    if (room.seatList.length === 0) return this.closeRoom(room, 'EMPTY');
    room.system(`${seat.displayName} hung up and left the room. Share the code so someone can take their place.`, now);
    room.game.pause(now);
    room.broadcastState(now);
  }

  narrate(room, context) {
    if (!this.narrator) return;
    this.narrator
      .line(context)
      .then((text) => {
        if (text && this.rooms.get(room.code) === room) {
          room.addMessage({ kind: 'narrator', name: 'The Exchange', text }, this.now());
        }
      })
      .catch(() => {});
  }
}
