// The end of a stage: star lamps, the score and exactly how it was worked out,
// and what to do next. Also the timed-out and campaign-finale versions.

import { CHAPTERS, stageById } from '/shared/campaign.js';
import { SCORE, STAR_LABELS } from '/shared/scoring.js';
import { FINALE } from '/shared/story.js';
import { h, formatDuration, prefersReducedMotion } from './dom.js';

const STAR_PATH = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z';

function starLamps(stars, animate) {
  return h(
    'div',
    { class: `star-lamps${animate ? ' is-animated' : ''}`, role: 'img', 'aria-label': `${stars} of 3 stars: ${STAR_LABELS[stars]}` },
    [1, 2, 3].map((n) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', STAR_PATH);
      svg.append(path);
      return h('span', { class: `star-lamp${n <= stars ? ' is-lit' : ''}`, style: `--i: ${n - 1}` }, svg);
    }),
  );
}

function breakdown(result) {
  const rows = result.breakdown.map((b) => {
    if (b.key === 'base') return ['Line restored', 'Every stage starts at the full score', b.points];
    if (b.key === 'time') {
      return [
        'Stage clock',
        `${formatDuration(result.activeMs)} against a par of ${formatDuration(result.parMs)}${
          b.overSeconds ? `: ${formatDuration(b.overSeconds * 1000)} over, one point per ${SCORE.secondsPerPoint} seconds` : ', within par'
        }`,
        b.points,
      ];
    }
    if (b.key === 'wrong') return ['Wrong answers', `${b.count} × ${SCORE.perWrong} points`, b.points];
    return ['Hints read', `${b.count} × ${SCORE.perHint} points, by either of you`, b.points];
  });
  const fmt = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
  return h(
    'section',
    { class: 'score-ticket', 'aria-labelledby': 'ticket-title' },
    h('h2', { id: 'ticket-title' }, 'How this score was worked out'),
    h(
      'table',
      {},
      h(
        'tbody',
        {},
        rows.map(([what, detail, points]) =>
          h('tr', {}, h('th', { scope: 'row' }, what, h('span', { class: 'ticket-detail' }, detail)), h('td', {}, fmt(points))),
        ),
      ),
      h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, 'Score'), h('td', {}, String(result.score)))),
    ),
  );
}

function howStars() {
  return h(
    'details',
    { class: 'how-stars' },
    h('summary', {}, 'How stars work'),
    h(
      'ul',
      {},
      h('li', {}, `★★★ Excellent: ${SCORE.threeStars} points or more.`),
      h('li', {}, `★★ Good: ${SCORE.twoStars} to ${SCORE.threeStars - 1} points.`),
      h('li', {}, '★ Completed: any finished stage.'),
      h('li', {}, `Time over par, wrong answers and hints each cost points, up to ${SCORE.timeCap} each. A score never drops below ${SCORE.floor}.`),
      h(
        'li',
        {},
        'The stage clock stops whenever either of you is disconnected and between puzzles, so a dropped connection, a slow device or a motion setting never costs you points.',
      ),
    ),
  );
}

/** Animates the score counting up. Returns a function that stops it. */
function countUp(el, to) {
  let raf = 0;
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 900);
    el.textContent = String(Math.round(to * (1 - (1 - k) ** 3)));
    if (k < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

export function renderResult(root, { game, partnerReady, waitingText, audio, onContinue, onReplay, onMap }) {
  const result = game.result;
  const stage = stageById(result.stageId);
  const chapter = CHAPTERS[stage.chapter - 1];
  const reduced = prefersReducedMotion();
  const timers = [];
  let stopCount = () => {};
  const ref = h('p', { class: 'result-ref' }, `Stage ${stage.id}: ${stage.title}`);

  if (game.phase === 'failed') {
    root.append(
      h(
        'article',
        { class: 'result is-failed' },
        ref,
        h('h1', { class: 'result-title', id: 'result-title', tabindex: '-1' }, 'The line went dead'),
        h(
          'p',
          { class: 'result-text' },
          `The countdown ran out with ${result.solved} of 3 puzzles restored. Try the stage again: the puzzles will be new. Or turn the countdown off in the stage map.`,
        ),
        h(
          'div',
          { class: 'result-actions' },
          h('button', { class: 'btn btn-lamp', type: 'button', 'data-needs-partner': '', onclick: onReplay }, 'Try the stage again'),
          h('button', { class: 'btn', type: 'button', onclick: onMap }, 'Stage map'),
        ),
        h('p', { class: 'stage-note' }),
      ),
    );
    return withReady(root, partnerReady, waitingText, () => {});
  }

  const finale = game.phase === 'finale';
  const scoreEl = h('span', { class: 'score-num' }, reduced ? String(result.score) : '0');
  const actions = h('div', { class: 'result-actions' });
  const next = result.nextStageId ? stageById(result.nextStageId) : null;
  if (finale) {
    actions.append(h('button', { class: 'btn btn-lamp', type: 'button', onclick: onContinue }, 'Back to the stage map'));
  } else {
    actions.append(
      h(
        'button',
        { class: 'btn btn-lamp', type: 'button', 'data-needs-partner': '', onclick: onContinue },
        stage.finale && next ? `Begin chapter ${next.chapter}` : `Continue to stage ${next.id}`,
      ),
      h('button', { class: 'btn', type: 'button', 'data-needs-partner': '', onclick: onReplay }, 'Replay this stage'),
      h('button', { class: 'btn-text', type: 'button', onclick: onMap }, 'Stage map'),
    );
  }

  root.append(
    h(
      'article',
      { class: `result${finale ? ' is-finale' : ''}` },
      h('div', { class: 'result-cord', 'aria-hidden': 'true' }),
      ref,
      h('h1', { class: 'result-title', id: 'result-title', tabindex: '-1' }, finale ? FINALE.title : 'Line restored'),
      starLamps(result.stars, !reduced),
      h('p', { class: 'result-label' }, STAR_LABELS[result.stars]),
      h(
        'p',
        { class: 'result-score' },
        scoreEl,
        h('span', { class: 'score-unit' }, ' points'),
        result.isBest && !result.firstClear ? h('span', { class: 'best-tag' }, `New best, up from ${result.previousBest}`) : null,
        !result.isBest ? h('span', { class: 'best-tag is-quiet' }, `Your best is still ${Math.max(result.previousBest ?? 0, result.score)}`) : null,
      ),
      stage.finale || finale
        ? h(
            'section',
            { class: 'chapter-close' },
            h('h2', {}, finale ? 'The end of the line' : `Chapter ${chapter.number} complete: ${chapter.title}`),
            h('p', {}, finale ? FINALE.text : chapter.outro),
          )
        : null,
      breakdown(result),
      howStars(),
      actions,
      h('p', { class: 'stage-note' }),
    ),
  );

  if (!reduced) {
    stopCount = countUp(scoreEl, result.score);
    for (let i = 0; i < result.stars; i++) timers.push(setTimeout(() => audio.play('star', { index: i }), 350 + i * 320));
  }
  return withReady(root, partnerReady, waitingText, () => {
    stopCount();
    timers.forEach(clearTimeout);
  });
}

/** Buttons that start a stage need both players; this keeps them in step without redrawing. */
function withReady(root, ready, waitingText, destroy) {
  const ctl = {
    destroy,
    setReady(isReady, text) {
      root.querySelectorAll('[data-needs-partner]').forEach((b) => (b.disabled = !isReady));
      const note = root.querySelector('.stage-note');
      if (note) {
        note.textContent = isReady ? '' : text;
        note.hidden = isReady;
      }
    },
  };
  ctl.setReady(ready, waitingText);
  return ctl;
}
