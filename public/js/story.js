// The opening: a short story told one page at a time, each page a small
// animated scene drawn in the exchange's own language (lamps, cords, a wall
// clock, a logbook), with Back, Next and an always-visible Skip. Shown on
// every fresh visit; replayable from Settings.
//
// The scenes are inline SVG animated by CSS, a few kilobytes in all: nothing
// downloads, nothing can fail to load, and under reduced motion the
// stylesheet collapses every animation to its final frame. No sound plays
// until the player's first tap, as everywhere else in the game.

import { OPENING } from '/shared/story.js';
import { $, h, s, clear, announce, prefersReducedMotion } from './dom.js';

/**
 * One scene per page of OPENING. Years come from the lore: Exchange 7 opened
 * in 1924 (the original switchboard below the building) and closed on a winter
 * night in 1963; tonight is some sixty years later.
 */
const SCENES = [sceneArchive, sceneRing, sceneCaller, sceneOperator, sceneTalk, sceneLines];

const g = (props, ...children) => s('g', props, ...children);

/** An archive card: EXCHANGE 7, 1924 to 1963, the file stamped CLOSED. */
function sceneArchive() {
  return s(
    'svg',
    { class: 'scene scene-archive', viewBox: '0 0 320 180', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { class: 'card', x: '52', y: '28', width: '216', height: '124', rx: '4' }),
    s('line', { class: 'rule', x1: '70', y1: '58', x2: '250', y2: '58' }),
    s('line', { class: 'rule', x1: '70', y1: '118', x2: '250', y2: '118' }),
    s('text', { class: 'card-head', x: '160', y: '50', 'text-anchor': 'middle' }, 'EXCHANGE 7'),
    s('text', { class: 'card-year', x: '160', y: '101', 'text-anchor': 'middle' }, '1924 — 1963'),
    s('text', { class: 'card-foot', x: '160', y: '138', 'text-anchor': 'middle' }, 'LINES CUT · DOORS LOCKED'),
    g({ class: 'stamp', transform: 'translate(226 136) rotate(-12)' }, s('rect', { x: '-34', y: '-13', width: '68', height: '26', rx: '3' }), s('text', { x: '0', y: '5', 'text-anchor': 'middle' }, 'CLOSED')),
    s('circle', { class: 'hole', cx: '66', cy: '42', r: '3' }),
    s('circle', { class: 'hole', cx: '254', cy: '42', r: '3' }),
  );
}

/** A dark switchboard; one lamp wakes and rings. */
function sceneRing() {
  const lamps = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      const live = r === 1 && c === 6;
      lamps.push(s('circle', { class: `lamp${live ? ' is-live' : ''}`, cx: String(62 + c * 28), cy: String(56 + r * 34), r: '7' }));
    }
  }
  return s(
    'svg',
    { class: 'scene scene-ring', viewBox: '0 0 320 180', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { class: 'board', x: '36', y: '30', width: '248', height: '120', rx: '8' }),
    ...lamps,
    g({ class: 'ring-waves', transform: 'translate(230 90)' }, s('circle', { r: '14' }), s('circle', { r: '24' }), s('circle', { r: '34' })),
    s('text', { class: 'board-tag', x: '160', y: '166', 'text-anchor': 'middle' }, 'LINE 7'),
  );
}

/** The Caller's side: dials, lamps and a machine, seen but not understood. */
function sceneCaller() {
  return s(
    'svg',
    { class: 'scene scene-caller', viewBox: '0 0 320 180', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { class: 'panel', x: '40', y: '26', width: '240', height: '128', rx: '10' }),
    g({ class: 'dial', transform: 'translate(96 90)' }, s('circle', { class: 'dial-face', r: '36' }), s('circle', { class: 'dial-plate', r: '26' }), s('circle', { class: 'dial-hole', cx: '0', cy: '-18', r: '4' }), s('circle', { class: 'dial-hole', cx: '14', cy: '-11', r: '4' }), s('circle', { class: 'dial-hole', cx: '18', cy: '4', r: '4' }), s('circle', { class: 'dial-hole', cx: '10', cy: '16', r: '4' })),
    g({ class: 'plates', transform: 'translate(160 62)' }, [0, 1, 2].map((i) => s('rect', { class: 'plate', x: String(i * 36), y: '0', width: '28', height: '28', rx: '4', style: `--i: ${i}` }))),
    g({ class: 'glyphs', transform: 'translate(160 62)' }, s('path', { d: 'M14 6l6 11h-12z' }), s('path', { d: 'M50 8v12M44 14h12' }), s('circle', { cx: '86', cy: '14', r: '6' })),
    g({ class: 'lever', transform: 'translate(236 118)' }, s('rect', { x: '-4', y: '-30', width: '8', height: '30', rx: '3' }), s('circle', { cy: '-32', r: '7' })),
    s('text', { class: 'query', x: '218', y: '118', 'text-anchor': 'middle' }, '?'),
  );
}

/** The Operator's side: the field manual, its page turning. */
function sceneOperator() {
  return s(
    'svg',
    { class: 'scene scene-operator', viewBox: '0 0 320 180', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { class: 'manual', x: '70', y: '22', width: '180', height: '136', rx: '3' }),
    s('line', { class: 'spine', x1: '160', y1: '22', x2: '160', y2: '158' }),
    g({ class: 'manual-text' }, [0, 1, 2, 3, 4].map((i) => s('line', { class: 'ink', x1: '84', y1: String(48 + i * 18), x2: String(118 + (i % 2) * 20), y2: String(48 + i * 18), style: `--i: ${i}` }))),
    g({ class: 'manual-figure', transform: 'translate(176 44)' }, s('path', { d: 'M14 6l6 11h-12z' }), s('text', { x: '30', y: '16' }, '= 3'), s('path', { d: 'M14 36v12M8 42h12' }), s('text', { x: '30', y: '46' }, '= 7'), s('circle', { cx: '14', cy: '74', r: '6' }), s('text', { x: '30', y: '79' }, '= 1')),
    s('path', { class: 'page-turn', d: 'M250 22v136l-90-0' }),
    s('text', { class: 'manual-tag', x: '160', y: '172', 'text-anchor': 'middle' }, 'FIELD MANUAL · NIGHT STAFF'),
  );
}

/** Two headsets, and a cord between them that carries the words. */
function sceneTalk() {
  return s(
    'svg',
    { class: 'scene scene-talk', viewBox: '0 0 320 180', 'aria-hidden': 'true', focusable: 'false' },
    g({ class: 'headset', transform: 'translate(70 90)' }, s('path', { d: 'M-26 0a26 26 0 0 1 52 0' }), s('rect', { x: '-32', y: '-4', width: '12', height: '22', rx: '4' }), s('rect', { x: '20', y: '-4', width: '12', height: '22', rx: '4' })),
    g({ class: 'headset', transform: 'translate(250 90)' }, s('path', { d: 'M-26 0a26 26 0 0 1 52 0' }), s('rect', { x: '-32', y: '-4', width: '12', height: '22', rx: '4' }), s('rect', { x: '20', y: '-4', width: '12', height: '22', rx: '4' })),
    s('path', { class: 'cord', d: 'M104 100c20 -30 36 30 56 0s36 30 56 0' }),
    g({ class: 'words' }, s('circle', { class: 'word', cx: '112', cy: '92', r: '3', style: '--i: 0' }), s('circle', { class: 'word', cx: '160', cy: '100', r: '3', style: '--i: 1' }), s('circle', { class: 'word', cx: '208', cy: '92', r: '3', style: '--i: 2' })),
    s('text', { class: 'talk-tag', x: '70', y: '140', 'text-anchor': 'middle' }, 'CALLER'),
    s('text', { class: 'talk-tag', x: '250', y: '140', 'text-anchor': 'middle' }, 'OPERATOR'),
  );
}

/** The frames of the exchange, two hundred lines, lit one route at a time, the last call at the end. */
function sceneLines() {
  const jacks = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 10; c++) {
      jacks.push(s('circle', { class: 'jack', cx: String(52 + c * 24), cy: String(48 + r * 28), r: '5', style: `--i: ${r * 10 + c}` }));
    }
  }
  return s(
    'svg',
    { class: 'scene scene-lines', viewBox: '0 0 320 180', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { class: 'frame', x: '36', y: '28', width: '248', height: '112', rx: '8' }),
    ...jacks,
    s('path', { class: 'route', d: 'M52 132h216c12 0 12 -28 0 -28h-216c-12 0 -12 -28 0 -28h216c12 0 12 -28 0 -28h-216' }),
    s('circle', { class: 'last-lamp', cx: '52', cy: '48', r: '8' }),
    s('text', { class: 'lines-tag', x: '160', y: '164', 'text-anchor': 'middle' }, 'TWO HUNDRED LINES · ONE LAST CALL'),
  );
}

export function runOpening({ audio, onDone }) {
  const screen = $('#screen-story');
  const scene = $('#story-scene');
  const page = $('#story-page');
  const back = $('#story-back');
  const next = $('#story-next');
  const skip = $('#story-skip');
  const dots = $('#story-dots');
  let index = 0;
  let finished = false;

  clear(dots);
  OPENING.forEach(() => dots.append(h('li', {})));

  function show(i, direction = 1) {
    index = Math.max(0, Math.min(OPENING.length - 1, i));
    const p = OPENING[index];
    const last = index === OPENING.length - 1;
    clear(scene).append(SCENES[index]());
    clear(page).append(h('p', { class: 'story-kicker' }, p.kicker), h('p', { class: 'story-text' }, p.text));
    page.dataset.dir = direction > 0 ? 'next' : 'back';
    scene.dataset.dir = page.dataset.dir;
    if (!prefersReducedMotion()) {
      for (const el of [page, scene]) {
        el.classList.remove('is-turning');
        void el.offsetWidth;
        el.classList.add('is-turning');
      }
    }
    back.disabled = index === 0;
    next.textContent = last ? 'Pick up the receiver' : 'Next';
    next.classList.toggle('is-final', last);
    [...dots.children].forEach((dot, d) => dot.classList.toggle('is-on', d <= index));
    dots.setAttribute('aria-label', `Page ${index + 1} of ${OPENING.length}`);
    announce(`${p.kicker}. ${p.text}`);
  }

  function finish() {
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onKey);
    next.removeEventListener('click', onNext);
    back.removeEventListener('click', onBack);
    skip.removeEventListener('click', finish);
    audio.unlock();
    audio.play('pickup');
    onDone();
  }

  function onNext() {
    audio.unlock();
    if (index === OPENING.length - 1) finish();
    else {
      audio.play('page');
      show(index + 1, 1);
    }
  }
  function onBack() {
    if (index > 0) {
      audio.play('page');
      show(index - 1, -1);
    }
  }
  function onKey(e) {
    if (screen.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.querySelector('#settings:not([hidden])')) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onNext();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onBack();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish();
    }
  }

  next.addEventListener('click', onNext);
  back.addEventListener('click', onBack);
  skip.addEventListener('click', finish);
  document.addEventListener('keydown', onKey);
  show(0);
  next.focus();
}
