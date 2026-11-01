import { formatRoomCode, normalizeRoomCode, roomCodeProblem } from '/shared/constants.js';
import { CHAPTERS, stageById } from '/shared/campaign.js';
import { AudioEngine } from './audio.js';
import { renderCaller } from './caller.js';
import { ChatPanel } from './chat.js';
import { $, $$, h, clear, announce, toast, copyText, formatClock, prefersReducedMotion } from './dom.js';
import { renderManual } from './manual.js';
import { createMap } from './map.js';
import { api, Connection, isTransient, retrying } from './net.js';
import { renderResult } from './result.js';
import { setupSettings } from './settings.js';
import { runOpening } from './story.js';
import {
  browserSessionId,
  forgetSeat,
  getSeat,
  joinAttemptId,
  loadPrefs,
  loadProgress,
  saveProgress,
  saveSeat,
  saveTicket,
  startVisit,
} from './store.js';

const ROLE_LABEL = { caller: 'Caller', operator: 'Operator' };
const ANSWER_TIMEOUT_MS = 6_000;
/** A connection drop shorter than this is never shown: most blips heal on the first retry. */
const QUIET_DROP_MS = 1_500;
/** After this long without a connection, a banner explains what is happening. */
const BANNER_AFTER_MS = 10_000;
/** A request or connection still waiting after this long explains that the server may be waking up. */
const SLOW_MS = 4_000;
/** After this long, the joining screen also suggests the network may be blocking the connection. */
const VERY_SLOW_MS = 45_000;
/** Joining from the start screen shows the joining screen only if it takes longer than this. */
const CONNECT_SCREEN_DELAY_MS = 400;
const WAKING_TEXT = 'Waking the game server. If nobody has played for a while, this takes up to a minute.';

const audio = new AudioEngine(loadPrefs().audio);

const app = {
  code: null,
  conn: null,
  connectTimer: null,
  enteredAt: 0,
  state: null,
  stateAt: 0,
  campaign: null,
  screen: null,
  puzzleKey: null,
  stageKey: null,
  controller: null,
  result: null, // { key, ctl }
  answerTimer: null,
  holdUntil: 0,
  holdTimer: null,
  welcomed: false,
  downSince: 0,
  outageShown: false,
  announcedMinutes: new Set(),
};

const chat = new ChatPanel({
  send: (msg) => (app.conn ? app.conn.send(msg) : false),
  audio,
});

const map = createMap($('#map'), {
  onPlay: (stageId) => {
    if (!app.conn?.send({ t: 'play', stageId })) toast('Not connected, so the stage did not start. Try again in a moment.', 'error');
    audio.unlock();
  },
});

// ---- Screens ----------------------------------------------------------------

const shell = $('#shell');
const ROOM_SCREENS = ['lobby', 'game', 'result'];

/** Screens: story, connect (loading or joining), menu, and the room's lobby, game and result. */
function showScreen(name) {
  const changed = app.screen !== name;
  app.screen = name;
  $('#screen-story').hidden = name !== 'story';
  $('#screen-connect').hidden = name !== 'connect';
  shell.hidden = name === 'story' || name === 'connect';
  for (const id of ['menu', ...ROOM_SCREENS]) $(`#screen-${id}`).hidden = id !== name;
  const inRoom = ROOM_SCREENS.includes(name);
  shell.classList.toggle('with-chat', inRoom);
  shell.classList.toggle('in-room', inRoom);
  document.body.classList.toggle('in-room', inRoom);
  $('#chat').hidden = !inRoom;
  $('#presence').hidden = !inRoom;
  $('#stage-indicator').hidden = name !== 'game';
  $('#timer').hidden = name !== 'game';
  if (changed) {
    const game = app.state?.game;
    audio.setMood(
      name === 'game' ? 'game' : name === 'result' ? (game?.phase === 'finale' ? 'won' : game?.phase === 'failed' ? 'lost' : 'result') : name === 'lobby' ? 'lobby' : 'menu',
    );
    if (name !== 'story') {
      const heading = $(`#screen-${name} h1`);
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
      window.scrollTo(0, 0);
    }
  }
}

function showOverlay({ title, body, actions = [], tone = '', dismissable = false }) {
  const overlay = $('#overlay');
  const card = overlay.querySelector('.overlay-card');
  card.className = `overlay-card ${tone}`;
  $('#overlay-title').textContent = title;
  const bodyEl = clear($('#overlay-body'));
  if (typeof body === 'string') bodyEl.append(h('p', {}, body));
  else if (body) bodyEl.append(body);
  const actionsEl = clear($('#overlay-actions'));
  for (const action of actions) {
    actionsEl.append(h('button', { class: `btn ${action.primary ? 'btn-lamp' : ''}`, type: 'button', onclick: action.onClick }, action.label));
  }
  overlay.dataset.dismissable = dismissable ? 'true' : '';
  const wasHidden = overlay.hidden;
  overlay.hidden = false;
  if (wasHidden) {
    app.overlayReturn = document.activeElement;
    (actionsEl.querySelector('.btn-lamp') || actionsEl.querySelector('button') || card).focus();
  }
}

function hideOverlay() {
  const overlay = $('#overlay');
  if (overlay.hidden) return;
  overlay.hidden = true;
  if (app.overlayReturn && document.contains(app.overlayReturn)) app.overlayReturn.focus();
  app.overlayReturn = null;
}

// Keep keyboard focus inside the overlay while it is open.
document.addEventListener('keydown', (e) => {
  const overlay = $('#overlay');
  if (overlay.hidden) return;
  if (e.key === 'Escape' && overlay.dataset.dismissable) {
    hideOverlay();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusable = $$('button, [href], input', overlay).filter((el) => !el.disabled);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// ---- Opening story ---------------------------------------------------------------

function startOpening(then) {
  showScreen('story');
  runOpening({ audio, onDone: then });
}

/** After a replay from Settings: back to wherever the player was. */
function returnFromOpening() {
  app.screen = null;
  if (app.code && app.state) render();
  else if (app.code && app.conn) showConnect();
  else showMenu();
}

// ---- Menu -------------------------------------------------------------------

function showMenu({ banner = null, bannerTone = 'error', joinCode = null } = {}) {
  showScreen('menu');
  const bannerEl = $('#menu-banner');
  bannerEl.hidden = !banner;
  bannerEl.textContent = banner || '';
  bannerEl.classList.toggle('is-info', bannerTone === 'info');
  const saved = loadProgress();
  const progress = $('#menu-progress');
  progress.hidden = !saved?.completed;
  if (saved?.completed) {
    progress.textContent = `Saved in this browser: ${saved.completed} of 200 stages restored, ${saved.stars} stars. Open or join a room to carry on.`;
  }
  const menu = $('#screen-menu');
  menu.classList.toggle('invited', Boolean(joinCode));
  // Whoever arrived by invite should see "Join room" as the main action.
  $('#create-form [type="submit"]').classList.toggle('btn-lamp', !joinCode);
  $('#join-form [type="submit"]').classList.toggle('btn-lamp', Boolean(joinCode));
  if (joinCode) {
    const input = $('#join-form [name="code"]');
    input.value = formatRoomCode(joinCode);
    checkJoinCode();
    $('#join-form [name="name"]').focus();
  }
}

function setFormBusy(form, busy, label) {
  const button = form.querySelector('[type="submit"]');
  button.disabled = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

function formError(form, message) {
  const el = form.querySelector('.form-error');
  el.hidden = !message;
  el.textContent = message || '';
}

let lookupSeq = 0;
let lookupTimer = null;
/** Looks up the code in the join form as it is typed, retrying by itself while the server cannot be reached. */
function checkJoinCode({ now = false } = {}) {
  const input = $('#join-form [name="code"]');
  const status = $('#join-status');
  const code = normalizeRoomCode(input.value);
  status.className = 'join-status';
  input.removeAttribute('aria-invalid');
  $('#join-recheck').hidden = true;
  clearTimeout(lookupTimer);
  const seq = ++lookupSeq; // also stops a lookup still retrying for an earlier code
  if (code.length < 6) {
    status.textContent = '';
    return;
  }
  const problem = roomCodeProblem(code);
  if (problem) {
    status.textContent = problem;
    status.classList.add('is-bad');
    input.setAttribute('aria-invalid', 'true');
    return;
  }
  status.textContent = 'Checking the code…';
  lookupTimer = setTimeout(
    async () => {
      const res = await retrying(() => api.lookup(code), {
        cancelled: () => seq !== lookupSeq,
        onRetry: () => (status.textContent = 'Can’t reach the game server yet. It may be waking up; checking again…'),
      });
      if (seq === lookupSeq) showLookup(res);
    },
    now ? 0 : 250,
  );
}

function showLookup(res) {
  const input = $('#join-form [name="code"]');
  const status = $('#join-status');
  const recheck = $('#join-recheck');
  const say = (text, tone, { invalid = false, canRecheck = false } = {}) => {
    status.textContent = text;
    status.classList.add(tone);
    if (invalid) input.setAttribute('aria-invalid', 'true');
    recheck.hidden = !canRecheck;
  };
  if (!res.ok) return say(res.message, 'is-bad', { canRecheck: isTransient(res) });
  const d = res.data;
  if (d.status === 'open') {
    say(d.hostName ? `${d.hostName} is waiting. You will be the ${ROLE_LABEL[d.role]}.` : `Room found. You will be the ${ROLE_LABEL[d.role]}.`, 'is-good');
  } else if (d.status === 'full') {
    say('That room already has a Caller and an Operator. Ask your friend for a new invite, or open your own room.', 'is-bad', { canRecheck: true });
  } else if (d.status === 'expired') {
    say(d.message, 'is-bad');
  } else {
    say(
      'No room has that code right now. Check it with your friend. If the game server just restarted, the room comes back once your friend’s game reconnects.',
      'is-bad',
      { invalid: true, canRecheck: true },
    );
  }
}

function setupMenu() {
  const createForm = $('#create-form');
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError(createForm, null);
    const data = new FormData(createForm);
    const status = createForm.querySelector('.form-status');
    setFormBusy(createForm, true, 'Opening…');
    const slow = setTimeout(() => {
      status.hidden = false;
      status.textContent = WAKING_TEXT;
    }, SLOW_MS);
    const res = await api.createRoom({ name: data.get('name'), role: data.get('role'), mode: data.get('mode'), progress: loadProgress()?.token });
    clearTimeout(slow);
    status.hidden = true;
    status.textContent = '';
    setFormBusy(createForm, false);
    if (!res.ok) {
      formError(createForm, res.message);
      return;
    }
    saveSeat(res.data.code, res.data.token, res.data.role);
    enterRoom(res.data.code, res.data.token);
  });

  const joinForm = $('#join-form');
  const codeInput = joinForm.querySelector('[name="code"]');
  codeInput.addEventListener('input', () => {
    const raw = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const formatted = raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
    if (codeInput.value !== formatted) codeInput.value = formatted;
    formError(joinForm, null);
    checkJoinCode();
  });
  codeInput.addEventListener('paste', (e) => {
    // Accept a pasted invite link as well as a bare code.
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    const match = text.match(/[?&]room=([A-Za-z0-9-]+)/);
    if (match) {
      e.preventDefault();
      codeInput.value = match[1];
      codeInput.dispatchEvent(new Event('input'));
    }
  });
  $('#join-recheck').addEventListener('click', () => checkJoinCode({ now: true }));
  let joining = false;
  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (joining) return; // one join at a time, however often the button is pressed
    formError(joinForm, null);
    const code = normalizeRoomCode(codeInput.value);
    const problem = roomCodeProblem(code);
    if (problem) {
      formError(joinForm, problem);
      codeInput.setAttribute('aria-invalid', 'true');
      codeInput.focus();
      return;
    }
    const existing = getSeat(code);
    if (existing) {
      enterRoom(code, existing.token);
      return;
    }
    joining = true;
    lookupSeq++; // the join's progress replaces the code check
    clearTimeout(lookupTimer);
    const status = $('#join-status');
    const progress = (text) => {
      status.className = 'join-status';
      status.textContent = text;
      $('#join-recheck').hidden = true;
    };
    setFormBusy(joinForm, true, 'Joining…');
    const slow = setTimeout(() => progress(WAKING_TEXT), SLOW_MS);
    // Every attempt carries the same join id, so a retry gets the seat the
    // first attempt was given (if it arrived) rather than a second seat.
    const body = { name: joinForm.querySelector('[name="name"]').value, progress: loadProgress()?.token, joinId: joinAttemptId(code) };
    const res = await retrying(() => api.join(code, body), {
      cancelled: () => app.screen !== 'menu' || normalizeRoomCode(codeInput.value) !== code,
      onRetry: () => progress('Still trying to reach the game server…'),
    });
    clearTimeout(slow);
    joining = false;
    setFormBusy(joinForm, false);
    progress('');
    if (!res.ok) {
      formError(joinForm, res.message);
      return;
    }
    saveSeat(code, res.data.token, res.data.role);
    enterRoom(code, res.data.token);
  });
}

// ---- Room connection ----------------------------------------------------------

function setRoomUrl(code) {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

const inviteLink = () => `${location.origin}/?room=${app.code}`;

function enterRoom(code, token) {
  leaveConnection();
  app.code = code;
  app.state = null;
  app.campaign = null;
  app.welcomed = false;
  app.downSince = 0;
  app.outageShown = false;
  app.puzzleKey = null;
  app.stageKey = null;
  app.enteredAt = Date.now();
  setRoomUrl(code);
  chat.reset(code);

  const conn = new Connection({
    code,
    token,
    // Read fresh on every attempt: after a server restart these rebuild the room.
    hello: () => ({ ticket: getSeat(code)?.ticket, progress: loadProgress()?.token, sid: browserSessionId() }),
  });
  app.conn = conn;
  conn.addEventListener('status', (e) => onConnStatus(e.detail));
  conn.addEventListener('message', (e) => onMessage(e.detail));
  // Straight after loading, the joining screen shows at once. From another
  // screen it waits a moment, so a quick join goes straight to the room.
  if (!app.screen || app.screen === 'connect') showConnect();
  else app.connectTimer = setTimeout(showConnect, CONNECT_SCREEN_DELAY_MS);
  conn.connect();
}

/** The joining screen: which room, what is happening, and what the player can do about it. */
function showConnect() {
  if (!app.conn || app.welcomed || app.screen === 'story') return;
  showScreen('connect');
  renderConnect();
}

const setText = (el, text) => {
  // Unchanged text is left alone, so screen readers do not hear it again.
  if (el.textContent !== text) el.textContent = text;
};

function renderConnect() {
  const conn = app.conn;
  if (!conn || app.welcomed) return;
  const waited = Date.now() - app.enteredAt;
  const offline = navigator.onLine === false;
  const slow = conn.attempt >= 2 || waited > SLOW_MS;
  setText($('#connect-title'), `Room ${formatRoomCode(app.code)}`);
  setText(
    $('#connect-detail'),
    offline
      ? 'You’re offline. Last Call connects as soon as your internet is back.'
      : conn.restarting
        ? 'The game server is restarting. This usually takes under a minute.'
        : waited > VERY_SLOW_MS
          ? 'Still can’t reach the game server. It may be restarting, or this network may be blocking the connection: keep waiting, or try another network (for example, mobile data).'
          : slow
            ? WAKING_TEXT
            : 'Opening the line…',
  );
  const seconds = Math.ceil((conn.retryAt - Date.now()) / 1000);
  setText($('#connect-retry'), slow && !offline && conn.state === 'reconnecting' ? (seconds > 0 ? `Trying again in ${seconds} s.` : 'Trying again now…') : '');
  $('#connect-try').hidden = !slow || conn.state === 'connecting';
  $('#connect-back').hidden = false;
}

function leaveConnection() {
  if (app.conn) app.conn.stop();
  app.conn = null;
  clearTimeout(app.connectTimer);
  $('#conn-banner').hidden = true;
  app.controller?.destroy();
  app.controller = null;
  app.result?.ctl.destroy();
  app.result = null;
  clearTimeout(app.holdTimer);
  app.holdUntil = 0;
  audio.stopEffects();
}

/**
 * Back to the start screen. `forget` drops this browser's seat: right after
 * leaving, or when the server says the seat or room is gone. Otherwise the seat
 * is kept, so the invite link (or the code) takes the player straight back.
 */
function leaveRoom({ local = false, forget = true, banner = null, bannerTone, joinCode = null } = {}) {
  // Tell the server so the seat is freed; we finish locally without waiting for its reply.
  if (!local) app.conn?.send({ t: 'leave' });
  if (app.code && forget) forgetSeat(app.code);
  leaveConnection();
  app.code = null;
  app.state = null;
  setRoomUrl(joinCode); // an invite worth retrying stays in the address, so a reload keeps it
  hideOverlay();
  showMenu({ banner, bannerTone, joinCode });
}

function confirmLeave() {
  showOverlay({
    title: 'Leave this room?',
    body: 'Your seat will be freed so someone else can join with the code. Your partner stays in the room, and your campaign progress stays saved in this browser.',
    dismissable: true,
    actions: [
      { label: 'Stay', onClick: hideOverlay },
      { label: 'Leave room', primary: true, onClick: () => leaveRoom() },
    ],
  });
}

function onConnStatus(detail) {
  if (detail.state === 'open') {
    app.downSince = 0;
    chat.setConnected(true);
    $('#conn-banner').hidden = true;
  } else if (detail.state === 'closed') {
    $('#conn-banner').hidden = true;
    onClosed(detail.code, detail.message);
    return;
  } else {
    chat.setConnected(false);
    if (detail.state === 'reconnecting' && !app.downSince) app.downSince = Date.now();
  }
  tickConnection();
}

/** Connected, Reconnecting or Offline, with a short drop never shown at all. */
function connectionLabel() {
  const conn = app.conn;
  if (!conn) return null;
  if (conn.state === 'open') return 'connected';
  if (navigator.onLine === false) return 'offline';
  if (!app.welcomed) return 'connecting';
  if (conn.restarting) return 'reconnecting';
  return Date.now() - app.downSince < QUIET_DROP_MS ? 'connected' : 'reconnecting';
}

function tickConnection() {
  const conn = app.conn;
  if (!conn) return;
  if (!app.welcomed && app.screen === 'connect') renderConnect();
  const label = connectionLabel();
  const pill = $('#conn-status');
  pill.classList.toggle('is-live', label === 'connected');
  pill.classList.toggle('is-waiting', label === 'reconnecting' || label === 'connecting');
  pill.classList.toggle('is-lost', label === 'offline');
  pill.querySelector('.status-text').textContent = { connected: 'Connected', reconnecting: 'Reconnecting…', offline: 'Offline', connecting: 'Connecting…' }[label];
  if (label === 'reconnecting' || label === 'offline') app.outageShown = true;

  const banner = $('#conn-banner');
  if (conn.state === 'open' || !app.welcomed) {
    banner.hidden = true;
    return;
  }
  const down = Date.now() - app.downSince;
  const show = conn.restarting || down > BANNER_AFTER_MS || (label === 'offline' && down > 3_000);
  if (show && banner.hidden) announce(label === 'offline' ? 'You are offline. Reconnecting when your internet is back.' : 'Reconnecting to the game server.');
  banner.hidden = !show;
  const seconds = Math.ceil((conn.retryAt - Date.now()) / 1000);
  const when = seconds > 0 ? `in ${seconds} s` : 'now';
  const kept = 'Your seat, stage, score and unsent messages are kept.';
  if (label === 'offline') {
    $('#conn-banner-title').textContent = 'You are offline';
    $('#conn-banner-detail').textContent = `Last Call reconnects as soon as your internet is back. ${kept}`;
  } else if (conn.restarting) {
    $('#conn-banner-title').textContent = 'The game server is restarting';
    $('#conn-banner-detail').textContent = `This usually takes under a minute. Reconnecting ${when}. ${kept}`;
  } else {
    $('#conn-banner-title').textContent = 'Reconnecting';
    $('#conn-banner-detail').textContent = `Trying again ${when}. ${kept}`;
  }
}

function onClosed(code, message) {
  const roomCode = app.code;
  if (code === 'REPLACED') {
    leaveConnection();
    showOverlay({
      title: 'Open in another tab',
      body: 'This room is now open in another tab or on another device. Only one can be connected at a time.',
      actions: [
        // The other tab is still using this seat, so it must not be forgotten here.
        { label: 'Back to start', onClick: () => leaveRoom({ local: true, forget: false }) },
        {
          label: 'Play here instead',
          primary: true,
          onClick: () => {
            hideOverlay();
            const seat = getSeat(roomCode);
            if (seat) enterRoom(roomCode, seat.token);
            else leaveRoom({ local: true });
          },
        },
      ],
    });
    return;
  }
  if (code === 'LEFT') {
    leaveRoom({ local: true, banner: 'You left the room.', bannerTone: 'info' });
    return;
  }
  if (code === 'SEAT_LOST') {
    leaveRoom({ local: true, banner: message, joinCode: roomCode });
    return;
  }
  if (code === 'RATE_LIMITED') {
    leaveRoom({ local: true, forget: false, banner: message, joinCode: roomCode });
    return;
  }
  leaveRoom({ local: true, banner: message || 'This room has closed. Open a new room to play again.' });
}

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome': {
      const first = !app.welcomed;
      app.welcomed = true;
      clearTimeout(app.connectTimer);
      app.campaign = msg.campaign;
      saveProgress(msg.progress, msg.campaign);
      chat.setIdentity(msg.state.you);
      chat.load(msg.chat);
      app.state = null; // a welcome always replaces what we had
      applyState(msg.state);
      chat.scrollToEnd(true);
      if (first) audio.play('join');
      else if (app.outageShown) toast('Back on the line.', 'good', 2500);
      app.outageShown = false;
      break;
    }
    case 'state':
      if (app.state && msg.state.rev < app.state.rev) break; // an older update
      applyState(msg.state);
      break;
    case 'progress':
      app.campaign = msg.campaign;
      saveProgress(msg.token, msg.campaign);
      if (app.screen === 'lobby') renderLobby();
      break;
    case 'chat':
      chat.add(msg.message);
      break;
    case 'chat-error':
      chat.fail(msg.clientId, msg.message, msg.retryable, msg.retryInMs);
      break;
    case 'typing': {
      const partner = app.state?.players.find((p) => p.role === msg.role);
      chat.showTyping(partner?.name || ROLE_LABEL[msg.role]);
      break;
    }
    case 'notice':
      settleAnswer();
      toast(msg.message, 'error');
      break;
    case 'event':
      if (msg.name === 'stage-started') audio.play('ring');
      break;
    case 'answer-result':
      onAnswerResult(msg);
      break;
    default:
      break;
  }
}

// ---- State --------------------------------------------------------------------

const partnerOf = (state) => state.players.find((p) => !p.you);
const partnerReady = () => {
  const p = app.state && partnerOf(app.state);
  return Boolean(p?.connected) && app.conn?.state === 'open';
};
const waitingText = () => {
  const p = app.state && partnerOf(app.state);
  if (!p?.present) return `Waiting for the ${ROLE_LABEL[p?.role || 'operator']} to join. Send them the invite link.`;
  if (!p.connected) return `Waiting for ${p.name} to reconnect.`;
  return 'Reconnecting…';
};

function applyState(state) {
  const prev = app.state;
  app.state = state;
  app.stateAt = Date.now();
  if (state.ticket) saveTicket(app.code, state.ticket);
  chat.setIdentity(state.you);

  if (prev) {
    const before = partnerOf(prev);
    const after = partnerOf(state);
    if (before.role === after.role && after.present) {
      if (!before.present) {
        audio.play('join');
        announce(`${after.name} joined as the ${ROLE_LABEL[after.role]}.`);
      } else if (before.connection === 'offline' && after.connection === 'online') {
        audio.play('join');
        announce(`${after.name} is back on the line.`);
      } else if (before.connection !== 'offline' && after.connection === 'offline') {
        audio.play('drop');
        toast(`${after.name} lost the line.${state.game.phase === 'playing' ? ' The stage clock is held until they are back.' : ''}`, 'error');
      }
    }
    const prevHints = prev.game.puzzle?.hints.length ?? 0;
    if (state.game.puzzle && prev.game.puzzle?.id === state.game.puzzle.id && state.game.puzzle.hints.length > prevHints) audio.play('hint');
  }
  render();
}

function render() {
  const state = app.state;
  if (!state || app.screen === 'story') return;
  renderPresence();
  const phase = state.game.phase;
  if (phase !== 'playing' && phase !== 'lobby' && Date.now() < app.holdUntil) return; // let the last solve land
  if (phase === 'lobby') {
    showScreen('lobby');
    renderLobby();
  } else if (phase === 'playing') {
    if (Date.now() < app.holdUntil && app.screen === 'game') {
      renderStageIndicator();
      return;
    }
    showScreen('game');
    renderGame();
  } else {
    showScreen('result');
    renderResultScreen();
  }
}

function renderPresence() {
  tickConnection();
  const state = app.state;
  const pill = $('#partner-status');
  if (!state) {
    pill.hidden = true;
    return;
  }
  const p = partnerOf(state);
  pill.hidden = false;
  pill.className = 'partner-status';
  const text = pill.querySelector('.status-text');
  if (!p.present) {
    pill.classList.add('is-waiting');
    text.textContent = `Waiting for the ${ROLE_LABEL[p.role]}`;
  } else if (p.connection === 'online') {
    pill.classList.add('is-live');
    text.textContent = `${p.name} is on the line`;
  } else if (p.connection === 'reconnecting') {
    pill.classList.add('is-waiting');
    text.textContent = `${p.name} is reconnecting`;
  } else {
    pill.classList.add('is-lost');
    text.textContent = `${p.name} lost the line`;
  }
}

// ---- Lobby and stage map ----------------------------------------------------------

function renderLobby() {
  const state = app.state;
  if (!state || !app.campaign) return;
  const partner = partnerOf(state);
  const together = partner.present && partner.connected;
  $('#lobby-code').textContent = formatRoomCode(state.room.code);
  $('#share-link').hidden = typeof navigator.share !== 'function';
  $('#ticket').classList.toggle('is-compact', together);
  $('#ticket-help').textContent = together
    ? `${partner.name} is on the line. Pick a stage below; either of you can start it.`
    : 'Send the link to your partner. They can also type the code on the start screen.';

  const seats = clear($('#seats'));
  for (const p of state.players) {
    const lampClass = p.connection === 'online' ? 'is-live' : p.present ? (p.connection === 'reconnecting' ? 'is-waiting' : 'is-lost') : 'is-waiting';
    const who = p.you
      ? 'This is you'
      : p.connection === 'online'
        ? `${p.name} is on the line`
        : p.present
          ? `${p.name} is ${p.connection === 'reconnecting' ? 'reconnecting' : 'away'}`
          : 'Waiting for someone to join';
    seats.append(
      h(
        'div',
        { class: `seat ${lampClass}${p.you ? ' is-you' : ''}`, 'data-role': p.role },
        h('span', { class: 'lamp-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'seat-role' }, ROLE_LABEL[p.role], p.you ? h('span', { class: 'you-tag' }, 'You') : null),
        h('span', { class: 'seat-who' }, p.you && p.name !== ROLE_LABEL[p.role] ? `${p.name}. ${who}` : who),
      ),
    );
  }

  const role = state.you.role;
  const briefing = clear($('#briefing'));
  briefing.append(
    h('summary', {}, `You are the ${ROLE_LABEL[role]}: what that means`),
    h(
      'ul',
      {},
      (role === 'caller'
        ? [
            'You are inside the exchange. You see symbols, lamps and machines your Operator cannot.',
            'Describe exactly what you see: shapes, colours, numbers and their order.',
            'Only you can work the machines. Wait for your Operator’s instructions before you act.',
            'You cannot see the manual, so ask questions and repeat instructions back.',
          ]
        : [
            'You hold the field manual. You cannot see inside the exchange.',
            'Ask the Caller to describe what they see, then find it in the manual.',
            'Give one clear instruction at a time and have the Caller repeat it back.',
            'Your notepad under the manual is private. Use it to keep track.',
          ]
      ).map((t) => h('li', {}, t)),
    ),
  );

  for (const radio of $$('[name="lobby-mode"]')) radio.checked = radio.value === state.room.mode;
  map.render({ campaign: app.campaign, canPlay: partnerReady(), waitingText: waitingText(), mode: state.room.mode });
}

// ---- A stage in play ---------------------------------------------------------------

function renderStageIndicator() {
  const game = app.state.game;
  const stage = stageById(game.stageId);
  if (!stage) return;
  $('#stage-indicator-ref').textContent = `Stage ${stage.id}`;
  const lamps = clear($('#puzzle-lamps'));
  game.puzzles.forEach((p, i) => {
    const current = game.phase === 'playing' && i === game.puzzleIndex && !p.solved;
    lamps.append(
      h(
        'li',
        { class: `${p.solved ? 'is-done' : ''}${current ? ' is-current is-live' : ''}`, 'aria-current': current ? 'step' : null },
        h('span', { class: 'lamp-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'puzzle-lamp-title' }, p.title),
        h('span', { class: 'sr-only' }, p.solved ? ' (restored)' : current ? ' (current)' : ''),
      ),
    );
  });
}

function renderGame() {
  const state = app.state;
  const game = state.game;
  const stage = stageById(game.stageId);
  renderStageIndicator();
  tickTimer();

  if (app.stageKey !== game.runId) {
    app.stageKey = game.runId;
    app.announcedMinutes.clear();
    const chapter = CHAPTERS[stage.chapter - 1];
    const head = clear($('#stage-head'));
    head.classList.remove('is-arriving');
    head.append(
      h('p', { class: 'stage-ref' }, `Stage ${stage.id}, ${chapter.title}`),
      h('h1', { class: 'stage-title', tabindex: '-1' }, stage.title),
      h('p', { class: 'stage-beat' }, stage.beat),
    );
    if (!prefersReducedMotion()) {
      void head.offsetWidth;
      head.classList.add('is-arriving');
    }
  }

  const p = game.puzzle;
  const key = `${p.id}:${state.you.role}`;
  if (key !== app.puzzleKey) {
    const moving = app.puzzleKey != null;
    app.controller?.destroy();
    app.controller = null;
    app.puzzleKey = key;
    const box = clear($('#stage'));
    box.classList.remove('is-entering');
    box.append(
      h(
        'header',
        { class: 'puzzle-head' },
        h('p', { class: 'puzzle-count' }, `Puzzle ${p.number} of ${game.puzzles.length}`),
        h('h2', { class: 'puzzle-title', id: 'puzzle-title', tabindex: '-1' }, p.title),
        state.you.role === 'caller' ? h('p', { class: 'puzzle-intro' }, p.view.intro) : null,
      ),
    );
    const body = h('div', {});
    box.append(body);
    app.controller =
      state.you.role === 'caller'
        ? renderCaller(body, p, { audio, submit: submitAnswer })
        : renderManual(body, p, { roomCode: state.room.code });
    if (moving) {
      if (!prefersReducedMotion()) {
        void box.offsetWidth;
        box.classList.add('is-entering');
      }
      $('#puzzle-title').focus({ preventScroll: false });
    }
  }
  renderHints();
}

// ---- Answers ------------------------------------------------------------------

function submitAnswer(answer) {
  const puzzle = app.state?.game.puzzle;
  if (!puzzle) return false;
  if (!app.conn?.send({ t: 'answer', puzzleId: puzzle.id, answer })) {
    toast('Not connected, so that was not sent. It will work again as soon as the line is back.', 'error');
    return false;
  }
  clearTimeout(app.answerTimer);
  app.answerTimer = setTimeout(() => {
    settleAnswer();
    toast('No reply from the exchange. Check your connection and try again.', 'error');
  }, ANSWER_TIMEOUT_MS);
  return true;
}

function settleAnswer() {
  clearTimeout(app.answerTimer);
  app.controller?.setBusy(false);
}

function onAnswerResult(result) {
  clearTimeout(app.answerTimer);
  if (app.state?.game.puzzle?.id === result.puzzleId) app.controller?.onResult(result);
  if (result.correct) {
    audio.play(result.stageComplete ? 'stage' : 'success');
    announce(result.stageComplete ? 'Stage restored.' : `Solved: ${result.solvedTitle}.`);
    // Hold the solved machine on screen for a moment. (The stage clock is
    // already stopped for the change-over, so this pause costs nothing.)
    app.holdUntil = Date.now() + (prefersReducedMotion() ? 700 : 1_600);
    clearTimeout(app.holdTimer);
    app.holdTimer = setTimeout(() => {
      app.holdUntil = 0;
      render();
    }, app.holdUntil - Date.now());
    if (!result.stageComplete) toast(`${result.solvedTitle}: restored.`, 'good', 2400);
  } else {
    audio.play('fail');
    if (app.state?.you.role === 'operator') {
      const parts = ['The Caller’s answer was wrong.'];
      if (result.feedback) parts.push(`${result.feedback.matched} of ${result.feedback.total} ${result.feedback.unit} held.`);
      toast(parts.join(' '), 'error');
    }
    announce('Wrong answer.');
  }
}

// ---- Hints --------------------------------------------------------------------

let hintTicker = null;

function renderHints() {
  const panel = $('#hints');
  const puzzle = app.state.game.puzzle;
  clearInterval(hintTicker);
  if (!puzzle) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  clear(panel);
  const shown = puzzle.hints.length;
  const readyAt = app.stateAt + puzzle.nextHintInMs;
  const button = h('button', { class: 'btn', type: 'button' }, `Read hint ${shown + 1} of ${puzzle.hintsTotal}`);
  const wait = h('p', { class: 'hints-wait', 'aria-live': 'polite' });
  button.addEventListener('click', () => {
    if (!app.conn?.send({ t: 'hint', puzzleId: puzzle.id })) toast('Not connected. Try again when the line is back.', 'error');
  });

  panel.append(
    h('h2', { id: 'hints-title' }, 'Stuck?'),
    h('p', { class: 'hints-lede' }, 'Each hint is clearer than the last, and costs 40 points. Your partner sees that you read one, not what it says.'),
  );
  if (shown) panel.append(h('ol', { class: 'hint-list' }, puzzle.hints.map((t) => h('li', {}, t))));
  panel.append(h('div', { class: 'hints-row' }, shown < puzzle.hintsTotal ? button : null, wait));

  if (shown >= puzzle.hintsTotal) {
    wait.textContent = 'You have read every hint for this puzzle.';
    return;
  }
  const tick = () => {
    const left = readyAt - Date.now();
    if (left > 0) {
      button.disabled = true;
      wait.textContent = `Next hint in ${formatClock(left)}. Try talking it through first.`;
    } else {
      button.disabled = false;
      wait.textContent = '';
      clearInterval(hintTicker);
    }
  };
  tick();
  if (readyAt > Date.now()) hintTicker = setInterval(tick, 1_000);
}

// ---- Stage clock ----------------------------------------------------------------

function tickTimer() {
  const state = app.state;
  if (!state || app.screen !== 'game' || !state.game.timer) return;
  const t = state.game.timer;
  const elapsed = Date.now() - app.stateAt;
  // The server restarts the clock by itself after a change-over; follow it here.
  const resumed = t.resumesInMs > 0 && elapsed >= t.resumesInMs;
  const running = t.running || resumed;
  const activeNow = t.activeMs + (t.running ? elapsed : resumed ? elapsed - t.resumesInMs : 0);
  const el = $('#timer');
  const label = $('#timer-label');
  const value = $('#timer-value');
  const waiting = t.resumesInMs > 0 && !resumed;
  el.classList.toggle('is-paused', !running);
  if (t.limitMs == null) {
    label.textContent = waiting ? 'Next line' : running ? `Stage clock, par ${formatClock(t.parMs)}` : 'Clock held';
    value.textContent = formatClock(activeNow);
    el.classList.toggle('is-over', activeNow > t.parMs);
    el.classList.remove('is-urgent');
    return;
  }
  const remaining = Math.max(0, t.remainingMs - (activeNow - t.activeMs));
  label.textContent = waiting ? 'Next line' : running ? 'Time left' : 'Clock held';
  value.textContent = formatClock(remaining);
  el.classList.toggle('is-urgent', remaining < 2 * 60_000);
  if (running) {
    audio.setIntensity(remaining < 3 * 60_000 ? 1 - remaining / (3 * 60_000) : 0);
    for (const minutes of [3, 1]) {
      if (remaining <= minutes * 60_000 && remaining > minutes * 60_000 - 2_000 && !app.announcedMinutes.has(minutes)) {
        app.announcedMinutes.add(minutes);
        announce(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left on the countdown.`);
      }
    }
  }
}

// ---- After a stage ---------------------------------------------------------------

function renderResultScreen() {
  const game = app.state.game;
  const key = `${game.result.runId}:${game.phase}`;
  if (app.result?.key === key) {
    app.result.ctl.setReady(partnerReady(), waitingText());
    return;
  }
  app.controller?.destroy();
  app.controller = null;
  app.puzzleKey = null;
  app.result?.ctl.destroy();
  map.focusStage(game.result.stageId);
  const root = clear($('#result'));
  const runId = game.result.runId;
  const ctl = renderResult(root, {
    game,
    partnerReady: partnerReady(),
    waitingText: waitingText(),
    audio,
    onContinue: () => app.conn?.send({ t: 'continue', from: runId }),
    onReplay: () => app.conn?.send({ t: 'play', stageId: game.result.stageId }),
    onMap: () => app.conn?.send({ t: 'map', from: runId }),
  });
  app.result = { key, ctl };
  $('#result-title')?.focus({ preventScroll: true });
}

// ---- Room buttons -------------------------------------------------------------------

function setupRoomControls() {
  $('#copy-link').addEventListener('click', async () => {
    const ok = await copyText(inviteLink());
    toast(ok ? 'Invite link copied. Send it to your partner.' : `Copy failed. The link is ${inviteLink()}`, ok ? 'good' : 'error');
  });
  $('#copy-code').addEventListener('click', async () => {
    const ok = await copyText(formatRoomCode(app.code));
    toast(ok ? 'Room code copied.' : 'Copy failed. Read the code out instead.', ok ? 'good' : 'error');
  });
  $('#share-link').addEventListener('click', async () => {
    try {
      await navigator.share({ title: 'Last Call', text: 'I’m on the line in Last Call and need a partner. Join my room:', url: inviteLink() });
    } catch {
      // cancelled
    }
  });
  $('#swap-roles').addEventListener('click', () => app.conn?.send({ t: 'swap' }));
  for (const radio of $$('[name="lobby-mode"]')) {
    radio.addEventListener('change', () => app.conn?.send({ t: 'mode', mode: radio.value }));
  }
  $('#leave-lobby').addEventListener('click', confirmLeave);
  $('#leave-game').addEventListener('click', confirmLeave);
  $('#abandon-stage').addEventListener('click', () => {
    const runId = app.state?.game.runId;
    showOverlay({
      title: 'Back to the stage map?',
      body: 'This takes both of you back to the map. This attempt at the stage ends; you can play it again any time.',
      dismissable: true,
      actions: [
        { label: 'Keep playing', onClick: hideOverlay },
        {
          label: 'Back to the map',
          primary: true,
          onClick: () => {
            hideOverlay();
            app.conn?.send({ t: 'map', from: runId });
          },
        },
      ],
    });
  });
  $('#conn-retry').addEventListener('click', () => app.conn?.reconnectNow());
  $('#connect-try').addEventListener('click', () => app.conn?.reconnectNow());
  // Not a goodbye: the server never heard from us, so the seat is kept for when the player comes back.
  $('#connect-back').addEventListener('click', () => leaveRoom({ local: true, forget: false }));
}

// ---- Boot -------------------------------------------------------------------------

function boot() {
  setupSettings({ audio, onReplayOpening: () => startOpening(returnFromOpening) });
  setupMenu();
  setupRoomControls();
  setInterval(tickTimer, 250);
  setInterval(tickConnection, 500);
  // Browsers only allow sound after a gesture; nothing plays before the first one.
  audio.attach();

  const fresh = startVisit();
  const raw = new URLSearchParams(location.search).get('room');
  const code = raw ? normalizeRoomCode(raw) : null;
  const valid = code && !roomCodeProblem(code);
  const seat = valid && getSeat(code);
  const toMenu = () =>
    raw
      ? valid
        ? showMenu({ joinCode: code })
        : showMenu({ banner: `That invite link is broken: ${roomCodeProblem(code)} Ask your friend for the code.` })
      : showMenu();
  // Back in a room (a reload, or returning from another app): straight in, never the story.
  if (seat) enterRoom(code, seat.token);
  // A fresh visit opens with the story (Skip is always there); a reload goes straight on.
  else if (fresh) startOpening(toMenu);
  else toMenu();
  // Tells boot.js the game started, so it never replaces this screen with a loading error.
  document.documentElement.dataset.booted = 'true';
}

boot();
