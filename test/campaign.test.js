import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAPTERS, MECHANICS, STAGES, STAGES_PER_CHAPTER, stageSignature, validateCampaign } from '../shared/campaign.js';
import { CHAPTER_STORY, OPENING } from '../shared/story.js';
import { PUZZLES } from '../server/puzzles/index.js';
import { seededRng } from '../server/random.js';
import { ROLE_ONLY, SOLVERS } from './support/solvers.js';

const SEEDS_PER_STAGE = 6;

function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

const parAvg = (chapter) => {
  const stages = STAGES.filter((s) => s.chapter === chapter);
  return stages.reduce((sum, s) => sum + s.parMs, 0) / stages.length;
};

test('the campaign has at least 200 valid stages in 10 chapters', () => {
  assert.ok(STAGES.length >= 200, `only ${STAGES.length} stages`);
  assert.deepEqual(validateCampaign(), []);
  assert.equal(CHAPTERS.length, 10);
  for (const ch of CHAPTERS) assert.equal(STAGES.filter((s) => s.chapter === ch.number).length, STAGES_PER_CHAPTER, ch.title);
  assert.equal(CHAPTER_STORY.length, CHAPTERS.length);
  assert.ok(OPENING.length >= 4 && OPENING.every((p) => p.text.length < 200), 'the opening is short pages');
  STAGES.forEach((s, i) => assert.equal(s.index, i));
});

test('no two stages share the same mix of mechanics and levels', () => {
  const seen = new Map();
  for (const s of STAGES) {
    const sig = stageSignature(s);
    assert.ok(!seen.has(sig), `${s.id} repeats ${seen.get(sig)}`);
    seen.set(sig, s.id);
  }
});

test('difficulty rises: chapter by chapter, and towards each chapter finale', () => {
  for (let ch = 2; ch <= CHAPTERS.length; ch++) assert.ok(parAvg(ch) > parAvg(ch - 1), `chapter ${ch} is not harder than ${ch - 1}`);
  for (const ch of CHAPTERS) {
    const stages = STAGES.filter((s) => s.chapter === ch.number);
    const finale = stages[stages.length - 1];
    assert.ok(finale.finale);
    assert.ok(stages.every((s) => s.parMs <= finale.parMs), `${ch.title} finale is its hardest stage`);
    assert.ok(stages[0].parMs < finale.parMs);
    assert.ok(finale.puzzles.some((p) => p.type === ch.featured), `${ch.title} finale features its mechanic`);
  }
  assert.equal(STAGES[0].difficulty, 1);
  assert.equal(STAGES[STAGES.length - 1].difficulty, 5);
  // Every mechanic appears, and each one's levels climb over the campaign.
  for (const type of Object.keys(MECHANICS)) {
    const levels = STAGES.flatMap((s) => s.puzzles.filter((p) => p.type === type).map((p) => p.level));
    assert.ok(levels.length >= 20, `${type} appears often`);
    assert.ok(levels[levels.length - 1] > levels[0], `${type} gets harder`);
  }
});

test('the first stage teaches the three original machines at their gentlest', () => {
  assert.deepEqual(
    STAGES[0].puzzles.map((p) => `${p.type}:${p.level}`).sort(),
    ['dead-line:1', 'patch-bay:1', 'teleprinter:1'],
  );
});

test('every stage is solvable from the two role views alone, and the server agrees', () => {
  let checked = 0;
  for (const stage of STAGES) {
    stage.puzzles.forEach((spec, p) => {
      const def = PUZZLES[spec.type];
      for (let seed = 1; seed <= SEEDS_PER_STAGE; seed++) {
        const where = `${stage.id} puzzle ${p + 1} (${spec.type} L${spec.level}) seed ${seed}`;
        const state = def.generate(seededRng(stage.index * 1009 + p * 101 + seed), spec.level);
        const caller = JSON.parse(JSON.stringify(def.views.caller(state)));
        const operator = JSON.parse(JSON.stringify(def.views.operator(state)));

        // The answer, worked out only from what the two players can see.
        let derived;
        assert.doesNotThrow(() => (derived = SOLVERS[spec.type](caller, operator)), where);
        const parsed = def.parseAnswer(derived, state);
        assert.ok(!parsed.error, `${where}: ${parsed.error}`);
        assert.equal(def.check(state, parsed.value).correct, true, `${where}: derived answer rejected`);
        assert.deepEqual(parsed.value, def.parseAnswer(def.solution(state), state).value, where);

        // Each role's view holds only that role's clues, and never the answer.
        const callerKeys = keysOf(caller);
        const operatorKeys = keysOf(operator);
        for (const k of ROLE_ONLY.operator) assert.ok(!callerKeys.has(k), `${where}: caller view has "${k}"`);
        for (const k of ROLE_ONLY.caller) assert.ok(!operatorKeys.has(k), `${where}: operator view has "${k}"`);
        const answerJson = JSON.stringify(def.solution(state));
        assert.ok(!JSON.stringify(caller).includes(answerJson), `${where}: caller view contains the answer`);
        if (!['teleprinter', 'cipher-wheel'].includes(spec.type)) {
          // (The Operator's roster and codebook list the candidate words by design.)
          assert.ok(!JSON.stringify(operator).includes(answerJson), `${where}: operator view contains the answer`);
        }
        assert.ok(!callerKeys.has('answer') && !operatorKeys.has('answer'), where);
        checked++;
      }
    });
  }
  assert.ok(checked >= STAGES.length * 3 * SEEDS_PER_STAGE);
});

test('every mechanic has three hints per role at every level, and rejects wrong answers', () => {
  for (const [type, def] of Object.entries(PUZZLES)) {
    for (let level = 1; level < def.levels.length; level++) {
      const state = def.generate(seededRng(level * 7), level);
      for (const role of ['caller', 'operator']) {
        assert.equal(def.hints[role].length, 3, `${type} ${role}`);
        for (const fn of def.hints[role]) assert.ok(fn(state).length > 20, `${type} L${level} ${role} hint`);
      }
      const right = def.solution(state);
      let wrong;
      if (typeof right === 'string') wrong = right.split('').reverse().join('') === right ? right.slice(1) + right[0] : right.split('').reverse().join('');
      else if (Array.isArray(right)) wrong = [...right].reverse();
      else wrong = Object.fromEntries(Object.keys(right).map((n, i) => [n, state.trunks[(state.trunks.indexOf(right[n]) + 1 + i) % state.trunks.length]]));
      const parsed = def.parseAnswer(wrong, state);
      if (!parsed.error) {
        const verdict = def.check(state, parsed.value);
        if (JSON.stringify(parsed.value) !== JSON.stringify(def.parseAnswer(right, state).value)) assert.equal(verdict.correct, false, `${type} L${level}`);
        assert.ok(verdict.total > 0 && verdict.matched <= verdict.total);
      }
    }
  }
});

test('input formats: malformed answers get a clear message, never a crash', () => {
  const junk = [null, undefined, 42, '', 'x'.repeat(500), {}, [], { 1: 'Z' }, ['Nobody'], 'UDUDUDUDUDUDUD'];
  for (const [type, def] of Object.entries(PUZZLES)) {
    const state = def.generate(seededRng(3), def.levels.length - 1);
    for (const raw of junk) {
      const parsed = def.parseAnswer(raw, state);
      if (parsed.error) assert.equal(typeof parsed.error, 'string', type);
      else assert.equal(typeof def.check(state, parsed.value).correct, 'boolean', type);
    }
  }
});
