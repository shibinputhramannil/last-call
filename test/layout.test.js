// The phone layouts' breakpoints are written twice: in the stylesheet, and in
// public/js/chat.js, which needs to know whether the chat is a collapsed dock.
// These keep the two in step. The layouts themselves are checked in a real
// browser by `npm run test:browser` (test/browser/layout.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/css/styles.css', import.meta.url), 'utf8');
const chat = await readFile(new URL('../public/js/chat.js', import.meta.url), 'utf8');
const constant = (name) => chat.match(new RegExp(`const ${name} = '([^']+)'`))?.[1];

test('the chat knows the same phone layouts as the stylesheet', () => {
  const docked = constant('DOCKED_CHAT');
  const side = constant('SIDE_CHAT');
  assert.ok(docked && side, 'chat.js names both layouts');
  assert.ok(css.includes(`@media ${docked}, ${side} {`), 'the phone rules apply upright and on its side');
  assert.ok(css.includes(`@media ${side} {`), 'the side-chat rules use the same query');
  assert.match(css, /@media \(max-width: 560px\), \(orientation: landscape\) and \(max-height: 500px\) and \(max-width: \d+px\) \{/, 'narrow-column rules reach the column beside the chat');
});

test('rules using :has() stand alone, so browsers without it keep every other rule', () => {
  // A selector list that contains :has() is dropped whole where :has() is unsupported.
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim());
  assert.deepEqual(
    selectors.filter((s) => s.includes(':has(') && s.includes(',')),
    [],
  );
});
