// The Operator's field manual, rendered from the role-specific puzzle data.

import { GLYPHS, glyphSvg, stampSvg } from './art.js';
import { h } from './dom.js';
import { loadNotes, saveNotes } from './store.js';

const LAMP_PREFIX = /^(Green|Amber|Red|White|Blue) lamp/;

const BLOCKS = {
  steps: (b) => [h('h3', {}, b.heading), h('ol', {}, b.items.map((t) => h('li', {}, t)))],

  rules: (b) => [
    h('h3', {}, b.heading),
    h(
      'ul',
      { class: 'rules' },
      b.items.map((t) => {
        const match = t.match(LAMP_PREFIX);
        return h('li', {}, match ? h('span', { class: 'swatch', 'data-color': match[1].toLowerCase(), 'aria-hidden': 'true' }) : null, t);
      }),
    ),
  ],

  glyphs: (b) => [
    h('h3', {}, b.heading),
    h(
      'ul',
      { class: 'glyph-directory' },
      b.entries.map((e) =>
        h(
          'li',
          {},
          glyphSvg(e.glyph, { label: `${e.name}: ${GLYPHS[e.glyph].description}` }),
          h('span', { class: 'glyph-name' }, e.name),
          h('span', { class: 'glyph-digit', 'aria-label': `digit ${e.digit}` }, String(e.digit)),
        ),
      ),
    ),
  ],

  grid: (b) => [
    h('h3', {}, b.heading),
    h('p', { class: 'caption' }, b.caption),
    h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        {},
        h('caption', { class: 'sr-only' }, 'Trunk letter for each lamp colour and stamped shape'),
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, 'Lamp'),
            b.cols.map((c) => h('th', { scope: 'col' }, h('span', { class: 'th-stamp' }, stampSvg(c.key), c.label))),
          ),
        ),
        h(
          'tbody',
          {},
          b.rows.map((r, i) =>
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, h('span', { class: 'swatch', 'data-color': r.key, 'aria-hidden': 'true' }), r.label),
              b.cells[i].map((letter) => h('td', {}, letter)),
            ),
          ),
        ),
      ),
    ),
  ],

  tapecode: (b) => [
    h('h3', {}, b.heading),
    h('p', { class: 'caption' }, b.caption),
    h(
      'ul',
      { class: 'tape-code' },
      b.entries.map((e) =>
        h(
          'li',
          { 'aria-label': `${e.letter}: ${e.bits.map((x) => (x ? 'hole' : 'blank')).join(', ')}` },
          h('span', { class: 'tape-letter', 'aria-hidden': 'true' }, e.letter),
          h('span', { class: 'code-dots', 'aria-hidden': 'true' }, e.bits.map((x) => h('i', { class: x ? 'on' : null }))),
        ),
      ),
    ),
  ],

  roster: (b) => [
    h('h3', {}, b.heading),
    h('p', { class: 'caption' }, b.caption),
    h('ul', { class: 'roster' }, b.names.map((n) => h('li', {}, n))),
  ],
};

export function renderManual(root, puzzle, { roomCode }) {
  const view = puzzle.view;
  const notes = h('textarea', { id: 'operator-notes', rows: 4, spellcheck: 'false' });
  notes.value = loadNotes(roomCode);
  notes.addEventListener('input', () => saveNotes(roomCode, notes.value));

  root.append(
    h('p', { class: 'task' }, 'Ask the Caller what they see, find it in the manual, and tell them exactly what to do.'),
    h(
      'article',
      { class: 'manual', 'aria-label': 'Field manual' },
      h(
        'header',
        { class: 'manual-head' },
        h('p', { class: 'manual-kicker' }, `Exchange 7 field manual, section ${puzzle.number} of 3`),
        h('h2', { class: 'manual-title' }, puzzle.title),
      ),
      h('p', { class: 'manual-intro' }, view.intro),
      view.blocks.map((b) => (BLOCKS[b.type] ? BLOCKS[b.type](b) : null)),
      h(
        'div',
        { class: 'notepad' },
        h('label', { for: 'operator-notes' }, 'Your notes'),
        notes,
        h('small', {}, 'Only you can see these. They stay in this browser tab.'),
      ),
    ),
  );
  return { onResult() {}, setBusy() {}, destroy() {} };
}
