// The Caller's view: machines rendered from the role-specific puzzle data.
// Each renderer returns a controller: { onResult(result), setBusy(bool), destroy() }.

import { GLYPHS, STAMPS, CAPS, describeCadence, glyphSvg, stampSvg } from './art.js';
import { h, s, announce, prefersReducedMotion } from './dom.js';

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const DIAL_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
const CORD_COLOURS = ['#c4513f', '#3f8a73', '#5566b8', '#c9a25a', '#9c5fb5'];

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
const overlayOpen = () => document.querySelector('.overlay:not([hidden]), #settings:not([hidden])');

function machineShell(engraving, stateText) {
  const state = h('span', { class: 'machine-state' }, stateText);
  const feedback = h('p', { class: 'feedback', role: 'status' });
  const machine = h('div', { class: 'machine' }, h('div', { class: 'machine-label' }, h('span', { class: 'engraved' }, engraving), state));
  return { machine, state, feedback };
}

function shake(machine) {
  if (prefersReducedMotion()) return;
  machine.classList.remove('is-wrong');
  void machine.offsetWidth;
  machine.classList.add('is-wrong');
}

function glow(machine) {
  machine.classList.add('is-solved');
}

function describeResult(result, fallback) {
  const parts = [fallback];
  if (result.feedback) parts.push(`${result.feedback.matched} of ${result.feedback.total} ${result.feedback.unit} held.`);
  if (result.penaltyMs) parts.push(`The countdown lost ${result.penaltyMs / 1000} seconds.`);
  return parts.join(' ');
}

function setFeedback(feedback, tone, text) {
  feedback.className = `feedback${tone ? ` is-${tone}` : ''}`;
  feedback.textContent = text;
}

/** A plain text form for typed answers (teleprinter, cipher wheel). */
function letterForm({ letters, label, button, ctx, onSubmit, help }) {
  const input = h('input', {
    class: 'tty-input',
    name: 'reply',
    maxlength: letters,
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    placeholder: '·'.repeat(letters),
    'aria-describedby': help,
    style: `--letters: ${letters}`,
  });
  const send = h('button', { class: 'btn btn-lamp', type: 'submit' }, button);
  const form = h('form', { class: 'tty-form', novalidate: true }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input), send);
  input.addEventListener('input', () => {
    const clean = input.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, letters);
    if (clean !== input.value) input.value = clean;
    ctx.audio.play('key');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit(input.value.trim());
  });
  return { form, input, send };
}

// ---- The Dead Line ----------------------------------------------------------------

function deadLine(root, view, ctx) {
  const { machine, state, feedback } = machineShell('Dead line', 'Out of service');
  const needed = view.digits;
  let digits = [];
  let busy = false;

  const boxes = h('div', { class: 'dialled', 'aria-hidden': 'true' }, Array.from({ length: needed }, () => h('span', {}, '·')));
  const dialledText = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const lever = h('button', { class: 'btn btn-lamp', type: 'button', disabled: true }, 'Pull the connect lever');
  const hangUp = h('button', { class: 'btn', type: 'button' }, 'Hang up and clear');

  // Rotary dial: a face of numbers, a finger plate that turns, and real buttons on top.
  const C = 140;
  const R = 100;
  const angleOf = (i) => 50 + i * 30; // degrees, anticlockwise from 3 o'clock
  const at = (deg, r) => [C + r * Math.cos((deg * Math.PI) / 180), C - r * Math.sin((deg * Math.PI) / 180)];
  const holesPath = DIAL_ORDER.map((_, i) => {
    const [x, y] = at(angleOf(i), R);
    return `M${x + 19} ${y}a19 19 0 1 0 -38 0a19 19 0 1 0 38 0`;
  }).join('');
  const plate = s(
    'g',
    { class: 'dial-plate' },
    s('path', { class: 'plate-disc', 'fill-rule': 'evenodd', d: `M${C + 128} ${C}a128 128 0 1 0 -256 0a128 128 0 1 0 256 0M${C + 56} ${C}a56 56 0 1 0 -112 0a56 56 0 1 0 112 0${holesPath}` }),
  );
  const [sx, sy] = at(-18, 122);
  const svg = s(
    'svg',
    { viewBox: '0 0 280 280', 'aria-hidden': 'true' },
    s('circle', { class: 'dial-face', cx: C, cy: C, r: 134 }),
    DIAL_ORDER.map((d, i) => {
      const [x, y] = at(angleOf(i), R);
      return s('text', { class: 'dial-num', x, y }, String(d));
    }),
    plate,
    s('circle', { class: 'dial-centre', cx: C, cy: C, r: 50 }),
    s('text', { class: 'dial-centre-text', x: C, y: C - 4 }, 'EXCHANGE'),
    s('text', { class: 'dial-centre-text', x: C, y: C + 16 }, '7'),
    s('path', { class: 'dial-stop', d: `M${sx} ${sy}l14 -6l4 12z` }),
  );
  const dial = h('div', { class: 'dial', role: 'group', 'aria-label': 'Rotary dial' }, svg);
  DIAL_ORDER.forEach((d, i) => {
    const [x, y] = at(angleOf(i), R);
    const btn = h('button', { class: 'dial-hole', type: 'button', 'aria-label': `Dial ${d}`, onclick: () => dialDigit(d) });
    btn.style.setProperty('left', `${(x / 280) * 100}%`);
    btn.style.setProperty('top', `${(y / 280) * 100}%`);
    dial.append(btn);
  });

  let spinTimer;
  function spin(d) {
    const i = DIAL_ORDER.indexOf(d);
    if (prefersReducedMotion()) {
      ctx.audio.play('pulse', { digit: d });
      return;
    }
    clearTimeout(spinTimer);
    plate.style.setProperty('transition', 'transform 0.28s cubic-bezier(0.3, 0.7, 0.4, 1)');
    plate.style.setProperty('transform', `rotate(${angleOf(i) + 18}deg)`);
    spinTimer = setTimeout(() => {
      const count = d === 0 ? 10 : d;
      plate.style.setProperty('transition', `transform ${0.12 + count * 0.07}s linear`);
      plate.style.setProperty('transform', 'rotate(0deg)');
      ctx.audio.play('pulse', { digit: d });
    }, 300);
  }

  function update() {
    [...boxes.children].forEach((box, i) => (box.textContent = digits[i] ?? '·'));
    lever.disabled = busy || digits.length !== needed;
    dialledText.textContent = digits.length ? `Dialled ${digits.join(' ')}` : 'Dial cleared';
  }

  function dialDigit(d) {
    if (busy) return;
    if (digits.length >= needed) {
      setFeedback(feedback, '', `${needed} digits dialled. Pull the lever, or hang up to start again.`);
      return;
    }
    digits.push(d);
    spin(d);
    feedback.textContent = '';
    update();
  }

  function submit() {
    if (busy || digits.length !== needed) return;
    if (!ctx.submit(digits.join(''))) return;
    busy = true;
    ctx.audio.play('relay');
    state.textContent = 'Connecting…';
    update();
  }

  lever.addEventListener('click', submit);
  hangUp.addEventListener('click', () => {
    digits = [];
    ctx.audio.play('click');
    feedback.textContent = '';
    update();
  });

  function onKey(e) {
    if (isTyping(document.activeElement) || e.altKey || e.ctrlKey || e.metaKey || overlayOpen()) return;
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      dialDigit(Number(e.key));
    } else if (e.key === 'Backspace' && digits.length) {
      e.preventDefault();
      digits.pop();
      update();
    } else if (e.key === 'Enter' && digits.length === needed && document.activeElement === document.body) {
      e.preventDefault();
      submit();
    }
  }
  document.addEventListener('keydown', onKey);

  const lampNames = view.lamps.length === 2 ? ['Upper lamp', 'Lower lamp'] : ['Signal lamp'];
  const lamps = h(
    'div',
    { class: `signal${view.lamps.length === 2 ? ' is-pair' : ''}` },
    view.lamps.map((colour, i) =>
      h(
        'div',
        { class: 'signal-unit' },
        h('div', { class: 'signal-lamp', 'data-color': colour, role: 'img', 'aria-label': `${lampNames[i]}, glowing ${colour}` }),
        h('p', { class: 'signal-caption', 'aria-hidden': 'true' }, `${lampNames[i]}: `, h('strong', {}, colour)),
      ),
    ),
    view.clock
      ? h(
          'div',
          { class: 'exchange-clock', role: 'img', 'aria-label': `Exchange clock reads ${view.clock}` },
          h('span', { class: 'clock-label', 'aria-hidden': 'true' }, 'Exchange clock'),
          h('span', { class: 'clock-face', 'aria-hidden': 'true' }, [...view.clock].map((ch) => h('span', { class: ch === ':' ? 'sep' : 'digit' }, ch))),
        )
      : null,
  );

  machine.append(
    h(
      'div',
      { class: 'deadline' },
      lamps,
      h(
        'ol',
        { class: 'plates', 'aria-label': 'Glyph plates, left to right', style: `--plates: ${view.plates.length}` },
        view.plates.map((p, i) =>
          h(
            'li',
            { class: `plate${p.barred ? ' is-barred' : ''}` },
            h(
              'div',
              { class: 'plate-face' },
              glyphSvg(p.glyph, {
                label: `Plate ${NUMERALS[i]}: ${GLYPHS[p.glyph].description}${p.barred ? ', with a brass bar bolted across it' : ''}`,
              }),
              p.barred ? h('span', { class: 'plate-bar', 'aria-hidden': 'true' }) : null,
            ),
            h('span', { class: 'plate-num', 'aria-hidden': 'true' }, NUMERALS[i]),
          ),
        ),
      ),
      h('div', { class: 'dial-wrap' }, dial, boxes, dialledText),
    ),
    h('div', { class: 'machine-actions' }, hangUp, lever),
    h('p', { class: 'kbd-hint' }, 'You can also type the digits on your keyboard. Backspace removes one.'),
    feedback,
  );
  root.append(h('p', { class: 'task' }, 'Describe the plates and the lamps to your Operator. Dial the number they give you, then pull the lever.'), machine);
  update();

  return {
    setBusy(value) {
      busy = value;
      if (!value) state.textContent = 'Out of service';
      update();
    },
    onResult(result) {
      busy = false;
      if (result.correct) {
        state.textContent = 'Line restored';
        setFeedback(feedback, 'good', 'The relays close. The line is live.');
        glow(machine);
      } else {
        state.textContent = 'Out of service';
        digits = [];
        setFeedback(feedback, 'bad', describeResult(result, 'The line stays dead.'));
        shake(machine);
      }
      update();
    },
    destroy() {
      clearTimeout(spinTimer);
      document.removeEventListener('keydown', onKey);
    },
  };
}

// ---- The Patch Bay ------------------------------------------------------------------

function patchBay(root, view, ctx) {
  const ringing = view.lines.filter((l) => l.lamp);
  const { machine, state, feedback } = machineShell('Patch bay', `${ringing.length} calls waiting`);
  const patches = new Map(); // line number -> trunk letter
  let holding = null;
  let busy = false;

  const bay = h('div', { class: 'bay', style: `--lines: ${view.lines.length > 8 ? Math.ceil(view.lines.length / 2) : view.lines.length}; --trunks: ${view.trunks.length}` });
  const cords = s('svg', { class: 'cords', 'aria-hidden': 'true' });
  const lineButtons = new Map();
  const trunkButtons = new Map();
  const list = h('ul', { class: 'patch-list', 'aria-label': 'Current patches' });
  const throwKey = h('button', { class: 'btn btn-lamp', type: 'button', disabled: true }, 'Throw the ringing key');
  const status = h('p', { class: 'sr-only', 'aria-live': 'polite' });

  const lines = h(
    'ol',
    { class: 'bay-lines', 'aria-label': 'Subscriber lines' },
    view.lines.map((line) => {
      const lampText = line.lamp ? `${line.lamp} lamp` : 'lamp off';
      const inner = [
        h('span', { class: 'line-num' }, String(line.number)),
        h('span', { class: 'line-lamp', 'data-color': line.lamp || 'off' }),
        h('span', { class: 'line-lamp-label' }, line.lamp ? line.lamp : 'off'),
        stampSvg(line.stamp),
        h('span', { class: 'socket' }),
      ];
      const label = `Line ${line.number}: ${lampText}, ${STAMPS[line.stamp].label} stamp${line.lamp ? ', ringing' : ''}`;
      const el = line.lamp
        ? h('button', { class: 'line-jack is-ringing', type: 'button', 'aria-label': label, 'aria-pressed': 'false', onclick: () => pickLine(line.number) }, inner)
        : h('div', { class: 'line-jack', role: 'img', 'aria-label': label }, inner);
      if (line.lamp) lineButtons.set(line.number, el);
      return h('li', {}, el);
    }),
  );

  const trunks = h(
    'ol',
    { class: 'bay-trunks', 'aria-label': 'Outgoing trunks' },
    view.trunks.map(({ letter, outOfOrder }) => {
      const el = h(
        'button',
        { class: `trunk-jack${outOfOrder ? ' is-broken' : ''}`, type: 'button', onclick: () => pickTrunk(letter) },
        h('span', { class: 'socket' }),
        h('span', { class: 'trunk-letter' }, letter),
        h('span', { class: outOfOrder ? 'ooo-tag' : 'trunk-label', 'aria-hidden': 'true' }, outOfOrder ? 'Out of order' : 'trunk'),
      );
      el.dataset.broken = outOfOrder ? 'true' : '';
      trunkButtons.set(letter, el);
      return h('li', {}, el);
    }),
  );

  bay.append(lines, trunks, cords);

  const say = (text) => (status.textContent = text);
  const lineOnTrunk = (letter) => {
    for (const [line, t] of patches) if (t === letter) return line;
    return null;
  };

  function pickLine(number) {
    if (busy) return;
    if (holding === number) {
      holding = null;
      say(`Line ${number} put down.`);
    } else {
      if (patches.has(number)) {
        patches.delete(number);
        ctx.audio.play('unplug');
      }
      holding = number;
      ctx.audio.play('click');
      say(`Line ${number} cord lifted. Choose a trunk.`);
    }
    render();
  }

  function pickTrunk(letter) {
    if (busy) return;
    const occupant = lineOnTrunk(letter);
    if (holding == null) {
      if (occupant != null) {
        patches.delete(occupant);
        ctx.audio.play('unplug');
        say(`Unplugged line ${occupant} from trunk ${letter}.`);
        render();
      } else {
        say('Pick a ringing line first, then a trunk.');
        setFeedback(feedback, '', 'Pick a lit line first, then a trunk.');
      }
      return;
    }
    if (occupant != null && occupant !== holding) patches.delete(occupant);
    patches.set(holding, letter);
    lastPatched = holding;
    say(`Line ${holding} patched to trunk ${letter}.${occupant != null && occupant !== holding ? ` Line ${occupant} was unplugged.` : ''}`);
    holding = null;
    ctx.audio.play('plug');
    feedback.textContent = '';
    render();
  }

  function drawCords() {
    while (cords.firstChild) cords.firstChild.remove();
    const box = bay.getBoundingClientRect();
    cords.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    const centre = (el) => {
      const r = el.querySelector('.socket').getBoundingClientRect();
      return [r.left + r.width / 2 - box.left, r.top + r.height / 2 - box.top];
    };
    ringing.forEach((line, i) => {
      const trunk = patches.get(line.number);
      if (!trunk) return;
      const [x1, y1] = centre(lineButtons.get(line.number));
      const [x2, y2] = centre(trunkButtons.get(trunk));
      const sag = Math.max(40, Math.abs(x2 - x1) * 0.25);
      const path = s('path', {
        d: `M${x1} ${y1}C${x1} ${y1 + sag} ${x2} ${y2 + sag * 0.4} ${x2} ${y2}`,
        stroke: CORD_COLOURS[i % CORD_COLOURS.length],
        class: line.number === lastPatched ? 'is-new' : null,
      });
      cords.append(path);
    });
    lastPatched = null;
  }
  let lastPatched = null;

  function render() {
    for (const [number, el] of lineButtons) {
      el.classList.toggle('is-selected', holding === number);
      el.classList.toggle('is-patched', patches.has(number));
      el.setAttribute('aria-pressed', String(holding === number));
    }
    for (const [letter, el] of trunkButtons) {
      const occupant = lineOnTrunk(letter);
      const broken = el.dataset.broken ? ', tagged out of order' : '';
      el.setAttribute('aria-label', occupant != null ? `Trunk ${letter}${broken}, line ${occupant} plugged in` : `Trunk ${letter}${broken}, empty`);
    }
    bay.classList.toggle('is-holding', holding != null);
    while (list.firstChild) list.firstChild.remove();
    for (const line of ringing) {
      const trunk = patches.get(line.number);
      if (!trunk) continue;
      list.append(
        h(
          'li',
          {},
          `Line ${line.number} to trunk ${trunk}`,
          h(
            'button',
            {
              class: 'btn-text',
              type: 'button',
              'aria-label': `Unplug line ${line.number}`,
              onclick: () => {
                patches.delete(line.number);
                ctx.audio.play('unplug');
                say(`Line ${line.number} unplugged.`);
                render();
              },
            },
            'Unplug',
          ),
        ),
      );
    }
    const left = ringing.filter((l) => !patches.has(l.number)).length;
    state.textContent = left ? `${left} ${left === 1 ? 'call' : 'calls'} waiting` : 'All calls patched';
    throwKey.disabled = busy || left > 0;
    drawCords();
  }

  throwKey.addEventListener('click', () => {
    if (busy) return;
    if (!ctx.submit(Object.fromEntries(patches))) return;
    busy = true;
    ctx.audio.play('relay');
    render();
  });

  const observer = new ResizeObserver(() => drawCords());
  observer.observe(bay);

  machine.append(
    bay,
    list,
    h('div', { class: 'machine-actions' }, throwKey),
    h('p', { class: 'kbd-hint' }, 'Select a lit line, then the trunk it should go to. Select a patched line again to move its cord.'),
    status,
    feedback,
  );
  root.append(h('p', { class: 'task' }, 'Tell your Operator about each lit line: its number, lamp colour and stamped shape. Patch each one where they say.'), machine);
  render();

  return {
    setBusy(value) {
      busy = value;
      render();
    },
    onResult(result) {
      busy = false;
      if (result.correct) {
        setFeedback(feedback, 'good', 'Every call connects at once.');
        glow(machine);
      } else {
        setFeedback(feedback, 'bad', describeResult(result, 'The calls drop. Check the routing.'));
        shake(machine);
      }
      render();
    },
    destroy() {
      observer.disconnect();
    },
  };
}

// ---- The Teleprinter ----------------------------------------------------------------

function teleprinter(root, view, ctx) {
  const { machine, state, feedback } = machineShell('Teleprinter', 'Waiting for a reply');
  let busy = false;
  const reelText = `${view.reel === 'feed' ? 'FEED' : 'REWOUND'}${view.shift ? ` · SHIFT ${view.shift}` : ''}`;

  const tape = h(
    'ol',
    { class: 'tape', 'aria-label': 'Punched tape, read column by column from row 1 at the top' },
    h(
      'li',
      { class: 'tape-rows', 'aria-hidden': 'true' },
      [1, 2, 3, 4, 5].map((n) =>
        h('span', {}, String(n), n === view.topRow ? h('b', { class: `top-mark${view.topRow === 5 ? ' is-flipped' : ''}` }, '▲ TOP') : null),
      ),
      h('span', { class: 'tape-colnum' }, 'row'),
    ),
    view.columns.map((bits, i) =>
      h(
        'li',
        { class: 'tape-col', 'aria-label': `Column ${i + 1}: ${bits.map((b) => (b ? 'hole' : 'blank')).join(', ')}` },
        bits.map((b) => h('span', { class: `hole ${b ? 'is-punched' : 'is-blank'}`, 'aria-hidden': 'true' })),
        h('span', { class: 'tape-colnum', 'aria-hidden': 'true' }, String(i + 1)),
      ),
    ),
  );

  const { form, input, send } = letterForm({
    letters: view.letters,
    label: `Type the ${view.letters}-letter name`,
    button: 'Send',
    ctx,
    help: 'tty-help',
    onSubmit(value) {
      if (busy) return;
      if (value.length !== view.letters) {
        setFeedback(feedback, 'bad', `The teleprinter needs exactly ${view.letters} letters.`);
        input.focus();
        return;
      }
      if (!ctx.submit(value)) return;
      busy = true;
      send.disabled = true;
      state.textContent = 'Transmitting…';
    },
  });

  machine.append(
    h(
      'div',
      { class: 'tty' },
      h(
        'div',
        { class: 'tty-top' },
        h('div', { class: 'reel', role: 'img', 'aria-label': `Tape reel labelled ${reelText.replace('·', ',')}` }, h('span', { class: 'reel-label', 'aria-hidden': 'true' }, reelText)),
        h(
          'div',
          {},
          h('p', {}, 'The reel label reads ', h('strong', {}, reelText), '.'),
          h('p', { class: 'kbd-hint is-left' }, `A ▲ TOP mark is printed beside row ${view.topRow} of the tape.`),
        ),
      ),
      h('div', { class: 'tape-wrap' }, tape),
      h('p', { class: 'kbd-hint', id: 'tty-help' }, 'Dark circles are holes. Dashed rings are blank. Row 1 is at the top.'),
      form,
    ),
    feedback,
  );
  root.append(h('p', { class: 'task' }, 'Read the tape to your Operator, column by column, and tell them what the reel says. Type the name they decode.'), machine);

  return {
    setBusy(value) {
      busy = value;
      send.disabled = value;
      if (!value) state.textContent = 'Waiting for a reply';
    },
    onResult(result) {
      busy = false;
      send.disabled = false;
      if (result.correct) {
        state.textContent = 'Connected';
        setFeedback(feedback, 'good', 'Someone on the other end takes a breath.');
        glow(machine);
      } else {
        state.textContent = 'Waiting for a reply';
        setFeedback(feedback, 'bad', describeResult(result, 'The teleprinter prints: NO SUCH PARTY.'));
        shake(machine);
        input.select();
      }
    },
    destroy() {},
  };
}

// ---- The Party Line -----------------------------------------------------------------

function cadenceMarks(cadence) {
  return h(
    'span',
    { class: 'cadence', 'aria-hidden': 'true' },
    [...cadence].map((c) => h('i', { class: c === 'L' ? 'long' : 'short' })),
  );
}

function partyLine(root, view, ctx) {
  const { machine, state, feedback } = machineShell('Party line', 'Waiting to ring back');
  let order = [];
  let busy = false;
  let playing = null;

  const lamp = h('span', { class: 'ringer-lamp', 'aria-hidden': 'true' });
  const playBtn = h('button', { class: 'btn', type: 'button' }, 'Play the rings');
  const log = h(
    'ol',
    { class: 'ring-log', 'aria-label': 'Ring log, in the order the rings came in' },
    view.rings.map((ring, i) =>
      h(
        'li',
        { class: `ring${ring.echo ? ' is-echo' : ''}${ring.trunk ? ' is-trunk' : ''}` },
        h('span', { class: 'ring-num' }, String(i + 1)),
        cadenceMarks(ring.cadence),
        h('span', { class: 'ring-words' }, describeCadence(ring.cadence)),
        ring.echo ? h('span', { class: 'ring-tag' }, 'dim') : null,
        ring.trunk ? h('span', { class: 'ring-tag is-star' }, '✱ marked') : null,
      ),
    ),
  );

  const seq = h('ol', { class: 'callback-seq', 'aria-label': 'Ring-back order so far', 'aria-live': 'polite' });
  const keys = new Map();
  const keyRow = h(
    'div',
    { class: 'household-keys', role: 'group', 'aria-label': 'Household keys' },
    view.households.map((name) => {
      const key = h('button', { class: 'household-key', type: 'button', onclick: () => press(name) }, name);
      keys.set(name, key);
      return key;
    }),
  );
  const undo = h('button', { class: 'btn', type: 'button' }, 'Undo');
  const clearBtn = h('button', { class: 'btn-text', type: 'button' }, 'Clear');
  const ringBack = h('button', { class: 'btn btn-lamp', type: 'button', disabled: true }, 'Ring back');

  function press(name) {
    if (busy || order.includes(name)) return;
    order.push(name);
    ctx.audio.play('key');
    render();
  }
  function render() {
    while (seq.firstChild) seq.firstChild.remove();
    if (!order.length) seq.append(h('li', { class: 'seq-empty' }, 'Press household keys in the order your Operator gives.'));
    order.forEach((name) => seq.append(h('li', {}, name)));
    for (const [name, key] of keys) {
      const pos = order.indexOf(name);
      key.disabled = busy || pos >= 0;
      key.setAttribute('aria-label', pos >= 0 ? `${name}, ring-back number ${pos + 1}` : name);
    }
    undo.disabled = busy || !order.length;
    ringBack.disabled = busy || !order.length;
  }
  undo.addEventListener('click', () => {
    order.pop();
    render();
  });
  clearBtn.addEventListener('click', () => {
    order = [];
    render();
  });
  ringBack.addEventListener('click', () => {
    if (busy || !order.length) return;
    if (!ctx.submit([...order])) return;
    busy = true;
    state.textContent = 'Ringing back…';
    ctx.audio.play('ring');
    render();
  });

  // Replays the log on the ringer lamp, with sound. The written log is always there too.
  playBtn.addEventListener('click', () => {
    clearTimeout(playing);
    let i = 0;
    const next = () => {
      log.querySelectorAll('.ring').forEach((el) => el.classList.remove('is-playing'));
      if (i >= view.rings.length) {
        lamp.className = 'ringer-lamp';
        return;
      }
      const ring = view.rings[i];
      log.children[i].classList.add('is-playing');
      lamp.className = `ringer-lamp is-on${ring.echo ? ' is-dim' : ''}`;
      lamp.style.setProperty('--pattern', `"${ring.cadence}"`);
      ctx.audio.play('cadence', { pattern: ring.cadence, channel: 'ringer' });
      const length = [...ring.cadence].reduce((t, c) => t + (c === 'L' ? 730 : 380), 0);
      i++;
      playing = setTimeout(next, length + 600);
    };
    next();
  });

  machine.append(
    h(
      'div',
      { class: 'party' },
      h('div', { class: 'ringer' }, lamp, h('div', {}, h('p', { class: 'ringer-title' }, 'Ringer log'), h('p', { class: 'kbd-hint is-left' }, '▬ is a long ring, ● a short one.')), playBtn),
      log,
      h('div', { class: 'callback' }, h('p', { class: 'engraved' }, 'Ring-back keys'), keyRow, seq, h('div', { class: 'machine-actions' }, clearBtn, undo, ringBack)),
    ),
    feedback,
  );
  root.append(h('p', { class: 'task' }, 'Read the ring log to your Operator: each ring’s pattern of long and short, in order. Press the household keys in the order they give.'), machine);
  render();

  return {
    setBusy(value) {
      busy = value;
      if (!value) state.textContent = 'Waiting to ring back';
      render();
    },
    onResult(result) {
      busy = false;
      if (result.correct) {
        state.textContent = 'Every household answered';
        setFeedback(feedback, 'good', 'Every household picks up, one after another.');
        glow(machine);
      } else {
        state.textContent = 'Waiting to ring back';
        setFeedback(feedback, 'bad', describeResult(result, 'The wrong houses answer, puzzled, and hang up.'));
        shake(machine);
        order = [];
      }
      render();
    },
    destroy() {
      clearTimeout(playing);
      ctx.audio.stop('ringer');
    },
  };
}

// ---- The Relay Rack -----------------------------------------------------------------

function relayRack(root, view, ctx) {
  const { machine, state, feedback } = machineShell('Relay rack', 'Faults showing');
  let positions = view.relays.map((r) => r.up);
  let busy = false;

  const lamps = h(
    'ol',
    { class: 'fault-lamps', 'aria-label': 'Fault lamps' },
    view.lamps.map((l) =>
      h(
        'li',
        { class: `fault${l.lit ? ' is-lit' : ''}` },
        h('span', { class: 'fault-lamp', 'aria-hidden': 'true' }),
        h('span', { class: 'fault-letter' }, l.letter),
        h('span', { class: 'fault-state' }, l.lit ? 'lit' : 'off'),
      ),
    ),
  );
  const buttons = view.relays.map((r, i) =>
    h(
      'button',
      { class: 'relay', type: 'button', 'data-cap': r.cap, onclick: () => toggle(i) },
      h('span', { class: 'relay-num' }, String(r.number)),
      h('span', { class: 'relay-cap', 'aria-hidden': 'true' }),
      h('span', { class: 'relay-cap-name' }, CAPS[r.cap].label),
      h('span', { class: 'relay-lever', 'aria-hidden': 'true' }, h('i', {})),
      h('span', { class: 'relay-pos' }),
    ),
  );
  const rack = h('ol', { class: 'relays', 'aria-label': 'Relays', style: `--relays: ${view.relays.length}` }, buttons.map((b) => h('li', {}, b)));
  const restore = h('button', { class: 'btn-text', type: 'button' }, 'Put every relay back as found');
  const submitBtn = h('button', { class: 'btn btn-lamp', type: 'button' }, 'Press the reset bar');

  function toggle(i) {
    if (busy) return;
    positions[i] = !positions[i];
    ctx.audio.play('toggle', { up: positions[i] });
    render();
  }
  function render() {
    buttons.forEach((b, i) => {
      const up = positions[i];
      const r = view.relays[i];
      b.classList.toggle('is-up', up);
      b.setAttribute('aria-pressed', String(up));
      b.setAttribute('aria-label', `Relay ${r.number}, ${CAPS[r.cap].label} cap, ${up ? 'up' : 'down'}`);
      b.querySelector('.relay-pos').textContent = up ? 'Up' : 'Down';
      b.disabled = busy;
    });
    const changed = positions.filter((p, i) => p !== view.relays[i].up).length;
    state.textContent = changed ? `${changed} ${changed === 1 ? 'relay' : 'relays'} moved` : 'As found';
    submitBtn.disabled = busy;
    restore.disabled = busy || !changed;
  }
  restore.addEventListener('click', () => {
    positions = view.relays.map((r) => r.up);
    ctx.audio.play('unplug');
    render();
  });
  submitBtn.addEventListener('click', () => {
    if (busy) return;
    if (!ctx.submit(positions.map((up) => (up ? 'U' : 'D')).join(''))) return;
    busy = true;
    ctx.audio.play('relay');
    render();
  });

  machine.append(
    h('div', { class: 'rack' }, h('div', { class: 'fault-panel' }, h('p', { class: 'engraved' }, 'Fault lamps'), lamps), rack),
    h('div', { class: 'machine-actions' }, restore, submitBtn),
    h('p', { class: 'kbd-hint' }, 'Select a relay to flip it up or down.'),
    feedback,
  );
  root.append(h('p', { class: 'task' }, 'Tell your Operator which fault lamps are lit and how each relay looks. Flip the relays as they instruct, then press the reset bar.'), machine);
  render();

  return {
    setBusy(value) {
      busy = value;
      render();
    },
    onResult(result) {
      busy = false;
      if (result.correct) {
        state.textContent = 'Faults cleared';
        setFeedback(feedback, 'good', 'The fault lamps go out, one by one.');
        glow(machine);
      } else {
        setFeedback(feedback, 'bad', describeResult(result, 'The fault lamps flare. The rack is not right yet.'));
        shake(machine);
      }
      render();
    },
    destroy() {},
  };
}

// ---- The Cipher Wheel ---------------------------------------------------------------

function cipherWheel(root, view, ctx) {
  const { machine, state, feedback } = machineShell('Telegraph desk', 'Awaiting reply');
  let busy = false;

  const n = view.wheel.length;
  const turn = view.wheel.indexOf(view.pointer);
  const C = 130;
  const wheel = s(
    'svg',
    { class: 'wheel-svg', viewBox: '0 0 260 260', 'aria-hidden': 'true' },
    s('circle', { class: 'wheel-rim', cx: C, cy: C, r: 124 }),
    s('circle', { class: 'wheel-inner', cx: C, cy: C, r: 70 }),
    view.wheel.map((glyph, i) => {
      const angle = ((i - turn) * 2 * Math.PI) / n - Math.PI / 2;
      const x = C + 97 * Math.cos(angle) - 20;
      const y = C + 97 * Math.sin(angle) - 20;
      const g = glyphSvg(glyph);
      g.setAttribute('x', String(x));
      g.setAttribute('y', String(y));
      g.setAttribute('width', '40');
      g.setAttribute('height', '40');
      if (i === turn) g.classList.add('is-pointed');
      return g;
    }),
    s('path', { class: 'wheel-pointer', d: `M${C - 11} 2h22l-11 20z` }),
    s('text', { class: 'wheel-hub', x: C, y: C + 6 }, 'CIPHER'),
  );

  const stamps = h(
    'div',
    { class: 'stamps', 'aria-label': view.stamps ? `${view.stamps} postage stamp${view.stamps === 1 ? '' : 's'}` : 'No postage stamps', role: 'img' },
    Array.from({ length: view.stamps }, () => h('span', { class: 'stamp-paper', 'aria-hidden': 'true' }, '7d')),
  );

  const { form, input, send } = letterForm({
    letters: view.cipher.length,
    label: `Type the ${view.cipher.length}-letter word`,
    button: 'Send reply',
    ctx,
    help: 'cipher-help',
    onSubmit(value) {
      if (busy) return;
      if (value.length !== view.cipher.length) {
        setFeedback(feedback, 'bad', `The reply needs ${view.cipher.length} letters.`);
        input.focus();
        return;
      }
      if (!ctx.submit(value)) return;
      busy = true;
      send.disabled = true;
      state.textContent = 'Transmitting…';
    },
  });

  machine.append(
    h(
      'div',
      { class: 'cipher' },
      h(
        'section',
        { class: 'telegram', 'aria-label': 'Telegram' },
        h('div', { class: 'telegram-head' }, h('span', { class: 'telegram-word' }, 'Telegram'), stamps),
        h('p', { class: 'telegram-count' }, view.stamps ? `${view.stamps} stamp${view.stamps === 1 ? '' : 's'}` : 'No stamps'),
        h(
          'p',
          { class: 'cipher-text', 'aria-label': `Enciphered letters: ${[...view.cipher].join(' ')}` },
          [...view.cipher].map((ch) => h('span', { 'aria-hidden': 'true' }, ch)),
          h('span', { class: 'stop', 'aria-hidden': 'true' }, 'STOP'),
        ),
      ),
      h(
        'figure',
        { class: 'wheel' },
        h('div', { class: 'wheel-frame', role: 'img', 'aria-label': `Cipher wheel. The pointer rests on ${GLYPHS[view.pointer].description}.` }, wheel),
        h(
          'figcaption',
          {},
          h('span', { class: 'pointer-window', 'aria-hidden': 'true' }, glyphSvg(view.pointer)),
          h('span', {}, 'Under the pointer'),
        ),
      ),
    ),
    h('p', { class: 'kbd-hint', id: 'cipher-help' }, 'Spell the telegram to your Operator and describe the glyph under the pointer.'),
    form,
    feedback,
  );
  root.append(h('p', { class: 'task' }, 'Describe the pointer’s glyph and spell out the telegram. Your Operator decodes it; type their word and send it.'), machine);

  return {
    setBusy(value) {
      busy = value;
      send.disabled = value;
      if (!value) state.textContent = 'Awaiting reply';
    },
    onResult(result) {
      busy = false;
      send.disabled = false;
      if (result.correct) {
        state.textContent = 'Delivered';
        setFeedback(feedback, 'good', 'The telegraph sounder clatters: MESSAGE RECEIVED.');
        glow(machine);
      } else {
        state.textContent = 'Awaiting reply';
        setFeedback(feedback, 'bad', describeResult(result, 'The sounder taps back: NOT UNDERSTOOD.'));
        shake(machine);
        input.select();
      }
    },
    destroy() {},
  };
}

const RENDERERS = {
  'dead-line': deadLine,
  'patch-bay': patchBay,
  teleprinter,
  'party-line': partyLine,
  'relay-rack': relayRack,
  'cipher-wheel': cipherWheel,
};

export function renderCaller(root, puzzle, ctx) {
  const render = RENDERERS[puzzle.view.kind];
  if (!render) {
    root.append(h('p', {}, 'This machine is not recognised. Reload the page.'));
    return { onResult() {}, setBusy() {}, destroy() {} };
  }
  announce(`${puzzle.title}. ${puzzle.view.intro}`);
  return render(root, puzzle.view, ctx);
}
