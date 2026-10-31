import { existsSync } from 'node:fs';
import { LOG_LEVELS } from './logger.js';

// Load a local .env during development. Hosting platforms set real env vars.
if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env');
}

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function headerName(name) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return null;
  if (!/^[a-z0-9-]{1,64}$/.test(raw)) throw new Error(`${name} must be an HTTP header name such as cf-connecting-ip (got "${raw}")`);
  return raw;
}

function origin(...names) {
  for (const name of names) {
    const raw = (process.env[name] || '').trim();
    if (!raw) continue;
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${name} must be a full address such as https://last-call.example.com (got "${raw}")`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name} must start with https:// or http://`);
    return url.origin;
  }
  return null;
}

function secret(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return null;
  if (raw.length < 16) throw new Error(`${name} must be at least 16 characters long`);
  return raw;
}

function databaseUrl(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return null;
  // Never echo the value: it contains the database password.
  if (!/^postgres(ql)?:\/\//.test(raw)) throw new Error(`${name} must be a PostgreSQL connection URL starting with postgres://`);
  return raw;
}

function siteVerification(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(raw)) throw new Error(`${name} must be the content value of Google's verification meta tag`);
  return raw;
}

function oneOf(name, options, fallback) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (!options.includes(raw)) throw new Error(`${name} must be one of ${options.join(', ')} (got "${raw}")`);
  return raw;
}

export function loadConfig() {
  return {
    logLevel: oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
    port: int('PORT', 3000, { min: 0, max: 65535 }),
    host: process.env.HOST || '0.0.0.0',
    trustProxy: bool('TRUST_PROXY'),
    clientIpHeader: headerName('CLIENT_IP_HEADER'),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    // Absolute address for share previews. Render sets RENDER_EXTERNAL_URL itself.
    publicUrl: origin('PUBLIC_URL', 'RENDER_EXTERNAL_URL'),
    dataDir: (process.env.DATA_DIR || '').trim() || null,
    saveSecret: secret('SAVE_SECRET'),
    roomIdleMs: int('ROOM_IDLE_MINUTES', 30, { min: 1, max: 24 * 60 }) * 60_000,
    roomMaxMs: int('ROOM_MAX_HOURS', 4, { min: 1, max: 72 }) * 3_600_000,
    // PostgreSQL for statistics and admin sessions (else SQLite in DATA_DIR, else memory).
    databaseUrl: databaseUrl('DATABASE_URL'),
    analytics: {
      retentionDays: int('ANALYTICS_RETENTION_DAYS', 90, { min: 31, max: 3_650 }),
      rollupDays: int('ANALYTICS_ROLLUP_DAYS', 730, { min: 31, max: 3_650 }),
    },
    admin: {
      username: (process.env.ADMIN_USERNAME || '').trim() || null,
      passwordHash: (process.env.ADMIN_PASSWORD_HASH || '').trim() || null,
      totpSecret: (process.env.ADMIN_TOTP_SECRET || '').replace(/\s/g, '') || null,
      mfa: oneOf('ADMIN_MFA', ['required', 'off'], 'required'),
      sessionHours: int('ADMIN_SESSION_HOURS', 8, { min: 1, max: 24 }),
      idleMinutes: int('ADMIN_IDLE_MINUTES', 30, { min: 5, max: 240 }),
    },
    googleSiteVerification: siteVerification('GOOGLE_SITE_VERIFICATION'),
    narrator: {
      enabled: bool('ENABLE_AI_NARRATOR') && Boolean(process.env.ANTHROPIC_API_KEY),
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    },
  };
}
