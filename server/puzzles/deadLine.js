import { GLYPHS, GLYPH_IDS } from '../../shared/art.js';
import { pick, sample, shuffle } from '../random.js';

// Symbol decoding. The Caller sees enamel glyph plates and signal lamps; the
// Operator's directory turns glyphs into digits and the lamp rules reorder them.

const ALL_LAMPS = ['green', 'amber', 'red', 'blue', 'white'];
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

export const LAMP_RULES = {
  green: { text: 'Green lamp: the line is clear. Keep the digits in plate order.', apply: (d) => [...d] },
  amber: { text: 'Amber lamp: the line is reversed. Reverse the order of all the digits.', apply: (d) => [...d].reverse() },
  red: {
    text: 'Red lamp: the line is crossed. Swap the first and last digits.',
    apply: (d) => {
      const out = [...d];
      [out[0], out[out.length - 1]] = [out[out.length - 1], out[0]];
      return out;
    },
  },
  blue: { text: 'Blue lamp: the line is weak. Add 1 to every digit; 9 becomes 0.', apply: (d) => d.map((x) => (x + 1) % 10) },
  white: { text: 'White lamp: the line has slipped. Move the first digit to the end.', apply: (d) => [...d.slice(1), d[0]] },
};

export const LEVELS = [
  null,
  { digits: 3, lamps: ['green', 'amber'], directory: 10 },
  { digits: 4, lamps: ['green', 'amber'], directory: 10 },
  { digits: 4, lamps: ['green', 'amber', 'red'], directory: 10 },
  { digits: 4, lamps: ['green', 'amber', 'red'], directory: 12, blanks: 1 },
  { digits: 4, lamps: ['green', 'amber', 'red', 'blue'], directory: 12, blanks: 1 },
  { digits: 5, lamps: ['green', 'amber', 'red', 'blue'], directory: 12, blanks: 1, clock: true },
  { digits: 5, lamps: ALL_LAMPS, directory: 14, blanks: 1, clock: true },
  { digits: 5, lamps: ALL_LAMPS, directory: 14, blanks: 2, clock: true, twoLamps: true },
  { digits: 6, lamps: ALL_LAMPS, directory: 16, blanks: 2, clock: true, twoLamps: true },
  { digits: 6, lamps: ALL_LAMPS, directory: 18, blanks: 2, clock: true, twoLamps: true },
];

/** 18:00 to 05:59 is night. */
export const isNight = (clock) => {
  const hour = Number(clock.slice(0, 2));
  return hour >= 18 || hour < 6;
};

/** The digits the lamps produce from the plate-order digits, upper lamp first. */
export function applyLamps(lamps, digits) {
  return lamps.reduce((d, lamp) => LAMP_RULES[lamp].apply(d), digits);
}

/** Every glyph gets a digit; with more than ten glyphs some digits repeat. */
function assignDigits(rng, count) {
  const digits = shuffle(rng, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  while (digits.length < count) digits.push(rng.int(10));
  return shuffle(rng, digits).slice(0, count);
}

export default {
  type: 'dead-line',
  levels: LEVELS,

  generate(rng, level) {
    const p = LEVELS[level];
    const glyphs = sample(rng, GLYPH_IDS, p.directory);
    const day = assignDigits(rng, p.directory);
    const night = p.clock ? assignDigits(rng, p.directory) : null;
    const directory = glyphs.map((glyph, i) => ({ glyph, day: day[i], night: night ? night[i] : null }));
    const active = sample(rng, glyphs, p.digits);
    const spare = glyphs.filter((g) => !active.includes(g));
    const plates = active.map((glyph) => ({ glyph, barred: false }));
    for (const glyph of sample(rng, spare, p.blanks || 0)) {
      plates.splice(rng.int(plates.length + 1), 0, { glyph, barred: true });
    }
    const lamps = [pick(rng, p.lamps)];
    if (p.twoLamps) {
      const second = pick(rng, p.lamps);
      lamps.push(lamps[0] === 'green' && second === 'green' ? pick(rng, p.lamps.slice(1)) : second);
    }
    const clock = p.clock ? `${String(rng.int(24)).padStart(2, '0')}:${String(rng.int(12) * 5).padStart(2, '0')}` : null;
    const column = clock && isNight(clock) ? 'night' : 'day';
    const byGlyph = Object.fromEntries(directory.map((e) => [e.glyph, e]));
    const digits = plates.filter((pl) => !pl.barred).map((pl) => byGlyph[pl.glyph][column]);
    return {
      level,
      line: 2 + rng.int(97),
      lampSet: p.lamps,
      twoLamps: Boolean(p.twoLamps),
      plates,
      lamps,
      clock,
      directory,
      answer: applyLamps(lamps, digits).join(''),
    };
  },

  views: {
    caller: (s) => ({
      kind: 'dead-line',
      intro: `Line ${s.line} is dead. A brass panel holds ${s.plates.length} enamel plates, ${s.lamps.length === 2 ? 'two signal lamps' : 'a signal lamp'}${s.clock ? ', an exchange clock' : ''} and a rotary dial. Something wants a number.`,
      plates: s.plates,
      lamps: s.lamps,
      clock: s.clock,
      digits: s.answer.length,
    }),
    operator: (s) => {
      const steps = [
        'Ask the Caller to describe each plate in order, left to right.',
        'Find each glyph in the directory and write down its digit, in plate order.',
        'Ask what colour the signal lamp is and apply the lamp rules.',
        'Read the digits to the Caller one at a time. They dial, then pull the connect lever.',
      ];
      if (s.plates.some((p) => p.barred)) steps.splice(1, 0, 'Ask whether any plate has a brass bar across it. Leave those plates out.');
      if (s.clock) steps.splice(1, 0, 'Ask what time the exchange clock shows, so you know which directory column to use.');
      if (s.twoLamps) steps[steps.length - 2] = 'Ask for the colour of both lamps, upper and lower, and apply the lamp rules.';
      const blocks = [
        { type: 'steps', heading: 'Procedure', items: steps },
        {
          type: 'glyphs',
          heading: 'Glyph directory',
          nightColumn: Boolean(s.clock),
          entries: s.directory
            .map((e) => ({ glyph: e.glyph, name: GLYPHS[e.glyph].name, day: e.day, night: e.night }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        },
        {
          type: 'rules',
          id: 'lamps',
          heading: 'Signal lamps',
          items: [
            ...s.lampSet.map((key) => ({ key, text: LAMP_RULES[key].text })),
            ...(s.twoLamps ? [{ key: 'two-lamps', text: 'Two lamps: apply the upper lamp’s rule first, then the lower lamp’s rule to the result.' }] : []),
          ],
        },
      ];
      if (s.clock) {
        blocks.push({
          type: 'rules',
          id: 'clock',
          heading: 'Exchange clock',
          items: [
            { key: 'night', text: 'From 18:00 to 05:59, read digits from the NIGHT column.' },
            { key: 'day', text: 'From 06:00 to 17:59, read digits from the DAY column.' },
          ],
        });
      }
      if (s.plates.some((p) => p.barred)) {
        blocks.push({
          type: 'rules',
          id: 'blanks',
          heading: 'Blanking plates',
          items: [{ key: 'barred', text: 'A plate with a brass bar bolted across it is a blanking plate. It carries no digit: leave it out entirely.' }],
        });
      }
      return { kind: 'dead-line', intro: 'A dead line wakes when its service number is dialled. The number is written on the panel in exchange glyphs, which only this directory can translate.', blocks };
    },
  },

  parseAnswer(raw, s) {
    const value = String(raw ?? '').replace(/\s/g, '');
    const n = s.answer.length;
    if (!new RegExp(`^\\d{${n}}$`).test(value)) return { error: `Dial exactly ${n} digits before pulling the lever.` };
    return { value };
  },

  check(s, value) {
    let matched = 0;
    for (let i = 0; i < s.answer.length; i++) if (value[i] === s.answer[i]) matched++;
    return { correct: value === s.answer, matched, total: s.answer.length, unit: 'relays' };
  },

  solution: (s) => s.answer,

  hints: {
    caller: [
      (s) =>
        `Your Operator has a directory of these symbols but cannot see your panel. Describe each plate in plain words, left to right, and say what colour ${s.lamps.length === 2 ? 'both lamps are, upper first' : 'the lamp is'}.`,
      (s) => {
        const parts = [`Your ${s.lamps.length === 2 ? 'lamps are' : 'signal lamp is'} ${s.lamps.join(' then ')}.`];
        if (s.clock) parts.push(`The clock reads ${s.clock}; your Operator needs that too.`);
        if (s.plates.some((p) => p.barred)) parts.push('Mention which plates have a brass bar across them.');
        return parts.join(' ');
      },
      (s) =>
        `If words fail, read these out: ${s.plates
          .map((p, i) => `plate ${NUMERALS[i]} is ${GLYPHS[p.glyph].description}${p.barred ? ' (with a brass bar across it)' : ''}`)
          .join('; ')}.`,
    ],
    operator: [
      (s) =>
        `The Caller sees ${s.plates.length} symbol plates and ${s.lamps.length === 2 ? 'two lamps' : 'one signal lamp'}${s.clock ? ' and a clock' : ''}. Ask them to describe each plate in order.`,
      (s) =>
        `Match each description to the directory and write its digit down in plate order${s.clock ? ', using the column the clock tells you' : ''}. Leave the lamp rules until you have every digit.`,
      (s) =>
        `Apply the lamp rules to your digits${s.twoLamps ? ', upper lamp first' : ''}. The Caller should end up dialling ${s.answer.length} digits. Read them out one at a time.`,
    ],
  },
};
