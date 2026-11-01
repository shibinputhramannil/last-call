// The stage map's reading of progress (public/js/map.js), run in Node with a
// small DOM. These pin down that the route, the rack and the list all agree
// with the server's campaign view, that saved progress from before the
// redesign reads exactly as before (the view is keyed by stage id, which the
// map never changed), and that the list stays a complete way to pick a stage.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { CHAPTERS, STAGES, STAGES_PER_CHAPTER } from '../shared/campaign.js';
import { Progress } from '../server/progress.js';

// map.js imports by web path, as the browser serves it.
register('./support/web-imports.js', import.meta.url);

// ---- A small DOM: enough for h()/s() and the map's queries -----------------------

class Node {
  constructor(tag, ns = null) {
    this.tagName = tag.toUpperCase();
    this.ns = ns;
    this.children = [];
    this.attrs = new Map();
    this.listeners = new Map();
    this.style = { setProperty: (k, v) => this.attrs.set(`style:${k}`, v) };
    const dataKey = (k) => `data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    this.dataset = new Proxy({}, { set: (_, k, v) => (this.attrs.set(dataKey(k), String(v)), true), get: (_, k) => this.attrs.get(dataKey(k)) });
    this.classList = {
      toggle: (c, on) => {
        const set = new Set((this.attrs.get('class') || '').split(/\s+/).filter(Boolean));
        if (on === undefined ? !set.has(c) : on) set.add(c);
        else set.delete(c);
        this.attrs.set('class', [...set].join(' '));
      },
      contains: (c) => (this.attrs.get('class') || '').split(/\s+/).includes(c),
    };
    this.parentNode = null;
  }
  /** As in a browser: the property reflects the attribute h() sets. */
  get disabled() {
    return this.attrs.has('disabled');
  }
  set disabled(v) {
    if (v) this.attrs.set('disabled', '');
    else this.attrs.delete('disabled');
  }
  get textContent() {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v) {
    this.children = [String(v)];
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get className() {
    return this.attrs.get('class') || '';
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  append(...items) {
    for (const item of items.flat(Infinity)) {
      if (item == null || item === false) continue;
      if (typeof item === 'object') item.parentNode = this;
      this.children.push(item);
    }
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
  }
  click() {
    for (const fn of this.listeners.get('click') || []) fn({ preventDefault() {} });
  }
  focus() {
    document.activeElement = this;
  }
  get offsetWidth() {
    return 0;
  }
  /** A tiny selector engine: tag, .class, #id, [attr="v"], descendant combinations, and :not(.class). */
  querySelectorAll(selector) {
    const out = [];
    const parts = selector.split(/\s+/).filter(Boolean);
    const matches = (n, part) => {
      if (typeof n === 'string') return false;
      for (const token of part.match(/([.#]?[\w-]+|\[[^\]]+\]|:not\([^)]+\))/g) || []) {
        if (token.startsWith('.') && !n.classList.contains(token.slice(1))) return false;
        else if (token.startsWith('#') && n.getAttribute('id') !== token.slice(1)) return false;
        else if (token.startsWith('[')) {
          const m = token.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
          if (!m || !n.hasAttribute(m[1]) || (m[2] !== undefined && n.getAttribute(m[1]) !== m[2])) return false;
        } else if (token.startsWith(':not(')) {
          if (matches(n, token.slice(5, -1))) return false;
        } else if (/^[\w-]+$/.test(token) && n.tagName !== token.toUpperCase()) return false;
      }
      return true;
    };
    const walk = (n, depth) => {
      for (const c of n.children) {
        if (typeof c === 'string') continue;
        if (matches(c, parts[depth])) {
          if (depth === parts.length - 1) out.push(c);
          else walk(c, depth + 1);
        }
        walk(c, depth);
      }
    };
    walk(this, 0);
    return [...new Set(out)];
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const document = {
  activeElement: null,
  documentElement: new Node('html'),
  createElement: (tag) => new Node(tag),
  createElementNS: (ns, tag) => new Node(tag, ns),
  createTextNode: (t) => String(t),
  querySelector: () => null,
};
document.documentElement.dataset.motion = 'full';
globalThis.document = document;
globalThis.Node = Node;
globalThis.queueMicrotask = (fn) => fn();
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { createMap } = await import('../public/js/map.js');

let root;
let played;
let map;
beforeEach(() => {
  root = new Node('div');
  played = [];
  map = createMap(root, { onPlay: (id) => played.push(id) });
});

const view = (progress, extra = {}) => ({ campaign: progress.view(), canPlay: true, waitingText: '', mode: 'untimed', ...extra });
const stageAt = (i) => STAGES[i];
const listButtons = () => root.querySelectorAll('.stage-list button');
const routeJacks = () => root.querySelectorAll('.route-jack');
const stateOf = (el) => ['is-done', 'is-next', 'is-locked'].find((c) => el.classList.contains(c)) || 'open';

test('a fresh campaign: stage 1 is next, every other stage is locked, and the list names them all', () => {
  const progress = new Progress();
  map.render(view(progress));
  const buttons = listButtons();
  assert.equal(buttons.length, STAGES_PER_CHAPTER, 'one list button per stage in the chapter');
  assert.equal(stateOf(buttons[0]), 'is-next');
  assert.ok(buttons.slice(1).every((b) => stateOf(b) === 'is-locked'));
  assert.equal(buttons[0].getAttribute('aria-label'), `Stage 1-1, ${stageAt(0).title}, next to play`);
  assert.match(buttons[5].getAttribute('aria-label'), /locked$/);
  // The route shows the same stages in the same states.
  const jacks = routeJacks();
  assert.equal(jacks.length, STAGES_PER_CHAPTER);
  assert.deepEqual(jacks.map(stateOf), buttons.map(stateOf));
  // The stage card offers stage 1 and says why the others wait.
  assert.equal(root.querySelector('#stage-card-title').textContent, stageAt(0).title);
  assert.equal(root.querySelector('.stage-card .btn-lamp').textContent, 'Start stage 1-1');
  assert.match(root.querySelector('.frame-next').textContent, /Next line: Stage 1-1/);
});

test('progress saved before the redesign reads exactly as before: done, next and locked follow the stage ids', () => {
  // A save in the stored format the server has always used: stars and best score per stage id.
  const saved = { v: 1, s: { '1-1': [3, 1000], '1-2': [2, 760], '1-3': [3, 980], '1-4': [1, 420], '1-5': [3, 900], '1-6': [2, 700], '1-7': [3, 1000] } };
  const progress = Progress.from(saved);
  assert.equal(progress.view().frontier, '1-8');
  map.render(view(progress));
  const buttons = listButtons();
  assert.deepEqual(buttons.slice(0, 7).map(stateOf), Array(7).fill('is-done'));
  assert.equal(stateOf(buttons[7]), 'is-next');
  assert.ok(buttons.slice(8).every((b) => stateOf(b) === 'is-locked'));
  assert.equal(buttons[3].getAttribute('aria-label'), `Stage 1-4, ${stageAt(3).title}, 1 of 3 stars, best 420`);
  // Stars on the route match the save, star for star.
  const starsOf = (jack) => jack.querySelectorAll('.jack-star.on').length;
  assert.deepEqual(routeJacks().slice(0, 7).map(starsOf), [3, 2, 3, 1, 3, 2, 3]);
  assert.equal(root.querySelector('.frame-count').textContent, '7 of 20 lines restored, 17 of 60 stars');
  assert.equal(root.querySelector('.frame-meter').getAttribute('aria-valuenow'), '7');
  // The card shows the next stage, not a finished one.
  assert.equal(root.querySelector('#stage-card-title').textContent, stageAt(7).title);
});

test('the chapter rack: locked until the previous chapter is finished, with real counts, and it switches the frame', () => {
  const progress = new Progress();
  for (let i = 0; i < STAGES_PER_CHAPTER + 3; i++) progress.record(STAGES[i].id, { score: 900, stars: 2 });
  map.render(view(progress));
  const keys = root.querySelectorAll('.chapter-key');
  assert.equal(keys.length, CHAPTERS.length);
  assert.ok(keys[0].classList.contains('is-complete'));
  assert.match(keys[0].getAttribute('aria-label'), /20 of 20 lines restored, 40 of 60 stars/);
  assert.ok(keys[1].classList.contains('is-current'), 'the frame opens on the chapter with the next stage');
  assert.match(keys[1].getAttribute('aria-label'), /3 of 20 lines restored/);
  assert.ok(keys[2].classList.contains('is-locked'));
  assert.match(keys[2].getAttribute('aria-label'), /locked$/);
  // Pressing a key shows that chapter's frame and selects its first open stage.
  keys[0].click();
  assert.equal(root.querySelector('#frame-title').textContent, CHAPTERS[0].title);
  assert.match(root.querySelector('.frame-next.is-done').textContent, /carries on at Stage 2-4/);
  keys[1].click();
  assert.equal(root.querySelector('#stage-card-title').textContent, STAGES[STAGES_PER_CHAPTER + 3].title);
});

test('choosing a stage from the list selects it everywhere, and Start sends exactly that stage', () => {
  const progress = new Progress();
  for (let i = 0; i < 4; i++) progress.record(STAGES[i].id, { score: 1000, stars: 3 });
  map.render(view(progress));
  listButtons()[1].click();
  assert.equal(root.querySelector('#stage-card-title').textContent, stageAt(1).title);
  assert.equal(listButtons()[1].getAttribute('aria-pressed'), 'true');
  assert.ok(routeJacks()[1].classList.contains('is-selected'));
  assert.equal(root.querySelector('.stage-card .btn-lamp').textContent, 'Play stage 1-2 again');
  root.querySelector('.stage-card .btn-lamp').click();
  assert.deepEqual(played, ['1-2']);
  // A locked stage can be looked at, but not started.
  listButtons()[9].click();
  const start = root.querySelector('.stage-card .btn-lamp');
  assert.equal(start.disabled, true);
  assert.match(root.querySelector('.stage-note').textContent, /Restore stage 1-9 to open this line/);
  // Without a partner on the line, an open stage cannot start either, and says why.
  listButtons()[4].click();
  map.render(view(progress, { canPlay: false, waitingText: 'Waiting for the Operator to join.' }));
  assert.equal(root.querySelector('.stage-card .btn-lamp').disabled, true);
  assert.equal(root.querySelector('.stage-note').textContent, 'Waiting for the Operator to join.');
});

test('a finished stage lights up on the next render, and the route marks the newly opened line', () => {
  const progress = new Progress();
  for (let i = 0; i < 3; i++) progress.record(STAGES[i].id, { score: 1000, stars: 3 });
  map.render(view(progress));
  assert.equal(stateOf(routeJacks()[3]), 'is-next');
  progress.record(STAGES[3].id, { score: 880, stars: 2 });
  map.render(view(progress));
  const jacks = routeJacks();
  assert.equal(stateOf(jacks[3]), 'is-done');
  assert.equal(stateOf(jacks[4]), 'is-next');
  assert.ok(jacks[4].classList.contains('is-unlocking'), 'the newly opened jack gets the unlock motion');
  assert.ok(root.querySelector('.route').classList.contains('is-advancing'), 'and the cord advances');
  // Under reduced motion, the same render adds no motion classes.
  document.documentElement.dataset.motion = 'reduce';
  progress.record(STAGES[4].id, { score: 900, stars: 3 });
  map.render(view(progress));
  assert.equal(root.querySelector('.route').classList.contains('is-advancing'), false);
  assert.equal(root.querySelectorAll('.route-jack.is-unlocking').length, 0);
  assert.equal(root.querySelectorAll('.route-signal').length, 0, 'no travelling signal either');
  document.documentElement.dataset.motion = 'full';
});

test('focusStage points the map at a stage just played, in its own chapter', () => {
  const progress = new Progress();
  for (let i = 0; i < STAGES_PER_CHAPTER + 1; i++) progress.record(STAGES[i].id, { score: 1000, stars: 3 });
  map.render(view(progress));
  map.focusStage('1-20');
  map.render(view(progress));
  assert.equal(root.querySelector('#frame-title').textContent, CHAPTERS[0].title);
  assert.equal(root.querySelector('#stage-card-title').textContent, stageAt(STAGES_PER_CHAPTER - 1).title);
  assert.match(root.querySelector('.stage-card .stage-ref').textContent, /chapter finale/);
});
