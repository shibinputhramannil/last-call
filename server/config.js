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
    narrator: {
      enabled: bool('ENABLE_AI_NARRATOR') && Boolean(process.env.ANTHROPIC_API_KEY),
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    },
  };
}
