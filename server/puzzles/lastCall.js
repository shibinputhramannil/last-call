import { pick, shuffle } from '../random.js';

export const NIGHT_STAFF = Object.freeze([
  'AGNES', 'DORIS', 'EDITH', 'ELSIE', 'ETHEL', 'HAZEL', 'IRENE', 'MABEL',
  'MAEVE', 'MAVIS', 'NORAH', 'OLIVE', 'PEARL', 'SYBIL', 'VIOLA', 'WILMA',
]);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const LEADER = [1, 1, 1, 1, 1];

const toBits = (n) => [16, 8, 4, 2, 1].map((b) => (n & b ? 1 : 0));
const describe = (bits) => bits.map((b) => (b ? 'hole' : 'blank')).join(', ');

export default {
  id: 'last-call',
  title: 'The Last Call',

  generate(rng) {
    // 30 usable patterns: never all blank, and all-holes is reserved for leader.
    const patterns = shuffle(
      rng,
      Array.from({ length: 30 }, (_, i) => i + 1),
    ).slice(0, LETTERS.length);
    const code = Object.fromEntries(LETTERS.map((letter, i) => [letter, toBits(patterns[i])]));
    const name = pick(rng, NIGHT_STAFF);
    const reel = pick(rng, ['feed', 'rewound']);
    const letters = reel === 'rewound' ? [...name].reverse() : [...name];
    const columns = [LEADER, ...letters.map((l) => code[l]), LEADER];
    return { code, name, reel, columns };
  },

  views: {
    caller: (s) => ({
      kind: 'last-call',
      intro:
        'A teleprinter chatters once and stops. A strip of punched tape hangs from its reel. Whoever is on the other end needs a name typed back to them.',
      reel: s.reel,
      columns: s.columns,
      letters: 5,
    }),
    operator: (s) => ({
      kind: 'last-call',
      intro:
        'Section 3. The exchange speaks in punched tape. Each column of five holes is one letter. The last message is always a name from the night staff.',
      blocks: [
        {
          type: 'steps',
          heading: '3.1 Procedure',
          items: [
            'Ask the Caller to read each tape column from row 1 at the top to row 5 at the bottom, as hole or blank.',
            'Columns with all five holes punched are leader. They carry no letter; skip them.',
            'Look up each pattern in the tape code (3.2).',
            'Ask how the reel is labelled and apply rule 3.3. The Caller types the name and sends it.',
          ],
        },
        {
          type: 'tapecode',
          heading: '3.2 Tape code',
          caption: 'Filled circle: hole. Ring: blank. Row 1 is at the top.',
          entries: LETTERS.map((letter) => ({ letter, bits: s.code[letter] })),
        },
        {
          type: 'rules',
          heading: '3.3 Reel direction',
          items: [
            'Reel labelled FEED: the letters run left to right as read.',
            'Reel labelled REWOUND: the tape was wound backwards. Reverse the order of the letters.',
          ],
        },
        {
          type: 'roster',
          heading: '3.4 Night staff, Exchange 7',
          caption: 'The name will be one of these. If your letters are close but not exact, check the pattern again.',
          names: NIGHT_STAFF,
        },
      ],
    }),
  },

  parseAnswer(raw) {
    const value = String(raw ?? '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
    if (value.length !== 5) return { error: 'The teleprinter needs a five-letter name.' };
    return { value };
  },

  check(s, value) {
    let matched = 0;
    for (let i = 0; i < 5; i++) if (value[i] === s.name[i]) matched++;
    return { correct: value === s.name, matched, total: 5, unit: 'letters' };
  },

  hints: {
    caller: [
      () =>
        'Your Operator holds the tape code. Read each column from top to bottom as "hole" or "blank", one column at a time.',
      (s) =>
        `Your reel is labelled ${s.reel === 'feed' ? 'FEED' : 'REWOUND'}. Tell your Operator; it decides which way the name runs. The columns with all five holes at each end are leader and carry no letter.`,
      (s) =>
        `Read slowly and have your Operator repeat each column back. The first letter column (the second column on the tape) reads: ${describe(s.columns[1])}.`,
    ],
    operator: [
      () => 'Ask the Caller to read each tape column from top to bottom as hole or blank, and how the reel is labelled.',
      () =>
        'Match each pattern to the tape code (3.2). Skip the leader columns, where all five holes are punched. You should end up with five letters.',
      () =>
        'If the reel says REWOUND, reverse your five letters. The result is one of the names on the night staff roster (3.4); if it is one letter off, re-check that column.',
    ],
  },
};
