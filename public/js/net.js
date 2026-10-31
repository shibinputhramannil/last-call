// HTTP calls for rooms, and a WebSocket connection that reconnects by itself.

const OFFLINE_MESSAGE = 'You appear to be offline. Check your internet connection, then try again.';
const UNREACHABLE_MESSAGE =
  'Could not reach the game server. It may be restarting or waking up, which can take about a minute. Try again shortly.';
const UNAVAILABLE_MESSAGE = 'The game server is restarting or unavailable. Wait a minute, then try again.';

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
  } catch {
    const offline = navigator.onLine === false;
    return { ok: false, status: 0, error: offline ? 'OFFLINE' : 'UNREACHABLE', message: offline ? OFFLINE_MESSAGE : UNREACHABLE_MESSAGE };
  }
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {}; // e.g. a proxy's HTML error page while the server is down
  }
  if (!res.ok) {
    const unavailable = res.status === 502 || res.status === 503 || res.status === 504;
    return {
      ok: false,
      status: res.status,
      error: body.error || (unavailable ? 'UNAVAILABLE' : 'SERVER_ERROR'),
      message: body.message || (unavailable ? UNAVAILABLE_MESSAGE : 'Something went wrong on the game server. Try again in a moment.'),
    };
  }
  return { ok: true, status: res.status, data: body };
}

export const api = {
  createRoom: ({ name, role, mode, progress }) =>
    request('/api/rooms', { method: 'POST', body: JSON.stringify({ name, role, mode, progress }) }),
  lookup: (code) => request(`/api/rooms/${encodeURIComponent(code)}`),
  join: (code, { name, progress }) =>
    request(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: JSON.stringify({ name, progress }) }),
};

/** Server close reasons that mean "stop trying": reconnecting cannot help. */
const TERMINAL = new Set(['ROOM_CLOSED', 'ROOM_NOT_FOUND', 'SEAT_LOST', 'REPLACED', 'LEFT']);

const TICK_MS = 5_000;
const PING_EVERY_MS = 15_000;
/** A ping with no reply this long after it was sent, while the page was awake, means the line is dead. */
const PING_REPLY_MS = 10_000;
/** A gap this long between ticks means the page was frozen or throttled: test again rather than judge. */
const FROZEN_GAP_MS = 20_000;
const MAX_BACKOFF_MS = 15_000;

/** Calls `fn` every TICK_MS from a Web Worker (not slowed in background tabs), or a timer as a fallback. */
function createTicker(fn) {
  let worker = null;
  let timer = null;
  try {
    worker = new Worker('/js/heartbeat-worker.js');
    worker.onmessage = fn;
  } catch {
    worker = null;
  }
  return {
    start() {
      if (worker) worker.postMessage({ start: true, everyMs: TICK_MS });
      else {
        clearInterval(timer);
        timer = setInterval(fn, TICK_MS);
      }
    },
    stop() {
      if (worker) worker.postMessage({ start: false });
      clearInterval(timer);
    },
    end() {
      this.stop();
      worker?.terminate();
    },
  };
}

/**
 * The room's WebSocket. Keeps exactly one socket at a time, reconnects with
 * backoff, and detects dead connections with app-level pings, because hosting
 * proxies can keep a socket looking open after the other end has gone.
 *
 * Emits 'status' ({ state, attempt, retryAt, offline, restarting }) and
 * 'message' (every server message except pongs).
 */
export class Connection extends EventTarget {
  constructor({ code, token, hello = () => ({}) }) {
    super();
    this.code = code;
    this.token = token;
    this.hello = hello;
    this.ws = null;
    this.state = 'idle'; // idle | connecting | open | reconnecting | closed
    this.everOpen = false;
    this.attempt = 0;
    this.retryAt = 0;
    this.retryTimer = null;
    this.restarting = false;
    this.stopped = false;
    this.lastHeard = 0;
    this.lastTick = 0;
    this.lastPingAt = 0;
    this.pingSeq = 0;
    this.probe = null; // the ping awaiting a reply: { id, sentAt }
    this.ticker = createTicker(() => this.onTick());
    this.onOnline = () => (this.state === 'open' ? this.sendProbe() : this.reconnectNow());
    this.onOffline = () => this.setState(this.state);
    this.onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (this.state === 'open') this.sendProbe();
      else this.reconnectNow();
    };
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit('status', {
      state,
      attempt: this.attempt,
      retryAt: this.retryAt,
      offline: navigator.onLine === false,
      restarting: this.restarting,
      ...extra,
    });
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.dropSocket();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let reason = null; // this socket's own close reason, never shared with a later socket
    this.setState(this.everOpen ? 'reconnecting' : 'connecting');

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      ws.send(JSON.stringify({ t: 'hello', code: this.code, token: this.token, ...this.hello() }));
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        if (this.probe && msg.id === this.probe.id) this.probe = null;
        return;
      }
      if (msg.t === 'closed') reason = msg;
      if (msg.t === 'welcome') {
        this.attempt = 0;
        this.everOpen = true;
        this.restarting = false;
        this.probe = null;
        this.lastPingAt = Date.now();
        this.lastTick = Date.now();
        this.setState('open');
        this.ticker.start();
      }
      this.emit('message', msg);
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.probe = null;
      this.ticker.stop();
      if (this.stopped) return;
      if (reason && TERMINAL.has(reason.code)) {
        this.stop();
        this.setState('closed', { code: reason.code, message: reason.message });
        return;
      }
      this.scheduleReconnect({ restarting: reason?.code === 'RESTARTING' });
    });

    ws.addEventListener('error', () => {
      // A close event always follows; reconnection is handled there.
    });
  }

  dropSocket() {
    const old = this.ws;
    this.ws = null;
    if (!old) return;
    try {
      old.close();
    } catch {
      // already closing
    }
  }

  scheduleReconnect({ restarting = false } = {}) {
    this.attempt++;
    if (restarting) this.restarting = true;
    // The first retry is almost immediate, so a blip heals before anyone notices.
    const base = this.restarting ? 2_000 * this.attempt : this.attempt === 1 ? 250 : 500 * 2 ** (this.attempt - 2);
    const delay = Math.min(MAX_BACKOFF_MS, base) * (0.75 + Math.random() * 0.5);
    this.retryAt = Date.now() + delay;
    this.setState('reconnecting');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Try now, e.g. when the network or the tab comes back. Never opens a second socket. */
  reconnectNow() {
    if (this.stopped || this.state === 'open') return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    clearTimeout(this.retryTimer);
    this.connect();
  }

  onTick() {
    const now = Date.now();
    const gap = now - (this.lastTick || now);
    this.lastTick = now;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.state !== 'open') return;
    if (gap > FROZEN_GAP_MS) {
      // The page was asleep; a reply may simply not have been processed yet.
      this.sendProbe();
      return;
    }
    if (this.probe && now - this.probe.sentAt > PING_REPLY_MS && this.lastHeard < this.probe.sentAt) {
      // The socket looks open but nothing comes back: abandon it and reconnect.
      this.ws = null;
      this.probe = null;
      this.ticker.stop();
      try {
        ws.close();
      } catch {
        // already closing
      }
      this.scheduleReconnect();
      return;
    }
    if (!this.probe && now - this.lastPingAt >= PING_EVERY_MS) this.sendPing();
  }

  sendPing() {
    const id = ++this.pingSeq;
    this.lastPingAt = Date.now();
    if (!this.probe) this.probe = { id, sentAt: this.lastPingAt };
    this.send({ t: 'ping', id });
  }

  /** Checks the line straight away with a fresh deadline. */
  sendProbe() {
    this.probe = null;
    this.sendPing();
  }

  /** Returns false if the message could not be sent right now. */
  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state !== 'open') return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ticker.end();
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.dropSocket();
  }
}
