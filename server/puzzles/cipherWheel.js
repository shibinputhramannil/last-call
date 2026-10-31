import { GLYPHS, GLYPH_IDS } from '../../shared/art.js';
import { pick, sample } from '../random.js';
import { shiftLetter } from './teleprinter.js';

// Telegram cipher. The Caller holds an enciphered telegram and a cipher wheel
// whose pointer rests on a glyph; the Operator's key table and rules turn the
// pointer (and, later, the stamps) into a shift that decodes the word.

export const CODEWORDS = Object.freeze({
  4: ['BELL', 'CALL', 'DIAL', 'DUSK', 'ECHO', 'HALL', 'HOLD', 'HOME', 'HUSH', 'KEYS', 'LAMP', 'LINE', 'MOON', 'RING', 'ROOM', 'TAPE', 'WAIT', 'WIRE'],
  5: ['CABLE', 'CLOCK', 'DOORS', 'DREAM', 'EARLY', 'HEARD', 'LATER', 'LIGHT', 'NIGHT', 'QUIET', 'RELAY', 'SHIFT', 'SPOKE', 'STAIR', 'TRUNK', 'VOICE', 'WAKEN', 'WIRES'],
  6: ['ANSWER', 'BEACON', 'BRIDGE', 'COPPER', 'ENGAGE', 'HANDLE', 'LADDER', 'LETTER', 'LISTEN', 'MEMORY', 'NUMBER', 'PLEASE', 'RECALL', 'SIGNAL', 'SILENT', 'SWITCH', 'TUNNEL', 'WINDOW'],
  7: ['CALLING', 'CONNECT', 'CROSSED', 'CURRENT', 'FOREVER', 'HALLWAY', 'HOLDING', 'KEEPING', 'LANTERN', 'MESSAGE', 'MORNING', 'NETWORK', 'RECEIVE', 'RETURNS', 'SILENCE', 'STATION', 'TONIGHT', 'WHISPER'],
});

export const LEVELS = [
  null,
  { length: 4, maxShift: 3, keys: 6, list: 10 },
  { length: 4, maxShift: 6, keys: 8, list: 12 },
  { length: 5, maxShift: 12, keys: 8, list: 12 },
  { length: 5, maxShift: 12, keys: 8, list: 14, stamps: 2 },
  { length: 6, maxShift: 20, keys: 8, list: 14, stamps: 2 },
  { length: 6, maxShift: 20, keys: 8, list: 16, alternate: true },
  { length: 7, maxShift: 20, keys: 8, list: 16, alternate: true, stamps: 2 },
  { length: 7, maxShift: 25, keys: 8, list: 18, alternate: true, stamps: 3 },
];

/** Decodes: letters move back by `shift`; with `alternate`, even positions move forward instead. */
export function decipher(text, shift, alternate) {
  return [...text].map((ch, i) => shiftLetter(ch, alternate && i % 2 === 1 ? shift : -shift)).join('');
}

function encipher(text, shift, alternate) {
  return [...text].map((ch, i) => shiftLetter(ch, alternate && i % 2 === 1 ? -shift : shift)).join('');
}

export default {
  type: 'cipher-wheel',
  levels: LEVELS,

  generate(rng, level) {
    const p = LEVELS[level];
    const wheel = sample(rng, GLYPH_IDS, p.keys);
    const keys = wheel.map((glyph) => ({ glyph, shift: 1 + rng.int(p.maxShift) }));
    let pointer;
    let stamps;
    let shift;
    do {
      pointer = pick(rng, wheel);
      stamps = p.stamps ? 1 + rng.int(p.stamps) : 0;
      shift = keys.find((k) => k.glyph === pointer).shift + stamps;
    } while (shift % 26 === 0);
    const pool = CODEWORDS[p.length];
    let word;
    let cipher;
    do {
      word = pick(rng, pool);
      cipher = encipher(word, shift, Boolean(p.alternate));
    } while (cipher === word);
    const codebook = [word, ...sample(rng, pool.filter((w) => w !== word), p.list - 1)].sort();
    return { level, wheel, keys, pointer, stamps, stampRule: Boolean(p.stamps), alternate: Boolean(p.alternate), word, cipher, codebook };
  },

  views: {
    caller: (s) => ({
      kind: 'cipher-wheel',
      intro: `A telegram arrives in cipher: ${s.cipher.length} letters. A brass cipher wheel sits beside it, its pointer resting on a glyph. Type the plain word back.`,
      cipher: s.cipher,
      wheel: s.wheel,
      pointer: s.pointer,
      stamps: s.stamps,
    }),
    operator: (s) => {
      const items = [
        s.alternate
          ? {
              key: 'alternate',
              text: 'Letters in odd positions (1st, 3rd, 5th…) move BACK through the alphabet by the shift. Letters in even positions (2nd, 4th…) move FORWARD by the shift. After Z comes A; before A comes Z.',
            }
          : { key: 'back', text: 'Move every letter BACK through the alphabet by the shift. D back 3 is A; A back 1 is Z.' },
      ];
      if (s.stampRule) items.unshift({ key: 'stamps', text: 'Add one to the wheel’s shift for every postage stamp on the telegram.' });
      return {
        kind: 'cipher-wheel',
        intro: 'Night-staff telegrams were enciphered with a brass wheel. The glyph under its pointer gives the shift; only this key table knows the numbers.',
        blocks: [
          {
            type: 'steps',
            heading: 'Procedure',
            items: [
              'Ask the Caller which glyph the wheel’s pointer rests on, and find its shift in the key table.',
              s.stampRule ? 'Ask how many postage stamps are on the telegram.' : null,
              'Ask the Caller to spell out the enciphered letters, in order.',
              'Decode each letter with the cipher rules, check the word against the codebook, and read it to the Caller.',
            ].filter(Boolean),
          },
          {
            type: 'keys',
            heading: 'Wheel key table',
            entries: s.keys.map((k) => ({ glyph: k.glyph, name: GLYPHS[k.glyph].name, shift: k.shift })).sort((a, b) => a.name.localeCompare(b.name)),
          },
          { type: 'rules', id: 'cipher', heading: 'Cipher rules', items },
          { type: 'roster', heading: 'Codebook', caption: 'The telegram decodes to one of these words.', names: s.codebook },
        ],
      };
    },
  },

  parseAnswer(raw, s) {
    const value = String(raw ?? '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
    if (value.length !== s.word.length) return { error: `The reply needs ${s.word.length} letters.` };
    return { value };
  },

  check(s, value) {
    let matched = 0;
    for (let i = 0; i < s.word.length; i++) if (value[i] === s.word[i]) matched++;
    return { correct: value === s.word, matched, total: s.word.length, unit: 'letters' };
  },

  solution: (s) => s.word,

  hints: {
    caller: [
      () => 'Describe the glyph under the wheel’s pointer to your Operator, then spell out the telegram one letter at a time.',
      (s) =>
        s.stampRule
          ? `Your telegram has ${s.stamps} postage stamp${s.stamps === 1 ? '' : 's'}. Tell your Operator: the stamps change the shift.`
          : `The telegram reads ${[...s.cipher].join(' ')}. Spell it slowly and have your Operator repeat it back.`,
      (s) => `The pointer rests on ${GLYPHS[s.pointer].description}.`,
    ],
    operator: [
      () => 'Find the pointer’s glyph in the key table: its number is the shift.',
      (s) =>
        `${s.stampRule ? 'Add one for each stamp. ' : ''}${s.alternate ? 'Odd positions go back, even positions go forward.' : 'Move each letter back by the shift.'} Count on your fingers or write out the alphabet.`,
      (s) => `The decoded word is in the codebook and has ${s.word.length} letters. If you are one letter off, re-check the shift for that position.`,
    ],
  },
};
