import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Password hashing (scrypt) and time-based one-time codes (TOTP, RFC 6238)
// for the admin sign-in. No third-party crypto.

const scrypt = promisify(scryptCallback);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
const MAX_N = 2 ** 17;
/** Shortest admin password accepted, both when setting it up and at sign-in. */
export const MIN_PASSWORD_LENGTH = 8;

/** "scrypt$N$r$p$salt$hash" (salt and hash in base64url). */
export async function hashPassword(password, { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p } = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N, r, p, maxmem: 128 * N * r * 2 });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function parsePasswordHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N < 2 ** 14 || N > MAX_N || (N & (N - 1)) !== 0 || r < 8 || r > 16 || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || hash.length < 32) return null;
  return { N, r, p, salt, hash };
}

/** Constant-time check of a password against a stored hash. */
export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed || typeof password !== 'string') return false;
  const { N, r, p, salt, hash } = parsed;
  const candidate = await scrypt(password.normalize('NFKC'), salt, hash.length, { N, r, p, maxmem: 128 * N * r * 2 });
  return timingSafeEqual(candidate, hash);
}

/** Compares two strings in constant time with respect to their content. */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// ---- TOTP ------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_MS = 30_000;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]+$/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

/** The 6-digit code for a 30-second step. */
export function totpCode(key, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matching step so callers can refuse its reuse, or null.
 */
export function verifyTotp(secret, code, now = Date.now()) {
  const key = base32Decode(secret);
  if (!key || key.length < 10 || typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / TOTP_STEP_MS);
  let match = null;
  for (const s of [step - 1, step, step + 1]) {
    if (safeEqual(totpCode(key, s), code)) match = s;
  }
  return match;
}

export function otpauthUri({ secret, account, issuer = 'Last Call admin' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
