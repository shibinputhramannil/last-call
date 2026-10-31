// Phone layouts in a real browser: `npm run test:browser`. Not part of
// `npm test`, because it needs Chrome, Chromium or Edge installed (it skips
// without one; set CHROME_PATH to choose).
//
// Two players on a local server, in portrait and landscape at common phone
// sizes. A phone on its side used to keep the portrait layout: a sticky top bar
// and a chat docked along the bottom left the puzzle and the settings panel a
// strip about a hundred pixels tall. Every control here is checked the way a
// finger finds it: scrolled into view, then hit-tested for anything on top.

/* global document, window, getComputedStyle */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.js';
import { silentLogger } from '../../server/logger.js';
import { findChrome, launchChrome } from './chrome.js';

const PHONES = [
  { name: 'iPhone SE (1st gen)', width: 320, height: 568 },
  { name: 'iPhone SE 2/3, iPhone 8', width: 375, height: 667 },
  { name: 'Galaxy S', width: 360, height: 800 },
  { name: 'iPhone 13/14', width: 390, height: 844 },
  { name: 'Pixel 7', width: 412, height: 915 },
  { name: 'iPhone Pro Max', width: 430, height: 932 },
];
const PORTRAIT = PHONES.map((p) => ({ label: `${p.name} portrait ${p.width}x${p.height}`, width: p.width, height: p.height }));
/** Sideways at full screen, and with the browser's address bar taking about 50px. */
const LANDSCAPE = PHONES.flatMap((p) => [
  { label: `${p.name} landscape ${p.height}x${p.width}`, width: p.height, height: p.width },
  { label: `${p.name} landscape with address bar ${p.height}x${p.width - 50}`, width: p.height, height: p.width - 50 },
]);

const chrome = findChrome();
const skip = chrome ? false : 'no Chrome, Chromium or Edge found (set CHROME_PATH)';

let app;
let base;
let browser;
let caller;
let operator;
let code;

// ---- In the page --------------------------------------------------------------

/** Where the layout's parts are, as the player sees them. */
function measure() {
  const root = document.documentElement;
  const rem = parseFloat(getComputedStyle(root).fontSize);
  const box = (el) => {
    if (!el || el.closest('[hidden]') || getComputedStyle(el).display === 'none') return null;
    const b = el.getBoundingClientRect();
    return b.width || b.height ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } : null;
  };
  const chat = document.getElementById('chat');
  return {
    vw: root.clientWidth,
    vh: window.innerHeight,
    rem,
    sideways: root.scrollWidth - root.clientWidth,
    topbarVar: parseFloat(getComputedStyle(root).getPropertyValue('--topbar-h')) * rem,
    bar: box(document.querySelector('.topbar')),
    chat: box(chat),
    chatPosition: getComputedStyle(chat).position,
    head: box(document.querySelector('.chat-head')),
    title: box(document.getElementById('chat-title')),
    toggle: box(document.getElementById('chat-toggle')),
    knob: box(document.getElementById('settings-btn')),
    input: box(document.getElementById('chat-input')),
    send: box(document.querySelector('.btn-send')),
    chips: [...document.querySelectorAll('#chat .chip')].map(box),
    settings: box(document.getElementById('settings')),
  };
}

/**
 * Controls in `scope` that a finger could not reach. Each is scrolled into
 * view (and, if something covers it there, into the uncovered part of the
 * screen, as a player would scroll it), then hit-tested at its centre.
 */
function unreachable(scope, maxRight = Infinity) {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const name = (el) =>
    el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.getAttribute('aria-label') || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 24)}"` : 'nothing';
  const band = () => {
    let top = 0;
    let bottom = vh;
    const bar = document.querySelector('.topbar');
    if (bar && getComputedStyle(bar).position === 'sticky' && bar.getBoundingClientRect().top <= 1) top = bar.getBoundingClientRect().bottom;
    const chat = document.getElementById('chat');
    if (!chat.hidden && getComputedStyle(chat).position === 'fixed' && chat.getBoundingClientRect().top > vh / 4) bottom = chat.getBoundingClientRect().top;
    return [top, bottom];
  };
  const root = document.querySelector(scope);
  const controls = [...root.querySelectorAll('button, input:not([type=hidden]), textarea, select, a[href], summary')].filter(
    (el) => !el.closest('[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  );
  const failures = [];
  for (const el of controls) {
    const target = (el.matches('input[type=radio], input[type=checkbox]') && el.closest('label')) || el;
    const hit = () => {
      const b = target.getBoundingClientRect();
      const x = Math.min(Math.max(b.left + b.width / 2, 1), vw - 2);
      const y = Math.min(Math.max(b.top + b.height / 2, 1), vh - 2);
      const h = document.elementFromPoint(x, y);
      return { ok: Boolean(h) && (h === target || target.contains(h) || h === el || el.contains(h)), h, b };
    };
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    let r = hit();
    if (!r.ok && getComputedStyle(target).position !== 'fixed') {
      const [top, bottom] = band();
      window.scrollBy(0, r.b.top + r.b.height / 2 - (top + bottom) / 2);
      r = hit();
    }
    if (!r.ok) failures.push(`${name(target)} is under ${name(r.h)}`);
    else if (r.b.left < -1 || r.b.right > Math.min(vw, maxRight) + 1) failures.push(`${name(target)} sticks out (${Math.round(r.b.left)}..${Math.round(r.b.right)}px)`);
  }
  window.scrollTo(0, 0);
  return { count: controls.length, failures };
}

/**
 * Shows a message the way dom.js toast() does (or uses the real one already
 * showing, when `text` is null), scrolls the screen to its end, and lists the
 * screen's controls underneath the message, and which of its last buttons
 * cannot be tapped.
 */
function messageCovers(screen, text) {
  const region = document.getElementById('toasts');
  const kept = [...region.children];
  let node = kept.find((t) => /lost the line/.test(t.textContent));
  if (text) {
    node = document.createElement('div');
    node.className = 'toast is-error';
    node.setAttribute('role', 'status');
    node.textContent = text;
    region.replaceChildren(node);
  }
  if (!node) return { error: 'no message is showing' };
  window.scrollTo(0, document.documentElement.scrollHeight);
  const vh = window.innerHeight;
  const t = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  const lines = Math.round((node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight));
  const covered = [];
  for (const el of document.querySelectorAll(`#${screen} :is(button, a[href], input, textarea, select, summary)`)) {
    if (el.closest('[hidden]') || !el.getClientRects().length) continue;
    const b = el.getBoundingClientRect();
    if (b.bottom <= 0 || b.top >= vh) continue;
    if (b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top) {
      covered.push((el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30));
    }
  }
  const blocked = [];
  for (const id of screen === 'screen-game' ? ['abandon-stage', 'leave-game'] : ['leave-lobby']) {
    const el = document.getElementById(id);
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (b.top < 0 || b.bottom > vh || !hit || (hit !== el && !el.contains(hit))) blocked.push(id);
  }
  if (text) region.replaceChildren(...kept);
  window.scrollTo(0, 0);
  return { lines, covered, blocked };
}

/** The longest "lost the line" message: a 20-character name (the most allowed). */
const LONGEST_DROP = 'Maximiliana Rosewood lost the line. The stage clock is held until they are back.';

// ---- Set-up -------------------------------------------------------------------

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

async function seatedPage(token, role) {
  const page = await browser.newPage(PORTRAIT[1]);
  await page.goto(`${base}/robots.txt`);
  await page.eval(
    (c, seat) => {
      localStorage.setItem('lastcall:opening-seen', 'true');
      localStorage.setItem('lastcall:seats', JSON.stringify({ [c]: { ...seat, savedAt: Date.now() } }));
    },
    code,
    { token, role },
  );
  await page.goto(`${base}/?room=${code}`);
  await page.waitFor(() => !document.getElementById('screen-lobby').hidden);
  return page;
}

const shown = (id) => !document.getElementById(id).hidden;

async function bothSized(size) {
  await caller.viewport(size);
  await operator.viewport(size);
}

async function tapCentre(page, selector) {
  const b = await page.eval((s) => {
    const el = document.querySelector(s);
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  await page.tap(b.x, b.y);
}

before(async () => {
  if (skip) return;
  app = createApp(
    { trustProxy: false, allowedOrigins: [], roomIdleMs: 30 * 60_000, roomMaxMs: 4 * 3_600_000, saveSecret: 'layout-test-secret-long-enough' },
    { log: silentLogger },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await launchChrome(chrome);
  const room = await post('/api/rooms', { name: 'Ada', role: 'caller', mode: 'untimed' });
  code = room.code;
  const seat = await post(`/api/rooms/${code}/join`, { name: 'Grace', joinId: 'layout-test-join-0123456789' });
  caller = await seatedPage(room.token, 'caller');
  operator = await seatedPage(seat.token, 'operator');
  await caller.waitFor(() => !document.querySelector('.stage-card .btn-lamp').disabled);
  await caller.eval(() => document.querySelector('.stage-card .btn-lamp').click());
  await caller.waitFor(shown, ['screen-game']);
  await operator.waitFor(shown, ['screen-game']);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

// ---- Checks -------------------------------------------------------------------

test('held sideways, the chat stands beside the puzzle, which gets the full height', { skip }, async () => {
  for (const size of LANDSCAPE) {
    await bothSized(size);
    for (const [role, page] of [
      ['Caller', caller],
      ['Operator', operator],
    ]) {
      const at = `${role}, ${size.label}`;
      const m = await page.eval(measure);
      assert.ok(m.sideways <= 0, `${at}: no sideways scrolling (${m.sideways}px)`);
      assert.equal(m.chatPosition, 'sticky', `${at}: chat is a column, not a dock`);
      assert.ok(Math.abs(m.chat.right - m.vw) <= 1 && m.chat.width >= 15 * m.rem - 1 && m.chat.width <= 19 * m.rem + 1, `${at}: chat column ${Math.round(m.chat.width)}px on the right`);
      assert.ok(Math.abs(m.bar.height - m.topbarVar) <= 1, `${at}: the slim top bar keeps its height (${m.bar.height} vs ${m.topbarVar})`);
      assert.ok(Math.abs(m.chat.top - m.bar.bottom) <= 1 && Math.abs(m.chat.bottom - m.vh) <= 1, `${at}: chat fills the height beside the puzzle`);
      assert.ok(m.vh - m.bar.bottom >= m.vh - 50, `${at}: the puzzle gets ${Math.round(m.vh - m.bar.bottom)}px of ${m.vh}px`);
      assert.equal(m.toggle, null, `${at}: nothing to expand`);
      assert.ok(m.knob.top >= m.head.top - 1 && m.knob.bottom <= m.head.bottom + 1 && m.knob.left >= m.chat.left && m.knob.right <= m.title.left, `${at}: the knob sits in the chat header, clear of its title`);

      const puzzle = await page.eval(unreachable, '#screen-game', m.chat.left);
      assert.ok(puzzle.count > 3, `${at}: found the puzzle's controls`);
      assert.deepEqual(puzzle.failures, [], `${at}: every puzzle control can be reached beside the chat`);
      const chat = await page.eval(unreachable, '#chat');
      assert.deepEqual(chat.failures, [], `${at}: every chat control can be reached`);
    }
  }
});

test('held upright, phones keep the docked chat, and wider screens their layouts', { skip }, async () => {
  for (const size of PORTRAIT) {
    await bothSized(size);
    for (const [role, page] of [
      ['Caller', caller],
      ['Operator', operator],
    ]) {
      const at = `${role}, ${size.label}`;
      const m = await page.eval(measure);
      assert.ok(m.sideways <= 0, `${at}: no sideways scrolling`);
      assert.equal(m.chatPosition, 'fixed', `${at}: chat is docked`);
      assert.ok(m.chat.left <= 0.5 && Math.abs(m.chat.right - m.vw) <= 1 && Math.abs(m.chat.bottom - m.vh) <= 1, `${at}: dock along the bottom`);
      assert.ok(Math.abs(m.chat.height - 11.5 * m.rem) <= 1, `${at}: dock height unchanged (${m.chat.height})`);
      assert.ok(Math.abs(m.bar.height - 3.4 * m.rem) <= 2, `${at}: top bar unchanged (${m.bar.height})`);
      assert.ok(m.toggle, `${at}: the chat can be expanded`);
      assert.ok(m.knob.top >= m.chat.top && m.knob.right <= m.title.left, `${at}: the knob sits in the dock's header`);
      const puzzle = await page.eval(unreachable, '#screen-game');
      assert.deepEqual(puzzle.failures, [], `${at}: every puzzle control can be reached above the dock`);
    }
  }
  // A tablet held upright docks the chat too; a desktop keeps its tall side column.
  for (const [size, position] of [
    [{ width: 820, height: 1180 }, 'fixed'],
    [{ width: 1280, height: 800 }, 'sticky'],
  ]) {
    await caller.viewport(size);
    const m = await caller.eval(measure);
    assert.equal(m.chatPosition, position, `${size.width}x${size.height}`);
    if (position === 'sticky') {
      assert.ok(m.chat.width >= 19 * m.rem - 1, 'the desktop chat column keeps its width');
      assert.ok(m.bar.height >= 3.75 * m.rem - 1, 'the desktop top bar keeps its height');
    }
  }
});

test('chat: typing and sending work upright and sideways, including with the keyboard taking room', { skip }, async () => {
  const cases = [
    { label: 'portrait 390x844', size: { width: 390, height: 844 }, keyboard: { width: 390, height: 508 }, mode: 'fixed' },
    { label: 'landscape 844x390', size: { width: 844, height: 390 }, keyboard: { width: 844, height: 190 }, mode: 'sticky' },
    { label: 'landscape 568x270', size: { width: 568, height: 270 }, keyboard: { width: 568, height: 150 }, mode: 'sticky' },
  ];
  let n = 0;
  for (const c of cases) {
    await bothSized(c.size);
    for (const keyboardShowing of [false, true]) {
      // Browsers that shrink the page for the on-screen keyboard: the page is
      // then only as tall as the space above it.
      if (keyboardShowing) await operator.viewport(c.keyboard);
      const at = `${c.label}${keyboardShowing ? ', keyboard showing' : ''}`;
      await tapCentre(operator, '#chat-input');
      assert.equal(await operator.eval(() => document.activeElement?.id), 'chat-input', `${at}: tapping the box focuses it`);
      const m = await operator.eval(measure);
      assert.equal(m.chatPosition, c.mode, `${at}: the layout does not change because of the keyboard`);
      assert.ok(m.input.top >= 0 && m.input.bottom <= m.vh + 1 && m.send.bottom <= m.vh + 1, `${at}: message box and Send are on screen`);
      const covered = await operator.eval(unreachable, '#chat-form');
      assert.deepEqual(covered.failures, [], `${at}: message box and Send can be tapped`);
      const text = `Testing ${++n}: ${at}`;
      await operator.type(text);
      await operator.press('Enter', 'Enter', 13);
      await caller.waitFor((t) => document.getElementById('chat-log').textContent.includes(t), [text]);
    }
  }

  // Sideways, the quick replies show in one row without expanding anything.
  await bothSized({ width: 667, height: 375 });
  const side = await operator.eval(measure);
  assert.equal(side.chips.length, 3);
  assert.ok(side.chips.every((b) => b && Math.abs(b.top - side.chips[0].top) <= 1), 'quick replies in one row');
  assert.deepEqual((await operator.eval(unreachable, '#chat .quick')).failures, []);
  await tapCentre(operator, '#chat [data-quick="Got it."]');
  await caller.waitFor(() => /Got it\./.test(document.getElementById('chat-log').textContent));

  // Upright, they appear once the docked chat is expanded.
  await bothSized({ width: 375, height: 667 });
  assert.ok((await operator.eval(measure)).chips.every((b) => b === null), 'hidden while the dock is collapsed');
  await tapCentre(operator, '#chat-toggle');
  await operator.waitFor(() => document.getElementById('chat').classList.contains('is-expanded'));
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual((await operator.eval(unreachable, '#chat')).failures, []);
  await tapCentre(operator, '#chat-toggle');
  await operator.waitFor(() => !document.getElementById('chat').classList.contains('is-expanded'));
  await new Promise((r) => setTimeout(r, 400));
});

test('settings open fully on screen beside the chat, with every control reachable, and close again', { skip }, async () => {
  const sizes = [PORTRAIT[1], PORTRAIT[2], ...LANDSCAPE.filter((s) => /iPhone 13|iPhone SE \(|Galaxy/.test(s.label))];
  for (const size of sizes) {
    await caller.viewport(size);
    const at = size.label;
    const landscape = size.width > size.height;
    await tapCentre(caller, '#settings-btn');
    await caller.waitFor(shown, ['settings']);
    const m = await caller.eval(measure);
    const p = m.settings;
    assert.ok(p.top >= -0.5 && p.left >= -0.5 && p.bottom <= m.vh + 0.5 && p.right <= m.vw + 0.5, `${at}: the panel is fully on screen`);
    if (landscape) {
      assert.ok(p.top >= m.bar.bottom - 1, `${at}: below the top bar`);
      assert.ok(p.right <= m.chat.left + 1, `${at}: beside the chat, which stays usable`);
      assert.ok(p.height >= Math.min(m.vh - m.bar.bottom - 20, 360), `${at}: the panel uses the height (${Math.round(p.height)}px)`);
    } else {
      assert.ok(p.bottom <= m.chat.top + 1, `${at}: above the docked chat`);
    }
    const controls = await caller.eval(unreachable, '#settings');
    assert.ok(controls.count >= 10, `${at}: found the settings controls`);
    assert.deepEqual(controls.failures, [], `${at}: every setting can be reached`);

    // Mute works from here, and is saved.
    const before = await caller.eval(() => document.getElementById('set-mute').checked);
    await tapCentre(caller, 'label:has(#set-mute)');
    assert.equal(await caller.eval(() => document.getElementById('set-mute').checked), !before, `${at}: mute toggles`);
    assert.equal(await caller.eval(() => JSON.parse(localStorage.getItem('lastcall:prefs')).audio.muted), !before);
    await tapCentre(caller, 'label:has(#set-mute)');

    // Closes with its button, and with Escape.
    await tapCentre(caller, '#settings-close');
    await caller.waitFor(() => document.getElementById('settings').hidden);
    await tapCentre(caller, '#settings-btn');
    await caller.waitFor(shown, ['settings']);
    await caller.press('Escape', 'Escape', 27);
    await caller.waitFor(() => document.getElementById('settings').hidden);
  }
});

test('a "lost the line" message never covers Back to the stage map or Leave room', { skip }, async () => {
  // Every layout, with the longest message, scrolled to the end of the stage.
  const sizes = [...PORTRAIT, ...LANDSCAPE, { label: 'tablet 820x1180', width: 820, height: 1180 }, { label: 'desktop 1280x800', width: 1280, height: 800 }];
  for (const size of sizes) {
    await caller.viewport(size);
    const r = await caller.eval(messageCovers, 'screen-game', LONGEST_DROP);
    assert.ok(r.lines >= 1, `${size.label}: the message showed`);
    assert.deepEqual(r.covered, [], `${size.label}: nothing under a ${r.lines}-line message`);
    assert.deepEqual(r.blocked, [], `${size.label}: both buttons can be tapped`);
  }

  // The real thing: the Operator's network goes (offline, and the server
  // loses the socket), and after the grace period the Caller's own message appears.
  const network = (offline) => operator.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await caller.viewport({ width: 390, height: 844 });
  await operator.send('Network.enable');
  await network(true);
  app.rooms.rooms.get(code).seats.operator.socket.terminate();
  await caller.waitFor(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /Grace lost the line/.test(t.textContent)), [], 20_000);
  for (const size of [
    { label: 'portrait 390x844', width: 390, height: 844 },
    { label: 'landscape 844x390', width: 844, height: 390 },
  ]) {
    await caller.viewport(size);
    const r = await caller.eval(messageCovers, 'screen-game', null);
    assert.equal(r.error, undefined, `${size.label}: the real message is still showing`);
    assert.deepEqual(r.covered, [], `${size.label}: nothing under the real message`);
    assert.deepEqual(r.blocked, [], `${size.label}: both buttons can be tapped while it shows`);
  }
  await network(false);
  await operator.waitFor(() => document.querySelector('#conn-status .status-text').textContent === 'Connected', [], 30_000);
});

test('the stage map (lobby) works sideways too', { skip }, async () => {
  await caller.eval(() => document.getElementById('abandon-stage').click());
  await caller.waitFor(shown, ['overlay']);
  await caller.eval(() => document.querySelector('#overlay-actions .btn-lamp').click());
  await caller.waitFor(shown, ['screen-lobby']);
  await operator.waitFor(shown, ['screen-lobby']);
  for (const size of LANDSCAPE) {
    await bothSized(size);
    for (const [role, page] of [
      ['Caller', caller],
      ['Operator', operator],
    ]) {
      const m = await page.eval(measure);
      assert.ok(m.sideways <= 0, `${role}, ${size.label}: no sideways scrolling`);
      const lobby = await page.eval(unreachable, '#screen-lobby', m.chat.left);
      // The chapter keys are a strip that scrolls sideways by design; the rest must be reachable.
      const real = lobby.failures.filter((f) => !/chapter-key|Chapter \d/.test(f));
      assert.deepEqual(real, [], `${role}, ${size.label}: every lobby control can be reached`);
    }
  }
  // Leave room, at the end of the lobby, is never under a message either.
  for (const size of [...PORTRAIT, ...LANDSCAPE]) {
    await caller.viewport(size);
    const r = await caller.eval(messageCovers, 'screen-lobby', LONGEST_DROP);
    assert.deepEqual(r.covered, [], `lobby, ${size.label}: nothing under a ${r.lines}-line message`);
    assert.deepEqual(r.blocked, [], `lobby, ${size.label}: Leave room can be tapped`);
  }
  assert.deepEqual([...caller.errors, ...operator.errors], [], 'no errors in either page');
});
