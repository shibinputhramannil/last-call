import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES } from '../shared/campaign.js';
import { SCORE, STAR_LABELS, scoreStage, starsFor } from '../shared/scoring.js';
import { Progress } from '../server/progress.js';
import { createSigner } from '../server/signing.js';

const PAR = 6 * 60_000;

test('a clean, quick stage scores 1000 and three stars', () => {
  const r = scoreStage({ activeMs: PAR - 1, parMs: PAR, wrong: 0, hints: 0 });
  assert.equal(r.score, 1000);
  assert.equal(r.stars, 3);
  assert.equal(r.label, 'Excellent');
  assert.deepEqual(
    r.breakdown.map((b) => b.points),
    [1000, -0, -0, -0],
  );
});

test('time over par, wrong answers and hints each cost points, with caps and a floor', () => {
  const r = scoreStage({ activeMs: PAR + 180_000, parMs: PAR, wrong: 2, hints: 3 });
  assert.equal(r.score, 1000 - 90 - 120 - 120);
  assert.equal(r.stars, 2);
  assert.equal(r.breakdown.find((b) => b.key === 'time').overSeconds, 180);
  const worst = scoreStage({ activeMs: PAR * 10, parMs: PAR, wrong: 50, hints: 50 });
  assert.equal(worst.score, Math.max(SCORE.floor, 1000 - SCORE.timeCap - SCORE.wrongCap - SCORE.hintCap));
  assert.equal(worst.stars, 1);
  assert.equal(worst.label, 'Completed');
});

test('star thresholds and labels', () => {
  assert.equal(starsFor(SCORE.threeStars), 3);
  assert.equal(starsFor(SCORE.threeStars - 1), 2);
  assert.equal(starsFor(SCORE.twoStars), 2);
  assert.equal(starsFor(SCORE.twoStars - 1), 1);
  assert.deepEqual(STAR_LABELS, { 1: 'Completed', 2: 'Good', 3: 'Excellent' });
  // A couple of hints still earns three stars: hints are cheaper than guessing.
  assert.equal(scoreStage({ activeMs: 0, parMs: PAR, wrong: 0, hints: 3 }).stars, 3);
});

test('progress unlocks stages in order and keeps the best result', () => {
  const p = new Progress();
  assert.ok(p.isUnlocked(STAGES[0].id));
  assert.ok(!p.isUnlocked(STAGES[1].id));
  assert.equal(p.frontier().id, STAGES[0].id);
  assert.deepEqual(p.record(STAGES[0].id, { score: 700, stars: 2 }), { firstClear: true, isBest: true, previousBest: null });
  assert.ok(p.isUnlocked(STAGES[1].id));
  assert.equal(p.frontier().id, STAGES[1].id);
  assert.deepEqual(p.record(STAGES[0].id, { score: 650, stars: 2 }), { firstClear: false, isBest: false, previousBest: 700 });
  assert.deepEqual(p.get(STAGES[0].id), { stars: 2, best: 700 });
  p.record(STAGES[0].id, { score: 910, stars: 3 });
  assert.deepEqual(p.get(STAGES[0].id), { stars: 3, best: 910 });
  assert.equal(p.totals().stars, 3);
  assert.equal(p.view().frontier, STAGES[1].id);
});

test('progress merges two players’ saves and rejects malformed data', () => {
  const a = Progress.from({ s: { '1-1': [3, 950], '1-2': [1, 300] } });
  const b = Progress.from({ s: { '1-2': [2, 700], '1-3': [1, 200], 'nope': [3, 1000], '1-4': [9, 5], '1-5': [2, 5000] } });
  assert.deepEqual([...b.stages.keys()], ['1-2', '1-3']);
  assert.equal(a.merge(b), true);
  assert.deepEqual(a.get('1-2'), { stars: 2, best: 700 });
  assert.ok(a.isUnlocked('1-4'));
  assert.equal(a.merge(b), false);
  assert.deepEqual(Progress.from(a.toJSON()).toJSON(), a.toJSON());
  assert.equal(Progress.from(null).totals().completed, 0);
});

test('signed saves cannot be forged or altered', () => {
  const signer = createSigner('a-test-secret-that-is-long-enough');
  const other = createSigner('a-different-secret-entirely-long');
  const token = signer.sign('progress', { s: { '1-1': [3, 999] } });
  assert.deepEqual(signer.verify('progress', token).s, { '1-1': [3, 999] });
  assert.equal(signer.verify('ticket', token), null, 'kinds are not interchangeable');
  assert.equal(other.verify('progress', token), null);
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ k: 'progress', s: { '10-20': [3, 1000] } })).toString('base64url');
  assert.equal(signer.verify('progress', `${forged}.${mac}`), null);
  assert.equal(signer.verify('progress', `${body}.${mac}x`), null);
  assert.equal(signer.verify('progress', 'garbage'), null);
  assert.equal(signer.verify('progress', 'x'.repeat(20_000)), null);
  assert.throws(() => createSigner('short'));
});
