import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { normalizeRoomCode, roomCodeProblem, ROLES, MODES } from '../shared/constants.js';
import { RateLimiter } from './rateLimit.js';
import { RoomManager } from './rooms.js';
import { createStaticHandler, securityHeaders } from './static.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 2_048;
const MAX_WS_PER_IP = 12;
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 25_000;

/**
 * Builds the HTTP + WebSocket server without listening, so tests can run it on
 * an ephemeral port.
 */
export function createApp(config, { narrator = null, log = console } = {}) {
  const rooms = new RoomManager({ idleMs: config.roomIdleMs, maxMs: config.roomMaxMs, narrator });
  const serveStatic = createStaticHandler({
    '/shared/': path.join(ROOT, 'shared'),
    '/': path.join(ROOT, 'public'),
  });

  const limits = {
    create: new RateLimiter({ capacity: 8, perMs: 10 * 60_000 }),
    lookup: new RateLimiter({ capacity: 40, perMs: 5 * 60_000 }),
    connect: new RateLimiter({ capacity: 30, perMs: 60_000 }),
  };
  const socketsPerIp = new Map();

  function clientIp(req) {
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

    if (parts.length === 2 && parts[1] === 'rooms' && req.method === 'POST') {
      const wait = limits.create.take(ip);
      if (wait) return tooMany(req, res, wait);
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(req, res, 400, { error: 'BAD_REQUEST', message: 'The request could not be read.' });
      }
      const role = ROLES.includes(body.role) ? body.role : 'caller';
      const mode = MODES.includes(body.mode) ? body.mode : 'timed';
      const result = rooms.create({ name: body.name, role, mode });
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
        const result = rooms.join(code, { name: body.name });
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

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    try {
      if (url.pathname === '/healthz') {
        return sendJson(req, res, 200, { ok: true, rooms: rooms.rooms.size });
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (await serveStatic(req, res, url.pathname)) return;
      res.writeHead(404, { ...securityHeaders(req), 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      log.error('[http]', err);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'SERVER_ERROR', message: 'Something went wrong on the server.' });
      else res.end();
    }
  });

  // ---- WebSocket ----------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

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
      onConnection(ws);
    });
  });

  function onConnection(ws) {
    let room = null;
    let seat = null;
    const messageLimiter = new RateLimiter({ capacity: 40, perMs: 10_000 });
    let strikes = 0;
    ws.isAlive = true;
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
      if (isBinary) return;
      if (messageLimiter.take('m')) {
        if (++strikes > 20) closeWith('FLOOD', 'Too many messages. Reconnecting will fix this.', 4008);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

      if (!seat) {
        if (msg.t !== 'hello') return;
        const code = normalizeRoomCode(msg.code);
        if (roomCodeProblem(code) || typeof msg.token !== 'string') {
          return closeWith('ROOM_NOT_FOUND', 'That room code is not valid.', 4004);
        }
        const result = rooms.attach(code, msg.token, ws);
        if (result.error) return closeWith(result.error, result.message, 4004);
        clearTimeout(helloTimer);
        room = result.room;
        seat = result.seat;
        return;
      }
      if (msg.t === 'hello') return;
      try {
        rooms.handle(room, seat, msg);
      } catch (err) {
        log.error('[ws]', err);
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
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
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
  }, HEARTBEAT_MS);

  const sweeper = setInterval(() => rooms.sweep(), 1_000);
  const pruner = setInterval(() => {
    for (const limiter of Object.values(limits)) limiter.prune();
  }, 5 * 60_000);
  heartbeat.unref();
  sweeper.unref();
  pruner.unref();

  function close() {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    clearInterval(pruner);
    rooms.shutdown();
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, rooms, close };
}
