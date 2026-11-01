// Sharing, in a real browser: `npm run test:browser`. The links the game
// hands to a share sheet or the clipboard are built from the address the
// server put in the page, never from the address the page is open on, so a
// game run on a developer's machine still shares a link a friend can open.

/* global document, window, location */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.js';
import { silentLogger } from '../../server/logger.js';
import { findChrome, launchChrome } from './chrome.js';

const chrome = findChrome();
const skip = chrome ? false : 'no Chrome, Chromium or Edge found (set CHROME_PATH)';
const PUBLIC = 'https://last-call.example.com';

let app;
let base;
let browser;

const shown = (id) => {
  const el = document.getElementById(id);
  return Boolean(el && !el.hidden && el.getClientRects().length);
};

/** Replaces the share sheet and the clipboard with recorders. `canShare` false means no Web Share at all. */
const recorders = (canShare) => `
  window.__shared = [];
  window.__copied = [];
  ${canShare ? 'navigator.share = (data) => { window.__shared.push(data); return Promise.resolve(); };' : 'delete navigator.share; Object.defineProperty(navigator, "share", { value: undefined, configurable: true });'}
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } });
`;

async function freshPage(canShare, size = { width: 1280, height: 860 }) {
  const page = await browser.newPage(size);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: recorders(canShare) });
  await page.goto(`${base}/robots.txt`);
  await page.eval(() => sessionStorage.setItem('lastcall:visit', 'true')); // past the opening
  return page;
}

before(async () => {
  if (skip) return;
  // The server is told its public address, as Render does with RENDER_EXTERNAL_URL;
  // the browser reaches it on 127.0.0.1, as a developer would on localhost.
  app = createApp(
    { trustProxy: false, allowedOrigins: [], roomIdleMs: 30 * 60_000, roomMaxMs: 4 * 3_600_000, saveSecret: 'share-test-secret-long-enough-12', publicUrl: PUBLIC },
    { log: silentLogger },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await launchChrome(chrome);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

test('Settings > Share Last Call shares the public game page, not the address the page is open on', { skip }, async () => {
  const page = await freshPage(true);
  await page.goto(`${base}/`);
  await page.waitFor(shown, ['screen-menu']);
  assert.equal(await page.eval(() => document.querySelector('link[rel=canonical]').href), `${PUBLIC}/`, 'the page names its public address');
  await page.eval(() => document.getElementById('settings-btn').click());
  await page.waitFor(shown, ['settings']);
  await page.eval(() => document.getElementById('set-share').click());
  await page.waitFor(() => window.__shared.length === 1);
  const shared = await page.eval(() => window.__shared[0]);
  assert.equal(shared.url, `${PUBLIC}/`);
  assert.equal(shared.title, 'Last Call');
  assert.match(shared.text, /puzzle game for two/i);
  assert.ok(!shared.url.includes('127.0.0.1') && !shared.url.includes('localhost'));
  assert.deepEqual(await page.eval(() => window.__copied), [], 'nothing copied when the share sheet worked');
  await page.close();
});

test('without Web Share, Share Last Call copies the public link and says so', { skip }, async () => {
  const page = await freshPage(false, { width: 390, height: 844 });
  await page.goto(`${base}/`);
  await page.waitFor(shown, ['screen-menu']);
  assert.equal(await page.eval(() => typeof navigator.share), 'undefined');
  await page.eval(() => document.getElementById('settings-btn').click());
  await page.waitFor(shown, ['settings']);
  await page.eval(() => document.getElementById('set-share').click());
  await page.waitFor(() => window.__copied.length === 1);
  assert.deepEqual(await page.eval(() => window.__copied), [`${PUBLIC}/`]);
  const toast = await page.waitFor(() => document.querySelector('#toasts .toast')?.textContent, [], 3_000);
  assert.match(toast, /Link to Last Call copied/);
  await page.close();
});

test('the lobby’s invite controls share and copy this room’s public invite link, which stays separate from the game link', { skip }, async () => {
  const page = await freshPage(true);
  await page.goto(`${base}/`);
  await page.waitFor(shown, ['screen-menu']);
  await page.eval(() => {
    document.querySelector('#create-form [name=name]').value = 'Ada';
    document.getElementById('create-form').requestSubmit();
  });
  await page.waitFor(shown, ['screen-lobby'], 15_000);
  const code = await page.eval(() => new URLSearchParams(location.search).get('room'));
  assert.match(code, /^[A-Z0-9]{6}$/);
  // Share…
  await page.eval(() => document.getElementById('share-link').click());
  await page.waitFor(() => window.__shared.length === 1);
  const shared = await page.eval(() => window.__shared[0]);
  assert.equal(shared.url, `${PUBLIC}/?room=${code}`);
  assert.match(shared.text, /Join my room/);
  // Copy invite link
  await page.eval(() => document.getElementById('copy-link').click());
  await page.waitFor(() => window.__copied.length === 1);
  assert.deepEqual(await page.eval(() => window.__copied), [`${PUBLIC}/?room=${code}`]);
  // The game link from Settings is still the plain game page, even inside a room.
  await page.eval(() => document.getElementById('settings-btn').click());
  await page.waitFor(shown, ['settings']);
  await page.eval(() => document.getElementById('set-share').click());
  await page.waitFor(() => window.__shared.length === 2);
  assert.equal(await page.eval(() => window.__shared[1].url), `${PUBLIC}/`);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('with no public address configured, links fall back to the page’s own origin rather than breaking', { skip }, async () => {
  const plain = createApp(
    { trustProxy: false, allowedOrigins: [], roomIdleMs: 30 * 60_000, roomMaxMs: 4 * 3_600_000, saveSecret: 'share-test-secret-long-enough-12' },
    { log: silentLogger },
  );
  await new Promise((resolve) => plain.server.listen(0, '127.0.0.1', resolve));
  const plainBase = `http://127.0.0.1:${plain.server.address().port}`;
  try {
    const page = await freshPage(true);
    // A different origin from `base`: mark the visit here too, past the opening.
    await page.goto(`${plainBase}/robots.txt`);
    await page.eval(() => sessionStorage.setItem('lastcall:visit', 'true'));
    await page.goto(`${plainBase}/`);
    await page.waitFor(shown, ['screen-menu']);
    await page.eval(() => document.getElementById('settings-btn').click());
    await page.waitFor(shown, ['settings']);
    await page.eval(() => document.getElementById('set-share').click());
    await page.waitFor(() => window.__shared.length === 1);
    assert.equal(await page.eval(() => window.__shared[0].url), `${plainBase}/`);
    await page.close();
  } finally {
    await plain.close();
  }
});
