import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { formatRoomCode, normalizeRoomCode, roomCodeProblem, ROLES, MODES } from '../shared/constants.js';
import { createAdmin } from './admin.js';
import { createLogger } from './logger.js';
import { RateLimiter } from './rateLimit.js';
import { RoomManager } from './rooms.js';
import { createSigner } from './signing.js';
import { createStaticHandler, securityHeaders } from './static.js';
import { createStore, resolveSecret } from './store.js';
import { validateMessage, validateRoomBody } from './validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_FILE = path.join(ROOT, 'public', 'index.html');
/** Room requests carry the browser's signed campaign progress, a few KB at most. */
const MAX_BODY = 16 * 1024;
const MAX_WS_PER_IP = 12;
/** Failed seat attempts (wrong token or room) allowed per IP before connections are refused for a while. */
const MAX_FAILED_ATTACH = 20;
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 25_000;
/**
 * Browsers send an app-level ping every 15 s from a Web Worker, whose timers
 * keep running in background tabs. Some proxies, including Render's, answer
 * WebSocket protocol pings themselves, so app-level silence is the reliable
 * sign that a player has gone.
 */
const SILENCE_LIMIT_MS = 70_000;
/** Time for "the server is restarting" messages to reach players before sockets close. */
const SHUTDOWN_FLUSH_MS = 750;
/** After this, remaining HTTP connections are cut so shutdown always finishes. */
const SHUTDOWN_FORCE_MS = 5_000;
const RESTARTING = {
  error: 'SERVER_RESTARTING',
  message: 'The game server is restarting. Wait a minute, then try again.',
};

const SHARE = {
  title: 'Last Call: a two-player telephone mystery',
  description:
    'One of you is trapped in an abandoned telephone exchange. The other holds the manual. Talk it through to restore 200 lines and connect the last call.',
  inviteTitle: (code) => `Join my call on Last Call (room ${formatRoomCode(code)})`,
  inviteDescription:
    'I’m on the line and need a partner. One of us sees the machines, the other holds the manual: talk it through to solve the exchange together.',
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Builds the HTTP + WebSocket server without listening, so tests can run it on
 * an ephemeral port.
 */
export function createApp(
  config,
  {
    narrator = null,
    log = createLogger('info'),
    store = createStore({ dataDir: config.dataDir, log }),
    signer = createSigner(resolveSecret({ secret: config.saveSecret, dataDir: config.dataDir }).secret),
    db = null,
    analytics = null,
    adminOptions = {},
    heartbeatMs = HEARTBEAT_MS,
    silenceLimitMs = SILENCE_LIMIT_MS,
  } = {},
) {
  let draining = false;
  let shutdownPromise = null;
  const rooms = new RoomManager({ idleMs: config.roomIdleMs, maxMs: config.roomMaxMs, narrator, signer, store, analytics, log });
  rooms.restore();
  const serveStatic = createStaticHandler({
    '/shared/': path.join(ROOT, 'shared'),
    '/': path.join(ROOT, 'public'),
  });

  const limits = {
    create: new RateLimiter({ capacity: 8, perMs: 10 * 60_000 }),
    lookup: new RateLimiter({ capacity: 40, perMs: 5 * 60_000 }),
    connect: new RateLimiter({ capacity: 30, perMs: 60_000 }),
    attach: new RateLimiter({ capacity: MAX_FAILED_ATTACH, perMs: 10 * 60_000 }),
  };
  const socketsPerIp = new Map();

  function clientIp(req) {
    if (config.trustProxy && config.clientIpHeader) {
      // A header the proxy sets to the real client IP and clients cannot forge
      // through it, e.g. Cloudflare's CF-Connecting-IP in front of Render.
      const value = String(req.headers[config.clientIpHeader] || '').split(',')[0].trim();
      if (value && value.length <= 64) return value;
    }
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // The right-most entry is the one added by our own proxy.
      if (fwd.length) return fwd[fwd.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  }

  // The private admin dashboard needs the database; without one, /admin is a 404.
  const admin = db && analytics ? createAdmin({ admin: config.admin, db, analytics, rooms, clientIp, publicUrl: config.publicUrl, log, ...adminOptions }) : null;

  function isHttps(req) {
    if (req.socket.encrypted) return true;
    if (!config.trustProxy) return false;
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  /** The public address for absolute share links: PUBLIC_URL, else the request's own host. */
  function publicOrigin(req) {
    if (config.publicUrl) return config.publicUrl;
    const host = String(req.headers.host || '');
    return `${req.isHttps ? 'https' : 'http'}://${/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? host : 'localhost'}`;
  }

  function sendJson(req, res, status, body, extra = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      ...securityHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
      ...extra,
    });
    res.end(payload);
  }

  function tooMany(req, res, waitMs) {
    sendJson(
      req,
      res,
      429,
      { error: 'RATE_LIMITED', message: 'Too many attempts from this connection. Wait a minute and try again.' },
      { 'Retry-After': String(Math.ceil(waitMs / 1000)) },
    );
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!String(req.headers['content-type'] || '').includes('application/json')) {
        reject(new Error('content-type'));
        return;
      }
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          resolve(body && typeof body === 'object' ? body : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  const joinErrors = {
    NOT_FOUND: [404, 'No room has that code. Check it with your friend; codes look like K7Q-M3X.'],
    FULL: [409, 'That room already has a Caller and an Operator.'],
  };

  async function handleApi(req, res, url) {
    const ip = clientIp(req);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', code?, 'join'?]

    // While shutting down, refuse new rooms and joins: they would vanish seconds later.
    if (draining && req.method !== 'GET') {
      return sendJson(req, res, 503, RESTARTING, { 'Retry-After': '30' });
    }

    if (parts.length === 2 && parts[1] === 'rooms' && req.method === 'POST') {
      const wait = limits.create.take(ip);
      if (wait) return tooMany(req, res, wait);
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(req, res, 400, { error: 'BAD_REQUEST', message: 'The request could not be read.' });
      }
      const clean = validateRoomBody(body);
      const role = ROLES.includes(clean.role) ? clean.role : 'caller';
      const mode = MODES.includes(clean.mode) ? clean.mode : 'timed';
      const result = rooms.create({ name: clean.name, role, mode, progress: clean.progress });
      if (result.error) return sendJson(req, res, result.error === 'BUSY' ? 503 : 400, result);
      return sendJson(req, res, 201, { code: result.room.code, token: result.seat.token, role: result.seat.role });
    }

    if (parts[1] === 'rooms' && parts.length >= 3) {
      const code = normalizeRoomCode(parts[2]);
      const problem = roomCodeProblem(code);
      const wait = limits.lookup.take(ip);
      if (wait) return tooMany(req, res, wait);
      if (problem) return sendJson(req, res, 400, { error: 'INVALID_CODE', message: problem });

      if (parts.length === 3 && req.method === 'GET') {
        return sendJson(req, res, 200, { code, ...rooms.lookup(code) });
      }
      if (parts.length === 4 && parts[3] === 'join' && req.method === 'POST') {
        let body;
        try {
          body = await readJson(req);
        } catch {
          return sendJson(req, res, 400, { error: 'BAD_REQUEST', message: 'The request could not be read.' });
        }
        const clean = validateRoomBody(body);
        const result = rooms.join(code, { name: clean.name, progress: clean.progress });
        if (result.error === 'EXPIRED') return sendJson(req, res, 410, { error: 'EXPIRED', message: result.message });
        if (result.error) {
          const [status, message] = joinErrors[result.error];
          return sendJson(req, res, status, { error: result.error, message });
        }
        return sendJson(req, res, 200, { code, token: result.seat.token, role: result.seat.role });
      }
    }
    return sendJson(req, res, 404, { error: 'NOT_FOUND', message: 'Unknown endpoint.' });
  }

  /**
   * Liveness and readiness for the host's load balancer: 200 or 503 while
   * draining, and nothing else. Player counts and history are only in the
   * signed-in admin dashboard.
   */
  function health() {
    return draining ? [503, { status: 'draining' }] : [200, { status: 'ok' }];
  }

  // The page itself carries share-preview tags with absolute URLs, so link
  // previews (WhatsApp and others) work without running any JavaScript.
  let indexCache = { mtimeMs: -1, text: '' };
  async function indexTemplate() {
    const info = await stat(INDEX_FILE);
    if (info.mtimeMs !== indexCache.mtimeMs) indexCache = { mtimeMs: info.mtimeMs, text: await readFile(INDEX_FILE, 'utf8') };
    return indexCache.text;
  }

  async function serveIndex(req, res, url) {
    const origin = publicOrigin(req);
    const code = normalizeRoomCode(url.searchParams.get('room') || '');
    const room = code && !roomCodeProblem(code) ? code : null;
    const values = {
      ORIGIN: origin,
      SHARE_URL: room ? `${origin}/?room=${room}` : `${origin}/`,
      SHARE_TITLE: room ? SHARE.inviteTitle(room) : SHARE.title,
      SHARE_DESCRIPTION: room ? SHARE.inviteDescription : SHARE.description,
      SITE_VERIFICATION: config.googleSiteVerification || '',
    };
    let template = await indexTemplate();
    // The Search Console verification tag appears only when it is configured.
    if (!values.SITE_VERIFICATION) template = template.replace(/^.*\{\{SITE_VERIFICATION\}\}.*\r?\n/m, '');
    const body = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => escapeHtml(values[key] ?? ''));
    const etag = `W/"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;
    const headers = { ...securityHeaders(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    req.isHttps = isHttps(req);
    try {
      if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        const [status, body] = health();
        return sendJson(req, res, status, body);
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (admin && (await admin.handle(req, res, url))) return;
      if ((url.pathname === '/' || url.pathname === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
        return await serveIndex(req, res, url);
      }
      if (await serveStatic(req, res, url.pathname)) return;
      res.writeHead(404, { ...securityHeaders(req), 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      log.error('request failed', { method: req.method, path: url.pathname, err });
      if (!res.headersSent) sendJson(req, res, 500, { error: 'SERVER_ERROR', message: 'Something went wrong on the game server. Try again.' });
      else res.end();
    }
  });
  // Outlive typical load-balancer idle timeouts so they never reuse a closed connection.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // ---- WebSocket ----------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (tests, curl); they hold no cookies to abuse
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.host === req.headers.host) return true;
    return config.allowedOrigins.includes(parsed.origin);
  }

  server.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return reject(400, 'Bad Request');
    }
    if (pathname !== '/ws') return reject(404, 'Not Found');
    if (draining) return reject(503, 'Service Unavailable');
    if (!originAllowed(req)) return reject(403, 'Forbidden');
    const ip = clientIp(req);
    if (limits.connect.take(ip)) return reject(429, 'Too Many Requests');
    if ((socketsPerIp.get(ip) || 0) >= MAX_WS_PER_IP) return reject(429, 'Too Many Requests');

    wss.handleUpgrade(req, socket, head, (ws) => {
      socketsPerIp.set(ip, (socketsPerIp.get(ip) || 0) + 1);
      ws.on('close', () => {
        const n = (socketsPerIp.get(ip) || 1) - 1;
        if (n <= 0) socketsPerIp.delete(ip);
        else socketsPerIp.set(ip, n);
      });
      onConnection(ws, ip);
    });
  });

  function onConnection(ws, ip) {
    let room = null;
    let seat = null;
    const messageLimiter = new RateLimiter({ capacity: 40, perMs: 10_000 });
    let strikes = 0;
    ws.isAlive = true;
    ws.lastMessageAt = Date.now();
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const closeWith = (code, message, wsCode = 4000) => {
      try {
        ws.send(JSON.stringify({ t: 'closed', code, message }));
      } catch {
        // ignore
      }
      ws.close(wsCode, code.toLowerCase());
    };

    const helloTimer = setTimeout(() => {
      if (!seat) closeWith('NO_HELLO', 'The connection timed out before joining a room.');
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      ws.lastMessageAt = Date.now();
      if (isBinary) return;
      if (messageLimiter.take('m')) {
        if (++strikes > 20) closeWith('FLOOD', 'Too many messages. Reconnecting will fix this.', 4008);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      const msg = validateMessage(parsed);
      if (!msg) {
        if (!seat && parsed?.t === 'hello') return closeWith('ROOM_NOT_FOUND', 'That room link is not valid. Ask your friend for a new one.', 4004);
        if (++strikes > 20) return closeWith('FLOOD', 'Too many malformed messages. Reconnecting will fix this.', 4008);
        if (seat) rooms.notice(room, seat, 'BAD_REQUEST', 'The exchange did not understand that request.');
        return;
      }

      if (!seat) {
        if (msg.t !== 'hello') return;
        const code = normalizeRoomCode(msg.code);
        if (roomCodeProblem(code)) return closeWith('ROOM_NOT_FOUND', 'That room code is not valid.', 4004);
        if (limits.attach.peek(ip)) {
          return closeWith('RATE_LIMITED', 'Too many attempts to join with the wrong details. Wait a few minutes, then try again.', 4029);
        }
        const result = rooms.attach(code, msg.token, ws, { ticket: msg.ticket, progress: msg.progress, sid: msg.sid });
        if (result.error) {
          limits.attach.take(ip);
          return closeWith(result.error, result.message, 4004);
        }
        clearTimeout(helloTimer);
        room = result.room;
        seat = result.seat;
        return;
      }
      if (msg.t === 'hello') return;
      try {
        rooms.handle(room, seat, msg);
      } catch (err) {
        log.error('message handling failed', { type: msg.t, room: room.code, err });
        rooms.notice(room, seat, 'SERVER_ERROR', 'Something went wrong on the server. Try that again.');
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (room && seat) rooms.detach(room, seat, ws);
    });
    ws.on('error', () => {});
  }

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      // Dead if it ignored our last protocol ping, or has gone quiet at the app level.
      if (!ws.isAlive || now - ws.lastMessageAt > silenceLimitMs) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, heartbeatMs);

  const sweeper = setInterval(() => rooms.sweep(), 1_000);
  const recorder = setInterval(() => analytics?.flush(), 5_000);
  const housekeeping = setInterval(async () => {
    try {
      await analytics?.maintain();
      await admin?.maintain();
    } catch (err) {
      log.warn('statistics housekeeping failed; will retry', { err: err.message });
    }
  }, 60 * 60_000);
  const pruner = setInterval(() => {
    for (const limiter of Object.values(limits)) limiter.prune();
  }, 5 * 60_000);
  heartbeat.unref();
  sweeper.unref();
  pruner.unref();
  recorder.unref();
  housekeeping.unref();

  /**
   * Graceful shutdown: stop taking new rooms and connections, save every room,
   * tell players the server is restarting (their browsers reconnect and resume),
   * give those messages a moment to arrive, then close everything.
   */
  function shutdown({ flushMs = SHUTDOWN_FLUSH_MS } = {}) {
    if (shutdownPromise) return shutdownPromise;
    draining = true;
    shutdownPromise = (async () => {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      clearInterval(pruner);
      clearInterval(recorder);
      clearInterval(housekeeping);
      rooms.shutdown();
      await analytics?.flush();
      if (flushMs > 0) await new Promise((resolve) => setTimeout(resolve, flushMs));
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        const force = setTimeout(() => server.closeAllConnections?.(), SHUTDOWN_FORCE_MS);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections?.();
      });
    })();
    return shutdownPromise;
  }

  return { server, rooms, admin, shutdown, close: () => shutdown({ flushMs: 0 }), isDraining: () => draining };
}
