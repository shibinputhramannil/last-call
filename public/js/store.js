// Small wrappers around browser storage. Every access is guarded: private
// windows and locked-down browsers can throw, and the game must still work.

const SEATS_KEY = 'lastcall:seats';
const PREFS_KEY = 'lastcall:prefs';
const LEGACY_AUDIO_KEY = 'lastcall:audio';
const PROGRESS_KEY = 'lastcall:progress';
const OPENING_KEY = 'lastcall:opening-seen';
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
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
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

/** The secret token (and signed room ticket) that let this browser reclaim its seat. */
export function getSeat(code) {
  return seats()[code] || null;
}

export function saveSeat(code, token, role) {
  const all = seats();
  all[code] = { ...all[code], token, role, savedAt: Date.now() };
  write(localStorage, SEATS_KEY, all);
}

/** Keeps the latest signed ticket, which can rebuild the room after a server restart. */
export function saveTicket(code, ticket) {
  const all = seats();
  if (!all[code] || all[code].ticket === ticket) return;
  all[code].ticket = ticket;
  all[code].savedAt = Date.now();
  write(localStorage, SEATS_KEY, all);
}

export function forgetSeat(code) {
  const all = seats();
  delete all[code];
  write(localStorage, SEATS_KEY, all);
  write(sessionStorage, `lastcall:pending:${code}`, null);
}

export const DEFAULT_PREFS = Object.freeze({
  audio: { master: 0.7, music: 0.5, sfx: 0.8, muted: false },
  motion: 'system',
  textSize: 'standard',
  contrast: 'standard',
  manualFont: 'typewriter',
});

export function loadPrefs() {
  const saved = read(localStorage, PREFS_KEY, null);
  const legacyAudio = saved ? null : read(localStorage, LEGACY_AUDIO_KEY, null);
  return {
    ...DEFAULT_PREFS,
    ...saved,
    audio: { ...DEFAULT_PREFS.audio, ...legacyAudio, ...saved?.audio },
  };
}

export function savePrefs(prefs) {
  write(localStorage, PREFS_KEY, prefs);
}

/** The team's campaign progress, signed by the server, plus a summary to show offline. */
export function loadProgress() {
  return read(localStorage, PROGRESS_KEY, null);
}

export function saveProgress(token, campaign) {
  if (!token) return;
  write(localStorage, PROGRESS_KEY, {
    token,
    completed: campaign?.completed ?? 0,
    stars: campaign?.stars ?? 0,
    frontier: campaign?.frontier ?? null,
    savedAt: Date.now(),
  });
}

export const openingSeen = () => read(localStorage, OPENING_KEY, false) === true;
export const markOpeningSeen = () => write(localStorage, OPENING_KEY, true);

/** Chat messages not yet confirmed by the server, kept across a reload of this tab. */
export function loadPending(code) {
  return read(sessionStorage, `lastcall:pending:${code}`, []);
}

export function savePending(code, items) {
  write(sessionStorage, `lastcall:pending:${code}`, items.length ? items : null);
}

export function loadDraft(code) {
  return read(sessionStorage, `lastcall:draft:${code}`, '');
}

export function saveDraft(code, text) {
  write(sessionStorage, `lastcall:draft:${code}`, text || null);
}

export function loadNotes(code) {
  return read(sessionStorage, `lastcall:notes:${code}`, '');
}

export function saveNotes(code, text) {
  write(sessionStorage, `lastcall:notes:${code}`, text);
}
