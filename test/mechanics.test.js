import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLamps, isNight } from '../server/puzzles/deadLine.js';
import { routeCalls } from '../server/puzzles/patchBay.js';
import teleprinter, { shiftLetter } from '../server/puzzles/teleprinter.js';
import partyLine, { CADENCES, callbackOrder } from '../server/puzzles/partyLine.js';
import relayRack, { applyAction, runProcedure } from '../server/puzzles/relayRack.js';
import cipherWheel, { decipher } from '../server/puzzles/cipherWheel.js';
import patchBay from '../server/puzzles/patchBay.js';
import { seededRng } from '../server/random.js';

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);

test('dead line: lamp rules, in order, upper lamp first', () => {
  assert.deepEqual(applyLamps(['green'], [1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(applyLamps(['amber'], [1, 2, 3, 4]), [4, 3, 2, 1]);
  assert.deepEqual(applyLamps(['red'], [1, 2, 3, 4]), [4, 2, 3, 1]);
  assert.deepEqual(applyLamps(['blue'], [8, 9, 0]), [9, 0, 1]);
  assert.deepEqual(applyLamps(['white'], [1, 2, 3, 4]), [2, 3, 4, 1]);
  assert.deepEqual(applyLamps(['white', 'amber'], [1, 2, 3, 4]), [1, 4, 3, 2]);
  assert.deepEqual(applyLamps(['amber', 'white'], [1, 2, 3, 4]), [3, 2, 1, 4]);
  assert.equal(isNight('18:00'), true);
  assert.equal(isNight('05:55'), true);
  assert.equal(isNight('06:00'), false);
  assert.equal(isNight('17:55'), false);
});

test('patch bay: busy and out-of-order trunks, red priority, stepping back', () => {
  const grid = { red: { circle: 'B' }, amber: { circle: 'B', square: 'D' }, white: { circle: 'A' } };
  const trunks = ['A', 'B', 'C', 'D'];
  const ringing = [
    { number: 2, lamp: 'amber', stamp: 'circle' },
    { number: 5, lamp: 'red', stamp: 'circle' },
  ];
  assert.deepEqual(routeCalls({ grid, ringing, trunks }).routes, { 2: 'B', 5: 'C' });
  assert.deepEqual(routeCalls({ grid, ringing, trunks, priority: true }).routes, { 5: 'B', 2: 'C' });
  assert.deepEqual(routeCalls({ grid, ringing, trunks, priority: true, stepBack: true }).routes, { 5: 'B', 2: 'A' });
  assert.deepEqual(routeCalls({ grid, ringing, trunks, outOfOrder: ['B'] }).routes, { 2: 'C', 5: 'D' });
  // Wrapping: after the last trunk comes A.
  assert.deepEqual(
    routeCalls({ grid, ringing: [{ number: 1, lamp: 'amber', stamp: 'square' }, { number: 3, lamp: 'amber', stamp: 'square' }], trunks }).routes,
    { 1: 'D', 3: 'A' },
  );
});

test('patch bay: every rule in the manual changes the answer on its board', () => {
  for (let level = 1; level < patchBay.levels.length; level++) {
    const p = patchBay.levels[level];
    for (const seed of SEEDS.slice(0, 40)) {
      const s = patchBay.generate(seededRng(seed), level);
      const base = { grid: s.grid, ringing: s.ringing, trunks: s.trunks };
      const full = routeCalls({ ...base, outOfOrder: s.outOfOrder, priority: s.priority, stepBack: s.stepBack });
      assert.deepEqual(full.routes, s.routes);
      if (p.busy) assert.ok(full.busyHits >= p.busy, `level ${level}: busy rule matters`);
      if (p.outOfOrder) assert.ok(full.brokenHits >= 1, `level ${level}: out-of-order rule matters`);
      if (p.priority) assert.notDeepEqual(routeCalls({ ...base, outOfOrder: s.outOfOrder, stepBack: s.stepBack }).routes, s.routes);
      if (p.stepBack) assert.notDeepEqual(routeCalls({ ...base, outOfOrder: s.outOfOrder, priority: s.priority }).routes, s.routes);
      if (!p.busy) assert.equal(full.busyHits + full.brokenHits, 0);
    }
  }
});

test('teleprinter: names decode through reel direction, upside-down tape and shift', () => {
  assert.equal(shiftLetter('A', -1), 'Z');
  assert.equal(shiftLetter('Z', 3), 'C');
  for (let level = 1; level < teleprinter.levels.length; level++) {
    for (const seed of SEEDS.slice(0, 30)) {
      const s = teleprinter.generate(seededRng(seed), level);
      assert.ok(s.roster.includes(s.name));
      assert.equal(new Set(Object.values(s.code).map((b) => b.join(''))).size, 26, 'tape code is unambiguous');
      assert.deepEqual(s.columns[0], [1, 1, 1, 1, 1]);
      assert.deepEqual(s.columns[s.columns.length - 1], [1, 1, 1, 1, 1]);
      if (!teleprinter.levels[level].shift) assert.equal(s.shift, 0);
    }
  }
});

test('party line: ring-back order by first ring or by count, with echoes and trunk rings', () => {
  const rings = [
    { household: 'Ellis' },
    { household: 'Baxter' },
    { household: 'Baxter' },
    { household: 'Nash', echo: true },
    { household: 'Ellis', trunk: true },
    { household: 'Nash', echo: true },
  ];
  assert.deepEqual(callbackOrder(rings, 'first'), ['Ellis', 'Baxter']);
  assert.deepEqual(callbackOrder(rings, 'count'), ['Ellis', 'Baxter']);
  assert.deepEqual(callbackOrder(rings, 'count', { doubleTrunk: false }), ['Ellis', 'Baxter']);
  assert.deepEqual(callbackOrder(rings, 'count', { ignoreEchoes: false }), ['Ellis', 'Baxter', 'Nash']);
  assert.deepEqual(callbackOrder([{ household: 'A' }, { household: 'B' }, { household: 'B' }], 'count'), ['B', 'A']);
  assert.equal(new Set(CADENCES).size, CADENCES.length);
  for (let level = 1; level < partyLine.levels.length; level++) {
    for (const seed of SEEDS.slice(0, 40)) {
      const s = partyLine.generate(seededRng(seed), level);
      assert.equal(new Set(s.directory.map((d) => d.cadence)).size, s.directory.length, 'each household has its own ring');
      assert.deepEqual(callbackOrder(s.rings, s.rule), s.answer);
    }
  }
});

test('relay rack: jobs, "right now" jobs, and the order they are done in', () => {
  const caps = ['red', 'green', 'blue', 'red'];
  const rack = [true, false, false, true];
  assert.deepEqual(applyAction(rack, caps, { kind: 'flip-colour', colour: 'red' }), [false, false, false, false]);
  assert.deepEqual(applyAction(rack, caps, { kind: 'flip-numbers', numbers: [2, 3] }), [true, true, true, true]);
  assert.deepEqual(applyAction(rack, caps, { kind: 'set-colour', colour: 'red', up: false }), [false, false, false, false]);
  assert.deepEqual(applyAction(rack, caps, { kind: 'flip-parity', odd: true }), [false, false, true, true]);
  assert.deepEqual(applyAction(rack, caps, { kind: 'match', colour: 'blue', relay: 1 }), [true, false, true, true]);
  assert.deepEqual(applyAction(rack, caps, { kind: 'conditional', relay: 2, up: true, then: 'red', otherwise: 'green' }), [true, true, false, true]);
  const jobs = [
    { kind: 'flip-colour', colour: 'red' },
    { kind: 'match', colour: 'green', relay: 1 },
  ];
  assert.deepEqual(runProcedure(rack, caps, jobs), [false, false, false, false]);
  assert.deepEqual(runProcedure(rack, caps, [...jobs].reverse()), [false, true, false, false]);
  for (let level = 1; level < relayRack.levels.length; level++) {
    for (const seed of SEEDS.slice(0, 40)) {
      const s = relayRack.generate(seededRng(seed), level);
      assert.equal(s.lit.length, relayRack.levels[level].lit);
      assert.notEqual(s.answer, s.rack.map((u) => (u ? 'U' : 'D')).join(''), 'the jobs change the rack');
      if (relayRack.levels[level].ordered) {
        const lit = s.lit.map((l) => s.actions[s.letters.indexOf(l)]);
        assert.notDeepEqual(runProcedure(s.rack, s.caps, [...lit].reverse()), s.final, `level ${level} seed ${seed}: order matters`);
      }
    }
  }
});

test('cipher wheel: back-shift, alternating shift and stamps', () => {
  assert.equal(decipher('KHOOR', 3, false), 'HELLO');
  assert.equal(decipher('DBMM', 1, false), 'CALL');
  assert.equal(decipher('DZMK', 1, true), 'CALL');
  for (let level = 1; level < cipherWheel.levels.length; level++) {
    for (const seed of SEEDS.slice(0, 40)) {
      const s = cipherWheel.generate(seededRng(seed), level);
      const shift = s.keys.find((k) => k.glyph === s.pointer).shift + s.stamps;
      assert.equal(decipher(s.cipher, shift, s.alternate), s.word);
      assert.notEqual(s.cipher, s.word);
      assert.ok(s.codebook.includes(s.word));
      if (!cipherWheel.levels[level].stamps) assert.equal(s.stamps, 0);
    }
  }
});
