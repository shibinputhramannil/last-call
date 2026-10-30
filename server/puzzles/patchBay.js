import { LAMPS, STAMPS, TRUNKS } from '../../shared/art.js';
import { pick, shuffle } from '../random.js';

const LINE_COUNT = 8;
const RINGING = 3;
const GRID_LAMPS = ['red', 'amber', 'white', 'blue'];
const GRID_STAMPS = ['circle', 'triangle', 'square', 'diamond'];

/**
 * Routes ringing lines lowest number first. Each call takes the trunk from the
 * grid; if it is already taken it steps to the next letter, wrapping F to A.
 */
export function routeCalls(grid, ringing) {
  const taken = new Set();
  const routes = {};
  for (const line of [...ringing].sort((a, b) => a.number - b.number)) {
    let index = TRUNKS.indexOf(grid[line.lamp][line.stamp]);
    while (taken.has(TRUNKS[index])) index = (index + 1) % TRUNKS.length;
    taken.add(TRUNKS[index]);
    routes[line.number] = TRUNKS[index];
  }
  return routes;
}

function hasCollision(grid, ringing) {
  const wanted = ringing.map((l) => grid[l.lamp][l.stamp]);
  return new Set(wanted).size < wanted.length;
}

export default {
  id: 'patch-bay',
  title: 'The Patch Bay',

  generate(rng) {
    const grid = Object.fromEntries(
      GRID_LAMPS.map((lamp) => [lamp, Object.fromEntries(GRID_STAMPS.map((stamp) => [stamp, pick(rng, TRUNKS)]))]),
    );
    // Every room gets at least one collision so rule 2.3 always matters.
    let ringing;
    for (let tries = 0; tries < 200; tries++) {
      const numbers = shuffle(rng, [1, 2, 3, 4, 5, 6, 7, 8]).slice(0, RINGING).sort((a, b) => a - b);
      const combos = shuffle(
        rng,
        GRID_LAMPS.flatMap((lamp) => GRID_STAMPS.map((stamp) => ({ lamp, stamp }))),
      ).slice(0, RINGING);
      ringing = numbers.map((number, i) => ({ number, ...combos[i] }));
      if (hasCollision(grid, ringing)) break;
    }
    if (!hasCollision(grid, ringing)) {
      // Fallback: force the first two calls onto the same grid cell's trunk.
      grid[ringing[1].lamp][ringing[1].stamp] = grid[ringing[0].lamp][ringing[0].stamp];
    }
    const lines = [];
    for (let number = 1; number <= LINE_COUNT; number++) {
      const ring = ringing.find((l) => l.number === number);
      lines.push(ring ? { ...ring } : { number, lamp: null, stamp: pick(rng, GRID_STAMPS) });
    }
    return { grid, lines, ringing, routes: routeCalls(grid, ringing) };
  },

  views: {
    caller: (s) => ({
      kind: 'patch-bay',
      intro:
        'The switchboard wakes. Three lines are ringing for a connection, and six trunk jacks wait below. Patch each lit line to the right trunk, then throw the ringing key.',
      lines: s.lines,
      trunks: TRUNKS,
    }),
    operator: (s) => ({
      kind: 'patch-bay',
      intro:
        'Section 2. Incoming calls must be patched to an outgoing trunk. Each call is identified by the colour of its line lamp and the shape stamped on its line plate.',
      blocks: [
        {
          type: 'steps',
          heading: '2.1 Procedure',
          items: [
            'Ask the Caller which lines are lit. Unlit lines are not ringing; ignore them.',
            'For each lit line, ask for its number, its lamp colour and the shape on its plate.',
            'Find the trunk in the routing grid (2.2), then apply rule 2.3.',
            'Tell the Caller which trunk each line goes to. They patch the cords and throw the key.',
          ],
        },
        {
          type: 'grid',
          heading: '2.2 Routing grid',
          caption: 'Read along the row for the lamp colour, then down to the column for the shape.',
          rows: GRID_LAMPS.map((lamp) => ({ key: lamp, label: LAMPS[lamp].label })),
          cols: GRID_STAMPS.map((stamp) => ({ key: stamp, label: STAMPS[stamp].label })),
          cells: GRID_LAMPS.map((lamp) => GRID_STAMPS.map((stamp) => s.grid[lamp][stamp])),
        },
        {
          type: 'rules',
          heading: '2.3 Busy trunks',
          items: [
            'Route calls in order of line number, lowest first.',
            'A trunk carries one call. If a call’s trunk is already taken, move it to the next letter along. After F comes A.',
            'Keep stepping until you reach a free trunk.',
          ],
        },
      ],
    }),
  },

  parseAnswer(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Patch every lit line first.' };
    const entries = Object.entries(raw);
    if (entries.length === 0 || entries.length > LINE_COUNT) return { error: 'Patch every lit line first.' };
    const value = {};
    const used = new Set();
    for (const [line, trunk] of entries) {
      const number = Number(line);
      if (!Number.isInteger(number) || number < 1 || number > LINE_COUNT || !TRUNKS.includes(trunk)) {
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

  hints: {
    caller: [
      () =>
        'Only the lit lines are ringing. For each one, tell your Operator its line number, its lamp colour and the shape stamped on its plate.',
      () =>
        'Calls are routed lowest line number first. When two calls want the same trunk, the lower number keeps it and the other moves along.',
      (s) =>
        `Your ringing lines are ${s.ringing
          .map((l) => `line ${l.number} (${LAMPS[l.lamp].label} lamp, ${STAMPS[l.stamp].label})`)
          .join(', ')}. Read them out exactly like that.`,
    ],
    operator: [
      () => 'Ask the Caller which lines are lit, and for each one: its number, lamp colour and stamped shape.',
      () =>
        'In the routing grid (2.2), go along the row for the lamp colour and down to the column for the shape. That cell is the trunk the call wants.',
      () =>
        'Work from the lowest line number up. At least two of these calls want the same trunk: the later one steps to the next free letter, and after F comes A.',
    ],
  },
};
