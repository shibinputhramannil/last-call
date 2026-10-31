// Artwork shared by both roles. These are pictures only: which digit, trunk or
// letter a picture stands for is decided per room on the server and only sent
// to the player whose role is allowed to know it.

// Each glyph is drawn with round-capped strokes in a 64x64 box.
// `h0.01` segments render as dots.
export const GLYPHS = Object.freeze({
  'hooked-eye': {
    name: 'The Hooked Eye',
    description: 'a ring with a dot in its centre and a stem dropping from the bottom that curls up to the left like a hook',
    strokes: ['M20 22a12 12 0 1 0 24 0a12 12 0 1 0 -24 0', 'M32 22h0.01', 'M32 34v14a6 6 0 0 1 -12 0'],
  },
  'broken-ladder': {
    name: 'The Broken Ladder',
    description: 'two upright rails joined by three rungs, with the middle rung snapped in the centre',
    strokes: ['M22 10v44', 'M42 10v44', 'M22 20h20', 'M22 32h6', 'M36 32h6', 'M22 44h20'],
  },
  'crowned-wave': {
    name: 'The Crowned Wave',
    description: 'a wavy horizontal line with three upright strokes standing above it, the middle one tallest',
    strokes: ['M10 42q5.5 -8 11 0t11 0t11 0t11 0', 'M21 30v-10', 'M32 30v-16', 'M43 30v-10'],
  },
  'hanging-key': {
    name: 'The Hanging Key',
    description: 'an upside-down key: a ring at the bottom, a straight shaft going up, and two teeth sticking out to the right near the top',
    strokes: ['M24 46a8 8 0 1 0 16 0a8 8 0 1 0 -16 0', 'M32 38v-28', 'M32 12h9', 'M32 20h6'],
  },
  'split-moon': {
    name: 'The Split Moon',
    description: 'a crescent moon opening to the right, cut through the middle by a straight horizontal line',
    strokes: ['M40 12a22 22 0 1 0 0 40a26 26 0 0 1 0 -40', 'M4 32h52'],
  },
  trident: {
    name: 'The Trident',
    description: 'a trident: three prongs pointing up, the outer two joined by a curve, on a long handle with a short crossbar at the bottom',
    strokes: ['M18 10v12a14 14 0 0 0 28 0v-12', 'M32 8v48', 'M25 50h14'],
  },
  'knotted-cord': {
    name: 'The Knotted Cord',
    description: 'two rings stacked one above the other like a figure eight, with a short tail hanging from the bottom',
    strokes: ['M23 18a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M23 36a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M32 45v11'],
  },
  bell: {
    name: 'The Bell',
    description: 'a bell with a flat rim and a small stem on top, with a single dot hanging beneath it',
    strokes: ['M20 42c0 -18 4 -27 12 -27s12 9 12 27', 'M14 42h36', 'M32 15v-6', 'M32 51h0.01'],
  },
  'twin-spires': {
    name: 'The Twin Spires',
    description: 'two tall pointed peaks side by side on one base line, with a dot floating between their tips',
    strokes: ['M8 52l12 -36l12 36', 'M32 52l12 -36l12 36', 'M5 52h54', 'M32 14h0.01'],
  },
  'sleeping-eye': {
    name: 'The Sleeping Eye',
    description: 'a closed eye: a downward-curving lid with three lashes hanging below it and a gentle arch above',
    strokes: ['M10 28q22 20 44 0', 'M21 35.5l-3 8', 'M32 38v9', 'M43 35.5l3 8', 'M16 16q16 -9 32 0'],
  },
  // Later chapters add these. Some deliberately resemble earlier glyphs
  // (ladder / broken ladder, open eye / sleeping eye), so describe carefully.
  ladder: {
    name: 'The Ladder',
    description: 'two upright rails joined by three complete rungs, none of them broken',
    strokes: ['M22 10v44', 'M42 10v44', 'M22 20h20', 'M22 32h20', 'M22 44h20'],
  },
  'open-eye': {
    name: 'The Open Eye',
    description: 'an open eye: a pointed almond outline with a round pupil in the middle',
    strokes: ['M8 32q24 -24 48 0q-24 24 -48 0', 'M26 32a6 6 0 1 0 12 0a6 6 0 1 0 -12 0'],
  },
  hourglass: {
    name: 'The Hourglass',
    description: 'an hourglass: a flat bar at the top and the bottom, joined by two lines that cross in the middle',
    strokes: ['M16 10h32', 'M16 54h32', 'M20 10l24 44', 'M44 10l-24 44'],
  },
  lightning: {
    name: 'The Lightning',
    description: 'a single zigzag lightning bolt running from the top right down to the bottom left',
    strokes: ['M40 6l-16 26h16l-16 26'],
  },
  horseshoe: {
    name: 'The Horseshoe',
    description: 'a horseshoe opening downwards: a rounded arch with a short flat foot at the bottom of each leg',
    strokes: ['M18 52v-22a14 14 0 0 1 28 0v22', 'M12 52h12', 'M40 52h12'],
  },
  spiral: {
    name: 'The Spiral',
    description: 'a spiral coiling outwards from a point in the centre, about two and a half turns',
    strokes: ['M32 32a3 3 0 0 1 6 0a7 7 0 0 1 -14 0a11 11 0 0 1 22 0a15 15 0 0 1 -30 0a19 19 0 0 1 38 0'],
  },
  'compass-star': {
    name: 'The Compass Star',
    description: 'a four-pointed star like a compass rose, with long sharp points up, down, left and right',
    strokes: ['M32 6l7 19l19 7l-19 7l-7 19l-7 -19l-19 -7l19 -7z'],
  },
  chain: {
    name: 'The Chain',
    description: 'two overlapping ovals side by side, like two links of a chain',
    strokes: ['M8 32a12 9 0 1 0 24 0a12 9 0 1 0 -24 0', 'M32 32a12 9 0 1 0 24 0a12 9 0 1 0 -24 0'],
  },
});

export const GLYPH_IDS = Object.freeze(Object.keys(GLYPHS));

// Lamp colours used by the switchboard. `label` is what players see in text.
export const LAMPS = Object.freeze({
  red: { label: 'red' },
  amber: { label: 'amber' },
  green: { label: 'green' },
  white: { label: 'white' },
  blue: { label: 'blue' },
});

// Shapes stamped onto patch-bay line plates (64x64 box, stroked).
export const STAMPS = Object.freeze({
  circle: { label: 'circle', d: 'M14 32a18 18 0 1 0 36 0a18 18 0 1 0 -36 0' },
  triangle: { label: 'triangle', d: 'M32 12l20 36h-40z' },
  square: { label: 'square', d: 'M15 15h34v34h-34z' },
  diamond: { label: 'diamond', d: 'M32 10l22 22l-22 22l-22 -22z' },
});

export const TRUNKS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);

// Relay caps on the relay rack. Always shown with their name as well as colour.
export const CAPS = Object.freeze({
  red: { label: 'red' },
  green: { label: 'green' },
  blue: { label: 'blue' },
  yellow: { label: 'yellow' },
});

// Ring cadences on the party line: L is a long ring, S a short one.
export const CADENCE_WORDS = Object.freeze({ L: 'long', S: 'short' });
export const describeCadence = (cadence) => [...cadence].map((c) => CADENCE_WORDS[c]).join(', ');
