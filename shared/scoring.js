// How a completed stage is scored. The server computes every score; the
// browser only uses these numbers to explain them. Only fair measures count:
// time is the stage clock, which stops whenever either player is disconnected
// and between puzzles, so a network drop or a slower animation setting never
// costs points.

export const SCORE = Object.freeze({
  max: 1000,
  floor: 100,
  /** One point off for every this-many seconds beyond the stage's par time. */
  secondsPerPoint: 2,
  timeCap: 300,
  perWrong: 60,
  wrongCap: 300,
  perHint: 40,
  hintCap: 300,
  /** Minimum score for each star rating. */
  threeStars: 850,
  twoStars: 600,
});

export const STAR_LABELS = Object.freeze({ 1: 'Completed', 2: 'Good', 3: 'Excellent' });

export function starsFor(score) {
  if (score >= SCORE.threeStars) return 3;
  if (score >= SCORE.twoStars) return 2;
  return 1;
}

/**
 * activeMs: stage clock time; parMs: the stage's par time;
 * wrong: wrong answers sent; hints: hints read by either player.
 */
export function scoreStage({ activeMs, parMs, wrong, hints }) {
  const overSeconds = Math.max(0, Math.floor((activeMs - parMs) / 1000));
  const time = Math.min(SCORE.timeCap, Math.floor(overSeconds / SCORE.secondsPerPoint));
  const wrongPoints = Math.min(SCORE.wrongCap, wrong * SCORE.perWrong);
  const hintPoints = Math.min(SCORE.hintCap, hints * SCORE.perHint);
  const score = Math.max(SCORE.floor, SCORE.max - time - wrongPoints - hintPoints);
  const stars = starsFor(score);
  return {
    score,
    stars,
    label: STAR_LABELS[stars],
    breakdown: [
      { key: 'base', points: SCORE.max },
      { key: 'time', points: -time, overSeconds },
      { key: 'wrong', points: -wrongPoints, count: wrong },
      { key: 'hints', points: -hintPoints, count: hints },
    ],
  };
}
