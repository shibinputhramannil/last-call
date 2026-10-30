import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRng } from '../server/random.js';
import {
  Game,
  ANSWER_COOLDOWN_MS,
  HINT_COOLDOWN_MS,
  TIME_LIMIT_MS,
  WRONG_PENALTY_MS,
} from '../server/game.js';

const answerFor = (game) => {
  const { def, state } = game.round;
  if (def.id === 'dead-line') return state.answer;
  if (def.id === 'patch-bay') return state.routes;
  return state.name;
};
const wrongFor = (game) => {
  const right = answerFor(game);
  if (typeof right === 'object') return Object.fromEntries(Object.keys(right).map((n, i) => [n, 'ABCDEF'[i]]));
  if (/^\d+$/.test(right)) return right === '0000' ? '1111' : '0000';
  return right === 'AGNES' ? 'DORIS' : 'AGNES';
};

function started(mode = 'timed', now = 0) {
  const game = new Game({ mode, rng: seededRng(7) });
  game.start(now);
  return game;
}

test('views never contain the private state', () => {
  const game = started();
  for (const role of ['caller', 'operator']) {
    const json = JSON.stringify(game.viewFor(role, 0));
    assert.ok(!json.includes('"answer"'));
    assert.ok(!json.includes('"state"'));
    assert.ok(!json.includes('"digitOf"'));
  }
  assert.ok('plates' in game.viewFor('caller', 0).puzzle.view);
  assert.ok(!('plates' in game.viewFor('operator', 0).puzzle.view));
});

test('only the caller can answer', () => {
  const game = started();
  const result = game.submitAnswer('operator', answerFor(game), 1_000);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_ALLOWED');
});

test('wrong answers cost time, are throttled, and give feedback from the second try', () => {
  const game = started('timed', 0);
  const first = game.submitAnswer('caller', wrongFor(game), 1_000);
  assert.equal(first.correct, false);
  assert.equal(first.penaltyMs, WRONG_PENALTY_MS);
  assert.equal(first.feedback, null);
  assert.equal(game.remaining(1_000), TIME_LIMIT_MS - 1_000 - WRONG_PENALTY_MS);

  const throttled = game.submitAnswer('caller', wrongFor(game), 1_500);
  assert.equal(throttled.code, 'COOLDOWN');

  const second = game.submitAnswer('caller', wrongFor(game), 1_000 + ANSWER_COOLDOWN_MS);
  assert.equal(second.feedback.total, 4);
  assert.equal(typeof second.feedback.matched, 'number');
});

test('malformed answers are rejected without a penalty', () => {
  const game = started('timed', 0);
  const result = game.submitAnswer('caller', '12', 1_000);
  assert.equal(result.code, 'INVALID');
  assert.equal(game.round.attempts, 0);
  assert.equal(game.remaining(1_000), TIME_LIMIT_MS - 1_000);
});

test('untimed games never lose and take no penalties', () => {
  const game = started('untimed', 0);
  const result = game.submitAnswer('caller', wrongFor(game), 1_000);
  assert.equal(result.penaltyMs, 0);
  assert.equal(game.remaining(10 * TIME_LIMIT_MS), null);
  assert.equal(game.checkTimeout(10 * TIME_LIMIT_MS), false);
});

test('hints unlock one at a time with a cooldown, per role', () => {
  const game = started();
  const h1 = game.requestHint('caller', 1_000);
  assert.equal(h1.tier, 1);
  assert.equal(game.requestHint('caller', 2_000).code, 'COOLDOWN');
  assert.equal(game.requestHint('operator', 2_000).tier, 1, 'operator has their own track');
  assert.equal(game.requestHint('caller', 1_000 + HINT_COOLDOWN_MS).tier, 2);
  assert.equal(game.requestHint('caller', 1_000 + 2 * HINT_COOLDOWN_MS).tier, 3);
  assert.equal(game.requestHint('caller', 1_000 + 3 * HINT_COOLDOWN_MS).code, 'NO_MORE_HINTS');
  const view = game.viewFor('caller', 1_000 + 3 * HINT_COOLDOWN_MS);
  assert.equal(view.puzzle.hints.length, 3);
  assert.equal(game.viewFor('operator', 0).puzzle.hints.length, 1);
});

test('pausing freezes the clock', () => {
  const game = started('timed', 0);
  game.pause(10_000);
  assert.equal(game.remaining(500_000), TIME_LIMIT_MS - 10_000);
  assert.equal(game.submitAnswer('caller', answerFor(game), 500_000).code, 'PAUSED');
  game.resume(500_000);
  assert.equal(game.remaining(510_000), TIME_LIMIT_MS - 20_000);
});

test('running out of time loses the game', () => {
  const game = started('timed', 0);
  assert.equal(game.checkTimeout(TIME_LIMIT_MS - 1), false);
  assert.equal(game.checkTimeout(TIME_LIMIT_MS), true);
  assert.equal(game.status, 'lost');
  assert.equal(game.viewFor('caller', TIME_LIMIT_MS).result.solved, 0);
});

test('solving all three puzzles wins', () => {
  const game = started('timed', 0);
  let now = 0;
  const titles = [];
  for (let i = 0; i < 3; i++) {
    now += ANSWER_COOLDOWN_MS;
    const result = game.submitAnswer('caller', answerFor(game), now);
    assert.equal(result.correct, true);
    titles.push(result.solvedTitle);
  }
  assert.deepEqual(titles, ['The Dead Line', 'The Patch Bay', 'The Last Call']);
  assert.equal(game.status, 'won');
  const view = game.viewFor('operator', now);
  assert.equal(view.result.solved, 3);
  assert.equal(view.puzzle, undefined);
});
