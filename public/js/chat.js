import { MAX_CHAT_LENGTH } from '/shared/constants.js';
import { $, h, clear, formatTime } from './dom.js';

const ROLE_LABEL = { caller: 'Caller', operator: 'Operator' };
const ACK_TIMEOUT_MS = 8_000;

const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).slice(0, 36);

export class ChatPanel {
  constructor({ send, audio }) {
    this.send = send;
    this.audio = audio;
    this.root = $('#chat');
    this.log = $('#chat-log');
    this.form = $('#chat-form');
    this.input = $('#chat-input');
    this.typingEl = $('#chat-typing');
    this.jump = $('#chat-jump');
    this.badge = $('#chat-badge');
    this.toggle = $('#chat-toggle');
    this.count = $('#chat-count');
    this.you = null;
    this.connected = false;
    this.pending = new Map(); // clientId -> { text, ts, status, el, timer }
    this.seen = new Set();
    this.unread = 0;
    this.lastTypingSent = 0;
    this.typingTimer = null;

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => {
      this.autosize();
      this.updateCount();
      const now = Date.now();
      if (this.input.value.trim() && now - this.lastTypingSent > 2_000) {
        this.lastTypingSent = now;
        this.send({ t: 'typing' });
      }
    });
    for (const chip of this.form.querySelectorAll('[data-quick]')) {
      chip.addEventListener('click', () => this.post(chip.dataset.quick));
    }
    this.log.addEventListener('scroll', () => {
      if (this.nearBottom()) this.jump.hidden = true;
    });
    this.jump.addEventListener('click', () => this.scrollToEnd(true));
    this.toggle.addEventListener('click', () => this.setExpanded(!this.root.classList.contains('is-expanded')));
    window.addEventListener('resize', () => {
      if (this.collapsedDock()) this.scrollToEnd(true);
    });
  }

  reset() {
    clear(this.log);
    this.pending.forEach((p) => clearTimeout(p.timer));
    this.pending.clear();
    this.seen.clear();
    this.setUnread(0);
    this.typingEl.textContent = '';
    this.input.value = '';
    this.autosize();
    this.renderEmpty();
  }

  setIdentity(you) {
    this.you = you;
    this.input.placeholder = you.role === 'caller' ? 'Describe what you see…' : 'Ask, explain, instruct…';
  }

  setExpanded(expanded) {
    this.root.classList.toggle('is-expanded', expanded);
    this.toggle.setAttribute('aria-expanded', String(expanded));
    this.toggle.querySelector('.sr-only').textContent = expanded ? 'Show less chat' : 'Show full chat';
    if (expanded) this.setUnread(0);
    this.scrollToEnd(true);
  }

  setUnread(n) {
    this.unread = n;
    this.badge.hidden = n === 0;
    this.badge.textContent = n > 9 ? '9+' : String(n);
  }

  renderEmpty() {
    if (this.log.children.length === 0) {
      this.log.append(h('li', { class: 'chat-empty' }, 'No messages yet. Say hello, then start describing.'));
    }
  }

  autosize() {
    this.input.style.setProperty('height', 'auto');
    this.input.style.setProperty('height', `${Math.min(this.input.scrollHeight + 2, 128)}px`);
  }

  updateCount() {
    const left = MAX_CHAT_LENGTH - this.input.value.length;
    this.count.hidden = left > 80;
    this.count.textContent = `${left} characters left`;
  }

  nearBottom() {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
  }

  collapsedDock() {
    return window.matchMedia('(max-width: 860px)').matches && !this.root.classList.contains('is-expanded');
  }

  scrollToEnd(force = false) {
    // The collapsed mobile dock only shows the latest lines, so it always follows them.
    if (force || this.nearBottom() || this.collapsedDock()) {
      this.log.scrollTop = this.log.scrollHeight;
      this.jump.hidden = true;
    } else {
      this.jump.hidden = false;
    }
  }

  /** Replaces the log with server history, keeping our own unsent messages. */
  load(history) {
    const stillPending = [...this.pending.entries()];
    clear(this.log);
    this.seen.clear();
    for (const message of history) this.append(message, { quiet: true });
    for (const [clientId, item] of stillPending) {
      if (history.some((m) => m.clientId === clientId && m.role === this.you?.role)) {
        clearTimeout(item.timer);
        this.pending.delete(clientId);
        continue;
      }
      this.log.append(item.el);
    }
    this.renderEmpty();
    this.scrollToEnd(true);
    this.flush();
  }

  setConnected(connected) {
    this.connected = connected;
    if (connected) this.flush();
    else {
      for (const item of this.pending.values()) {
        if (item.status === 'sending') this.setPendingState(item, 'queued');
      }
    }
  }

  submit() {
    const text = this.input.value.trim();
    if (!text) return;
    this.post(text);
    this.input.value = '';
    this.autosize();
    this.updateCount();
  }

  post(text) {
    const clientId = newId();
    const item = { clientId, text, ts: Date.now(), status: 'sending', el: null, timer: null };
    item.el = this.renderMessage(
      { kind: 'player', role: this.you?.role, name: this.you?.name, text, ts: item.ts, clientId },
      true,
    );
    this.pending.set(clientId, item);
    this.log.querySelector('.chat-empty')?.remove();
    this.log.append(item.el);
    this.scrollToEnd(true);
    this.transmit(item);
  }

  transmit(item) {
    clearTimeout(item.timer);
    if (!this.send({ t: 'chat', clientId: item.clientId, text: item.text })) {
      this.setPendingState(item, 'queued');
      return;
    }
    this.setPendingState(item, 'sending');
    item.timer = setTimeout(() => {
      this.setPendingState(item, 'failed', 'Not delivered. The connection may have dropped.');
    }, ACK_TIMEOUT_MS);
  }

  flush() {
    for (const item of this.pending.values()) {
      if (item.status === 'queued') this.transmit(item);
    }
  }

  setPendingState(item, status, reason = '') {
    item.status = status;
    const el = item.el;
    el.classList.toggle('is-pending', status === 'sending' || status === 'queued');
    el.classList.toggle('is-failed', status === 'failed');
    el.querySelector('.msg-state')?.remove();
    if (status === 'sending') {
      el.append(h('div', { class: 'msg-state' }, 'Sending…'));
    } else if (status === 'queued') {
      el.append(h('div', { class: 'msg-state' }, 'Waiting for the connection. It will send when you are back online.'));
    } else if (status === 'failed') {
      el.append(
        h(
          'div',
          { class: 'msg-state', role: 'alert' },
          reason || 'Not sent.',
          h('button', { type: 'button', onclick: () => this.transmit(item) }, 'Retry'),
          h('button', { type: 'button', onclick: () => this.discard(item) }, 'Delete'),
        ),
      );
    }
  }

  discard(item) {
    clearTimeout(item.timer);
    item.el.remove();
    this.pending.delete(item.clientId);
    this.renderEmpty();
  }

  /** A message arrived from the server (ours or theirs). */
  add(message) {
    const mine = message.kind === 'player' && message.role === this.you?.role && message.clientId && this.pending.has(message.clientId);
    if (mine) {
      const item = this.pending.get(message.clientId);
      clearTimeout(item.timer);
      this.pending.delete(message.clientId);
      const el = this.renderMessage(message, true);
      item.el.replaceWith(el);
      this.seen.add(message.id);
      this.audio.play('sent');
      return;
    }
    if (this.seen.has(message.id)) return;
    this.append(message);
  }

  append(message, { quiet = false } = {}) {
    this.seen.add(message.id);
    this.log.querySelector('.chat-empty')?.remove();
    const isMine = message.kind === 'player' && message.role === this.you?.role;
    this.log.append(this.renderMessage(message, isMine));
    if (quiet) return;
    this.scrollToEnd(isMine);
    if (message.kind === 'player' && !isMine) {
      this.typingEl.textContent = '';
      this.audio.play('incoming');
      if (this.collapsedDock() || document.hidden) this.setUnread(this.unread + 1);
    }
  }

  fail(clientId, reason, retryable, retryInMs) {
    const item = this.pending.get(clientId);
    if (!item) return;
    clearTimeout(item.timer);
    if (!retryable) {
      this.setPendingState(item, 'failed', reason);
      return;
    }
    this.setPendingState(item, 'failed', `${reason} Retrying shortly.`);
    item.timer = setTimeout(() => this.transmit(item), Math.max(retryInMs || 0, 1_000));
  }

  showTyping(name) {
    this.typingEl.textContent = `${name} is typing…`;
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => (this.typingEl.textContent = ''), 3_500);
  }

  renderMessage(message, isMine) {
    if (message.kind === 'system') {
      return h('li', { class: 'msg-system' }, message.text);
    }
    if (message.kind === 'narrator') {
      return h('li', { class: 'msg-narrator' }, h('span', { class: 'who' }, message.name || 'The Exchange'), message.text);
    }
    const label = ROLE_LABEL[message.role] || '';
    const showName = message.name && message.name !== label;
    return h(
      'li',
      { class: `msg${isMine ? ' is-mine' : ''}`, 'data-role': message.role },
      h(
        'div',
        { class: 'msg-meta' },
        showName ? h('span', { class: 'msg-name' }, isMine ? `${message.name} (you)` : message.name) : null,
        h('span', { class: 'msg-role' }, !showName && isMine ? `${label} (you)` : label),
        h('time', { datetime: new Date(message.ts).toISOString() }, formatTime(message.ts)),
      ),
      h('p', { class: 'msg-text' }, message.text),
    );
  }
}
