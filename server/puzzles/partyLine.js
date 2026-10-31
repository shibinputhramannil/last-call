import { describeCadence } from '../../shared/art.js';
import { pick, sample } from '../random.js';

// Ring patterns. Several households share one line, each with its own ring.
// The Caller sees the rings that came in; the Operator knows whose ring is
// whose and the order in which the exchange rings them back.

export const HOUSEHOLDS = Object.freeze([
  'Abbott', 'Baxter', 'Carver', 'Dalton', 'Ellis', 'Fenwick', 'Gardner', 'Holloway', 'Irwin', 'Jessop', 'Kemble', 'Locke',
  'Mercer', 'Morrow', 'Nash', 'Oakley', 'Pryce', 'Rooke', 'Sutton', 'Thorne', 'Upton', 'Vance', 'Ward', 'Yates',
]);

/** Every pattern of two to four long (L) or short (S) rings. */
export const CADENCES = Object.freeze(
  [2, 3, 4].flatMap((n) => Array.from({ length: 2 ** n }, (_, i) => [...i.toString(2).padStart(n, '0')].map((b) => (b === '1' ? 'L' : 'S')).join(''))),
);

export const LEVELS = [
  null,
  { households: 4, rings: 3, rule: 'first' },
  { households: 4, rings: 4, rule: 'first' },
  { households: 5, rings: 5, rule: 'count' },
  { households: 5, rings: 6, rule: 'count' },
  { households: 5, rings: 6, rule: 'count', echoes: 1 },
  { households: 6, rings: 7, rule: 'count', echoes: 1, trunk: 1 },
  { households: 6, rings: 8, rule: 'count', echoes: 2, trunk: 1 },
  { households: 7, rings: 9, rule: 'count', echoes: 2, trunk: 2 },
];

/**
 * The ring-back order. Echo rings are ignored and trunk rings count twice.
 * 'first': each household once, in the order they first rang.
 * 'count': most rings first; a tie goes to whoever rang first.
 */
export function callbackOrder(rings, rule, { ignoreEchoes = true, doubleTrunk = true } = {}) {
  const counts = new Map();
  const first = new Map();
  rings.forEach((r, i) => {
    if (r.echo && ignoreEchoes) return;
    counts.set(r.household, (counts.get(r.household) || 0) + (r.trunk && doubleTrunk ? 2 : 1));
    if (!first.has(r.household)) first.set(r.household, i);
  });
  return [...counts.keys()].sort((a, b) =>
    rule === 'count' ? counts.get(b) - counts.get(a) || first.get(a) - first.get(b) : first.get(a) - first.get(b),
  );
}

const same = (a, b) => a.join('|') === b.join('|');

function attempt(rng, p) {
  const households = sample(rng, HOUSEHOLDS, p.households);
  const cadences = sample(rng, CADENCES, p.households);
  const directory = households.map((household, i) => ({ household, cadence: cadences[i] }));
  const rings = Array.from({ length: p.rings }, () => ({ household: pick(rng, households), echo: false, trunk: false }));
  const slots = sample(
    rng,
    rings.map((_, i) => i),
    (p.echoes || 0) + (p.trunk || 0),
  );
  slots.slice(0, p.echoes || 0).forEach((i) => (rings[i].echo = true));
  slots.slice(p.echoes || 0).forEach((i) => (rings[i].trunk = true));

  const answer = callbackOrder(rings, p.rule);
  if (answer.length < 2) return null;
  if (p.rule === 'first' && p.rings > 3 && new Set(rings.map((r) => r.household)).size === rings.length) return null;
  if (p.rule === 'count' && (answer.length < 3 || same(answer, callbackOrder(rings, 'first')))) return null;
  if (p.echoes && same(answer, callbackOrder(rings, p.rule, { ignoreEchoes: false }))) return null;
  if (p.trunk && same(answer, callbackOrder(rings, p.rule, { doubleTrunk: false }))) return null;
  return { directory, rings, answer };
}

export default {
  type: 'party-line',
  levels: LEVELS,

  generate(rng, level) {
    const p = LEVELS[level];
    let made = null;
    for (let tries = 0; !made; tries++) {
      if (tries > 5_000) throw new Error(`party-line level ${level}: could not build a ring history`);
      made = attempt(rng, p);
    }
    const cadenceOf = Object.fromEntries(made.directory.map((d) => [d.household, d.cadence]));
    return {
      level,
      rule: p.rule,
      echoRule: Boolean(p.echoes),
      trunkRule: Boolean(p.trunk),
      directory: made.directory,
      rings: made.rings.map((r) => ({ ...r, cadence: cadenceOf[r.household] })),
      keys: sample(
        rng,
        made.directory.map((d) => d.household),
        made.directory.length,
      ),
      answer: made.answer,
    };
  },

  views: {
    caller: (s) => ({
      kind: 'party-line',
      intro: `The party line’s ringer lamp has logged ${s.rings.length} rings. Every household on the line is waiting to be rung back, in the proper order.`,
      rings: s.rings.map((r) => ({ cadence: r.cadence, echo: r.echo, trunk: r.trunk })),
      households: s.keys,
    }),
    operator: (s) => {
      const items = [
        s.rule === 'first'
          ? { key: 'first', text: 'Ring back every household that rang, once each, in the order they first rang.' }
          : {
              key: 'count',
              text: 'Ring back every household that rang, once each. The household that rang most often goes first, then the next most, and so on. If two households rang equally often, the one that rang first goes first.',
            },
      ];
      if (s.echoRule) items.push({ key: 'echo', text: 'A dim ring is an echo from a crossed line. Ignore it completely.' });
      if (s.trunkRule) items.push({ key: 'trunk', text: 'A ring marked ✱ is a trunk call from far away. It counts as two rings.' });
      return {
        kind: 'party-line',
        intro: 'Households on a party line share one wire, so each has its own ring: a pattern of long and short rings. The ringer lamp logs every ring; you decide who is rung back, and in what order.',
        blocks: [
          {
            type: 'steps',
            heading: 'Procedure',
            items: [
              'Ask the Caller to read out each logged ring in order: its pattern of long and short rings.',
              s.echoRule && s.trunkRule ? 'Ask whether each ring is dim, or marked ✱.' : s.echoRule ? 'Ask whether any ring looks dim.' : null,
              'Find the household for each pattern in the directory.',
              'Work out the ring-back order with the rules below. The Caller presses the household keys in that order.',
            ].filter(Boolean),
          },
          {
            type: 'cadences',
            heading: 'Party line directory',
            caption: '▬ is a long ring, ● a short one.',
            entries: [...s.directory].sort((a, b) => a.household.localeCompare(b.household)).map((d) => ({ ...d, words: describeCadence(d.cadence) })),
          },
          { type: 'rules', id: 'callback', heading: 'Ring-back rules', items },
        ],
      };
    },
  },

  parseAnswer(raw, s) {
    if (!Array.isArray(raw) || raw.length === 0) return { error: 'Press at least one household key before ringing back.' };
    if (raw.length > s.keys.length) return { error: 'Each household can only be rung back once.' };
    const valid = new Set(s.keys);
    if (!raw.every((h) => typeof h === 'string' && valid.has(h))) return { error: 'That household is not on this line.' };
    if (new Set(raw).size !== raw.length) return { error: 'Each household can only be rung back once.' };
    return { value: [...raw] };
  },

  check(s, value) {
    let matched = 0;
    for (let i = 0; i < s.answer.length; i++) if (value[i] === s.answer[i]) matched++;
    return { correct: same(value, s.answer), matched, total: s.answer.length, unit: 'households' };
  },

  solution: (s) => [...s.answer],

  hints: {
    caller: [
      () => 'Read out each ring in your log, in order, as long and short rings. Your Operator knows whose ring is whose.',
      (s) =>
        s.echoRule || s.trunkRule
          ? 'Say which rings look dim, and which have a ✱ beside them. The ring-back rules treat them differently.'
          : 'Press the household keys in exactly the order your Operator gives. You can clear and start again before ringing back.',
      (s) => `Your log reads: ${s.rings.map((r, i) => `ring ${i + 1} is ${describeCadence(r.cadence)}${r.echo ? ' (dim)' : ''}${r.trunk ? ' (✱)' : ''}`).join('; ')}.`,
    ],
    operator: [
      () => 'Ask the Caller to read the ring log in order, one ring at a time, as long and short.',
      () => 'Match each pattern to a household in the directory. Write the households down in the order they rang.',
      (s) =>
        s.rule === 'first'
          ? 'Ring each household back once, in the order of their first ring. Skip repeats.'
          : `Count each household’s rings${s.echoRule ? ' (not the dim ones)' : ''}${s.trunkRule ? ', counting ✱ rings twice' : ''}. Most rings goes first; ties go to whoever rang first.`,
    ],
  },
};
