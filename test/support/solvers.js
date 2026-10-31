// Independent solvers for the tests. Each one works out a puzzle's answer
// using ONLY what the two players are shown: the Caller's view and the
// Operator's view. If a solver can do it and the server accepts the result,
// the clues are complete and consistent. The solvers deliberately re-implement
// the rules from the manual's wording keys rather than importing server code.

const block = (op, type, id) => op.blocks.find((b) => b.type === type && (id == null || b.id === id));
const rules = (op, id) => new Set((block(op, 'rules', id)?.items || []).map((i) => i.key));

function need(condition, message) {
  if (!condition) throw new Error(`clue missing: ${message}`);
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const shift = (letter, by) => ALPHABET[(ALPHABET.indexOf(letter) + by + 104) % 26];

export const SOLVERS = {
  'dead-line'(caller, op) {
    const directory = block(op, 'glyphs').entries;
    const lampRules = rules(op, 'lamps');
    let column = 'day';
    if (caller.clock) {
      need(rules(op, 'clock').has('night'), 'clock rule');
      const hour = Number(caller.clock.slice(0, 2));
      column = hour >= 18 || hour < 6 ? 'night' : 'day';
      need(block(op, 'glyphs').nightColumn, 'night column');
    }
    if (caller.plates.some((p) => p.barred)) need(rules(op, 'blanks').has('barred'), 'blanking plate rule');
    let digits = caller.plates
      .filter((p) => !p.barred)
      .map((p) => {
        const entry = directory.find((e) => e.glyph === p.glyph);
        need(entry, `glyph ${p.glyph} in the directory`);
        return entry[column];
      });
    if (caller.lamps.length === 2) need(lampRules.has('two-lamps'), 'two-lamp rule');
    for (const lamp of caller.lamps) {
      need(lampRules.has(lamp), `${lamp} lamp rule`);
      if (lamp === 'amber') digits = digits.reverse();
      if (lamp === 'red') digits = [digits[digits.length - 1], ...digits.slice(1, -1), digits[0]];
      if (lamp === 'blue') digits = digits.map((d) => (d + 1) % 10);
      if (lamp === 'white') digits = [...digits.slice(1), digits[0]];
    }
    need(digits.length === caller.digits, 'digit count');
    return digits.join('');
  },

  'patch-bay'(caller, op) {
    const grid = block(op, 'grid');
    const has = rules(op, 'routing');
    const letters = caller.trunks.map((t) => t.letter);
    const broken = caller.trunks.filter((t) => t.outOfOrder).map((t) => t.letter);
    if (broken.length) need(has.has('out-of-order'), 'out-of-order rule');
    const trunkFor = (line) => {
      const r = grid.rows.findIndex((row) => row.key === line.lamp);
      const c = grid.cols.findIndex((col) => col.key === line.stamp);
      need(r >= 0 && c >= 0, 'grid cell');
      return grid.cells[r][c];
    };
    const calls = caller.lines.filter((l) => l.lamp);
    calls.sort((a, b) => (has.has('priority') ? (b.lamp === 'red') - (a.lamp === 'red') : 0) || a.number - b.number);
    const taken = new Set();
    const routes = {};
    for (const call of calls) {
      let i = letters.indexOf(trunkFor(call));
      const step = has.has('step-back') && call.number % 2 === 0 ? -1 : 1;
      if (taken.has(letters[i]) || broken.includes(letters[i])) need(has.has('busy'), 'busy-trunk rule');
      while (taken.has(letters[i]) || broken.includes(letters[i])) i = (i + step + letters.length) % letters.length;
      taken.add(letters[i]);
      routes[call.number] = letters[i];
    }
    return routes;
  },

  teleprinter(caller, op) {
    const code = block(op, 'tapecode').entries;
    const has = rules(op, 'tape');
    const decoded = [];
    for (let bits of caller.columns) {
      if (caller.topRow === 5) {
        need(has.has('flip'), 'upside-down tape rule');
        bits = [...bits].reverse();
      }
      if (bits.every((b) => b === 1)) continue;
      if (bits.every((b) => b === 0)) {
        need(has.has('spacer'), 'spacer rule');
        continue;
      }
      const entry = code.find((e) => e.bits.join('') === bits.join(''));
      need(entry, 'tape pattern in the code');
      decoded.push(entry.letter);
    }
    let letters = decoded;
    if (caller.reel === 'rewound') {
      need(has.has('rewound'), 'rewound rule');
      letters = letters.reverse();
    }
    if (caller.shift) {
      need(has.has('shift'), 'shift rule');
      letters = letters.map((l) => shift(l, -caller.shift));
    }
    const name = letters.join('');
    need(block(op, 'roster').names.includes(name), `${name} on the roster`);
    return name;
  },

  'party-line'(caller, op) {
    const directory = block(op, 'cadences').entries;
    const has = rules(op, 'callback');
    const counts = new Map();
    const first = new Map();
    caller.rings.forEach((ring, i) => {
      if (ring.echo) {
        need(has.has('echo'), 'echo rule');
        return;
      }
      const entry = directory.find((d) => d.cadence === ring.cadence);
      need(entry, `cadence ${ring.cadence} in the directory`);
      if (ring.trunk) need(has.has('trunk'), 'trunk-ring rule');
      counts.set(entry.household, (counts.get(entry.household) || 0) + (ring.trunk ? 2 : 1));
      if (!first.has(entry.household)) first.set(entry.household, i);
    });
    const byCount = has.has('count');
    need(byCount || has.has('first'), 'ring-back order rule');
    const order = [...counts.keys()].sort((a, b) => (byCount ? counts.get(b) - counts.get(a) : 0) || first.get(a) - first.get(b));
    for (const h of order) need(caller.households.includes(h), `${h} key on the Caller's board`);
    return order;
  },

  'relay-rack'(caller, op) {
    const procedure = block(op, 'procedure').entries;
    need(rules(op, 'faults').has('order'), 'lamp order rule');
    const caps = caller.relays.map((r) => r.cap);
    let rack = caller.relays.map((r) => r.up);
    const lit = caller.lamps.filter((l) => l.lit).map((l) => l.letter).sort();
    for (const letter of lit) {
      const entry = procedure.find((e) => e.lamp === letter);
      need(entry, `job for lamp ${letter}`);
      const a = entry.action;
      const before = rack;
      const flip = (test) => before.map((v, i) => (test(i) ? !v : v));
      if (a.kind === 'flip-colour') rack = flip((i) => caps[i] === a.colour);
      else if (a.kind === 'flip-numbers') rack = flip((i) => a.numbers.includes(i + 1));
      else if (a.kind === 'set-colour') rack = before.map((v, i) => (caps[i] === a.colour ? a.up : v));
      else if (a.kind === 'flip-parity') rack = flip((i) => (i + 1) % 2 === (a.odd ? 1 : 0));
      else if (a.kind === 'match') rack = before.map((v, i) => (caps[i] === a.colour ? before[a.relay - 1] : v));
      else if (a.kind === 'conditional') {
        const colour = before[a.relay - 1] === a.up ? a.then : a.otherwise;
        rack = flip((i) => caps[i] === colour);
      } else throw new Error(`unknown job ${a.kind}`);
      need(entry.text.length > 10, 'job wording');
    }
    return rack.map((up) => (up ? 'U' : 'D')).join('');
  },

  'cipher-wheel'(caller, op) {
    const keys = block(op, 'keys').entries;
    const has = rules(op, 'cipher');
    const key = keys.find((k) => k.glyph === caller.pointer);
    need(key, 'pointer glyph in the key table');
    let by = key.shift;
    if (caller.stamps) {
      need(has.has('stamps'), 'stamp rule');
      by += caller.stamps;
    }
    const alternate = has.has('alternate');
    need(alternate || has.has('back'), 'cipher direction rule');
    const word = [...caller.cipher].map((ch, i) => shift(ch, alternate && i % 2 === 1 ? by : -by)).join('');
    need(block(op, 'roster').names.includes(word), `${word} in the codebook`);
    return word;
  },
};

/** Keys that only one role's view may contain. */
export const ROLE_ONLY = {
  caller: ['plates', 'lamps', 'clock', 'lines', 'trunks', 'columns', 'reel', 'rings', 'households', 'relays', 'cipher', 'pointer', 'stamps'],
  operator: ['blocks', 'directory', 'grid', 'code', 'roster', 'codebook', 'procedure', 'entries'],
};
