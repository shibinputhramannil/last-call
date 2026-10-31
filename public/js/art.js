import { CAPS, GLYPHS, STAMPS, describeCadence } from '/shared/art.js';
import { s } from './dom.js';

/** An exchange glyph as inline SVG. The label is a plain visual description. */
export function glyphSvg(id, { label } = {}) {
  const glyph = GLYPHS[id];
  const svg = s(
    'svg',
    {
      class: 'glyph',
      viewBox: '0 0 64 64',
      role: label ? 'img' : null,
      'aria-label': label || null,
      'aria-hidden': label ? null : 'true',
      focusable: 'false',
    },
    glyph.strokes.map((d) => s('path', { d, class: d.endsWith('h0.01') ? 'dot' : null })),
  );
  return svg;
}

export function stampSvg(id, { label } = {}) {
  return s(
    'svg',
    {
      class: 'stamp',
      viewBox: '0 0 64 64',
      role: label ? 'img' : null,
      'aria-label': label || null,
      'aria-hidden': label ? null : 'true',
      focusable: 'false',
    },
    s('path', { d: STAMPS[id].d }),
  );
}

export { CAPS, GLYPHS, STAMPS, describeCadence };
