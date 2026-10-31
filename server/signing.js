import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signs small records the server hands to browsers to keep: a team's campaign
 * progress and a seat's room ticket. Browsers can store and return them but
 * cannot forge or alter them. Tokens look like "<base64url json>.<base64url mac>".
 */
export function createSigner(secret) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('the signing secret must be at least 16 characters');
  const mac = (body) => createHmac('sha256', secret).update(body).digest('base64url');
  return {
    sign(kind, payload) {
      const body = Buffer.from(JSON.stringify({ k: kind, ...payload })).toString('base64url');
      return `${body}.${mac(body)}`;
    },
    /** The payload if `token` is a valid token of this kind, otherwise null. */
    verify(kind, token, { maxLength = 12_000 } = {}) {
      if (typeof token !== 'string' || token.length > maxLength) return null;
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const [body, sig] = parts;
      const expected = Buffer.from(mac(body));
      const given = Buffer.from(sig);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return data && typeof data === 'object' && data.k === kind ? data : null;
      } catch {
        return null;
      }
    },
  };
}

/** A short one-way fingerprint of a seat token, so tickets never contain the token itself. */
export const fingerprint = (token) => createHash('sha256').update(String(token)).digest('base64url').slice(0, 22);
