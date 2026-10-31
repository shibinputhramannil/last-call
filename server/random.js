import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../shared/constants.js';

/** Cryptographically random room code, e.g. "K7QM3X". */
export function newRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** 128-bit secret that lets a player reclaim their seat after a disconnect. */
export function newSeatToken() {
  return randomBytes(16).toString('base64url');
}

export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Small RNG interface so puzzles can be generated with crypto randomness in
 * production and a deterministic sequence in tests.
 */
export const cryptoRng = {
  int: (n) => randomInt(n),
};

export function seededRng(seed = 1) {
  // mulberry32
  let a = seed >>> 0;
  return {
    int(n) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(r * n);
    },
  };
}

export function shuffle(rng, items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pick(rng, items) {
  return items[rng.int(items.length)];
}

/** `n` distinct items in random order. */
export function sample(rng, items, n) {
  return shuffle(rng, items).slice(0, n);
}

/** Short random id for a stage run or room seed. */
export function newId(bytes = 6) {
  return randomBytes(bytes).toString('base64url');
}
