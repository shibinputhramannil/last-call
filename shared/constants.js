// Values shared by the server and the browser. Nothing in this file is secret.

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
export const ROOM_CODE_LENGTH = 6;

export const MAX_NAME_LENGTH = 20;
export const MAX_CHAT_LENGTH = 400;
export const ROLES = Object.freeze(['caller', 'operator']);
export const MODES = Object.freeze(['timed', 'untimed']);

/** Strips spaces and dashes and upper-cases a typed room code. */
export function normalizeRoomCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

/** Returns null when valid, otherwise a player-facing reason. */
export function roomCodeProblem(code) {
  if (!code) return 'Enter the 6-character room code.';
  if (code.length !== ROOM_CODE_LENGTH) return `Room codes have ${ROOM_CODE_LENGTH} characters.`;
  for (const ch of code) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) {
      return 'Room codes use letters and digits, but never I, L, O, 0 or 1.';
    }
  }
  return null;
}

export function formatRoomCode(code) {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}
