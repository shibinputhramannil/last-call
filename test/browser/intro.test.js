// The opening and the stage map in a real browser: `npm run test:browser`.
// The opening plays on a fresh visit with animated scenes, can be skipped,
// stepped through and replayed, and never gets in the way of an invite, a
// reload or a reconnection. The map's route and list agree, and both work at
// desktop, phone and phone-landscape sizes, with and without motion.

/* global document, window, getComputedStyle */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.js';
import { silentLogger } from '../../server/logger.js';
import { STAGES } from '../../shared/campaign.js';
import { PUZZLES } from '../../server/puzzles/index.js';
import { TRANSITION_MS, ANSWER_COOLDOWN_MS } from '../../server/game.js';
import { findChrome, launchChrome } from './chrome.js';

const chrome = findChrome();
const skip = chrome ? false : 'no Chrome, Chromium or Edge found (set CHROME_PATH)';

const SIZES = {
  desktop: { width: 1280, height: 860 },
  phone: { width: 390, height: 844 },
  narrow: { width: 320, height: 568 },
  landscape: { width: 844, height: 390 },
};

let app;
let base;
let browser;
let room;
let hostToken;
const clock = { t: Date.now() };

const shown = (id) => {
  const el = document.getElementById(id);
  return Boolean(el && !el.hidden && el.getClientRects().length);
};
const text = (sel) => document.querySelector(sel)?.textContent.trim() ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A page as the Caller of the test room, straight into the lobby (a saved seat skips the opening). */
async function seated(size) {
  const page = await browser.newPage(size);
  await page.goto(`${base}/robots.txt`);
  await page.eval(
    (c, t) => localStorage.setItem('lastcall:seats', JSON.stringify({ [c]: { token: t, role: 'caller', savedAt: Date.now() } })),
    room.code,
    hostToken,
  );
  await page.goto(`${base}/?room=${room.code}`);
  await page.waitFor(shown, ['screen-lobby'], 15_000);
  return page;
}

/** Solves the next `count` stages on the server, the way the game would. */
function solveStages(count) {
  const rooms = app.rooms;
  const host = room.seats.caller;
  const answer = () => PUZZLES[room.game.round.type].solution(room.game.round.state);
  const start = room.progress.view().completed;
  for (let i = start; i < start + count; i++) {
    rooms.handle(room, host, { t: 'play', stageId: STAGES[i].id });
    while (room.game.playing) {
      clock.t += TRANSITION_MS + ANSWER_COOLDOWN_MS + 5_000;
      rooms.handle(room, host, { t: 'answer', puzzleId: room.game.round.id, answer: answer() });
    }
    rooms.handle(room, host, { t: 'map', from: room.game.result.runId });
  }
}

before(async () => {
  if (skip) return;
  app = createApp(
    { trustProxy: false, allowedOrigins: [], roomIdleMs: 30 * 60_000, roomMaxMs: 4 * 3_600_000, saveSecret: 'intro-test-secret-long-enough-12' },
    { log: silentLogger },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  app.rooms.now = () => clock.t;
  browser = await launchChrome(chrome);
  // A room with both seats held by fake sockets, so stages can be solved on the server.
  const fake = () => ({ send() {}, close() {} });
  const created = app.rooms.create({ name: 'Ada', role: 'caller', mode: 'untimed' });
  room = created.room;
  hostToken = created.seat.token;
  app.rooms.attach(room.code, hostToken, fake());
  const guest = app.rooms.join(room.code, { name: 'Grace' });
  app.rooms.attach(room.code, guest.seat.token, fake());
  solveStages(7);
  app.rooms.detach(room, room.seats.caller, room.seats.caller.socket);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

// ---- The opening ----------------------------------------------------------------

test('a fresh visit opens with the animated story; Skip, Next, Back and Escape all work; a reload does not replay it', { skip }, async () => {
  const page = await browser.newPage(SIZES.desktop);
  await page.goto(`${base}/`);
  await page.waitFor(shown, ['screen-story']);
  assert.ok(await page.eval(() => document.querySelector('#story-scene svg.scene-archive') != null), 'the first page has its scene');
  assert.match(await page.eval(text, '.scene-archive .card-year'), /1924 — 1963/, 'the archive card uses the lore’s dates');
  assert.equal(await page.eval(text, '.story-kicker'), 'Exchange 7');
  assert.equal(await page.eval(() => document.activeElement?.id), 'story-next', 'Next has focus');
  assert.equal(await page.eval(() => (window.__contexts || []).length), 0, 'no sound before a gesture');
  const skipBox = await page.eval(() => {
    const r = document.getElementById('story-skip').getBoundingClientRect();
    return { top: r.top, right: r.right, w: r.width, h: r.height, vw: window.innerWidth };
  });
  assert.ok(skipBox.top < 60 && skipBox.vw - skipBox.right < 60 && skipBox.w >= 24 && skipBox.h >= 24, 'Skip is a tappable button in the top-right corner');

  await page.press('ArrowRight', 'ArrowRight', 39);
  assert.equal(await page.eval(text, '.story-kicker'), 'Tonight');
  assert.ok(await page.eval(() => document.querySelector('#story-scene svg.scene-ring') != null), 'the second page has its own scene');
  await page.press('ArrowLeft', 'ArrowLeft', 37);
  assert.equal(await page.eval(text, '.story-kicker'), 'Exchange 7');
  for (let i = 0; i < 5; i++) await page.eval(() => document.getElementById('story-next').click());
  assert.equal(await page.eval(text, '#story-next'), 'Pick up the receiver');
  assert.ok(await page.eval(() => document.querySelector('#story-scene svg.scene-lines') != null));
  await page.eval(() => document.getElementById('story-next').click());
  await page.waitFor(shown, ['screen-menu']);

  await page.send('Page.reload', {});
  await page.waitFor(shown, ['screen-menu'], 15_000);
  assert.equal(await page.eval(shown, ['screen-story']), false, 'a reload goes straight on');

  // Replay from Settings, then Escape skips it.
  await page.eval(() => document.getElementById('settings-btn').click());
  await page.waitFor(shown, ['settings']);
  await page.eval(() => document.getElementById('set-replay').click());
  await page.waitFor(shown, ['screen-story']);
  await page.press('Escape', 'Escape', 27);
  await page.waitFor(shown, ['screen-menu']);
  assert.deepEqual(page.errors, []);
});

test('under reduced motion every scene is a still at its final frame, and nothing waits on an animation', { skip }, async () => {
  const page = await browser.newPage(SIZES.phone);
  await page.goto(`${base}/robots.txt`);
  await page.eval(() => localStorage.setItem('lastcall:prefs', JSON.stringify({ audio: { master: 0.6, music: 0.4, sfx: 0.7, muted: false }, motion: 'reduce', textSize: 'standard', contrast: 'standard', manualFont: 'typewriter' })));
  await page.goto(`${base}/`);
  await page.waitFor(shown, ['screen-story']);
  assert.equal(await page.eval(() => document.documentElement.dataset.motion), 'reduce');
  const stamp = await page.eval(() => {
    const s = getComputedStyle(document.querySelector('.scene-archive .stamp'));
    return { opacity: s.opacity, duration: s.animationDuration };
  });
  assert.equal(stamp.opacity, '1', 'the stamp is already down');
  assert.ok(parseFloat(stamp.duration) < 0.01, `animation collapsed (${stamp.duration})`);
  // Pages turn at once, with no turning class applied.
  await page.eval(() => document.getElementById('story-next').click());
  assert.equal(await page.eval(text, '.story-kicker'), 'Tonight');
  assert.equal(await page.eval(() => document.getElementById('story-page').classList.contains('is-turning')), false);
  const lamp = await page.eval(() => getComputedStyle(document.querySelector('.scene-ring .lamp.is-live')).fill);
  assert.notEqual(lamp, 'rgb(62, 48, 42)', 'the live lamp is lit, not waiting to light');
});

test('an invite link, a reload mid-room and a reconnection never show the opening', { skip }, async () => {
  const page = await browser.newPage(SIZES.phone);
  // A room with a seat to spare, opened the way a player would.
  const invite = app.rooms.create({ name: 'Mabel', role: 'caller', mode: 'untimed' }).room;
  // A fresh visit to an invite: story first, Skip leads to the join form with the room checked.
  await page.goto(`${base}/?room=${invite.code}`);
  await page.waitFor(shown, ['screen-story']);
  await page.eval(() => document.getElementById('story-skip').click());
  await page.waitFor(shown, ['screen-menu']);
  await page.waitFor(() => document.getElementById('join-status').classList.contains('is-good'), [], 10_000);
  assert.equal(await page.eval(() => document.querySelector('#join-form [name=code]').value), `${invite.code.slice(0, 3)}-${invite.code.slice(3)}`);
  // Joining, then a reload: straight back to the lobby, no story in between.
  await page.eval(() => document.getElementById('join-form').requestSubmit());
  await page.waitFor(shown, ['screen-lobby'], 15_000);
  await page.send('Page.reload', {});
  const seen = [];
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const v = await page
      .eval(() => {
        const on = (id) => {
          const el = document.getElementById(id);
          return Boolean(el && !el.hidden && el.getClientRects().length);
        };
        return { story: on('screen-story'), lobby: on('screen-lobby') };
      })
      .catch(() => null);
    if (v?.story) seen.push('story');
    if (v?.lobby) break;
    await sleep(60);
  }
  assert.deepEqual(seen, []);
  assert.ok(await page.eval(shown, ['screen-lobby']));
  // The seat the invite gave is kept, so a second reload does the same.
  await page.send('Page.reload', {});
  await page.waitFor(shown, ['screen-lobby'], 15_000);
  assert.equal(await page.eval(shown, ['screen-story']), false);
  // Leave, freeing the seat for the other tests' room state.
  await page.eval(() => document.getElementById('leave-lobby').click());
  await page.waitFor(shown, ['overlay']);
  await page.eval(() => document.querySelector('#overlay-actions .btn-lamp').click());
  await page.waitFor(shown, ['screen-menu']);
});

// ---- The map ------------------------------------------------------------------------

test('the route and the list show the same progress, at desktop, phone, narrow and landscape sizes', { skip }, async () => {
  for (const [name, size] of Object.entries(SIZES)) {
    const page = await seated(size);
    const m = await page.eval(() => {
      const list = [...document.querySelectorAll('.stage-list .jack')].map((b) => ['is-done', 'is-next', 'is-locked'].find((c) => b.classList.contains(c)) || 'open');
      const route = [...document.querySelectorAll('.route-jack')].map((g) => ['is-done', 'is-next', 'is-locked'].find((c) => g.classList.contains(c)) || 'open');
      const names = [...document.querySelectorAll('.jack-tag-text')].map((t) => t.textContent);
      const vw = document.documentElement.clientWidth;
      const svg = document.querySelector('.route').getBoundingClientRect();
      // Each name tag must sit inside the frame, and never overlap another tag.
      const tags = [...document.querySelectorAll('.jack-tag-text')].map((t) => t.getBoundingClientRect());
      let overlaps = 0;
      for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
        const a = tags[i];
        const b = tags[j];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps++;
      }
      const outside = tags.filter((t) => t.left < svg.left - 2 || t.right > svg.right + 2).length;
      return { list, route, names, sideways: document.documentElement.scrollWidth - vw, overlaps, outside, lit: getComputedStyle(document.querySelector('.route-lit')).strokeDashoffset, meter: document.querySelector('.frame-meter').getAttribute('aria-valuenow') };
    });
    assert.equal(m.list.length, 20, name);
    assert.deepEqual(m.route, m.list, `${name}: route and list agree`);
    assert.equal(m.list.filter((s) => s === 'is-done').length, 7, name);
    assert.equal(m.list[7], 'is-next', name);
    assert.equal(m.names.length, 20, `${name}: every stage is named on the route`);
    assert.equal(m.overlaps, 0, `${name}: no two names overlap`);
    assert.equal(m.outside, 0, `${name}: no name runs outside the frame`);
    assert.ok(m.sideways <= 0, `${name}: no sideways scrolling`);
    assert.equal(m.meter, '7');
    assert.notEqual(m.lit, '0px', `${name}: the cord is lit part-way (${m.lit})`);
    await page.close();
  }
});

test('the list is a complete way to choose a stage by keyboard, and the chapter rack switches frames', { skip }, async () => {
  const page = await seated(SIZES.desktop);
  await page.eval(() => document.querySelector('.stage-list .jack').focus());
  for (let i = 0; i < 3; i++) await page.press('ArrowRight', 'ArrowRight', 39);
  assert.equal(await page.eval(() => document.activeElement.dataset.stage), '1-4');
  await page.press('End', 'End', 35);
  assert.equal(await page.eval(() => document.activeElement.dataset.stage), '1-20');
  await page.press('Home', 'Home', 36);
  assert.equal(await page.eval(() => document.activeElement.dataset.stage), '1-1');
  await page.press('Enter', 'Enter', 13);
  assert.equal(await page.eval(text, '#stage-card-title'), STAGES[0].title);
  assert.equal(await page.eval(text, '.stage-card .btn-lamp'), 'Play stage 1-1 again');
  // The rack: chapter 2 is locked until chapter 1 is done; its key says so.
  const keys = await page.eval(() => [...document.querySelectorAll('.chapter-key')].map((k) => k.getAttribute('aria-label')));
  assert.equal(keys.length, 10);
  assert.match(keys[0], /7 of 20 lines restored, 21 of 60 stars/);
  assert.match(keys[1], /locked$/);
  // Pressing the current key keeps the frame; pressing a locked one shows that frame's dark route.
  await page.eval(() => document.querySelectorAll('.chapter-key')[2].click());
  assert.match(await page.eval(text, '#frame-title'), /Crossed Wires/);
  assert.equal(await page.eval(() => document.querySelectorAll('.route-jack.is-locked').length), 20);
  assert.equal(await page.eval(() => document.querySelector('.stage-card .btn-lamp').disabled), true);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('finishing a stage advances the route with a short motion, which reduced motion turns off', { skip }, async () => {
  const page = await seated(SIZES.desktop);
  const before = await page.eval(() => document.querySelectorAll('.route-jack.is-done').length);
  // The Operator (a fake socket) and the Caller (this page) are both on the line; the server finishes the next stage.
  app.rooms.attach(room.code, room.seats.operator.token, { send() {}, close() {} });
  solveStages(1);
  await page.waitFor((n) => document.querySelectorAll('.route-jack.is-done').length === n + 1, [before], 10_000);
  assert.ok(await page.eval(() => document.querySelector('.route').classList.contains('is-advancing')), 'the cord advances');
  assert.ok(await page.eval(() => document.querySelector('.route-jack.is-unlocking') != null), 'the newly opened jack lights with the unlock motion');
  const dur = await page.eval(() => getComputedStyle(document.querySelector('.route-jack.is-unlocking .jack-lamp')).animationDuration);
  assert.ok(parseFloat(dur) > 0.5, `a visible motion (${dur})`);
  // The same again with reduced motion: no motion classes, and still correct.
  await page.eval(() => {
    localStorage.setItem('lastcall:prefs', JSON.stringify({ audio: { master: 0.6, music: 0.4, sfx: 0.7, muted: false }, motion: 'reduce', textSize: 'standard', contrast: 'standard', manualFont: 'typewriter' }));
  });
  await page.send('Page.reload', {});
  await page.waitFor(shown, ['screen-lobby'], 15_000);
  const n = await page.eval(() => document.querySelectorAll('.route-jack.is-done').length);
  solveStages(1);
  await page.waitFor((k) => document.querySelectorAll('.route-jack.is-done').length === k + 1, [n], 10_000);
  assert.equal(await page.eval(() => document.querySelector('.route').classList.contains('is-advancing')), false);
  assert.equal(await page.eval(() => document.querySelectorAll('.route-signal').length), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});
