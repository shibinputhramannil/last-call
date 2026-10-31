import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES } from '../shared/campaign.js';
import { PUZZLES } from '../server/puzzles/index.js';
import { seededRng } from '../server/random.js';
import { ANSWER_COOLDOWN_MS, HINT_COOLDOWN_MS, TRANSITION_MS, WRONG_PENALTY_MS, Game } from '../server/game.js';

const solution = (game) => PUZZLES[game.round.type].solution(game.round.state);
const wrongFor = (game) => {
  const right = solution(game);
  if (typeof right === 'string') return right.split('').reverse().join('') === right ? right.slice(1) + right[0] : right.split('').reverse().join('');
  if (Array.isArray(right)) return [...right].reverse();
  const trunks = game.round.state.trunks;
  return Object.fromEntries(Object.keys(right).map((n) => [n, trunks[(trunks.indexOf(right[n]) + 1) % trunks.length]]));
};

function started(mode = 'timed', stage = STAGES[0], now = 0) {
  const game = new Game({ mode, rng: seededRng(7) });
  game.startStage(stage, now);
  return game;
}

/** Plays every puzzle of the run correctly, a cooldown apart. Returns the time of the last answer. */
function solveAll(game, from = 1_000) {
  let t = from;
  while (game.playing) {
    const r = game.submitAnswer('caller', game.round.id, solution(game), t);
    assert.ok(r.ok && r.correct, JSON.stringify(r));
    t += TRANSITION_MS + ANSWER_COOLDOWN_MS + 10_000;
  }
  return t;
}

test('a stage run is three puzzles; solving all three completes the stage with a score', () => {
  const game = started('untimed');
  assert.equal(game.phase, 'playing');
  assert.equal(game.run.rounds.length, 3);
  assert.deepEqual(
    game.run.rounds.map((r) => r.type),
    STAGES[0].puzzles.map((p) => p.type),
  );
  solveAll(game);
  assert.equal(game.phase, 'complete');
  assert.equal(game.result.stars, 3);
  assert.equal(game.result.score, 1000);
  assert.equal(game.result.wrong, 0);
  assert.equal(game.result.solved, 3);
});

test('only the final stage of the campaign ends in the finale', () => {
  const second = started('untimed', STAGES[1]);
  solveAll(second);
  assert.equal(second.phase, 'complete');
  const last = started('untimed', STAGES[STAGES.length - 1]);
  solveAll(last);
  assert.equal(last.phase, 'finale');
});

test('views never contain the private state or the other role’s clues', () => {
  const game = started();
  for (const role of ['caller', 'operator']) {
    const json = JSON.stringify(game.viewFor(role, 0));
    assert.ok(!json.includes('"answer"'));
    assert.ok(!json.includes('"state"'));
    assert.ok(!json.includes(JSON.stringify(solution(game))));
  }
  assert.ok('plates' in game.viewFor('caller', 0).puzzle.view);
  assert.ok(!('plates' in game.viewFor('operator', 0).puzzle.view));
  assert.ok(!('blocks' in game.viewFor('caller', 0).puzzle.view));
});

test('only the caller can answer, and only the current puzzle', () => {
  const game = started();
  assert.equal(game.submitAnswer('operator', game.round.id, solution(game), 1_000).code, 'NOT_ALLOWED');
  assert.equal(game.submitAnswer('caller', 'old.1', solution(game), 1_000).code, 'STALE');
  assert.equal(game.submitAnswer('caller', game.round.id, '', 1_000).code, 'INVALID');
});

test('wrong answers count against the score, are throttled, and give feedback from the second try', () => {
  const game = started('timed', STAGES[0], 0);
  const first = game.submitAnswer('caller', game.round.id, wrongFor(game), 1_000);
  assert.equal(first.correct, false);
  assert.equal(first.penaltyMs, WRONG_PENALTY_MS);
  assert.equal(first.feedback, null);
  assert.equal(game.remaining(1_000), STAGES[0].limitMs - 1_000 - WRONG_PENALTY_MS);
  assert.equal(game.submitAnswer('caller', game.round.id, wrongFor(game), 1_500).code, 'COOLDOWN');
  const second = game.submitAnswer('caller', game.round.id, wrongFor(game), 1_000 + ANSWER_COOLDOWN_MS);
  assert.ok(second.feedback && second.feedback.total > 0);
  solveAll(game, 10_000);
  assert.equal(game.result.wrong, 2);
  assert.equal(game.result.score, 1000 - 2 * 60);
});

test('an untimed stage never fails, and wrong answers cost no countdown time', () => {
  const game = started('untimed');
  const r = game.submitAnswer('caller', game.round.id, wrongFor(game), 1_000);
  assert.equal(r.penaltyMs, 0);
  assert.equal(game.checkTimeout(10 * 3_600_000), false);
});

test('a timed stage fails when its countdown runs out', () => {
  const game = started('timed');
  assert.equal(game.checkTimeout(STAGES[0].limitMs - 1), false);
  assert.equal(game.checkTimeout(STAGES[0].limitMs + 1), true);
  assert.equal(game.phase, 'failed');
  assert.equal(game.result.failed, true);
  assert.equal(game.result.stars, undefined);
});

test('the stage clock stops while a player is disconnected, so a drop costs nothing', () => {
  const game = started('untimed', STAGES[0], 0);
  game.pause(60_000); // a player drops after a minute
  game.resume(60_000 + 30 * 60_000); // and is back half an hour later
  assert.equal(game.activeMs(60_000 + 30 * 60_000 + 5_000), 65_000);
  const done = new Game({ mode: 'untimed', rng: seededRng(7) });
  done.startStage(STAGES[0], 0);
  done.pause(1_000);
  done.resume(5 * 3_600_000);
  solveAll(done, 5 * 3_600_000 + 1_000);
  assert.ok(done.result.activeMs < STAGES[0].parMs, 'hours offline did not count');
  assert.equal(done.result.score, 1000);
});

test('the change-over after each solved puzzle is never counted', () => {
  const game = started('untimed', STAGES[0], 0);
  game.submitAnswer('caller', game.round.id, solution(game), 10_000);
  const view = game.viewFor('caller', 10_000 + 1_000);
  assert.equal(view.timer.running, false);
  assert.ok(view.timer.resumesInMs > 0);
  assert.equal(game.activeMs(10_000 + TRANSITION_MS), 10_000);
  assert.equal(game.activeMs(10_000 + TRANSITION_MS + 2_000), 12_000);
});

test('hints are paced, capped at three per role, and counted in the score', () => {
  const game = started('untimed', STAGES[0], 0);
  const id = game.round.id;
  assert.equal(game.requestHint('caller', id, 0).tier, 1);
  assert.equal(game.requestHint('caller', id, 1_000).code, 'COOLDOWN');
  assert.equal(game.requestHint('operator', id, 1_000).tier, 1);
  assert.equal(game.requestHint('caller', id, HINT_COOLDOWN_MS).tier, 2);
  assert.equal(game.requestHint('caller', id, HINT_COOLDOWN_MS * 2).tier, 3);
  assert.equal(game.requestHint('caller', id, HINT_COOLDOWN_MS * 3).code, 'NO_MORE_HINTS');
  assert.equal(game.requestHint('caller', 'old.1', HINT_COOLDOWN_MS * 3).code, 'STALE');
  assert.equal(game.viewFor('caller', HINT_COOLDOWN_MS * 3).puzzle.hints.length, 3);
  assert.equal(game.viewFor('operator', HINT_COOLDOWN_MS * 3).puzzle.hints.length, 1);
  solveAll(game, HINT_COOLDOWN_MS * 3);
  assert.equal(game.result.hints, 4);
  assert.equal(game.result.score, 1000 - 4 * 40);
});

test('a run survives being saved and restored, mid-puzzle, with the clock banked', () => {
  const game = started('timed', STAGES[3], 0);
  game.submitAnswer('caller', game.round.id, solution(game), 20_000);
  game.requestHint('operator', game.round.id, 30_000);
  const data = JSON.parse(JSON.stringify(game.toJSON(40_000)));
  const back = Game.fromJSON(data);
  assert.equal(back.phase, 'playing');
  assert.equal(back.run.index, 1);
  assert.equal(back.paused, true, 'restored runs wait for both players');
  assert.equal(back.activeMs(999_999), game.activeMs(40_000));
  assert.deepEqual(back.viewFor('operator', 50_000).puzzle.view, game.viewFor('operator', 50_000).puzzle.view);
  back.resume(100_000);
  assert.equal(back.submitAnswer('caller', back.round.id, PUZZLES[back.round.type].solution(back.round.state), 110_000).correct, true);
  assert.equal(Game.fromJSON({ mode: 'timed', phase: 'nonsense' }).phase, 'lobby');
  assert.equal(Game.fromJSON({ mode: 'timed', phase: 'playing', run: { stageId: 'no-such', rounds: [] } }).phase, 'lobby');
});
