// Small wrappers around browser storage. Every access is guarded: private
// windows and locked-down browsers can throw, and the game must still work.
// Where storage is blocked, values are kept in memory for the life of the
// page, so a player can still join and reconnect until they reload.

const SEATS_KEY = 'lastcall:seats';
const PREFS_KEY = 'lastcall:prefs';
const LEGACY_AUDIO_KEY = 'lastcall:audio';
const PROGRESS_KEY = 'lastcall:progress';
const OPENING_KEY = 'lastcall:opening-seen';
const SEAT_TTL_MS = 8 * 3_600_000;
const RANDOM_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** Values that could not be written to real storage; null marks a removal. */
const memory = { localStorage: new Map(), sessionStorage: new Map() };

/** localStorage or sessionStorage, or null. Merely reading the property throws when site data is blocked. */
function area(name) {
  try {
    return globalThis[name] ?? null;
  } catch {
    return null;
  }
}

function readRaw(name, key) {
  if (memory[name].has(key)) return memory[name].get(key);
  try {
    return area(name)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(name, key, raw) {
  try {
    const storage = area(name);
    if (!storage) throw new Error('storage unavailable');
    if (raw == null) storage.removeItem(key);
    else storage.setItem(key, raw);
    memory[name].delete(key);
  } catch {
    memory[name].set(key, raw ?? null);
  }
}

function read(name, key, fallback) {
  try {
    const raw = readRaw(name, key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(name, key, value) {
  writeRaw(name, key, value == null ? null : JSON.stringify(value));
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function seats() {
  const all = read('localStorage', SEATS_KEY, {});
  const now = Date.now();
  for (const [code, seat] of Object.entries(all)) {
    if (!seat || now - seat.savedAt > SEAT_TTL_MS) delete all[code];
  }
  return all;
}

/** The secret token (and signed room ticket) that let this browser reclaim its seat. */
export function getSeat(code) {
  return seats()[code] || null;
}

export function saveSeat(code, token, role) {
  const all = seats();
  all[code] = { ...all[code], token, role, savedAt: Date.now() };
  write('localStorage', SEATS_KEY, all);
  write('sessionStorage', `lastcall:join:${code}`, null);
}

/** Keeps the latest signed ticket, which can rebuild the room after a server restart. */
export function saveTicket(code, ticket) {
  const all = seats();
  if (!all[code] || all[code].ticket === ticket) return;
  all[code].ticket = ticket;
  all[code].savedAt = Date.now();
  write('localStorage', SEATS_KEY, all);
}

export function forgetSeat(code) {
  const all = seats();
  delete all[code];
  write('localStorage', SEATS_KEY, all);
  write('sessionStorage', `lastcall:pending:${code}`, null);
}

/**
 * A random id for this tab's attempt to join a room. Every retry of the join,
 * even after a reload, sends the same id, so the server hands back the seat it
 * already gave instead of a second one. Cleared once the seat is saved.
 */
export function joinAttemptId(code) {
  const key = `lastcall:join:${code}`;
  let id = read('sessionStorage', key, null);
  if (typeof id !== 'string' || !RANDOM_ID.test(id)) {
    id = randomId();
    write('sessionStorage', key, id);
  }
  return id;
}

export const DEFAULT_PREFS = Object.freeze({
  audio: { master: 0.7, music: 0.5, sfx: 0.8, muted: false },
  motion: 'system',
  textSize: 'standard',
  contrast: 'standard',
  manualFont: 'typewriter',
});

export function loadPrefs() {
  const saved = read('localStorage', PREFS_KEY, null);
  const legacyAudio = saved ? null : read('localStorage', LEGACY_AUDIO_KEY, null);
  return {
    ...DEFAULT_PREFS,
    ...saved,
    audio: { ...DEFAULT_PREFS.audio, ...legacyAudio, ...saved?.audio },
  };
}

export function savePrefs(prefs) {
  write('localStorage', PREFS_KEY, prefs);
}

/** The team's campaign progress, signed by the server, plus a summary to show offline. */
export function loadProgress() {
  return read('localStorage', PROGRESS_KEY, null);
}

export function saveProgress(token, campaign) {
  if (!token) return;
  write('localStorage', PROGRESS_KEY, {
    token,
    completed: campaign?.completed ?? 0,
    stars: campaign?.stars ?? 0,
    frontier: campaign?.frontier ?? null,
    savedAt: Date.now(),
  });
}

/**
 * A random id for this tab's browser session, used only for anonymous play
 * statistics. It lives in sessionStorage, so it ends when the tab closes, and
 * the server stores only a keyed hash of it.
 */
export function browserSessionId() {
  try {
    let id = readRaw('sessionStorage', 'lastcall:sid');
    if (!id || !RANDOM_ID.test(id)) {
      id = randomId();
      writeRaw('sessionStorage', 'lastcall:sid', id);
    }
    return id;
  } catch {
    return null;
  }
}

export const openingSeen = () => read('localStorage', OPENING_KEY, false) === true;
export const markOpeningSeen = () => write('localStorage', OPENING_KEY, true);

/** Chat messages not yet confirmed by the server, kept across a reload of this tab. */
export function loadPending(code) {
  return read('sessionStorage', `lastcall:pending:${code}`, []);
}

export function savePending(code, items) {
  write('sessionStorage', `lastcall:pending:${code}`, items.length ? items : null);
}

export function loadDraft(code) {
  return read('sessionStorage', `lastcall:draft:${code}`, '');
}

export function saveDraft(code, text) {
  write('sessionStorage', `lastcall:draft:${code}`, text || null);
}

export function loadNotes(code) {
  return read('sessionStorage', `lastcall:notes:${code}`, '');
}

export function saveNotes(code, text) {
  write('sessionStorage', `lastcall:notes:${code}`, text);
}
