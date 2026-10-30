// Small wrappers around browser storage. Every access is guarded: private
// windows and locked-down browsers can throw, and the game must still work.

const SEATS_KEY = 'lastcall:seats';
const AUDIO_KEY = 'lastcall:audio';
const SEAT_TTL_MS = 8 * 3_600_000;

function read(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

function seats() {
  const all = read(localStorage, SEATS_KEY, {});
  const now = Date.now();
  for (const [code, seat] of Object.entries(all)) {
    if (!seat || now - seat.savedAt > SEAT_TTL_MS) delete all[code];
  }
  return all;
}

/** The secret token that lets this browser reclaim its seat in a room. */
export function getSeat(code) {
  return seats()[code] || null;
}

export function saveSeat(code, token, role) {
  const all = seats();
  all[code] = { token, role, savedAt: Date.now() };
  write(localStorage, SEATS_KEY, all);
}

export function forgetSeat(code) {
  const all = seats();
  delete all[code];
  write(localStorage, SEATS_KEY, all);
}

export function loadAudioPrefs() {
  return { master: 0.7, music: 0.6, sfx: 0.8, muted: false, ...read(localStorage, AUDIO_KEY, {}) };
}

export function saveAudioPrefs(prefs) {
  write(localStorage, AUDIO_KEY, prefs);
}

export function loadNotes(code) {
  return read(sessionStorage, `lastcall:notes:${code}`, '');
}

export function saveNotes(code, text) {
  write(sessionStorage, `lastcall:notes:${code}`, text);
}
