import { CAPS } from '../../shared/art.js';
import { pick, sample } from '../random.js';

// Sequence deduction. The Caller sees a rack of relays and which fault lamps
// are lit; the Operator holds the fault procedure, a job for each lamp, done
// in order. Some jobs depend on what the rack is doing at that moment.

const COLOURS = Object.keys(CAPS);
const LAMP_LETTERS = ['A', 'B', 'C', 'D', 'E'];
const BASIC = ['flip-colour', 'flip-numbers'];

export const LEVELS = [
  null,
  { relays: 5, lamps: 3, lit: 1, kinds: BASIC },
  { relays: 5, lamps: 3, lit: 2, kinds: BASIC },
  { relays: 6, lamps: 3, lit: 2, kinds: [...BASIC, 'set-colour'] },
  { relays: 6, lamps: 3, lit: 2, kinds: [...BASIC, 'set-colour', 'flip-parity', 'match'], ordered: true },
  { relays: 7, lamps: 4, lit: 2, kinds: [...BASIC, 'set-colour', 'flip-parity', 'match'], ordered: true },
  { relays: 7, lamps: 4, lit: 3, kinds: [...BASIC, 'set-colour', 'match', 'conditional'] },
  { relays: 8, lamps: 4, lit: 3, kinds: [...BASIC, 'set-colour', 'flip-parity', 'match', 'conditional'], ordered: true },
  { relays: 8, lamps: 5, lit: 3, kinds: [...BASIC, 'set-colour', 'flip-parity', 'match', 'conditional'], ordered: true },
];

const pos = (up) => (up ? 'up' : 'down');

export function describeAction(a) {
  switch (a.kind) {
    case 'flip-colour':
      return `Flip every relay with a ${a.colour} cap.`;
    case 'flip-numbers':
      return `Flip relays ${a.numbers[0]} and ${a.numbers[1]}.`;
    case 'set-colour':
      return `Set every relay with a ${a.colour} cap to ${pos(a.up).toUpperCase()}, whatever it shows now.`;
    case 'flip-parity':
      return `Flip every ${a.odd ? 'odd' : 'even'}-numbered relay.`;
    case 'match':
      return `Set every relay with a ${a.colour} cap to match relay ${a.relay} as it is right now.`;
    case 'conditional':
      return `If relay ${a.relay} is ${pos(a.up).toUpperCase()} right now, flip every ${a.then} relay. Otherwise, flip every ${a.otherwise} relay.`;
    default:
      throw new Error(`unknown relay action ${a.kind}`);
  }
}

/** Applies one job to the rack (an array of booleans, true = up, relay 1 first). */
export function applyAction(rack, caps, a) {
  const out = [...rack];
  const flipWhere = (test) => out.forEach((v, i) => test(i) && (out[i] = !v));
  switch (a.kind) {
    case 'flip-colour':
      flipWhere((i) => caps[i] === a.colour);
      break;
    case 'flip-numbers':
      flipWhere((i) => a.numbers.includes(i + 1));
      break;
    case 'set-colour':
      out.forEach((_, i) => caps[i] === a.colour && (out[i] = a.up));
      break;
    case 'flip-parity':
      flipWhere((i) => (i + 1) % 2 === (a.odd ? 1 : 0));
      break;
    case 'match': {
      const target = rack[a.relay - 1];
      out.forEach((_, i) => caps[i] === a.colour && (out[i] = target));
      break;
    }
    case 'conditional': {
      const colour = rack[a.relay - 1] === a.up ? a.then : a.otherwise;
      flipWhere((i) => caps[i] === colour);
      break;
    }
    default:
      throw new Error(`unknown relay action ${a.kind}`);
  }
  return out;
}

export const runProcedure = (rack, caps, actions) => actions.reduce((r, a) => applyAction(r, caps, a), rack);
const same = (a, b) => a.join() === b.join();

function makeAction(rng, kind, n, present) {
  const relay = () => 1 + rng.int(n);
  switch (kind) {
    case 'flip-colour':
      return { kind, colour: pick(rng, present) };
    case 'flip-numbers':
      return { kind, numbers: sample(rng, Array.from({ length: n }, (_, i) => i + 1), 2).sort((a, b) => a - b) };
    case 'set-colour':
      return { kind, colour: pick(rng, present), up: rng.int(2) === 1 };
    case 'flip-parity':
      return { kind, odd: rng.int(2) === 1 };
    case 'match':
      return { kind, colour: pick(rng, present), relay: relay() };
    case 'conditional': {
      const [then, otherwise] = sample(rng, present, 2);
      return { kind, relay: relay(), up: rng.int(2) === 1, then, otherwise };
    }
    default:
      throw new Error(`unknown relay action ${kind}`);
  }
}

function attempt(rng, p) {
  const caps = Array.from({ length: p.relays }, () => pick(rng, COLOURS));
  const present = [...new Set(caps)];
  if (present.length < 3) return null;
  const rack = Array.from({ length: p.relays }, () => rng.int(2) === 1);
  const letters = LAMP_LETTERS.slice(0, p.lamps);
  const kinds = sample(rng, p.kinds, p.kinds.length);
  const actions = letters.map((_, i) => makeAction(rng, kinds[i % kinds.length], p.relays, present));
  const lit = sample(rng, letters, p.lit).sort();
  const litActions = lit.map((l) => actions[letters.indexOf(l)]);

  // Every lit job must change something, the result must differ from the start,
  // and where the level says so, doing the jobs out of order must go wrong.
  let state = rack;
  for (const a of litActions) {
    const next = applyAction(state, caps, a);
    if (same(next, state)) return null;
    state = next;
  }
  if (same(state, rack)) return null;
  if (p.ordered && same(state, runProcedure(rack, caps, [...litActions].reverse()))) return null;
  if (p.kinds.includes('conditional') && !litActions.some((a) => a.kind === 'conditional')) return null;
  return { caps, rack, letters, actions, lit, final: state };
}

export default {
  type: 'relay-rack',
  levels: LEVELS,

  generate(rng, level) {
    const p = LEVELS[level];
    let made = null;
    for (let tries = 0; !made; tries++) {
      if (tries > 10_000) throw new Error(`relay-rack level ${level}: could not build a rack`);
      made = attempt(rng, p);
    }
    return { level, ...made, answer: made.final.map((up) => (up ? 'U' : 'D')).join('') };
  },

  views: {
    caller: (s) => ({
      kind: 'relay-rack',
      intro: `A rack of ${s.caps.length} relays hums in the machine hall, and ${s.letters.length} fault lamps sit above it. Set the relays right, then press the reset bar.`,
      relays: s.caps.map((cap, i) => ({ number: i + 1, cap, up: s.rack[i] })),
      lamps: s.letters.map((letter) => ({ letter, lit: s.lit.includes(letter) })),
    }),
    operator: (s) => ({
      kind: 'relay-rack',
      intro: 'Each fault lamp on the rack calls for one job. The Caller can see the rack and the lamps; only this procedure says what the jobs are.',
      blocks: [
        {
          type: 'steps',
          heading: 'Procedure',
          items: [
            'Ask the Caller which fault lamps are lit.',
            'Ask for each relay’s number, cap colour and whether it is up or down.',
            'Do the job for each lit lamp, in alphabetical order. Tell the Caller which relays to flip or set as you go.',
            'When every job is done, the Caller presses the reset bar.',
          ],
        },
        {
          type: 'procedure',
          heading: 'Fault procedure',
          entries: s.letters.map((lamp, i) => ({ lamp, action: s.actions[i], text: describeAction(s.actions[i]) })),
        },
        {
          type: 'rules',
          id: 'faults',
          heading: 'Fault rules',
          items: [
            { key: 'order', text: 'Only lit lamps count. Do their jobs in alphabetical order, A first; ignore every unlit lamp.' },
            { key: 'flip', text: 'To flip a relay: up becomes down and down becomes up.' },
            { key: 'now', text: '“Right now” means the rack as it stands when you reach that job, after the earlier jobs.' },
          ],
        },
      ],
    }),
  },

  parseAnswer(raw, s) {
    const value = String(raw ?? '').toUpperCase();
    if (!new RegExp(`^[UD]{${s.caps.length}}$`).test(value)) return { error: 'Every relay must be up or down.' };
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
      () => 'Tell your Operator which fault lamps are lit, then each relay’s number, cap colour and position.',
      () => 'Do one job at a time as your Operator reads them out, and say what the rack looks like after each one. Order matters.',
      (s) =>
        `Lit lamps: ${s.lit.join(', ')}. Your rack, from relay 1: ${s.caps.map((c, i) => `${i + 1} ${c} ${s.rack[i] ? 'up' : 'down'}`).join(', ')}.`,
    ],
    operator: [
      () => 'Ask which fault lamps are lit and write down each relay’s cap colour and position.',
      () => 'Work through the lit lamps alphabetically. After each job, update your list of positions before starting the next.',
      (s) =>
        `Watch the jobs that say “right now”: they depend on the rack after the earlier jobs. There ${s.lit.length === 1 ? 'is one lit lamp' : `are ${s.lit.length} lit lamps`} to deal with.`,
    ],
  },
};
