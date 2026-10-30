import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLYPHS } from '../shared/art.js';
import { seededRng } from '../server/random.js';
import deadLine, { applyLampRule } from '../server/puzzles/deadLine.js';
import patchBay, { routeCalls } from '../server/puzzles/patchBay.js';
import lastCall, { NIGHT_STAFF } from '../server/puzzles/lastCall.js';
import { PUZZLES } from '../server/puzzles/index.js';

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const hintTexts = (def, role, state) => def.hints[role].map((fn) => fn(state));

test('every puzzle accepts its own answer and has three hints per role', () => {
  for (const def of PUZZLES) {
    assert.equal(def.hints.caller.length, 3, def.id);
    assert.equal(def.hints.operator.length, 3, def.id);
    for (const seed of SEEDS.slice(0, 50)) {
      const s = def.generate(seededRng(seed));
      const answer = def.id === 'patch-bay' ? s.routes : def.id === 'dead-line' ? s.answer : s.name;
      const parsed = def.parseAnswer(answer);
      assert.ok(!parsed.error, `${def.id} seed ${seed}: ${parsed.error}`);
      assert.equal(def.check(s, parsed.value).correct, true, `${def.id} seed ${seed}`);
    }
  }
});

test('dead line: lamp rules', () => {
  assert.deepEqual(applyLampRule('green', [1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(applyLampRule('amber', [1, 2, 3, 4]), [4, 3, 2, 1]);
  assert.deepEqual(applyLampRule('red', [1, 2, 3, 4]), [4, 2, 3, 1]);
});

test('dead line: answer follows from the operator directory and the caller panel', () => {
  for (const seed of SEEDS) {
    const s = deadLine.generate(seededRng(seed));
    const caller = deadLine.views.caller(s);
    const operator = deadLine.views.operator(s);
    const directory = operator.blocks.find((b) => b.type === 'glyphs').entries;
    const digitOf = Object.fromEntries(directory.map((e) => [e.glyph, e.digit]));
    const derived = applyLampRule(caller.lamp, caller.plates.map((g) => digitOf[g])).join('');
    assert.equal(derived, s.answer);
    assert.equal(new Set(caller.plates).size, 4);
    assert.equal(new Set(directory.map((e) => e.digit)).size, 10, 'digits are unique');
  }
});

test('dead line: each role only sees its own half', () => {
  for (const seed of SEEDS) {
    const s = deadLine.generate(seededRng(seed));
    const caller = JSON.stringify(deadLine.views.caller(s));
    const operator = deadLine.views.operator(s);
    assert.ok(!caller.includes('digit"'), 'caller never sees digits');
    assert.ok(!caller.includes(s.answer), 'caller never sees the answer');
    assert.ok(!('plates' in operator) && !('lamp' in operator), 'operator never sees the panel');
    for (const hint of hintTexts(deadLine, 'caller', s)) assert.ok(!/\d/.test(hint), `caller hint leaks a digit: ${hint}`);
    for (const hint of hintTexts(deadLine, 'operator', s)) {
      for (const id of s.plates) assert.ok(!hint.includes(GLYPHS[id].description), 'operator hint leaks a plate');
    }
  }
});

test('dead line: rejects malformed dials', () => {
  for (const raw of ['', '123', '12345', 'abcd', null, {}, '12a4']) {
    assert.ok(deadLine.parseAnswer(raw).error, String(raw));
  }
  assert.equal(deadLine.parseAnswer(' 0 4 2 9 ').value, '0429');
});

test('patch bay: routing wraps F to A and respects line order', () => {
  const grid = { red: { circle: 'F' }, amber: { circle: 'F' }, white: { circle: 'A' } };
  const routes = routeCalls(grid, [
    { number: 5, lamp: 'amber', stamp: 'circle' },
    { number: 2, lamp: 'red', stamp: 'circle' },
    { number: 7, lamp: 'white', stamp: 'circle' },
  ]);
  assert.deepEqual(routes, { 2: 'F', 5: 'A', 7: 'B' });
});

test('patch bay: every room has a collision, and views are split', () => {
  for (const seed of SEEDS) {
    const s = patchBay.generate(seededRng(seed));
    const wanted = s.ringing.map((l) => s.grid[l.lamp][l.stamp]);
    assert.ok(new Set(wanted).size < wanted.length, `seed ${seed} has no collision`);
    const caller = patchBay.views.caller(s);
    const operator = patchBay.views.operator(s);
    assert.equal(caller.lines.length, 8);
    assert.equal(caller.lines.filter((l) => l.lamp).length, 3);
    assert.ok(!('grid' in caller) && !('routes' in caller));
    assert.ok(!('lines' in operator) && !('ringing' in operator));
    for (const hint of hintTexts(patchBay, 'caller', s)) assert.ok(!/trunk [A-F]\b/.test(hint));
    for (const hint of hintTexts(patchBay, 'operator', s)) {
      for (const l of s.ringing) assert.ok(!hint.includes(`line ${l.number}`));
    }
  }
});

test('patch bay: rejects bad patches and partial routing', () => {
  const s = patchBay.generate(seededRng(3));
  assert.ok(patchBay.parseAnswer({ 1: 'A', 2: 'A' }).error, 'two cords in one jack');
  assert.ok(patchBay.parseAnswer({ 9: 'A' }).error);
  assert.ok(patchBay.parseAnswer({ 1: 'G' }).error);
  assert.ok(patchBay.parseAnswer([]).error);
  const partial = { [s.ringing[0].number]: s.routes[s.ringing[0].number] };
  assert.equal(patchBay.check(s, patchBay.parseAnswer(partial).value).correct, false);
});

test('last call: tape decodes to a roster name in either reel direction', () => {
  const seenReels = new Set();
  for (const seed of SEEDS) {
    const s = lastCall.generate(seededRng(seed));
    seenReels.add(s.reel);
    const caller = lastCall.views.caller(s);
    const operator = lastCall.views.operator(s);
    const table = operator.blocks.find((b) => b.type === 'tapecode').entries;
    const byPattern = new Map(table.map((e) => [e.bits.join(''), e.letter]));
    assert.equal(byPattern.size, 26, 'tape code patterns are unique');
    assert.ok(!byPattern.has('11111'), 'leader pattern is never a letter');
    const cols = caller.columns.filter((c) => c.join('') !== '11111');
    let word = cols.map((c) => byPattern.get(c.join(''))).join('');
    if (caller.reel === 'rewound') word = [...word].reverse().join('');
    assert.equal(word, s.name);
    assert.ok(NIGHT_STAFF.includes(word));
    assert.ok(!JSON.stringify(caller).includes(s.name), 'caller never sees the name');
    assert.ok(!('columns' in operator) && !('reel' in operator));
    for (const hint of [...hintTexts(lastCall, 'caller', s), ...hintTexts(lastCall, 'operator', s)]) {
      assert.ok(!hint.includes(s.name));
    }
  }
  assert.deepEqual([...seenReels].sort(), ['feed', 'rewound']);
});

test('last call: input is case-insensitive and ignores spaces', () => {
  assert.equal(lastCall.parseAnswer(' ma bel ').value, 'MABEL');
  assert.ok(lastCall.parseAnswer('MAB').error);
});
