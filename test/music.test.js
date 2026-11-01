// The score (public/js/music.js), run in Node against a fake Web Audio API.
// These pin down what makes background music wear on a long session: notes
// that start or stop abruptly, passages that repeat, a stalled page bunching
// missed bars together, and a countdown that churns the sound graph.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeParam {
  constructor(value) {
    this.value = value;
    this.events = [];
  }
  record(type, value, time, extra = {}) {
    if (!Number.isFinite(value) || !Number.isFinite(time)) throw new TypeError(`non-finite ${type}`);
    this.events.push({ type, value, time, ...extra });
    return this;
  }
  setValueAtTime(v, t) {
    return this.record('set', v, t);
  }
  linearRampToValueAtTime(v, t) {
    return this.record('linear', v, t);
  }
  exponentialRampToValueAtTime(v, t) {
    if (!(v > 0)) throw new RangeError('exponential ramp to zero');
    return this.record('exp', v, t);
  }
  setTargetAtTime(v, t, c) {
    if (!(c > 0)) throw new RangeError('time constant must be positive');
    return this.record('target', v, t, { c });
  }
}
class FakeNode {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.nodes.push(this);
  }
  connect(target) {
    return target;
  }
}
class FakeSource extends FakeNode {
  start(t = 0) {
    this.startedAt = t;
    this.ctx.started.push(this);
  }
  stop(t) {
    this.stopAt = t;
  }
}
class FakeContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48_000;
    this.nodes = [];
    this.started = [];
  }
  createGain() {
    return Object.assign(new FakeNode(this), { gain: new FakeParam(1) });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(this), { frequency: new FakeParam(350), Q: new FakeParam(1), type: 'lowpass' });
  }
  createOscillator() {
    return Object.assign(new FakeSource(this), { frequency: new FakeParam(440), detune: new FakeParam(0), type: 'sine' });
  }
  createBufferSource() {
    return Object.assign(new FakeSource(this), { loop: false });
  }
}

const { BPM, MOODS, Score } = await import('../public/js/music.js');
const BAR = (60 / BPM) * 4;

/** A deterministic random source: the same seed plays the same score. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function play({ seconds, mood = 'menu', seed = 1, intensity = 0 }) {
  const ctx = new FakeContext();
  const record = [];
  const score = new Score(ctx, { out: ctx.createGain(), mood, intensity, rng: seeded(seed), record });
  score.start(0);
  score.scheduleUntil(seconds);
  return { ctx, score, record };
}

test('every voice fades in and out: no note starts or stops at full level', () => {
  const { ctx, score } = play({ seconds: 120, mood: 'game', intensity: 0.8 });
  // Every enveloped voice; the score's own fade-in busses rise once and stay up.
  const gains = ctx.nodes.filter((n) => n.gain && n.gain.events.length && n !== score.main && n !== score.low);
  assert.ok(gains.length > 40, 'many enveloped voices');
  for (const g of gains) {
    const first = g.gain.events[0];
    assert.equal(first.value, 0, 'starts from silence');
    const rises = g.gain.events.filter((e) => e.value > 0);
    assert.ok(rises.every((e) => e.type === 'target' || e.type === 'linear'), 'rises are ramps, never jumps');
    const last = g.gain.events[g.gain.events.length - 1];
    assert.ok(last.type === 'target' && last.value === 0, 'ends by fading to silence');
    const stops = g.gain.events.filter((e) => e.value === 0 && e.type === 'target');
    assert.ok(stops.length, 'has a release');
  }
  // Every oscillator stops after its envelope has had time to fall silent.
  for (const s of ctx.started) assert.ok(s.stopAt > s.startedAt + 0.5, `voice runs ${s.stopAt - s.startedAt}s`);
});

test('a long session never hears a passage twice: progressions and phrases keep changing', () => {
  const { record } = play({ seconds: 30 * 60 });
  const chords = record.filter((e) => e.layer === 'chord').map((e) => e.note);
  assert.ok(chords.length >= 100, `${chords.length} chords in half an hour`);
  // Sections of four chords: no section is the same as the one before it.
  const sections = [];
  for (let i = 0; i + 4 <= chords.length; i += 4) sections.push(chords.slice(i, i + 4).join(' '));
  for (let i = 1; i < sections.length; i++) assert.notEqual(sections[i], sections[i - 1], `section ${i} repeats its predecessor`);
  assert.ok(new Set(sections).size >= 4, 'several different progressions are used');
  // The bell's phrases: at least five distinct shapes, with rests between some sections.
  const bells = record.filter((e) => e.layer === 'bell');
  const byBar = new Map();
  for (const b of bells) {
    const bar = Math.floor(b.t / BAR);
    byBar.set(bar, [...(byBar.get(bar) || []), b.note]);
  }
  const shapes = new Set([...byBar.values()].map((notes) => notes.map((n, i, a) => (i ? n - a[i - 1] : 0)).join(',')));
  assert.ok(shapes.size >= 5, `${shapes.size} phrase shapes`);
  const silentBars = sections.length * 8 - byBar.size;
  assert.ok(silentBars > sections.length, 'the bell rests often');
});

test('the mood changes the music without a seam: levels glide, the next section plays in the new mood', () => {
  const { ctx, score, record } = play({ seconds: 20 });
  score.setMood('game', 20);
  assert.equal(score.padFilter.frequency.events.at(-1).type, 'target', 'brightness glides');
  score.scheduleUntil(80);
  const after = record.filter((e) => e.layer === 'chord' && e.t >= 20);
  assert.ok(after.length >= 4);
  assert.ok(after.every((e) => e.mood === 'game'));
  // No voice was cut: nothing scheduled before the change was stopped early.
  for (const s of ctx.started.filter((s) => s.startedAt < 20)) assert.ok(s.stopAt > s.startedAt + 0.5);
  // The sounds are among the game progressions.
  const names = after.map((e) => e.note);
  assert.ok(names.every((n) => ['Am', 'Bb', 'E', 'Dm', 'F', 'G', 'C'].includes(n)));
});

test('after a stall, the score skips to the next bar instead of playing the missed ones at once', () => {
  const { ctx, score } = play({ seconds: 4 });
  ctx.currentTime = 60; // the page froze for a minute
  const before = ctx.started.length;
  score.scheduleUntil(62);
  const fresh = ctx.started.slice(before);
  assert.ok(fresh.length > 0);
  assert.ok(fresh.every((s) => s.startedAt >= 60), 'nothing scheduled in the past');
  const bars = new Set(fresh.map((s) => Math.round(s.startedAt / BAR)));
  assert.ok(bars.size <= 2, `${bars.size} bars scheduled at once`);
});

test('the countdown shapes the music bar by bar, never by automation churn', () => {
  const { ctx, score, record } = play({ seconds: 8, mood: 'game' });
  const events = () => ctx.nodes.reduce((n, node) => n + Object.values(node).filter((p) => p instanceof FakeParam).reduce((m, p) => m + p.events.length, 0), 0);
  const before = events();
  for (let i = 0; i <= 1_000; i++) score.setIntensity(i / 1_000);
  assert.equal(events(), before, 'setting the intensity changes nothing by itself');
  score.scheduleUntil(40);
  const beats = record.filter((e) => e.layer === 'heartbeat' && e.t >= 8);
  assert.ok(beats.length >= 8, 'the heartbeat plays once the countdown is pressing');
  const calm = play({ seconds: 40, mood: 'game', intensity: 0 });
  assert.equal(calm.record.filter((e) => e.layer === 'heartbeat').length, 0, 'and not at all when it is not');
});

test('levels stay a backdrop: every voice is quiet and the moods only shape the tone', () => {
  for (const mood of Object.keys(MOODS)) {
    const { ctx } = play({ seconds: 60, mood, intensity: 1 });
    const peaks = ctx.nodes.filter((n) => n.gain).map((n) => Math.max(0, ...n.gain.events.map((e) => e.value)));
    const loudest = Math.max(...peaks.filter((p) => p < 1)); // the mix and send busses sit at 1 or above
    assert.ok(loudest <= 0.08, `${mood}: loudest voice ${loudest}`);
  }
});
