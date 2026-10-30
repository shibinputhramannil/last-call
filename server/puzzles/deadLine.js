import { GLYPHS, GLYPH_IDS } from '../../shared/art.js';
import { pick, shuffle } from '../random.js';

const LAMP_RULES = {
  green: 'Green lamp: the line is clear. Dial the digits in plate order, I to IV.',
  amber: 'Amber lamp: the line is reversed. Dial the digits backwards, from plate IV to plate I.',
  red: 'Red lamp: the line is crossed. Swap the first and last digits, then dial in plate order.',
};
const PLATE_NUMERALS = ['I', 'II', 'III', 'IV'];

/** Applies the lamp rule from manual section 1.3 to the plate-order digits. */
export function applyLampRule(lamp, digits) {
  const d = [...digits];
  if (lamp === 'amber') return d.reverse();
  if (lamp === 'red') {
    [d[0], d[d.length - 1]] = [d[d.length - 1], d[0]];
    return d;
  }
  return d;
}

export default {
  id: 'dead-line',
  title: 'The Dead Line',

  generate(rng) {
    const digits = shuffle(rng, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const digitOf = Object.fromEntries(GLYPH_IDS.map((id, i) => [id, digits[i]]));
    const plates = shuffle(rng, GLYPH_IDS).slice(0, 4);
    const lamp = pick(rng, ['green', 'amber', 'red']);
    const answer = applyLampRule(lamp, plates.map((id) => digitOf[id])).join('');
    return { digitOf, plates, lamp, answer };
  },

  views: {
    caller: (s) => ({
      kind: 'dead-line',
      intro:
        'Line 7 is dead. A brass panel holds four enamel plates, a signal lamp and a rotary dial. Something wants a number.',
      plates: s.plates,
      lamp: s.lamp,
      digits: 4,
    }),
    operator: (s) => ({
      kind: 'dead-line',
      intro:
        'Section 1. A dead line can be woken by dialling its four-digit service number. The number is etched on the panel in exchange glyphs, which only this directory can translate.',
      blocks: [
        {
          type: 'steps',
          heading: '1.1 Procedure',
          items: [
            'Ask the Caller to describe the four plates in order, I to IV, left to right.',
            'Find each glyph in the directory below and write down its digit.',
            'Ask the Caller what colour the signal lamp is, and apply rule 1.3.',
            'Read the four digits to the Caller. They dial, then pull the connect lever.',
          ],
        },
        {
          type: 'glyphs',
          heading: '1.2 Glyph directory',
          entries: GLYPH_IDS.map((id) => ({ glyph: id, name: GLYPHS[id].name, digit: s.digitOf[id] })).sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        },
        {
          type: 'rules',
          heading: '1.3 Signal lamp',
          items: [LAMP_RULES.green, LAMP_RULES.amber, LAMP_RULES.red],
        },
      ],
    }),
  },

  parseAnswer(raw) {
    const value = String(raw ?? '').replace(/\s/g, '');
    if (!/^\d{4}$/.test(value)) return { error: 'Dial exactly four digits before pulling the lever.' };
    return { value };
  },

  check(s, value) {
    let matched = 0;
    for (let i = 0; i < 4; i++) if (value[i] === s.answer[i]) matched++;
    return { correct: value === s.answer, matched, total: 4, unit: 'relays' };
  },

  hints: {
    caller: [
      () =>
        'Your Operator has a directory of these symbols but cannot see your panel. Describe each plate in plain words, left to right, and say what colour the lamp is.',
      (s) =>
        `Your signal lamp is ${s.lamp}. The lamp changes the order the digits must be dialled in, so make sure your Operator has heard its colour.`,
      (s) =>
        `If words fail, read these out: ${s.plates
          .map((id, i) => `plate ${PLATE_NUMERALS[i]} is ${GLYPHS[id].description}`)
          .join('; ')}.`,
    ],
    operator: [
      () =>
        'The Caller sees four symbol plates numbered I to IV and one signal lamp. Ask them to describe each plate in order, and the lamp colour.',
      () =>
        'Match each description to the glyph directory (1.2) and write its digit down in plate order. Leave the lamp rule until you have all four.',
      () =>
        'Apply rule 1.3 to your four digits: green keeps the order, amber reverses all four, red swaps only the first and last. Then read them out one at a time.',
    ],
  },
};
