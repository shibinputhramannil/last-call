// The stage map: a cable route through the exchange. Each chapter is one frame
// of the main distribution board; its twenty stages are jacks strung along a
// patch cord that winds up the frame. The cord is lit as far as the team has
// restored it, the next stage breathes like a waiting lamp, and the stages
// beyond are dark sockets with the cord's dashed guide ahead of them.
//
// The route is a picture. The same stages are also a plain list under it
// ("Stages in this chapter"), which is what the keyboard and screen readers
// use, and the row of line keys above switches chapter. Nothing here changes
// what progress means: it reads the campaign view the server sends, keyed by
// stage id, exactly as before.

import { CHAPTERS, MECHANICS, STAGES, STAGES_PER_CHAPTER, stageById } from '/shared/campaign.js';
import { $$, h, s, clear, formatClock, prefersReducedMotion } from './dom.js';

const COLUMNS = 4;
const starText = (n) => `${n} of 3 stars`;

// The route's geometry, in the SVG's own units. Four jacks to a row, the rows
// climbing up the frame, the cord snaking left to right then right to left.
const VW = 400;
const ROW_H = 78;
const PAD_X = 50;
const PAD_Y = 36;
const ROWS = STAGES_PER_CHAPTER / COLUMNS;
const VH = PAD_Y * 2 + (ROWS - 1) * ROW_H;

/** Where jack `n` (0-based within its chapter) sits. */
function jackPoint(n) {
  const row = Math.floor(n / COLUMNS);
  const col = n % COLUMNS;
  const x = row % 2 === 0 ? col : COLUMNS - 1 - col;
  return { x: PAD_X + (x * (VW - 2 * PAD_X)) / (COLUMNS - 1), y: VH - PAD_Y - row * ROW_H };
}

/** The cord's path through every jack, rounded at the turns. */
function routePath(count) {
  const pts = Array.from({ length: count }, (_, i) => jackPoint(i));
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.y === b.y) d += ` L${b.x} ${b.y}`;
    else {
      // A turn up to the next row: a half-loop out past the frame's edge.
      const out = a.x > VW / 2 ? 34 : -34;
      d += ` C${a.x + out} ${a.y}, ${b.x + out} ${b.y}, ${b.x} ${b.y}`;
    }
  }
  return d;
}

export function createMap(root, { onPlay }) {
  let selected = null; // stage id
  let chapterNo = null;
  let last = null;
  let litBefore = null; // how far the cord was lit at the last render, per chapter (for the unlock motion)
  const cordPath = routePath(STAGES_PER_CHAPTER);
  const svgNS = 'http://www.w3.org/2000/svg';

  const isDone = (campaign, stage) => Boolean(campaign.stages[stage.id]);
  const isUnlocked = (campaign, stage) => stage.index === 0 || isDone(campaign, STAGES[stage.index - 1]);
  const chapterStages = (number) => STAGES.filter((st) => st.chapter === number);
  const chapterStars = (campaign, number) => chapterStages(number).reduce((sum, st) => sum + (campaign.stages[st.id]?.stars || 0), 0);
  const restoredIn = (campaign, number) => chapterStages(number).filter((st) => isDone(campaign, st)).length;

  function render(view) {
    last = view;
    const { campaign } = view;
    if (!selected || !stageById(selected)) selected = campaign.frontier;
    if (!chapterNo) chapterNo = stageById(selected).chapter;
    const chapter = CHAPTERS[chapterNo - 1];
    const stages = chapterStages(chapterNo);
    const restored = restoredIn(campaign, chapterNo);
    const stars = chapterStars(campaign, chapterNo);
    const frontier = stageById(campaign.frontier);
    const nextHere = stages.find((st) => st.id === campaign.frontier) || null;

    clear(root).append(
      lineKeys(campaign),
      h(
        'section',
        { class: 'frame', 'aria-labelledby': 'frame-title' },
        h(
          'header',
          { class: 'frame-head' },
          h('p', { class: 'frame-ref' }, `Frame ${chapter.number} of ${CHAPTERS.length}`),
          h('h2', { id: 'frame-title' }, chapter.title),
          h('p', { class: 'frame-intro' }, chapter.intro),
          progressBar(restored, stages.length, stars),
          nextHere
            ? h('p', { class: 'frame-next' }, h('span', { class: 'lamp-dot is-live', 'aria-hidden': 'true' }), ` Next line: Stage ${nextHere.id}, ${nextHere.title}`)
            : frontier && restored === stages.length
              ? h('p', { class: 'frame-next is-done' }, `Every line in this frame is restored. The route carries on at Stage ${frontier.id}.`)
              : null,
        ),
        route(campaign, stages, restored),
        stageList(campaign, stages),
      ),
      stageCard(view),
    );
    litBefore = { chapter: chapterNo, restored };
  }

  // ---- The line keys: one per chapter ---------------------------------------------

  function lineKeys(campaign) {
    return h(
      'nav',
      { class: 'chapters', 'aria-label': 'Chapters' },
      h(
        'ol',
        { class: 'chapter-keys' },
        CHAPTERS.map((ch) => {
          const first = STAGES.find((st) => st.chapter === ch.number);
          const locked = !isUnlocked(campaign, first);
          const done = restoredIn(campaign, ch.number);
          const stars = chapterStars(campaign, ch.number);
          const current = ch.number === chapterNo;
          const complete = done === STAGES_PER_CHAPTER;
          return h(
            'li',
            {},
            h(
              'button',
              {
                type: 'button',
                class: `chapter-key${current ? ' is-current' : ''}${locked ? ' is-locked' : ''}${complete ? ' is-complete' : ''}`,
                'aria-current': current ? 'true' : null,
                'aria-label': `Chapter ${ch.number}, ${ch.title}${locked ? ', locked' : `, ${done} of ${STAGES_PER_CHAPTER} lines restored, ${stars} of ${STAGES_PER_CHAPTER * 3} stars`}`,
                onclick: () => {
                  chapterNo = ch.number;
                  const firstOpen = chapterStages(ch.number).find((st) => isUnlocked(campaign, st) && !isDone(campaign, st));
                  selected = (firstOpen || first).id;
                  render(last);
                  root.querySelector('.chapter-key.is-current')?.focus();
                },
              },
              h('span', { class: `key-lamp${complete ? ' is-lit' : locked ? '' : ' is-warm'}`, 'aria-hidden': 'true' }),
              h('span', { class: 'key-num', 'aria-hidden': 'true' }, String(ch.number)),
              h('span', { class: 'key-title', 'aria-hidden': 'true' }, ch.title),
              h('span', { class: 'key-meter', 'aria-hidden': 'true' }, locked ? 'Locked' : `${done}/${STAGES_PER_CHAPTER}`),
            ),
          );
        }),
      ),
    );
  }

  function progressBar(restored, total, stars) {
    return h(
      'div',
      { class: 'frame-progress' },
      h(
        'div',
        { class: 'frame-meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(restored), 'aria-label': 'Lines restored in this chapter' },
        h('span', { class: 'frame-meter-fill', style: `width: ${(100 * restored) / total}%` }),
      ),
      h('p', { class: 'frame-count' }, `${restored} of ${total} lines restored, ${stars} of ${total * 3} stars`),
    );
  }

  // ---- The route: the picture of the stages ----------------------------------------

  function route(campaign, stages, restored) {
    const reduced = prefersReducedMotion();
    const justUnlocked = !reduced && litBefore && litBefore.chapter === chapterNo && restored > litBefore.restored;
    const litCount = Math.min(restored, stages.length);
    // How far along the cord the lit part reaches: to the frontier jack, so the next lamp sits at its tip.
    const litTo = Math.min(stages.length - 1, litCount);

    const svg = s('svg', { class: `route${justUnlocked ? ' is-advancing' : ''}`, viewBox: `0 0 ${VW} ${VH}`, 'aria-hidden': 'true', focusable: 'false' });
    // The frame's rails and the dashed guide for the whole route.
    svg.append(s('path', { class: 'route-guide', d: cordPath }));
    // The lit cord, drawn up to the frontier by clipping to the jacks' progress.
    const lit = s('path', { class: 'route-lit', d: cordPath });
    svg.append(lit);
    // Lit fraction, by path length: measured once the element is in the document.
    queueMicrotask(() => {
      try {
        const len = lit.getTotalLength();
        const fraction = fractionTo(litTo, stages.length);
        lit.style.setProperty('stroke-dasharray', `${len}`);
        lit.style.setProperty('--route-len', `${len}`);
        lit.style.setProperty('stroke-dashoffset', `${len * (1 - fraction)}`);
        if (justUnlocked) {
          const from = fractionTo(Math.min(stages.length - 1, litBefore.restored), stages.length);
          lit.style.setProperty('--route-from', `${len * (1 - from)}`);
        }
      } catch {
        // Not in a document yet (tests): the static drawing is enough.
      }
    });
    // Signal pulses that travel the lit cord now and then.
    if (!reduced && litTo > 0) {
      const pulse = s('circle', { class: 'route-signal', r: '4' });
      const motion = document.createElementNS(svgNS, 'animateMotion');
      motion.setAttribute('dur', `${6 + litTo * 0.6}s`);
      motion.setAttribute('repeatCount', 'indefinite');
      motion.setAttribute('keyPoints', `0;${fractionTo(litTo, stages.length).toFixed(4)}`);
      motion.setAttribute('keyTimes', '0;1');
      motion.setAttribute('calcMode', 'linear');
      const mpath = document.createElementNS(svgNS, 'mpath');
      mpath.setAttribute('href', '#route-cord');
      motion.append(mpath);
      pulse.append(motion);
      svg.append(pulse);
    }
    lit.setAttribute('id', 'route-cord');

    stages.forEach((stage, i) => {
      const { x, y } = jackPoint(i);
      const done = campaign.stages[stage.id];
      const open = isUnlocked(campaign, stage);
      const next = open && !done;
      const g = s('g', {
        class: `route-jack${done ? ' is-done' : ''}${next ? ' is-next' : ''}${open ? '' : ' is-locked'}${stage.finale ? ' is-finale' : ''}${stage.id === selected ? ' is-selected' : ''}${justUnlocked && i === litCount ? ' is-unlocking' : ''}`,
        transform: `translate(${x} ${y})`,
        'data-stage': stage.id,
      });
      if (stage.finale) g.append(s('circle', { class: 'jack-finale-ring', r: '21' }));
      g.append(s('circle', { class: 'jack-well', r: '15' }));
      g.append(s('circle', { class: 'jack-lamp', r: '11' }));
      g.append(s('text', { class: 'jack-label', y: '4.5', 'text-anchor': 'middle' }, String(stage.number)));
      if (done) {
        g.append(
          s(
            'g',
            { class: 'jack-stars', transform: 'translate(0 24)' },
            [-9, 0, 9].map((dx, k) => s('path', { class: `jack-star${done.stars > k ? ' on' : ''}`, d: 'M0 -4l1.2 2.5 2.8.4-2 2 .5 2.8L0 4.4l-2.5 1.3.5-2.8-2-2 2.8-.4z', transform: `translate(${dx} 0)` })),
          ),
        );
      }
      // An enamel name tag above the jack. Neighbours on a row take turns
      // sitting high and low, so two names never share a line; a tag at the
      // frame's edge leans in towards the middle so it stays inside.
      const high = (i % COLUMNS) % 2 === 1;
      const edge = x < PAD_X + 1 ? 'start' : x > VW - PAD_X - 1 ? 'end' : 'middle';
      const tag = s('g', { class: 'jack-tag', transform: `translate(0 ${high ? -33 : -21})` });
      const dx = edge === 'start' ? -12 : edge === 'end' ? 12 : 0;
      tag.append(s('text', { class: 'jack-tag-text', 'text-anchor': edge, x: String(dx), y: '3' }, stage.title));
      g.append(tag);
      g.addEventListener('click', () => select(stage.id));
      svg.append(g);
    });
    return h('div', { class: 'route-wrap' }, svg);
  }

  /** The fraction of the cord from the first jack to jack `n`, by the route's geometry. */
  function fractionTo(n, count) {
    if (n <= 0) return 0;
    const seg = (a, b) => {
      if (a.y === b.y) return Math.abs(b.x - a.x);
      // The half-loop between rows: approximate the cubic's length.
      return Math.hypot(b.x - a.x, b.y - a.y) * 1.35;
    };
    let total = 0;
    let upTo = 0;
    for (let i = 1; i < count; i++) {
      const d = seg(jackPoint(i - 1), jackPoint(i));
      total += d;
      if (i <= n) upTo += d;
    }
    return total ? upTo / total : 0;
  }

  // ---- The list: the same stages as buttons ----------------------------------------

  function stageList(campaign, stages) {
    const list = h(
      'ol',
      { class: 'stage-list', 'aria-label': `Stages in chapter ${stages[0].chapter}` },
      stages.map((stage) => {
        const done = campaign.stages[stage.id];
        const open = isUnlocked(campaign, stage);
        const next = open && !done;
        const label = `Stage ${stage.id}, ${stage.title}, ${done ? `${starText(done.stars)}, best ${done.best}` : open ? 'next to play' : 'locked'}`;
        return h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: `jack${done ? ' is-done' : ''}${next ? ' is-next' : ''}${open ? '' : ' is-locked'}${stage.finale ? ' is-finale' : ''}${stage.id === selected ? ' is-selected' : ''}`,
              'aria-pressed': String(stage.id === selected),
              'aria-label': label,
              'data-stage': stage.id,
              onclick: () => select(stage.id),
            },
            h('span', { class: 'jack-socket', 'aria-hidden': 'true' }, h('span', { class: 'jack-num' }, String(stage.number))),
            h(
              'span',
              { class: 'jack-name', 'aria-hidden': 'true' },
              h('span', { class: 'jack-title' }, stage.title),
              h('span', { class: 'jack-state' }, done ? `${'★'.repeat(done.stars)}${'☆'.repeat(3 - done.stars)}` : next ? 'Next' : open ? 'Open' : 'Locked'),
            ),
          ),
        );
      }),
    );
    list.addEventListener('keydown', onArrow);
    return h('details', { class: 'stage-list-wrap', open: true }, h('summary', {}, 'All stages in this chapter'), list);
  }

  // ---- The card: the selected stage --------------------------------------------------

  function stageCard(view) {
    const { campaign } = view;
    const stage = stageById(selected);
    const done = campaign.stages[stage.id];
    const open = isUnlocked(campaign, stage);
    const label = done ? `Play stage ${stage.id} again` : `Start stage ${stage.id}`;
    const button = h('button', { class: 'btn btn-lamp', type: 'button', disabled: !open || !view.canPlay, onclick: () => onPlay(stage.id) }, label);
    let note = '';
    if (!open) note = `Restore stage ${STAGES[stage.index - 1].id} to open this line.`;
    else if (!view.canPlay) note = view.waitingText;
    return h(
      'aside',
      { class: 'stage-card', 'aria-labelledby': 'stage-card-title' },
      h('p', { class: 'stage-ref' }, `Stage ${stage.id}${stage.finale ? ', chapter finale' : ''}${done ? '' : open ? ', next line' : ', locked'}`),
      h('h3', { id: 'stage-card-title' }, stage.title),
      h('p', { class: 'stage-beat' }, stage.beat),
      h(
        'ul',
        { class: 'stage-puzzles', 'aria-label': 'Puzzles in this stage' },
        stage.puzzles.map((p) =>
          h(
            'li',
            {},
            h('span', { class: 'sp-title' }, MECHANICS[p.type].title),
            h('span', { class: 'sp-skill' }, MECHANICS[p.type].skill),
            h(
              'span',
              { class: 'sp-level', role: 'img', 'aria-label': `Difficulty ${p.level} of ${MECHANICS[p.type].maxLevel}` },
              Array.from({ length: MECHANICS[p.type].maxLevel }, (_, i) => h('i', { class: i < p.level ? 'on' : null })),
            ),
          ),
        ),
      ),
      h(
        'dl',
        { class: 'stage-facts' },
        h('div', {}, h('dt', {}, 'Par time'), h('dd', {}, formatClock(stage.parMs))),
        view.mode === 'timed' ? h('div', {}, h('dt', {}, 'Countdown'), h('dd', {}, formatClock(stage.limitMs))) : null,
        h('div', {}, h('dt', {}, 'Best'), h('dd', {}, done ? `${'★'.repeat(done.stars)}${'☆'.repeat(3 - done.stars)} ${done.best}` : 'Not yet restored')),
      ),
      button,
      note ? h('p', { class: 'stage-note' }, note) : null,
    );
  }

  function select(id) {
    selected = id;
    chapterNo = stageById(id).chapter;
    render(last);
    root.querySelector(`.stage-list [data-stage="${id}"]`)?.focus();
  }

  /** Arrow keys move along the list; Home and End jump to its ends. */
  function onArrow(e) {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    const buttons = $$('.stage-list .jack', root);
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    let to = null;
    if (step) to = Math.max(0, Math.min(buttons.length - 1, i + step));
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = buttons.length - 1;
    if (to == null) return;
    e.preventDefault();
    buttons[to].focus();
  }

  return {
    render,
    /** Points the map at a stage, e.g. the one just played. */
    focusStage(id) {
      if (!stageById(id)) return;
      selected = id;
      chapterNo = stageById(id).chapter;
    },
  };
}
