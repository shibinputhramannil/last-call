import { MODES } from '../shared/constants.js';

// Shape checks for everything a browser can send over the WebSocket. Each
// message is reduced to the fields its type allows, with types and lengths
// checked, before the game sees it. Game rules (whose turn, which puzzle,
// whether an answer is right) are still checked by the server afterwards.

const ID = /^[A-Za-z0-9_.-]{1,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const SESSION = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNED = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const str = (v, max, pattern) => typeof v === 'string' && v.length <= max && (!pattern || pattern.test(v));
const optional = (v, check) => v === undefined || v === null || check(v);

/** Answers: a short string, a short list of short strings, or a small map of short strings. */
function answerOk(a) {
  if (typeof a === 'string') return a.length <= 64;
  if (Array.isArray(a)) return a.length <= 12 && a.every((x) => typeof x === 'string' && x.length <= 24);
  if (a && typeof a === 'object') {
    const entries = Object.entries(a);
    return entries.length <= 16 && entries.every(([k, v]) => k.length <= 4 && typeof v === 'string' && v.length <= 2);
  }
  return false;
}

const RULES = {
  hello: (m) =>
    str(m.code, 12) &&
    str(m.token, 64, TOKEN) &&
    optional(m.ticket, (v) => str(v, 2_048, SIGNED)) &&
    optional(m.progress, (v) => str(v, 12_000, SIGNED)) &&
    optional(m.sid, (v) => str(v, 64, SESSION)) && { t: 'hello', code: m.code, token: m.token, ticket: m.ticket ?? null, progress: m.progress ?? null, sid: m.sid ?? null },
  ping: (m) => optional(m.id, Number.isSafeInteger) && { t: 'ping', id: m.id ?? null },
  chat: (m) => str(m.clientId, 40, ID) && typeof m.text === 'string' && m.text.length <= 2_000 && { t: 'chat', clientId: m.clientId, text: m.text },
  typing: () => ({ t: 'typing' }),
  play: (m) => str(m.stageId, 8) && { t: 'play', stageId: m.stageId },
  continue: (m) => str(m.from, 24, ID) && { t: 'continue', from: m.from },
  map: (m) => str(m.from, 24, ID) && { t: 'map', from: m.from },
  swap: () => ({ t: 'swap' }),
  mode: (m) => MODES.includes(m.mode) && { t: 'mode', mode: m.mode },
  answer: (m) => str(m.puzzleId, 24, ID) && answerOk(m.answer) && { t: 'answer', puzzleId: m.puzzleId, answer: m.answer },
  hint: (m) => str(m.puzzleId, 24, ID) && { t: 'hint', puzzleId: m.puzzleId },
  leave: () => ({ t: 'leave' }),
};

/** Returns a clean copy of a valid message, or null. */
export function validateMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return null;
  const rule = Object.hasOwn(RULES, msg.t) ? RULES[msg.t] : null;
  return (rule && rule(msg)) || null;
}

/** Room-creation and join bodies: optional name and signed progress, role and mode by name. */
export function validateRoomBody(body) {
  return {
    name: typeof body.name === 'string' ? body.name.slice(0, 100) : null,
    role: typeof body.role === 'string' ? body.role : null,
    mode: typeof body.mode === 'string' ? body.mode : null,
    progress: str(body.progress, 12_000, SIGNED) ? body.progress : null,
  };
}
