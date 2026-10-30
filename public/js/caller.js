// The Caller's view: machines rendered from the role-specific puzzle data.
// Each renderer returns a controller: { onResult(result), setBusy(bool), destroy() }.

import { GLYPHS, STAMPS, glyphSvg, stampSvg } from './art.js';
import { h, s, announce, prefersReducedMotion } from './dom.js';

const NUMERALS = ['I', 'II', 'III', 'IV'];
const DIAL_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
const CORD_COLOURS = ['#b5483b', '#3f8a73', '#5566b8'];

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

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

function describeResult(result, fallback) {
  const parts = [fallback];
  if (result.feedback) parts.push(`${result.feedback.matched} of ${result.feedback.total} ${result.feedback.unit} held.`);
  if (result.penaltyMs) parts.push(`The clock lost ${result.penaltyMs / 1000} seconds.`);
  return parts.join(' ');
}

// ---- 1. The Dead Line ----------------------------------------------------------

function deadLine(root, view, ctx) {
  const { machine, state, feedback } = machineShell('Line 7', 'Out of service');
  let digits = [];
  let busy = false;

  const boxes = h('div', { class: 'dialled', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => h('span', {}, '·')));
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
    dial.append(
      h('button', {
        class: 'dial-hole',
        type: 'button',
        'aria-label': `Dial ${d}`,
        onclick: () => dialDigit(d),
      }),
    );
    const btn = dial.lastChild;
    btn.style.setProperty('left', `${(x / 280) * 100}%`);
    btn.style.setProperty('top', `${(y / 280) * 100}%`);
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
    lever.disabled = busy || digits.length !== 4;
    dialledText.textContent = digits.length ? `Dialled ${digits.join(' ')}` : 'Dial cleared';
  }

  function dialDigit(d) {
    if (busy) return;
    if (digits.length >= 4) {
      feedback.className = 'feedback';
      feedback.textContent = 'Four digits dialled. Pull the lever, or hang up to start again.';
      return;
    }
    digits.push(d);
    spin(d);
    feedback.textContent = '';
    update();
  }

  function submit() {
    if (busy || digits.length !== 4) return;
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
    if (isTyping(document.activeElement) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.querySelector('.overlay:not([hidden])')) return;
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      dialDigit(Number(e.key));
    } else if (e.key === 'Backspace' && digits.length) {
      e.preventDefault();
      digits.pop();
      update();
    } else if (e.key === 'Enter' && digits.length === 4 && document.activeElement === document.body) {
      e.preventDefault();
      submit();
    }
  }
  document.addEventListener('keydown', onKey);

  const lamp = h('div', {
    class: 'signal-lamp',
    'data-color': view.lamp,
    role: 'img',
    'aria-label': `Signal lamp, glowing ${view.lamp}`,
  });

  machine.append(
    h(
      'div',
      { class: 'deadline' },
      h('div', { class: 'signal' }, lamp, h('p', { class: 'signal-caption', 'aria-hidden': 'true' }, 'Signal lamp: ', h('strong', {}, view.lamp))),
      h(
        'ol',
        { class: 'plates', 'aria-label': 'Glyph plates, left to right' },
        view.plates.map((id, i) =>
          h(
            'li',
            { class: 'plate' },
            h('div', { class: 'plate-face' }, glyphSvg(id, { label: `Plate ${NUMERALS[i]}: ${GLYPHS[id].description}` })),
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
  root.append(
    h('p', { class: 'task' }, 'Describe the four plates and the lamp to your Operator. Dial the number they give you, then pull the lever.'),
    machine,
  );
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
        feedback.className = 'feedback is-good';
        feedback.textContent = 'The relays close. Line 7 is live.';
      } else {
        state.textContent = 'Out of service';
        digits = [];
        feedback.className = 'feedback is-bad';
        feedback.textContent = describeResult(result, 'The line stays dead.');
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

// ---- 2. The Patch Bay ------------------------------------------------------------

function patchBay(root, view, ctx) {
  const { machine, state, feedback } = machineShell('Patch bay', 'Three calls waiting');
  const ringing = view.lines.filter((l) => l.lamp);
  const patches = new Map(); // line number -> trunk letter
  let holding = null;
  let busy = false;

  const bay = h('div', { class: 'bay' });
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
    view.trunks.map((letter) => {
      const el = h(
        'button',
        { class: 'trunk-jack', type: 'button', 'aria-label': `Trunk ${letter}`, onclick: () => pickTrunk(letter) },
        h('span', { class: 'socket' }),
        h('span', { class: 'trunk-letter' }, letter),
        h('span', { class: 'trunk-label', 'aria-hidden': 'true' }, 'trunk'),
      );
      trunkButtons.set(letter, el);
      return h('li', {}, el);
    }),
  );

  bay.append(lines, trunks, cords);

  function say(text) {
    status.textContent = text;
  }

  function lineOnTrunk(letter) {
    for (const [line, t] of patches) if (t === letter) return line;
    return null;
  }

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
      say(`Line ${number} cord lifted. Choose a trunk, A to F.`);
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
        feedback.className = 'feedback';
        feedback.textContent = 'Pick a lit line first, then a trunk.';
      }
      return;
    }
    if (occupant != null && occupant !== holding) {
      patches.delete(occupant);
    }
    patches.set(holding, letter);
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
      cords.append(
        s('path', {
          d: `M${x1} ${y1}C${x1} ${y1 + sag} ${x2} ${y2 + sag * 0.4} ${x2} ${y2}`,
          stroke: CORD_COLOURS[i % CORD_COLOURS.length],
        }),
      );
    });
  }

  function render() {
    for (const [number, el] of lineButtons) {
      el.classList.toggle('is-selected', holding === number);
      el.classList.toggle('is-patched', patches.has(number));
      el.setAttribute('aria-pressed', String(holding === number));
    }
    for (const [letter, el] of trunkButtons) {
      const occupant = lineOnTrunk(letter);
      el.setAttribute('aria-label', occupant != null ? `Trunk ${letter}, line ${occupant} plugged in` : `Trunk ${letter}, empty`);
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
    const answer = Object.fromEntries(patches);
    if (!ctx.submit(answer)) return;
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
  root.append(
    h('p', { class: 'task' }, 'Tell your Operator about each lit line: its number, lamp colour and stamped shape. Patch each one where they say.'),
    machine,
  );
  render();

  return {
    setBusy(value) {
      busy = value;
      render();
    },
    onResult(result) {
      busy = false;
      if (result.correct) {
        feedback.className = 'feedback is-good';
        feedback.textContent = 'Every call connects at once.';
      } else {
        feedback.className = 'feedback is-bad';
        feedback.textContent = describeResult(result, 'The calls drop. Check the routing.');
        shake(machine);
      }
      render();
    },
    destroy() {
      observer.disconnect();
    },
  };
}

// ---- 3. The Last Call ------------------------------------------------------------

function lastCall(root, view, ctx) {
  const { machine, state, feedback } = machineShell('Teleprinter', 'Waiting for a reply');
  let busy = false;
  const label = view.reel === 'feed' ? 'FEED →' : '← REWOUND';

  const tape = h(
    'ol',
    { class: 'tape', 'aria-label': 'Punched tape, read column by column from row 1 at the top' },
    h(
      'li',
      { class: 'tape-rows', 'aria-hidden': 'true' },
      [1, 2, 3, 4, 5].map((n) => h('span', {}, String(n))),
      h('span', { class: 'tape-colnum' }, 'row'),
    ),
    view.columns.map((bits, i) =>
      h(
        'li',
        {
          class: 'tape-col',
          'aria-label': `Column ${i + 1}: ${bits.map((b) => (b ? 'hole' : 'blank')).join(', ')}`,
        },
        bits.map((b) => h('span', { class: `hole ${b ? 'is-punched' : 'is-blank'}`, 'aria-hidden': 'true' })),
        h('span', { class: 'tape-colnum', 'aria-hidden': 'true' }, String(i + 1)),
      ),
    ),
  );

  const input = h('input', {
    class: 'tty-input',
    name: 'name',
    maxlength: 5,
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    placeholder: '·····',
    'aria-describedby': 'tty-help',
  });
  const send = h('button', { class: 'btn btn-lamp', type: 'submit' }, 'Send');
  const form = h(
    'form',
    { class: 'tty-form', novalidate: true },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Type the name'), input),
    send,
  );
  input.addEventListener('input', () => {
    const clean = input.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
    if (clean !== input.value) input.value = clean;
    ctx.audio.play('key');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const value = input.value.trim();
    if (value.length !== 5) {
      feedback.className = 'feedback is-bad';
      feedback.textContent = 'The teleprinter needs exactly five letters.';
      input.focus();
      return;
    }
    if (!ctx.submit(value)) return;
    busy = true;
    send.disabled = true;
    state.textContent = 'Transmitting…';
  });

  machine.append(
    h(
      'div',
      { class: 'tty' },
      h(
        'div',
        { class: 'tty-top' },
        h('div', { class: 'reel', role: 'img', 'aria-label': `Tape reel labelled ${view.reel === 'feed' ? 'FEED' : 'REWOUND'}` }, h('span', { class: 'reel-label', 'aria-hidden': 'true' }, label)),
        h('p', {}, 'The reel label reads ', h('strong', {}, view.reel === 'feed' ? 'FEED' : 'REWOUND'), '.'),
      ),
      h('div', { class: 'tape-wrap' }, tape),
      h('p', { class: 'kbd-hint', id: 'tty-help' }, 'Dark circles are holes. Dashed rings are blank. Row 1 is at the top.'),
      form,
    ),
    feedback,
  );
  root.append(
    h('p', { class: 'task' }, 'Read the tape to your Operator, column by column. Type the name they decode and send it.'),
    machine,
  );

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
        feedback.className = 'feedback is-good';
        feedback.textContent = 'Someone on the other end takes a breath.';
      } else {
        state.textContent = 'Waiting for a reply';
        feedback.className = 'feedback is-bad';
        feedback.textContent = describeResult(result, 'The teleprinter prints: NO SUCH PARTY.');
        shake(machine);
        input.select();
      }
    },
    destroy() {},
  };
}

const RENDERERS = { 'dead-line': deadLine, 'patch-bay': patchBay, 'last-call': lastCall };

export function renderCaller(root, puzzle, ctx) {
  const render = RENDERERS[puzzle.view.kind];
  if (!render) {
    root.append(h('p', {}, 'This machine is not recognised. Reload the page.'));
    return { onResult() {}, setBusy() {}, destroy() {} };
  }
  announce(`${puzzle.title}. ${puzzle.view.intro}`);
  return render(root, puzzle.view, ctx);
}
