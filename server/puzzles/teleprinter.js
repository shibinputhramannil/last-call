import { pick, sample, shuffle } from '../random.js';

// Punched tape. The Caller reads columns of holes off a tape; the Operator's
// tape code turns them into letters, and the reel rules put the name right.

export const ROSTERS = Object.freeze({
  4: ['ALMA', 'ANNE', 'BETH', 'CORA', 'DORA', 'EDNA', 'ELLA', 'EMMA', 'ENID', 'ETTA', 'IRIS', 'JUNE', 'LENA', 'LOIS', 'MAUD', 'NELL', 'OLGA', 'RUBY', 'RUTH', 'VERA'],
  5: [
    'AGNES', 'BERYL', 'CELIA', 'DAISY', 'DORIS', 'EDITH', 'ELSIE', 'ETHEL', 'FLORA', 'GRACE', 'HAZEL', 'HILDA', 'IRENE',
    'JOYCE', 'MABEL', 'MAEVE', 'MAVIS', 'NANCY', 'NORAH', 'OLIVE', 'PEARL', 'PEGGY', 'SYBIL', 'VIOLA', 'WILMA',
  ],
  6: [
    'AGATHA', 'AUDREY', 'BRENDA', 'CICELY', 'DOREEN', 'EILEEN', 'ESTHER', 'EVELYN', 'GLADYS', 'HATTIE',
    'HILARY', 'IMOGEN', 'JOANNA', 'MARION', 'MAXINE', 'MURIEL', 'PHOEBE', 'VIOLET', 'WINNIE', 'YVONNE',
  ],
  7: [
    'ADELINE', 'ANTONIA', 'BEATRIX', 'BLANCHE', 'CAROLYN', 'CLARICE', 'DOROTHY', 'ESTELLE', 'FLORRIE', 'HARRIET', 'JESSAMY',
    'LAVINIA', 'LETITIA', 'LILLIAN', 'MARGERY', 'MATILDA', 'MILDRED', 'PAULINE', 'ROSALIE', 'SHIRLEY', 'VALERIE',
  ],
});

export const LEVELS = [
  null,
  { length: 4, reels: ['feed'], roster: 12 },
  { length: 4, reels: ['feed', 'rewound'], roster: 12 },
  { length: 5, reels: ['feed', 'rewound'], roster: 14 },
  { length: 5, reels: ['feed', 'rewound'], roster: 14, spacers: 1 },
  { length: 5, reels: ['feed', 'rewound'], roster: 16, spacers: 1, flip: true },
  { length: 6, reels: ['feed', 'rewound'], roster: 16, spacers: 1, flip: true },
  { length: 6, reels: ['feed', 'rewound'], roster: 16, spacers: 1, flip: true, shift: 3 },
  { length: 6, reels: ['feed', 'rewound'], roster: 18, spacers: 2, flip: true, shift: 5 },
  { length: 7, reels: ['feed', 'rewound'], roster: 18, spacers: 2, flip: true, shift: 5 },
  { length: 7, reels: ['feed', 'rewound'], roster: 20, spacers: 3, flip: true, shift: 9 },
];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const LEADER = [1, 1, 1, 1, 1];
const SPACER = [0, 0, 0, 0, 0];
const toBits = (n) => [16, 8, 4, 2, 1].map((b) => (n & b ? 1 : 0));
const describe = (bits) => bits.map((b) => (b ? 'hole' : 'blank')).join(', ');
export const shiftLetter = (letter, by) => LETTERS[(LETTERS.indexOf(letter) + by + 26 * 4) % 26];

export default {
  type: 'teleprinter',
  levels: LEVELS,

  generate(rng, level) {
    const p = LEVELS[level];
    // 30 usable patterns: all-blank is reserved for spacers, all-holes for leader.
    const patterns = shuffle(
      rng,
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    const code = Object.fromEntries(LETTERS.map((letter, i) => [letter, toBits(patterns[i])]));
    const pool = ROSTERS[p.length];
    const name = pick(rng, pool);
    const roster = [name, ...sample(rng, pool.filter((n) => n !== name), p.roster - 1)].sort();
    const reel = pick(rng, p.reels);
    const flipped = Boolean(p.flip) && rng.int(2) === 1;
    const shift = p.shift ? 1 + rng.int(p.shift) : 0;

    let letters = [...name].map((l) => shiftLetter(l, shift));
    if (reel === 'rewound') letters = letters.reverse();
    const body = letters.map((l) => code[l]);
    for (let i = 0; i < (p.spacers || 0); i++) body.splice(1 + rng.int(body.length - 1), 0, SPACER);
    const columns = [LEADER, ...body, LEADER].map((bits) => (flipped ? [...bits].reverse() : [...bits]));
    return {
      level,
      code,
      name,
      roster,
      reel,
      flipped,
      shift,
      columns,
      rewoundRule: p.reels.includes('rewound'),
      spacerRule: Boolean(p.spacers),
      flipRule: Boolean(p.flip),
      shiftRule: Boolean(p.shift),
    };
  },

  views: {
    caller: (s) => ({
      kind: 'teleprinter',
      intro: 'A teleprinter chatters once and stops. A strip of punched tape hangs from its reel. Whoever is on the other end needs a name typed back to them.',
      reel: s.reel,
      shift: s.shift,
      topRow: s.flipped ? 5 : 1,
      columns: s.columns,
      letters: s.name.length,
    }),
    operator: (s) => {
      const rules = [
        { key: 'leader', text: 'Columns with all five holes punched are leader. They carry no letter; skip them.' },
        ...(s.spacerRule ? [{ key: 'spacer', text: 'A column with no holes at all is a spacer. It carries no letter; skip it.' }] : []),
        ...(s.flipRule
          ? [{ key: 'flip', text: 'The tape is printed with a ▲ TOP mark on its top edge. If the mark is beside row 5, the tape is upside down: read every column from row 5 up to row 1.' }]
          : []),
        { key: 'feed', text: 'Reel labelled FEED: the letters run left to right as read.' },
        ...(s.rewoundRule ? [{ key: 'rewound', text: 'Reel labelled REWOUND: the tape was wound backwards. Reverse the order of the letters.' }] : []),
        ...(s.shiftRule
          ? [{ key: 'shift', text: 'If the reel label also says SHIFT and a number, move every letter back that many places in the alphabet. B back 1 is A; A back 1 is Z.' }]
          : []),
      ];
      return {
        kind: 'teleprinter',
        intro: `The exchange speaks in punched tape. Each column of five holes is one letter. The message is always a name from the night staff: ${s.name.length} letters.`,
        blocks: [
          {
            type: 'steps',
            heading: 'Procedure',
            items: [
              'Ask the Caller to read each tape column from row 1 at the top to row 5 at the bottom, as hole or blank.',
              s.flipRule ? 'Ask which row the printed ▲ TOP mark is beside.' : null,
              'Look up each pattern in the tape code.',
              'Ask exactly what the reel label says and apply the reel rules. The Caller types the name and sends it.',
            ].filter(Boolean),
          },
          {
            type: 'tapecode',
            heading: 'Tape code',
            caption: 'Filled circle: hole. Ring: blank. Row 1 is at the top.',
            entries: LETTERS.map((letter) => ({ letter, bits: s.code[letter] })),
          },
          { type: 'rules', id: 'tape', heading: 'Tape and reel rules', items: rules },
          {
            type: 'roster',
            heading: 'Night staff, Exchange 7',
            caption: 'The name will be one of these. If your letters are close but not exact, check that column again.',
            names: s.roster,
          },
        ],
      };
    },
  },

  parseAnswer(raw, s) {
    const value = String(raw ?? '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
    if (value.length !== s.name.length) return { error: `The teleprinter needs a ${s.name.length}-letter name.` };
    return { value };
  },

  check(s, value) {
    let matched = 0;
    for (let i = 0; i < s.name.length; i++) if (value[i] === s.name[i]) matched++;
    return { correct: value === s.name, matched, total: s.name.length, unit: 'letters' };
  },

  solution: (s) => s.name,

  hints: {
    caller: [
      () => 'Your Operator holds the tape code. Read each column from top to bottom as "hole" or "blank", one column at a time.',
      (s) =>
        `Your reel label reads ${s.reel === 'feed' ? 'FEED' : 'REWOUND'}${s.shift ? ` · SHIFT ${s.shift}` : ''}. Tell your Operator exactly that.${s.flipRule ? ` The ▲ TOP mark is beside row ${s.flipped ? 5 : 1}; mention it too.` : ''} The all-holes columns at each end are leader.`,
      (s) =>
        `Read slowly and have your Operator repeat each column back. The second column on the tape (the first after the leader) reads: ${describe(s.columns[1])}.`,
    ],
    operator: [
      () => 'Ask the Caller to read each tape column from top to bottom as hole or blank, and what the reel label says.',
      (s) =>
        `Match each pattern to the tape code. Skip leader${s.spacerRule ? ' and spacer' : ''} columns. You should end up with ${s.name.length} letters.${s.flipRule ? ' If the ▲ TOP mark is by row 5, turn each column upside down before looking it up.' : ''}`,
      (s) =>
        `Apply the reel rules${s.shiftRule ? ', including the shift back through the alphabet' : ''}. The result is one of the names on the roster; if it is one letter off, re-check that column.`,
    ],
  },
};
