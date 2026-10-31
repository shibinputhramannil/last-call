import { LAMPS, STAMPS, TRUNKS } from '../../shared/art.js';
import { pick, sample, shuffle } from '../random.js';

// Routing. The Caller sees which lines ring and how they look; the Operator's
// routing grid and rules say which outgoing trunk each call must take.

const FEW_LAMPS = ['red', 'amber', 'white'];
const MANY_LAMPS = ['red', 'amber', 'white', 'blue'];
const FEW_STAMPS = ['circle', 'triangle', 'square'];
const MANY_STAMPS = ['circle', 'triangle', 'square', 'diamond'];

export const LEVELS = [
  null,
  { lines: 6, ringing: 2, trunks: 4, lamps: FEW_LAMPS, stamps: FEW_STAMPS, busy: 0 },
  { lines: 6, ringing: 3, trunks: 4, lamps: FEW_LAMPS, stamps: FEW_STAMPS, busy: 1 },
  { lines: 8, ringing: 3, trunks: 6, lamps: MANY_LAMPS, stamps: MANY_STAMPS, busy: 1 },
  { lines: 8, ringing: 3, trunks: 6, lamps: MANY_LAMPS, stamps: MANY_STAMPS, busy: 1, outOfOrder: 1 },
  { lines: 8, ringing: 4, trunks: 6, lamps: MANY_LAMPS, stamps: MANY_STAMPS, busy: 2, outOfOrder: 1 },
  { lines: 10, ringing: 4, trunks: 6, lamps: MANY_LAMPS, stamps: MANY_STAMPS, busy: 1, outOfOrder: 1, priority: true },
  { lines: 10, ringing: 4, trunks: 8, lamps: MANY_LAMPS, stamps: MANY_STAMPS, busy: 1, outOfOrder: 2, priority: true },
  { lines: 10, ringing: 5, trunks: 8, lamps: MANY_LAMPS, stamps: MANY_STAMPS, busy: 2, outOfOrder: 2, priority: true },
  { lines: 10, ringing: 4, trunks: 8, lamps: MANY_LAMPS, stamps: MANY_STAMPS, busy: 1, outOfOrder: 1, priority: true, stepBack: true },
  { lines: 12, ringing: 5, trunks: 8, lamps: MANY_LAMPS, stamps: MANY_STAMPS, busy: 2, outOfOrder: 2, priority: true, stepBack: true },
];

/**
 * Routes ringing calls. Calls go in line-number order (red lamps first when
 * `priority`). Each takes its grid trunk; if that trunk is busy or out of
 * order it steps to the next letter (or the previous one, for even lines when
 * `stepBack`), wrapping round, until it finds a free working trunk.
 */
export function routeCalls({ grid, ringing, trunks, outOfOrder = [], priority = false, stepBack = false }) {
  const order = [...ringing].sort(
    (a, b) => (priority ? Number(b.lamp === 'red') - Number(a.lamp === 'red') : 0) || a.number - b.number,
  );
  const taken = new Set();
  const routes = {};
  let busyHits = 0;
  let brokenHits = 0;
  for (const call of order) {
    let i = trunks.indexOf(grid[call.lamp][call.stamp]);
    if (taken.has(trunks[i])) busyHits++;
    else if (outOfOrder.includes(trunks[i])) brokenHits++;
    const step = stepBack && call.number % 2 === 0 ? -1 : 1;
    while (taken.has(trunks[i]) || outOfOrder.includes(trunks[i])) i = (i + step + trunks.length) % trunks.length;
    taken.add(trunks[i]);
    routes[call.number] = trunks[i];
  }
  return { routes, busyHits, brokenHits };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function attempt(rng, p) {
  const trunks = TRUNKS.slice(0, p.trunks);
  const grid = Object.fromEntries(p.lamps.map((lamp) => [lamp, Object.fromEntries(p.stamps.map((stamp) => [stamp, pick(rng, trunks)]))]));
  const outOfOrder = sample(rng, trunks, p.outOfOrder || 0).sort();
  const numbers = sample(
    rng,
    Array.from({ length: p.lines }, (_, i) => i + 1),
    p.ringing,
  ).sort((a, b) => a - b);
  const combos = sample(
    rng,
    p.lamps.flatMap((lamp) => p.stamps.map((stamp) => ({ lamp, stamp }))),
    p.ringing,
  );
  const ringing = numbers.map((number, i) => ({ number, ...combos[i] }));
  const setup = { grid, ringing, trunks, outOfOrder, priority: Boolean(p.priority), stepBack: Boolean(p.stepBack) };
  const result = routeCalls(setup);

  // Every rule in the manual must matter for this board.
  if (p.busy === 0 && (result.busyHits > 0 || result.brokenHits > 0)) return null;
  if (result.busyHits < p.busy) return null;
  if (p.outOfOrder && result.brokenHits < 1) return null;
  if (p.priority && same(result.routes, routeCalls({ ...setup, priority: false }).routes)) return null;
  if (p.stepBack && same(result.routes, routeCalls({ ...setup, stepBack: false }).routes)) return null;
  return { ...setup, routes: result.routes };
}

export default {
  type: 'patch-bay',
  levels: LEVELS,

  generate(rng, level) {
    const p = LEVELS[level];
    let made = null;
    for (let tries = 0; !made; tries++) {
      if (tries > 5_000) throw new Error(`patch-bay level ${level}: could not build a board`);
      made = attempt(rng, p);
    }
    const lines = [];
    for (let number = 1; number <= p.lines; number++) {
      const ring = made.ringing.find((l) => l.number === number);
      lines.push(ring ? { ...ring } : { number, lamp: null, stamp: pick(rng, p.stamps) });
    }
    return { level, busyRule: p.busy > 0, ...made, lines, gridLamps: shuffle(rng, p.lamps), gridStamps: p.stamps };
  },

  views: {
    caller: (s) => ({
      kind: 'patch-bay',
      intro: `The switchboard wakes. ${s.ringing.length} lines are ringing for a connection and ${s.trunks.length} trunk jacks wait below. Patch each lit line to the right trunk, then throw the ringing key.`,
      lines: s.lines,
      trunks: s.trunks.map((letter) => ({ letter, outOfOrder: s.outOfOrder.includes(letter) })),
    }),
    operator: (s) => {
      const items = [
        {
          key: s.priority ? 'priority' : 'order',
          text: s.priority
            ? 'Route calls with a red lamp first, lowest line number first. Then route every other call, lowest line number first.'
            : 'Route calls in order of line number, lowest first.',
        },
      ];
      if (s.busyRule || s.outOfOrder.length) {
        items.push({
          key: 'busy',
          text: `A trunk carries one call. If a call’s trunk is already taken, move it to the next letter along; after ${s.trunks[s.trunks.length - 1]} comes A. Keep stepping until you reach a free trunk.`,
        });
      }
      if (s.stepBack) {
        items.push({
          key: 'step-back',
          text: `Calls on even-numbered lines step backwards instead: to the previous letter, and before A comes ${s.trunks[s.trunks.length - 1]}.`,
        });
      }
      if (s.outOfOrder.length) {
        items.push({ key: 'out-of-order', text: 'A trunk tagged OUT OF ORDER carries nothing. Step past it exactly as if it were taken.' });
      }
      return {
        kind: 'patch-bay',
        intro: 'Incoming calls must be patched to an outgoing trunk. Each call is identified by the colour of its line lamp and the shape stamped on its line plate.',
        blocks: [
          {
            type: 'steps',
            heading: 'Procedure',
            items: [
              'Ask the Caller which lines are lit. Unlit lines are not ringing; ignore them.',
              'For each lit line, ask for its number, its lamp colour and the shape on its plate.',
              s.outOfOrder.length ? 'Ask which trunk jacks are tagged OUT OF ORDER.' : null,
              'Find each call’s trunk in the routing grid, then apply the routing rules.',
              'Tell the Caller which trunk each line goes to. They patch the cords and throw the key.',
            ].filter(Boolean),
          },
          {
            type: 'grid',
            heading: 'Routing grid',
            caption: 'Read along the row for the lamp colour, then down to the column for the shape.',
            rows: s.gridLamps.map((lamp) => ({ key: lamp, label: LAMPS[lamp].label })),
            cols: s.gridStamps.map((stamp) => ({ key: stamp, label: STAMPS[stamp].label })),
            cells: s.gridLamps.map((lamp) => s.gridStamps.map((stamp) => s.grid[lamp][stamp])),
          },
          { type: 'rules', id: 'routing', heading: 'Routing rules', items },
        ],
      };
    },
  },

  parseAnswer(raw, s) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Patch every lit line first.' };
    const entries = Object.entries(raw);
    if (entries.length === 0 || entries.length > s.lines.length) return { error: 'Patch every lit line first.' };
    const value = {};
    const used = new Set();
    for (const [line, trunk] of entries) {
      const number = Number(line);
      if (!Number.isInteger(number) || number < 1 || number > s.lines.length || !s.trunks.includes(trunk)) {
        return { error: 'That patch is not on this board.' };
      }
      if (used.has(trunk)) return { error: 'A trunk jack can only take one cord.' };
      used.add(trunk);
      value[number] = trunk;
    }
    return { value };
  },

  check(s, value) {
    let matched = 0;
    for (const line of s.ringing) if (value[line.number] === s.routes[line.number]) matched++;
    const extra = Object.keys(value).some((n) => !(n in s.routes));
    return { correct: matched === s.ringing.length && !extra, matched, total: s.ringing.length, unit: 'calls' };
  },

  solution: (s) => ({ ...s.routes }),

  hints: {
    caller: [
      () => 'Only the lit lines are ringing. For each one, tell your Operator its line number, its lamp colour and the shape stamped on its plate.',
      (s) =>
        s.outOfOrder.length
          ? `Tell your Operator that trunk${s.outOfOrder.length > 1 ? 's' : ''} ${s.outOfOrder.join(' and ')} ${s.outOfOrder.length > 1 ? 'are' : 'is'} tagged OUT OF ORDER. Their routing rules depend on it.`
          : 'Patch each call exactly where your Operator says, even if two calls seem to want the same trunk: their rules settle it.',
      (s) =>
        `Your ringing lines are ${s.ringing.map((l) => `line ${l.number} (${LAMPS[l.lamp].label} lamp, ${STAMPS[l.stamp].label})`).join(', ')}. Read them out exactly like that.`,
    ],
    operator: [
      () => 'Ask the Caller which lines are lit, and for each one: its number, lamp colour and stamped shape.',
      () => 'In the routing grid, go along the row for the lamp colour and down to the column for the shape. That cell is the trunk the call wants.',
      (s) =>
        `Route the calls in the order the rules give${s.priority ? ', red lamps first' : ''}. ${s.busyRule || s.outOfOrder.length ? 'At least one call finds its trunk busy or out of order and has to step along.' : 'On this board no two calls want the same trunk.'}`,
    ],
  },
};
