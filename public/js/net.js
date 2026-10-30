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
  createRoom: ({ name, role, mode }) => request('/api/rooms', { method: 'POST', body: JSON.stringify({ name, role, mode }) }),
  lookup: (code) => request(`/api/rooms/${encodeURIComponent(code)}`),
  join: (code, { name }) => request(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: JSON.stringify({ name }) }),
};

/** Server close reasons that mean "stop trying": reconnecting cannot help. */
const TERMINAL = new Set(['ROOM_CLOSED', 'ROOM_NOT_FOUND', 'SEAT_LOST', 'REPLACED', 'LEFT']);

const PING_EVERY_MS = 15_000;
const SILENCE_LIMIT_MS = 40_000;

export class Connection extends EventTarget {
  constructor(code, token) {
    super();
    this.code = code;
    this.token = token;
    this.ws = null;
    this.state = 'idle'; // idle | connecting | open | reconnecting | closed
    this.attempt = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.lastHeard = 0;
    this.stopped = false;
    this.onOnline = () => this.state !== 'open' && this.reconnectNow();
    this.onVisible = () => document.visibilityState === 'visible' && this.state !== 'open' && this.reconnectNow();
    window.addEventListener('online', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit('status', { state, attempt: this.attempt, ...extra });
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    ws.addEventListener('open', () => {
      this.lastHeard = Date.now();
      ws.send(JSON.stringify({ t: 'hello', code: this.code, token: this.token }));
    });

    ws.addEventListener('message', (event) => {
      this.lastHeard = Date.now();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        this.attempt = 0;
        this.setState('open');
        this.startPing();
      }
      if (msg.t === 'closed') {
        this.closedReason = msg;
      }
      if (msg.t !== 'pong') this.emit('message', msg);
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.stopPing();
      this.ws = null;
      const reason = this.closedReason;
      this.closedReason = null;
      if (this.stopped) return;
      if (reason && TERMINAL.has(reason.code)) {
        this.stop();
        this.setState('closed', { code: reason.code, message: reason.message });
        return;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // A close event always follows; reconnection is handled there.
    });
  }

  scheduleReconnect() {
    this.attempt++;
    const base = Math.min(10_000, 500 * 2 ** Math.min(this.attempt - 1, 5));
    const delay = base / 2 + Math.random() * (base / 2);
    this.retryAt = Date.now() + delay;
    this.setState('reconnecting', { retryAt: this.retryAt, offline: navigator.onLine === false });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  reconnectNow() {
    if (this.stopped || this.state === 'open' || this.state === 'connecting') return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    clearTimeout(this.retryTimer);
    this.connect();
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) {
        // The socket looks open but nothing is arriving (common after sleep or a network switch).
        this.ws.close();
        return;
      }
      this.ws.send(JSON.stringify({ t: 'ping' }));
    }, PING_EVERY_MS);
  }

  stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
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
    this.stopPing();
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }
}
