// The stage map: chapters as a row of line keys, each chapter's twenty stages
// as a field of switchboard jacks that light up as you restore them.

import { CHAPTERS, MECHANICS, STAGES, stageById } from '/shared/campaign.js';
import { $$, h, clear, formatClock } from './dom.js';

const COLUMNS = 5;
const starText = (n) => `${n} of 3 stars`;

export function createMap(root, { onPlay }) {
  let selected = null; // stage id
  let chapterNo = null;
  let last = null;

  const isDone = (campaign, stage) => Boolean(campaign.stages[stage.id]);
  const isUnlocked = (campaign, stage) => stage.index === 0 || isDone(campaign, STAGES[stage.index - 1]);

  function chapterStars(campaign, number) {
    return STAGES.filter((s) => s.chapter === number).reduce((sum, s) => sum + (campaign.stages[s.id]?.stars || 0), 0);
  }

  function render(view) {
    last = view;
    const { campaign } = view;
    if (!selected || !stageById(selected)) selected = campaign.frontier;
    if (!chapterNo) chapterNo = stageById(selected).chapter;
    const chapter = CHAPTERS[chapterNo - 1];
    const stages = STAGES.filter((s) => s.chapter === chapterNo);
    const restored = stages.filter((s) => isDone(campaign, s)).length;

    const keys = h(
      'ol',
      { class: 'chapter-keys' },
      CHAPTERS.map((ch) => {
        const first = STAGES.find((s) => s.chapter === ch.number);
        const locked = !isUnlocked(campaign, first);
        const stars = chapterStars(campaign, ch.number);
        return h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: `chapter-key${ch.number === chapterNo ? ' is-current' : ''}${locked ? ' is-locked' : ''}`,
              'aria-current': ch.number === chapterNo ? 'true' : null,
              'aria-label': `Chapter ${ch.number}, ${ch.title}${locked ? ', locked' : `, ${stars} of 60 stars`}`,
              onclick: () => {
                chapterNo = ch.number;
                const firstOpen = STAGES.filter((s) => s.chapter === ch.number).find((s) => isUnlocked(campaign, s) && !isDone(campaign, s));
                selected = (firstOpen || first).id;
                render(last);
                root.querySelector('.chapter-key.is-current')?.focus();
              },
            },
            h('span', { class: 'key-num', 'aria-hidden': 'true' }, String(ch.number)),
            h('span', { class: 'key-title', 'aria-hidden': 'true' }, ch.title),
            h('span', { class: 'key-stars', 'aria-hidden': 'true' }, locked ? 'Locked' : `★ ${stars}`),
          ),
        );
      }),
    );

    const jacks = h(
      'ol',
      { class: 'jacks', 'aria-label': `Stages in chapter ${chapter.number}` },
      stages.map((stage) => {
        const done = campaign.stages[stage.id];
        const open = isUnlocked(campaign, stage);
        const next = open && !done;
        const label = `Stage ${stage.id}, ${stage.title}, ${done ? `${starText(done.stars)}, best ${done.best}` : open ? 'not yet played' : 'locked'}`;
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
              { class: 'jack-stars', 'aria-hidden': 'true' },
              [1, 2, 3].map((n) => h('i', { class: done && done.stars >= n ? 'on' : null })),
            ),
          ),
        );
      }),
    );
    jacks.addEventListener('keydown', onArrow);

    clear(root).append(
      h('nav', { class: 'chapters', 'aria-label': 'Chapters' }, keys),
      h(
        'div',
        { class: 'map-body' },
        h(
          'section',
          { class: 'board', 'aria-labelledby': 'board-title' },
          h(
            'header',
            { class: 'board-head' },
            h('h2', { id: 'board-title' }, `Chapter ${chapter.number}: ${chapter.title}`),
            h('p', { class: 'board-intro' }, chapter.intro),
            h('p', { class: 'board-count' }, `${restored} of ${stages.length} lines restored, ${chapterStars(campaign, chapter.number)} of 60 stars`),
          ),
          jacks,
        ),
        stageCard(view),
      ),
    );
  }

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
      h('p', { class: 'stage-ref' }, `Stage ${stage.id}${stage.finale ? ', chapter finale' : ''}`),
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
    root.querySelector(`[data-stage="${id}"]`)?.focus();
  }

  /** Arrow keys move between jacks in the grid. */
  function onArrow(e) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS }[e.key];
    if (!step) return;
    const buttons = $$('.jack', root);
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, i + step))].focus();
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
