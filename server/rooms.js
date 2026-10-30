import { MAX_CHAT_LENGTH, MAX_NAME_LENGTH, MODES, ROLES } from '../shared/constants.js';
import { Game } from './game.js';
import { newRoomCode, newSeatToken, tokensMatch } from './random.js';
import { RateLimiter } from './rateLimit.js';

const CHAT_HISTORY = 200;
const RECENT_CLIENT_IDS = 60;
/** A disconnected seat can be taken over by someone joining with the code after this long. */
export const SEAT_RECLAIM_MS = 20_000;
const TOMBSTONE_MS = 12 * 3_600_000;
const MAX_TOMBSTONES = 20_000;

const ROLE_LABEL = { caller: 'Caller', operator: 'Operator' };

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
    `This room closed after ${Math.round(cfg.idleMs / 60_000)} minutes with nobody on the line. Open a new room to play again.`,
  MAX_AGE: (cfg) => `This room reached its ${Math.round(cfg.maxMs / 3_600_000)}-hour limit and closed. Open a new room to play again.`,
  EMPTY: () => 'Both players left, so this room closed. Open a new room to play again.',
  SHUTDOWN: () => 'The server is restarting. Open a new room in a minute or two.',
};

class Seat {
  constructor(role, name, now) {
    this.role = role;
    this.name = name;
    this.token = newSeatToken();
    this.socket = null;
    this.everConnected = false;
    this.lastSeenAt = now;
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
}

export class Room {
  constructor(code, mode, now) {
    this.code = code;
    this.mode = mode;
    this.createdAt = now;
    this.lastActiveAt = now;
    this.seats = { caller: null, operator: null };
    this.chat = [];
    this.nextMessageId = 1;
    this.game = new Game({ mode });
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
      serverNow: now,
      room: { code: this.code, mode: this.mode },
      you: { role: seat.role, name: seat.displayName },
      players: ROLES.map((role) => {
        const s = this.seats[role];
        return {
          role,
          name: s ? s.displayName : null,
          present: Boolean(s),
          connected: Boolean(s?.connected),
          you: s === seat,
        };
      }),
      game: this.game.viewFor(seat.role, now),
    };
  }

  broadcastState(now) {
    for (const seat of this.seatList) this.send(seat, { t: 'state', state: this.snapshotFor(seat, now) });
  }

  addMessage(entry, now) {
    const message = { id: String(this.nextMessageId++), ts: now, ...entry };
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.broadcast({ t: 'chat', message });
    return message;
  }

  system(text, now) {
    return this.addMessage({ kind: 'system', text }, now);
  }
}

export class RoomManager {
  constructor({ idleMs, maxMs, maxRooms = 5_000, narrator = null, now = () => Date.now() }) {
    this.cfg = { idleMs, maxMs };
    this.maxRooms = maxRooms;
    this.narrator = narrator;
    this.now = now;
    this.rooms = new Map();
    this.tombstones = new Map();
  }

  // ---- HTTP-facing operations -------------------------------------------------

  create({ name, role, mode }) {
    if (!ROLES.includes(role)) return { error: 'BAD_REQUEST', message: 'Choose to play as the Caller or the Operator.' };
    if (!MODES.includes(mode)) return { error: 'BAD_REQUEST', message: 'Choose timed or untimed.' };
    if (this.rooms.size >= this.maxRooms) {
      return { error: 'BUSY', message: 'The exchange is full right now. Try again in a few minutes.' };
    }
    let code;
    do code = newRoomCode();
    while (this.rooms.has(code) || this.tombstones.has(code));
    const now = this.now();
    const room = new Room(code, mode, now);
    const seat = new Seat(role, cleanName(name), now);
    room.seats[role] = seat;
    this.rooms.set(code, room);
    return { room, seat };
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

  join(code, { name }) {
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
    room.broadcastState(now);
    return { room, seat };
  }

  // ---- Socket lifecycle -------------------------------------------------------

  attach(code, token, socket) {
    const room = this.rooms.get(code);
    if (!room) {
      const tomb = this.tombstones.get(code);
      return tomb
        ? { error: 'ROOM_CLOSED', message: CLOSE_MESSAGES[tomb.reason](this.cfg) }
        : {
            error: 'ROOM_NOT_FOUND',
            message: 'This room no longer exists. It may have expired, or the server restarted. Open a new room to keep playing.',
          };
    }
    const seat = room.seatByToken(token);
    if (!seat) {
      return {
        error: 'SEAT_LOST',
        message: 'Your place in this room was given to someone else after you were away. Join again with the room code if a seat is free.',
      };
    }
    const now = this.now();
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
    seat.socket = socket;
    seat.everConnected = true;
    seat.lastSeenAt = now;
    room.lastActiveAt = now;

    room.send(seat, { t: 'welcome', state: room.snapshotFor(seat, now), chat: room.chat });
    room.system(
      returning ? `${seat.displayName} is back on the line.` : `${seat.displayName} joined as the ${ROLE_LABEL[seat.role]}.`,
      now,
    );
    if (room.game.paused && room.bothConnected() && room.game.resume(now)) {
      room.system('Both lines are open again. The clock is running.', now);
    }
    room.broadcastState(now);
    return { room, seat };
  }

  detach(room, seat, socket) {
    if (seat.socket !== socket) return; // already replaced by a newer connection
    const now = this.now();
    seat.socket = null;
    seat.lastSeenAt = now;
    room.lastActiveAt = now;
    if (!this.rooms.has(room.code)) return;
    room.system(`${seat.displayName} lost the line.`, now);
    if (room.game.status === 'playing' && room.game.pause(now)) {
      room.system('The clock is held until both players are back.', now);
    }
    room.broadcastState(now);
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
    this.tombstones.set(room.code, { reason, at: this.now() });
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value;
      this.tombstones.delete(oldest);
    }
  }

  /** Expires idle/old rooms and ends timed games. Call periodically. */
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
      if (room.game.checkTimeout(now)) {
        room.system('The clock ran out. The exchange has forgotten you.', now);
        this.narrate(room, { event: 'lost' });
        room.broadcastState(now);
      }
    }
    for (const [code, tomb] of this.tombstones) {
      if (now - tomb.at > TOMBSTONE_MS) this.tombstones.delete(code);
    }
  }

  shutdown() {
    for (const room of [...this.rooms.values()]) this.closeRoom(room, 'SHUTDOWN');
  }

  // ---- Client messages --------------------------------------------------------

  handle(room, seat, msg) {
    const now = this.now();
    room.lastActiveAt = now;
    switch (msg.t) {
      case 'ping':
        return room.send(seat, { t: 'pong' });
      case 'chat':
        return this.onChat(room, seat, msg, now);
      case 'typing':
        if (seat.typingLimiter.take('t', 1, now) === 0) {
          room.broadcast({ t: 'typing', role: seat.role }, seat);
        }
        return;
      case 'start':
        return this.onStart(room, seat, now);
      case 'swap':
        return this.onSwap(room, seat, now);
      case 'mode':
        return this.onMode(room, seat, msg, now);
      case 'restart':
        return this.onRestart(room, seat, now);
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

  onStart(room, seat, now) {
    if (room.game.status !== 'lobby') return;
    if (!room.bothConnected()) {
      return this.notice(room, seat, 'WAITING', 'You need both a Caller and an Operator on the line to start.');
    }
    room.game.start(now);
    room.system(`${seat.displayName} opened the exchange. The first puzzle: ${room.game.round.def.title}.`, now);
    room.broadcast({ t: 'event', name: 'started' });
    room.broadcastState(now);
  }

  onSwap(room, seat, now) {
    if (room.game.status !== 'lobby') return this.notice(room, seat, 'NOT_LOBBY', 'Roles can only be swapped before the game starts.');
    const { caller, operator } = room.seats;
    room.seats.caller = operator;
    room.seats.operator = caller;
    if (room.seats.caller) room.seats.caller.role = 'caller';
    if (room.seats.operator) room.seats.operator.role = 'operator';
    room.system(`${seat.displayName} swapped roles.`, now);
    room.broadcastState(now);
  }

  onMode(room, seat, msg, now) {
    if (room.game.status !== 'lobby' || !MODES.includes(msg.mode) || msg.mode === room.mode) return;
    room.mode = msg.mode;
    room.game = new Game({ mode: msg.mode });
    room.system(
      msg.mode === 'timed'
        ? `${seat.displayName} set a 25-minute clock.`
        : `${seat.displayName} turned the clock off. Take as long as you need.`,
      now,
    );
    room.broadcastState(now);
  }

  onRestart(room, seat, now) {
    if (room.game.status !== 'won' && room.game.status !== 'lost') return;
    room.game = new Game({ mode: room.mode });
    room.system(`${seat.displayName} returned to the lobby. Swap roles or start a new run.`, now);
    room.broadcastState(now);
  }

  onAnswer(room, seat, msg, now) {
    const game = room.game;
    if (game.status === 'playing' && msg.puzzleId !== game.round.def.id) {
      return this.notice(room, seat, 'STALE', 'That answer was for a puzzle you have already moved past.');
    }
    const result = game.submitAnswer(seat.role, msg.answer, now);
    if (!result.ok) return this.notice(room, seat, result.code, result.message, { retryInMs: result.retryInMs });

    if (result.correct) {
      room.broadcast({ t: 'answer-result', correct: true, solvedTitle: result.solvedTitle, won: result.won });
      room.system(
        result.won ? `${result.solvedTitle} answered. The exchange remembers you.` : `${result.solvedTitle} solved.`,
        now,
      );
      this.narrate(room, { event: result.won ? 'won' : 'solved', title: result.solvedTitle });
    } else {
      room.broadcast({ t: 'answer-result', correct: false, penaltyMs: result.penaltyMs, feedback: result.feedback });
      const parts = ['Wrong. The exchange did not answer.'];
      if (result.feedback) parts.push(`${result.feedback.matched} of ${result.feedback.total} ${result.feedback.unit} held.`);
      if (result.penaltyMs) parts.push(`The clock lost ${result.penaltyMs / 1000} seconds.`);
      room.system(parts.join(' '), now);
      if (result.lost) {
        room.system('The clock ran out. The exchange has forgotten you.', now);
        this.narrate(room, { event: 'lost' });
      }
    }
    room.broadcastState(now);
  }

  onHint(room, seat, msg, now) {
    const game = room.game;
    if (game.status !== 'playing' || msg.puzzleId !== game.round.def.id) return;
    const result = game.requestHint(seat.role, now);
    if (!result.ok) return this.notice(room, seat, result.code, result.message, { retryInMs: result.retryInMs });
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
    if (room.game.status === 'playing') room.game.pause(now);
    room.broadcastState(now);
  }

  narrate(room, context) {
    if (!this.narrator) return;
    const progress = room.game.puzzleIndex;
    this.narrator
      .line({ ...context, progress })
      .then((text) => {
        if (text && this.rooms.get(room.code) === room) {
          room.addMessage({ kind: 'narrator', name: 'The Exchange', text }, this.now());
        }
      })
      .catch(() => {});
  }
}
