import { formatRoomCode, normalizeRoomCode, roomCodeProblem } from '/shared/constants.js';
import { AudioEngine } from './audio.js';
import { renderCaller } from './caller.js';
import { ChatPanel } from './chat.js';
import { $, $$, h, clear, announce, toast, copyText, formatClock, prefersReducedMotion } from './dom.js';
import { renderManual } from './manual.js';
import { api, Connection } from './net.js';
import { forgetSeat, getSeat, loadAudioPrefs, saveAudioPrefs, saveSeat } from './store.js';

const ROLE_LABEL = { caller: 'Caller', operator: 'Operator' };
const ANSWER_TIMEOUT_MS = 6_000;

const audio = new AudioEngine(loadAudioPrefs());

const app = {
  code: null,
  conn: null,
  state: null,
  stateAt: 0,
  screen: 'intro',
  puzzleKey: null,
  controller: null,
  answerTimer: null,
  holdUntil: 0,
  holdTimer: null,
  endShownFor: null,
  announcedMinutes: new Set(),
  welcomed: false,
};

const chat = new ChatPanel({
  send: (msg) => (app.conn ? app.conn.send(msg) : false),
  audio,
});

// ---- Screens ----------------------------------------------------------------

const shell = $('#shell');

function showScreen(name) {
  const changed = app.screen !== name;
  app.screen = name;
  $('#screen-intro').hidden = name !== 'intro';
  shell.hidden = name === 'intro';
  for (const id of ['menu', 'lobby', 'game']) $(`#screen-${id}`).hidden = id !== name;
  const inRoom = name === 'lobby' || name === 'game';
  shell.classList.toggle('with-chat', inRoom);
  shell.classList.toggle('in-room', inRoom);
  $('#chat').hidden = !inRoom;
  $('#progress').hidden = name !== 'game';
  $('#timer').hidden = name !== 'game';
  $('#conn-status').hidden = !inRoom;
  if (changed) {
    audio.setMood(name === 'game' ? 'game' : name === 'lobby' ? 'lobby' : 'menu');
    const heading = $(`#screen-${name} h1, #screen-${name} h2`);
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: false });
    }
    window.scrollTo(0, 0);
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
    actionsEl.append(
      h('button', { class: `btn ${action.primary ? 'btn-lamp' : ''}`, type: 'button', onclick: action.onClick }, action.label),
    );
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

// ---- Opening ----------------------------------------------------------------

function runIntro(next) {
  const intro = $('#screen-intro');
  showScreen('intro');
  const finish = () => {
    intro.classList.add('is-done');
    $('.intro-enter', intro).focus();
  };
  if (prefersReducedMotion()) intro.classList.add('is-done');
  $('.intro-skip', intro).addEventListener('click', finish);
  $('.intro-actions', intro).addEventListener('animationend', () => intro.classList.add('is-done'));
  const onKey = (e) => {
    if (e.key === 'Escape' && !intro.classList.contains('is-done')) finish();
  };
  document.addEventListener('keydown', onKey);
  $('.intro-enter', intro).addEventListener('click', () => {
    document.removeEventListener('keydown', onKey);
    audio.unlock();
    audio.play('pickup');
    if (prefersReducedMotion()) {
      next();
      return;
    }
    intro.classList.add('is-leaving');
    setTimeout(() => {
      intro.classList.remove('is-leaving');
      next();
    }, 500);
  });
}

// ---- Audio controls -----------------------------------------------------------

function setupAudioControls() {
  const mute = $('#mute-btn');
  const masters = [$('#volume-master'), $('#volume-master-2')];
  const music = $('#volume-music');
  const sfx = $('#volume-sfx');
  const more = $('#audio-more');
  const panel = $('#audio-panel');
  const note = $('#audio-note');

  const sync = () => {
    const p = audio.prefs;
    mute.setAttribute('aria-pressed', String(p.muted));
    mute.setAttribute('aria-label', p.muted ? 'Unmute sound' : 'Mute sound');
    for (const m of masters) m.value = Math.round(p.master * 100);
    music.value = Math.round(p.music * 100);
    sfx.value = Math.round(p.sfx * 100);
    note.hidden = audio.unlocked;
  };
  const update = (patch) => {
    audio.setPrefs(patch);
    saveAudioPrefs(audio.prefs);
  };

  mute.addEventListener('click', () => {
    audio.unlock();
    update({ muted: !audio.prefs.muted });
  });
  for (const m of masters) {
    m.addEventListener('input', () => update({ master: m.value / 100, muted: false }));
  }
  music.addEventListener('input', () => update({ music: music.value / 100 }));
  sfx.addEventListener('input', () => {
    update({ sfx: sfx.value / 100 });
    audio.play('click');
  });
  more.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== more && !more.contains(e.target)) {
      panel.hidden = true;
      more.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      panel.hidden = true;
      more.setAttribute('aria-expanded', 'false');
      more.focus();
    }
  });
  audio.onChange(sync);
  sync();

  // Browsers only allow sound after a gesture; unlock on the first one anywhere.
  const unlockOnce = () => {
    audio.unlock();
    if (audio.unlocked) {
      document.removeEventListener('pointerdown', unlockOnce, true);
      document.removeEventListener('keydown', unlockOnce, true);
    }
  };
  document.addEventListener('pointerdown', unlockOnce, true);
  document.addEventListener('keydown', unlockOnce, true);
}

// ---- Menu -------------------------------------------------------------------

function showMenu({ banner = null, bannerTone = 'error', joinCode = null } = {}) {
  showScreen('menu');
  const bannerEl = $('#menu-banner');
  bannerEl.hidden = !banner;
  bannerEl.textContent = banner || '';
  bannerEl.classList.toggle('is-info', bannerTone === 'info');
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
function checkJoinCode() {
  const input = $('#join-form [name="code"]');
  const status = $('#join-status');
  const code = normalizeRoomCode(input.value);
  status.className = 'join-status';
  input.removeAttribute('aria-invalid');
  clearTimeout(lookupTimer);
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
  const seq = ++lookupSeq;
  lookupTimer = setTimeout(async () => {
    const res = await api.lookup(code);
    if (seq !== lookupSeq) return;
    if (!res.ok) {
      status.textContent = res.message;
      status.classList.add('is-bad');
      return;
    }
    const d = res.data;
    if (d.status === 'open') {
      status.textContent = d.hostName
        ? `${d.hostName} is waiting. You will be the ${ROLE_LABEL[d.role]}.`
        : `Room found. You will be the ${ROLE_LABEL[d.role]}.`;
      status.classList.add('is-good');
    } else if (d.status === 'full') {
      status.textContent = 'That room already has a Caller and an Operator.';
      status.classList.add('is-bad');
    } else if (d.status === 'expired') {
      status.textContent = d.message;
      status.classList.add('is-bad');
    } else {
      status.textContent = 'No room has that code. Check it with your friend.';
      status.classList.add('is-bad');
      input.setAttribute('aria-invalid', 'true');
    }
  }, 250);
}

function setupMenu() {
  const createForm = $('#create-form');
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError(createForm, null);
    const data = new FormData(createForm);
    setFormBusy(createForm, true, 'Opening…');
    const res = await api.createRoom({ name: data.get('name'), role: data.get('role'), mode: data.get('mode') });
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
  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
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
    setFormBusy(joinForm, true, 'Joining…');
    const res = await api.join(code, { name: joinForm.querySelector('[name="name"]').value });
    setFormBusy(joinForm, false);
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

function inviteLink() {
  return `${location.origin}/?room=${app.code}`;
}

function enterRoom(code, token) {
  leaveConnection();
  app.code = code;
  app.state = null;
  app.welcomed = false;
  app.endShownFor = null;
  app.puzzleKey = null;
  setRoomUrl(code);
  chat.reset();

  const connectingTimer = setTimeout(() => {
    if (!app.welcomed) {
      showOverlay({
        title: 'Connecting',
        body: h('div', {}, h('div', { class: 'spinner-lamp', 'aria-hidden': 'true' }), h('p', {}, `Opening the line to room ${formatRoomCode(code)}…`)),
        actions: [{ label: 'Back to start', onClick: () => leaveRoom({ local: true }) }],
      });
    }
  }, 400);

  const conn = new Connection(code, token);
  app.conn = conn;
  conn.addEventListener('status', (e) => onConnStatus(e.detail, connectingTimer));
  conn.addEventListener('message', (e) => onMessage(e.detail));
  conn.connect();
}

function leaveConnection() {
  if (app.conn) app.conn.stop();
  app.conn = null;
  if (app.controller) app.controller.destroy();
  app.controller = null;
  clearTimeout(app.holdTimer);
}

function leaveRoom({ local = false, banner = null, bannerTone, joinCode = null } = {}) {
  // Tell the server so the seat is freed; we finish locally without waiting for its reply.
  if (!local) app.conn?.send({ t: 'leave' });
  if (app.code) forgetSeat(app.code);
  leaveConnection();
  app.code = null;
  app.state = null;
  setRoomUrl(null);
  hideOverlay();
  showMenu({ banner, bannerTone, joinCode });
}

function confirmLeave() {
  showOverlay({
    title: 'Leave this room?',
    body: 'Your seat will be freed so someone else can join with the code. Your partner stays in the room.',
    dismissable: true,
    actions: [
      { label: 'Stay', onClick: hideOverlay },
      { label: 'Leave room', primary: true, onClick: () => leaveRoom() },
    ],
  });
}

function onConnStatus(detail, connectingTimer) {
  const pill = $('#conn-status');
  const text = pill.querySelector('.status-text');
  const wasOpen = app.connState === 'open';
  app.connState = detail.state;
  pill.classList.remove('is-live', 'is-lost', 'is-waiting');

  if (detail.state === 'open') {
    clearTimeout(connectingTimer);
    chat.setConnected(true);
    renderStatus();
    return;
  }
  chat.setConnected(false);
  if (detail.state === 'connecting') {
    pill.classList.add('is-waiting');
    text.textContent = 'Connecting…';
  } else if (detail.state === 'reconnecting') {
    pill.classList.add('is-lost');
    text.textContent = detail.offline ? 'You are offline' : 'Reconnecting…';
    if (app.welcomed && wasOpen) {
      toast('Connection lost. Reconnecting… Your seat is kept for you.', 'error');
      announce('Connection lost. Reconnecting.');
    }
    if (!app.welcomed && detail.attempt >= 3) {
      showOverlay({
        title: 'Still connecting',
        body: detail.offline
          ? 'You appear to be offline. The game will connect when your network is back.'
          : 'The exchange is not answering yet. It will keep trying.',
        actions: [{ label: 'Back to start', onClick: () => leaveRoom({ local: true }) }],
      });
    }
  } else if (detail.state === 'closed') {
    clearTimeout(connectingTimer);
    onClosed(detail.code, detail.message);
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
        { label: 'Back to start', onClick: () => leaveRoom({ local: true }) },
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
  leaveRoom({ local: true, banner: message || 'This room has closed. Open a new room to play again.' });
}

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome': {
      const first = !app.welcomed;
      app.welcomed = true;
      hideOverlayIfConnecting();
      chat.setIdentity(msg.state.you);
      chat.load(msg.chat);
      applyState(msg.state);
      chat.scrollToEnd(true); // the panel was hidden until applyState showed the room

      if (first) audio.play('join');
      else toast('Reconnected.', 'good', 2500);
      break;
    }
    case 'state':
      applyState(msg.state);
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
      if (msg.name === 'started') audio.play('ring');
      break;
    case 'answer-result':
      onAnswerResult(msg);
      break;
    default:
      break;
  }
}

function hideOverlayIfConnecting() {
  const title = $('#overlay-title').textContent;
  if (title === 'Connecting' || title === 'Still connecting') hideOverlay();
}

// ---- State --------------------------------------------------------------------

function partnerOf(state) {
  return state.players.find((p) => !p.you);
}

function applyState(state) {
  const prev = app.state;
  app.state = state;
  app.stateAt = Date.now();
  chat.setIdentity(state.you);

  if (prev) {
    const before = partnerOf(prev);
    const after = partnerOf(state);
    if (before && after && before.role === after.role) {
      if (!before.connected && after.connected) {
        audio.play('join');
        announce(`${after.name} is on the line.`);
      } else if (before.connected && !after.connected && after.present) {
        audio.play('drop');
        toast(`${after.name} lost the line. ${state.game.status === 'playing' ? 'The clock is held until they are back.' : ''}`, 'error');
      }
    }
    const prevHints = prev.game.puzzle?.hints.length ?? 0;
    if (state.game.puzzle && prev.game.puzzle?.id === state.game.puzzle.id && state.game.puzzle.hints.length > prevHints) {
      audio.play('hint');
    }
  }
  render();
}

function render() {
  const state = app.state;
  if (!state) return;
  renderStatus();
  const status = state.game.status;
  if (status === 'lobby') {
    hideEndOverlay();
    showScreen('lobby');
    renderLobby();
    return;
  }
  showScreen('game');
  renderProgress();
  tickTimer();
  if (Date.now() < app.holdUntil) return; // let the "solved" moment play out
  renderGame();
  if (status === 'won' || status === 'lost') showEnd();
}

function renderStatus() {
  const state = app.state;
  if (!state || app.conn?.state !== 'open') return;
  const pill = $('#conn-status');
  const text = pill.querySelector('.status-text');
  const partner = partnerOf(state);
  pill.classList.remove('is-live', 'is-lost', 'is-waiting');
  if (!partner.present) {
    pill.classList.add('is-waiting');
    text.textContent = `Waiting for the ${ROLE_LABEL[partner.role]}`;
  } else if (!partner.connected) {
    pill.classList.add('is-lost');
    text.textContent = `${partner.name} lost the line`;
  } else {
    pill.classList.add('is-live');
    text.textContent = `${partner.name} is on the line`;
  }
}

function renderLobby() {
  const state = app.state;
  $('#lobby-code').textContent = formatRoomCode(state.room.code);
  $('#share-link').hidden = typeof navigator.share !== 'function';

  const seats = clear($('#seats'));
  for (const p of state.players) {
    const lampClass = p.connected ? 'is-live' : p.present ? 'is-lost' : 'is-waiting';
    const who = p.you
      ? 'This is you'
      : p.connected
        ? `${p.name} is on the line`
        : p.present
          ? `${p.name} is reconnecting`
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

  const briefing = clear($('#briefing'));
  const role = state.you.role;
  briefing.append(
    h('h2', {}, `You are the ${ROLE_LABEL[role]}`),
    h(
      'ul',
      {},
      (role === 'caller'
        ? [
            'You are inside the exchange. You see symbols, lamps and machines your Operator cannot.',
            'Describe exactly what you see: shapes, colours, numbers and their order.',
            'Only you can work the machines. Wait for your Operator’s instructions before you dial or patch.',
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

  const both = state.players.every((p) => p.connected);
  const partner = partnerOf(state);
  $('#start-game').disabled = !both;
  $('#lobby-wait').textContent = both
    ? 'Both lines are open. Either of you can start.'
    : partner.present
      ? `Waiting for ${partner.name} to reconnect.`
      : `Waiting for the ${ROLE_LABEL[partner.role]}. Send them the invite link.`;
}

function renderProgress() {
  const game = app.state.game;
  const list = clear($('#progress'));
  game.progress.forEach((p, i) => {
    const current = game.status === 'playing' && i === game.puzzleIndex;
    list.append(
      h(
        'li',
        { class: `${p.solved ? 'is-done' : ''} ${current ? 'is-current is-live' : ''}`, 'aria-current': current ? 'step' : null },
        h('span', { class: 'lamp-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'progress-title' }, p.title),
        h('span', { class: 'sr-only' }, p.solved ? ' (solved)' : current ? ' (current)' : ''),
      ),
    );
  });
}

function renderGame() {
  const state = app.state;
  const game = state.game;
  const stage = $('#stage');
  const key = game.puzzle ? `${game.puzzle.id}:${state.you.role}` : `end:${game.status}`;

  if (key !== app.puzzleKey) {
    if (app.controller) app.controller.destroy();
    app.controller = null;
    app.puzzleKey = key;
    clear(stage);
    if (game.puzzle) {
      const p = game.puzzle;
      stage.append(
        h(
          'header',
          { class: 'puzzle-head' },
          h('p', { class: 'puzzle-count' }, `Puzzle ${p.number} of ${game.progress.length}`),
          h('h1', { class: 'puzzle-title', id: 'puzzle-title', tabindex: '-1' }, p.title),
          state.you.role === 'caller' ? h('p', { class: 'puzzle-intro' }, p.view.intro) : null,
        ),
      );
      const body = h('div', {});
      stage.append(body);
      app.controller =
        state.you.role === 'caller'
          ? renderCaller(body, p, { audio, submit: submitAnswer })
          : renderManual(body, p, { roomCode: state.room.code });
      if (app.welcomedPuzzle && app.welcomedPuzzle !== p.id) $('#puzzle-title').focus();
      app.welcomedPuzzle = p.id;
    } else {
      stage.append(
        h(
          'header',
          { class: 'puzzle-head' },
          h('h1', { class: 'puzzle-title', id: 'puzzle-title', tabindex: '-1' }, game.status === 'won' ? 'The line is open' : 'The line is dead'),
        ),
      );
    }
  }
  renderHints();
}

// ---- Answers ------------------------------------------------------------------

function submitAnswer(answer) {
  const puzzle = app.state?.game.puzzle;
  if (!puzzle) return false;
  if (!app.conn?.send({ t: 'answer', puzzleId: puzzle.id, answer })) {
    toast('Not connected, so that was not sent. Wait for the line to come back, then try again.', 'error');
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
  app.controller?.onResult(result);
  if (result.correct) {
    audio.play(result.won ? 'win' : 'success');
    announce(result.won ? 'All three lines restored. You won.' : `Solved: ${result.solvedTitle}.`);
    // Hold the solved machine on screen for a moment before the next puzzle.
    app.holdUntil = Date.now() + (prefersReducedMotion() ? 900 : 1_800);
    clearTimeout(app.holdTimer);
    app.holdTimer = setTimeout(() => {
      app.holdUntil = 0;
      render();
    }, app.holdUntil - Date.now());
    toast(result.won ? 'The last call goes through.' : `${result.solvedTitle}: solved.`, 'good', 2600);
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
    if (!app.conn?.send({ t: 'hint', puzzleId: puzzle.id })) {
      toast('Not connected. Try again when the line is back.', 'error');
    }
  });

  panel.append(
    h('h2', { id: 'hints-title' }, 'Stuck?'),
    h('p', { class: 'hints-lede' }, 'Each hint is clearer than the last. Your partner sees that you read one, not what it says.'),
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

// ---- Timer --------------------------------------------------------------------

function tickTimer() {
  const state = app.state;
  if (!state || app.screen !== 'game') return;
  const timer = state.game.timer;
  const el = $('#timer');
  const value = $('#timer-value');
  const label = $('#timer-label');
  const since = timer.running ? Date.now() - app.stateAt : 0;
  el.classList.toggle('is-paused', !timer.running && state.game.status === 'playing');

  if (timer.limitMs == null) {
    label.textContent = 'Time taken';
    value.textContent = formatClock(timer.elapsedMs + since);
    el.classList.remove('is-urgent');
    return;
  }
  const remaining = Math.max(0, timer.remainingMs - since);
  label.textContent = timer.running || state.game.status !== 'playing' ? 'Time left' : 'Clock held';
  value.textContent = formatClock(remaining);
  el.classList.toggle('is-urgent', remaining < 3 * 60_000 && state.game.status === 'playing');
  if (state.game.status === 'playing' && timer.running) {
    audio.setIntensity(remaining < 5 * 60_000 ? 1 - remaining / (5 * 60_000) : 0);
    for (const minutes of [5, 1]) {
      if (remaining <= minutes * 60_000 && remaining > minutes * 60_000 - 2_000 && !app.announcedMinutes.has(minutes)) {
        app.announcedMinutes.add(minutes);
        announce(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left.`);
      }
    }
  }
}

// ---- End of a run ---------------------------------------------------------------

function showEnd() {
  const game = app.state.game;
  if (app.endShownFor === game.status) return;
  app.endShownFor = game.status;
  const r = game.result;
  const won = game.status === 'won';
  audio.setMood(won ? 'won' : 'lost');
  if (!won) audio.play('lose');
  const wrong = Math.max(0, r.attempts - r.solved);
  const current = game.progress[Math.min(game.puzzleIndex, game.progress.length - 1)];
  showOverlay({
    title: won ? 'The exchange remembers you' : 'The exchange forgot you',
    tone: won ? 'is-won' : 'is-lost',
    body: h(
      'div',
      {},
      h(
        'p',
        {},
        won
          ? 'All three lines are restored and the last call went through. Somewhere in the dark, a switchboard lamp stays lit.'
          : `The clock ran out during ${current.title}. Every lamp on the board goes dark.`,
      ),
      h(
        'ul',
        { class: 'stats' },
        h('li', {}, h('strong', {}, formatClock(r.elapsedMs)), h('span', {}, game.mode === 'timed' ? 'on the clock' : 'time taken')),
        h('li', {}, h('strong', {}, `${r.solved}/3`), h('span', {}, 'solved')),
        h('li', {}, h('strong', {}, String(wrong)), h('span', {}, wrong === 1 ? 'wrong answer' : 'wrong answers')),
        h('li', {}, h('strong', {}, String(r.hints)), h('span', {}, r.hints === 1 ? 'hint' : 'hints')),
      ),
      h('p', {}, 'Play again to return to the lobby with your partner. You can swap roles there.'),
    ),
    actions: [
      { label: 'Leave room', onClick: () => leaveRoom() },
      { label: won ? 'Play again' : 'Try again', primary: true, onClick: () => app.conn?.send({ t: 'restart' }) },
    ],
  });
}

function hideEndOverlay() {
  if (app.endShownFor) {
    app.endShownFor = null;
    app.announcedMinutes.clear();
    hideOverlay();
  }
}

// ---- Lobby & game buttons ---------------------------------------------------------

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
      await navigator.share({ title: 'Last Call', text: 'Join me in Last Call. I need you on the line.', url: inviteLink() });
    } catch {
      // cancelled
    }
  });
  $('#swap-roles').addEventListener('click', () => app.conn?.send({ t: 'swap' }));
  $('#start-game').addEventListener('click', () => {
    audio.unlock();
    app.conn?.send({ t: 'start' });
  });
  for (const radio of $$('[name="lobby-mode"]')) {
    radio.addEventListener('change', () => app.conn?.send({ t: 'mode', mode: radio.value }));
  }
  $('#leave-lobby').addEventListener('click', confirmLeave);
  $('#leave-game').addEventListener('click', confirmLeave);
}

// ---- Boot -------------------------------------------------------------------------

function boot() {
  setupAudioControls();
  setupMenu();
  setupRoomControls();
  setInterval(tickTimer, 250);

  const raw = new URLSearchParams(location.search).get('room');
  if (raw) {
    const code = normalizeRoomCode(raw);
    const valid = !roomCodeProblem(code);
    const seat = valid && getSeat(code);
    if (seat) {
      // Returning to a room (reload, or back from another app): skip the opening.
      enterRoom(code, seat.token);
      return;
    }
    runIntro(() =>
      valid
        ? showMenu({ joinCode: code })
        : showMenu({ banner: `That invite link is broken: ${roomCodeProblem(code)} Ask your friend for the code.` }),
    );
    return;
  }
  runIntro(() => showMenu());
}

boot();
