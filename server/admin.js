import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { silentLogger } from './logger.js';
import { RateLimiter } from './rateLimit.js';
import { MIN_PASSWORD_LENGTH, safeEqual, verifyPassword, verifyTotp } from './auth.js';
import { securityHeaders } from './static.js';

// The private Superadmin dashboard at /admin.
//
// - The only account comes from server environment variables (a username, an
//   scrypt password hash and a TOTP secret); there is no sign-up, default
//   password or other way in. Every page, asset and API checks the session on
//   the server.
// - Sessions are random 256-bit ids in a __Host- cookie (Secure, HttpOnly,
//   SameSite=Strict). Only their SHA-256 hash is stored. They expire after a
//   period of inactivity and at an absolute limit, rotate every few minutes,
//   and can be revoked from the dashboard.
// - Changes need a same-origin request with the session's CSRF token.
// - Sign-ins are rate-limited per IP and overall, and every sign-in, sign-out
//   and revocation is audited. Passwords, codes and cookies are never logged.

const ADMIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin');
export const COOKIE = '__Host-lc_admin';
const ROTATE_MS = 15 * 60_000;
const ROTATE_GRACE_MS = 30_000;
const TOUCH_MS = 30_000;
const MAX_BODY = 4_096;
const AUDIT_DAYS = 365;
// Spends the same scrypt work when the username is wrong, so timing doesn't reveal it.
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const hashId = (id) => createHash('sha256').update(id).digest('base64url');

/** Keeps only the network part of an IP address: a.b.c.0/24, or the first three groups of IPv6. */
export function truncateIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const v4 = ip.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  return null;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Why the dashboard is off, or null when it is configured. */
export function adminProblem(admin) {
  if (!admin?.username || !admin?.passwordHash) return 'ADMIN_USERNAME and ADMIN_PASSWORD_HASH are not set';
  if (admin.mfa !== 'off' && !admin.totpSecret) return 'ADMIN_TOTP_SECRET is not set (or set ADMIN_MFA=off, not recommended)';
  return null;
}

export function createAdmin({
  admin,
  db,
  analytics,
  rooms,
  clientIp,
  publicUrl = null,
  log = silentLogger,
  now = () => Date.now(),
  failDelayMs = 400,
}) {
  const problem = adminProblem(admin);
  const sessionMs = (admin?.sessionHours ?? 8) * 3_600_000;
  const idleMs = (admin?.idleMinutes ?? 30) * 60_000;
  const limits = {
    ip: new RateLimiter({ capacity: 5, perMs: 15 * 60_000 }),
    all: new RateLimiter({ capacity: 30, perMs: 15 * 60_000 }),
  };

  // ---- Responses ---------------------------------------------------------------

  const baseHeaders = (req, extra = {}) => ({
    ...securityHeaders(req),
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extra,
  });

  function send(req, res, status, body, type, extra = {}) {
    res.writeHead(status, baseHeaders(req, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra }));
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  const json = (req, res, status, body, extra) => send(req, res, status, JSON.stringify(body), 'application/json; charset=utf-8', extra);
  const notFound = (req, res) => send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');

  async function asset(req, res, name, type) {
    send(req, res, 200, await readFile(path.join(ADMIN_DIR, name), 'utf8'), type);
  }

  const cookie = (id, maxAgeMs) => `${COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`;

  function readJson(req) {
    return new Promise((resolve) => {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return resolve(null);
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          resolve(null);
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : null);
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  /** Requests that change something must come from this site's own pages. */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin) {
      const own = `${req.isHttps ? 'https' : 'http'}://${req.headers.host}`;
      return origin === own || (publicUrl && origin === publicUrl);
    }
    return req.headers['sec-fetch-site'] === 'same-origin';
  }

  // ---- Audit ---------------------------------------------------------------------

  async function audit(req, action, outcome, { actor = null, detail = null } = {}) {
    const entry = [randomUUID(), now(), actor, action, outcome, truncateIp(clientIp(req)), detail ? JSON.stringify(detail) : null];
    try {
      await db.run('INSERT INTO audit_log (id, at, actor, action, outcome, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)', entry);
    } catch (err) {
      log.error('could not write the admin audit log', { action, err: err.message });
    }
    log.info('admin audit', { action, outcome });
  }

  // ---- Sessions ------------------------------------------------------------------

  async function createSession(req) {
    const id = randomBytes(32).toString('base64url');
    const t = now();
    const handle = randomBytes(9).toString('base64url');
    await db.run(
      `INSERT INTO admin_sessions (id_hash, handle, username, csrf, created_at, rotated_at, last_seen, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [hashId(id), handle, admin.username, randomBytes(24).toString('base64url'), t, t, t, t + sessionMs, truncateIp(clientIp(req)), String(req.headers['user-agent'] || '').slice(0, 160)],
    );
    return { id, handle };
  }

  /** The signed-in session for this request, or null. May rotate the cookie. */
  async function authenticate(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const t = now();
    const h = hashId(id);
    const row = await db.get('SELECT * FROM admin_sessions WHERE id_hash = ? OR (prev_hash = ? AND prev_until > ?)', [h, h, t]);
    if (!row) return null;
    const expired = row.revoked_at != null || Number(row.expires_at) <= t || t - Number(row.last_seen) > idleMs;
    if (expired || !safeEqual(row.username, admin.username)) return null;

    const session = { handle: row.handle, csrf: row.csrf, username: row.username, expiresAt: Number(row.expires_at), setCookie: null };
    if (row.id_hash === h && t - Number(row.rotated_at) > ROTATE_MS) {
      // Rotate the cookie; the old one keeps working for a few seconds.
      const next = randomBytes(32).toString('base64url');
      await db.run('UPDATE admin_sessions SET id_hash = ?, prev_hash = ?, prev_until = ?, rotated_at = ?, last_seen = ? WHERE id_hash = ?', [
        hashId(next),
        h,
        t + ROTATE_GRACE_MS,
        t,
        t,
        h,
      ]);
      session.setCookie = cookie(next, session.expiresAt - t);
    } else if (t - Number(row.last_seen) > TOUCH_MS) {
      await db.run('UPDATE admin_sessions SET last_seen = ? WHERE handle = ?', [t, row.handle]);
    }
    return session;
  }

  // ---- Sign-in ----------------------------------------------------------------------

  const delay = () => new Promise((resolve) => setTimeout(resolve, failDelayMs * (0.75 + Math.random() * 0.5)));

  async function login(req, res) {
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'FORBIDDEN', message: 'Sign in from the Last Call admin page.' });
    const ip = clientIp(req);
    const t = now();
    const wait = limits.ip.take(ip, 1, t) || limits.all.take('all', 1, t);
    if (wait) {
      await audit(req, 'login', 'rate_limited');
      return json(
        req,
        res,
        429,
        { error: 'RATE_LIMITED', message: `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60_000)} minutes.` },
        { 'Retry-After': String(Math.ceil(wait / 1000)) },
      );
    }
    const body = await readJson(req);
    const username = typeof body?.username === 'string' ? body.username.slice(0, 64) : '';
    const password = typeof body?.password === 'string' ? body.password.slice(0, 256) : '';
    const code = typeof body?.code === 'string' ? body.code.replace(/\s/g, '').slice(0, 6) : '';

    const userOk = safeEqual(username, admin.username);
    // The length rule is checked after scrypt, so a short password costs the same time as a wrong one.
    const passOk = (await verifyPassword(password, userOk ? admin.passwordHash : DUMMY_HASH)) && password.length >= MIN_PASSWORD_LENGTH;
    let mfaOk = true;
    let step = null;
    if (admin.mfa !== 'off') {
      step = verifyTotp(admin.totpSecret, code, t);
      const last = await db.get("SELECT value FROM admin_state WHERE key = 'totp_last_step'");
      // A code can be used once: refuse a step at or before the last one accepted.
      mfaOk = step !== null && (!last || step > Number(last.value));
    }
    if (!(userOk && passOk && mfaOk)) {
      await audit(req, 'login', 'failed', { detail: { reason: !userOk || !passOk ? 'credentials' : 'code' } });
      await delay();
      return json(req, res, 401, { error: 'SIGN_IN_FAILED', message: 'Sign-in failed. Check your username, password and code, then try again.' });
    }
    if (step !== null) {
      await db.run(
        "INSERT INTO admin_state (key, value) VALUES ('totp_last_step', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [String(step)],
      );
    }
    const { id, handle } = await createSession(req);
    await audit(req, 'login', 'success', { actor: admin.username, detail: { session: handle } });
    return json(req, res, 200, { ok: true }, { 'Set-Cookie': cookie(id, sessionMs) });
  }

  // ---- Data --------------------------------------------------------------------------

  async function overview() {
    await analytics.flush();
    return {
      live: { ...rooms.liveStats(), measuredAt: now() },
      storage: { label: db.label, persistent: db.persistent, dialect: db.dialect, retentionDays: analytics.retentionDays, rollupDays: analytics.rollupDays },
      metrics: await analytics.metrics(),
    };
  }

  async function activity() {
    await analytics.flush();
    const online = rooms.onlineSessionKeys();
    return (await analytics.activity({ limit: 30 })).map((a) => ({ ...a, online: online.has(a.id) }));
  }

  async function adminSessions(current) {
    const t = now();
    const rows = await db.all(
      'SELECT handle, created_at, last_seen, expires_at, ip, user_agent FROM admin_sessions WHERE revoked_at IS NULL AND expires_at > ? AND last_seen > ? ORDER BY last_seen DESC',
      [t, t - idleMs],
    );
    return rows.map((r) => ({
      handle: r.handle,
      createdAt: Number(r.created_at),
      lastSeen: Number(r.last_seen),
      expiresAt: Number(r.expires_at),
      network: r.ip,
      browser: r.user_agent,
      current: r.handle === current.handle,
    }));
  }

  async function auditLog() {
    const rows = await db.all('SELECT at, actor, action, outcome, ip, detail FROM audit_log ORDER BY at DESC LIMIT 100');
    return rows.map((r) => ({ at: Number(r.at), actor: r.actor, action: r.action, outcome: r.outcome, network: r.ip, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  /** Housekeeping: old audit entries and long-dead sessions. */
  async function maintain() {
    const t = now();
    await db.run('DELETE FROM audit_log WHERE at < ?', [t - AUDIT_DAYS * 86_400_000]);
    await db.run('DELETE FROM admin_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [t - 30 * 86_400_000, t - 30 * 86_400_000]);
  }

  // ---- Routing -------------------------------------------------------------------------

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== '/admin' && !p.startsWith('/admin/')) return false;
    if (problem) {
      notFound(req, res);
      return true;
    }
    const get = req.method === 'GET' || req.method === 'HEAD';
    const post = req.method === 'POST';

    // Public: the sign-in page and what it needs.
    if (get && p === '/admin/assets/admin.css') return asset(req, res, 'admin.css', 'text/css; charset=utf-8').then(() => true);
    if (get && p === '/admin/assets/login.js') return asset(req, res, 'login.js', 'text/javascript; charset=utf-8').then(() => true);
    if (post && p === '/admin/login') return login(req, res).then(() => true);

    const session = await authenticate(req);
    const extra = session?.setCookie ? { 'Set-Cookie': session.setCookie } : {};

    if (get && (p === '/admin' || p === '/admin/')) {
      await asset(req, res, session ? 'dashboard.html' : 'login.html', 'text/html; charset=utf-8');
      return true;
    }
    if (!session) {
      if (p.startsWith('/admin/api/') || p.startsWith('/admin/assets/')) json(req, res, 401, { error: 'SIGNED_OUT', message: 'Sign in to continue.' });
      else notFound(req, res);
      return true;
    }

    if (get && p === '/admin/assets/dashboard.js') {
      send(req, res, 200, await readFile(path.join(ADMIN_DIR, 'dashboard.js'), 'utf8'), 'text/javascript; charset=utf-8', extra);
      return true;
    }
    if (get && p === '/admin/api/session') {
      json(req, res, 200, { username: session.username, csrf: session.csrf, expiresAt: session.expiresAt, idleMinutes: idleMs / 60_000 }, extra);
      return true;
    }
    const reads = {
      '/admin/api/overview': () => overview(),
      '/admin/api/activity': async () => ({ sessions: await activity() }),
      '/admin/api/admin-sessions': async () => ({ sessions: await adminSessions(session) }),
      '/admin/api/audit': async () => ({ entries: await auditLog() }),
    };
    if (get && reads[p]) {
      json(req, res, 200, await reads[p](), extra);
      return true;
    }

    if (post) {
      if (!sameOrigin(req) || !safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) {
        await audit(req, 'request', 'csrf_rejected', { actor: session.username, detail: { path: p } });
        json(req, res, 403, { error: 'FORBIDDEN', message: 'This request was refused. Reload the page and try again.' });
        return true;
      }
      if (p === '/admin/api/logout') {
        await db.run('UPDATE admin_sessions SET revoked_at = ? WHERE handle = ?', [now(), session.handle]);
        await audit(req, 'logout', 'success', { actor: session.username, detail: { session: session.handle } });
        json(req, res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
        return true;
      }
      if (p === '/admin/api/admin-sessions/revoke') {
        const body = await readJson(req);
        const target = typeof body?.handle === 'string' && /^[A-Za-z0-9_-]{12}$/.test(body.handle) ? body.handle : null;
        const r = target ? await db.run('UPDATE admin_sessions SET revoked_at = ? WHERE handle = ? AND revoked_at IS NULL', [now(), target]) : { changes: 0 };
        await audit(req, 'session.revoke', r.changes ? 'success' : 'not_found', { actor: session.username, detail: { session: target } });
        json(req, res, r.changes ? 200 : 404, { ok: r.changes > 0, self: target === session.handle }, target === session.handle ? { 'Set-Cookie': cookie('', 0) } : extra);
        return true;
      }
      if (p === '/admin/api/admin-sessions/revoke-others') {
        const r = await db.run('UPDATE admin_sessions SET revoked_at = ? WHERE handle <> ? AND revoked_at IS NULL', [now(), session.handle]);
        await audit(req, 'session.revoke_others', 'success', { actor: session.username, detail: { revoked: r.changes } });
        json(req, res, 200, { ok: true, revoked: r.changes }, extra);
        return true;
      }
    }
    notFound(req, res);
    return true;
  }

  return { enabled: !problem, problem, handle, maintain, authenticate };
}
