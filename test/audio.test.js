// The sound engine (public/js/audio.js), run in Node against a fake Web Audio
// API. These pin down the causes of music that started late, stopped and never
// came back, overlapped itself, or got in the way of the game: sound unlocked
// on events that carry no user activation, gesture listeners removed for good
// after the first unlock, errors thrown into game code, and effects that kept
// playing (or doubled up) after the screen changed.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

class FakeParam {
  constructor(value) {
    this.value = value;
    this.events = [];
  }
  record(type, value, time, extra = {}) {
    if (!Number.isFinite(value) || !Number.isFinite(time)) throw new TypeError('The provided value is non-finite.');
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
    if (!(v > 0)) throw new RangeError('The float target value provided should not be 0.');
    return this.record('exp', v, t);
  }
  setTargetAtTime(v, t, c) {
    if (!(c > 0)) throw new RangeError('Time constant must be positive.');
    return this.record('target', v, t, { c });
  }
  cancelScheduledValues(t) {
    this.events = this.events.filter((e) => e.time < t);
    return this;
  }
  get last() {
    return this.events[this.events.length - 1];
  }
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outputs = new Set();
    this.disconnected = false;
    ctx.nodes.push(this);
  }
  connect(target) {
    this.outputs.add(target);
    return target;
  }
  disconnect() {
    this.outputs.clear();
    this.disconnected = true;
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

class FakeAudioContext {
  static instances = [];
  static allowResume = true;
  static failCreate = false;
  static failNodes = false;
  constructor(options) {
    if (FakeAudioContext.failCreate) throw new DOMException('No audio output device.', 'NotSupportedError');
    this.options = options;
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = 8_000;
    this.nodes = [];
    this.started = [];
    this.resumeCalls = 0;
    this.onstatechange = null;
    this.destination = new FakeNode(this, 'destination');
    FakeAudioContext.instances.push(this);
  }
  setState(state) {
    this.state = state;
    this.onstatechange?.();
  }
  resume() {
    this.resumeCalls++;
    if (!FakeAudioContext.allowResume) return Promise.reject(new DOMException('The AudioContext was not allowed to start.', 'NotAllowedError'));
    return Promise.resolve().then(() => this.setState('running'));
  }
  suspend() {
    return Promise.resolve().then(() => this.setState('suspended'));
  }
  close() {
    return Promise.resolve().then(() => this.setState('closed'));
  }
  node(kind, params) {
    if (FakeAudioContext.failNodes) throw new DOMException('Cannot create a node.', 'InvalidStateError');
    return Object.assign(new FakeNode(this, kind), params);
  }
  createGain() {
    return this.node('gain', { gain: new FakeParam(1) });
  }
  createBiquadFilter() {
    return this.node('filter', { frequency: new FakeParam(350), Q: new FakeParam(1) });
  }
  createConvolver() {
    return this.node('convolver', {});
  }
  createDynamicsCompressor() {
    return this.node('compressor', { threshold: new FakeParam(-24), ratio: new FakeParam(12) });
  }
  createOscillator() {
    if (FakeAudioContext.failNodes) throw new DOMException('Cannot create a node.', 'InvalidStateError');
    return Object.assign(new FakeSource(this, 'osc'), { frequency: new FakeParam(440), detune: new FakeParam(0), type: 'sine' });
  }
  createBufferSource() {
    if (FakeAudioContext.failNodes) throw new DOMException('Cannot create a node.', 'InvalidStateError');
    return new FakeSource(this, 'buffer');
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, sampleRate, getChannelData: (c) => data[c] };
  }
}

// A fresh page for every test, so engines from earlier tests hear nothing.
let doc;
beforeEach(() => {
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  globalThis.document = doc;
});
globalThis.window = Object.assign(new EventTarget(), { AudioContext: FakeAudioContext });
const activation = { isActive: false };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userActivation: activation } });

const { AudioEngine } = await import('../public/js/audio.js');
const { MOODS } = await import('../public/js/music.js');

const PREFS = { master: 0.7, music: 0.5, sfx: 0.8, muted: false };
const engines = [];
const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fires an input event the way a browser would: with user activation only if that event grants it. */
function gesture(type, { pointerType = 'touch', active = true, key } = {}) {
  activation.isActive = active;
  doc.dispatchEvent(Object.assign(new Event(type), { pointerType, key }));
  activation.isActive = false;
}

function tap() {
  gesture('pointerdown', { pointerType: 'touch', active: false }); // a finger going down grants nothing
  gesture('pointerup', { pointerType: 'touch' });
  gesture('touchend');
  gesture('click', { pointerType: 'touch' });
}

function setVisible(visible) {
  doc.visibilityState = visible ? 'visible' : 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
}

/** An engine listening to this fake page; torn down after each test so no timer is left running. */
function engine(prefs = PREFS) {
  const audio = new AudioEngine(prefs);
  audio.attach();
  engines.push(audio);
  return audio;
}

async function started(prefs) {
  const audio = engine(prefs);
  tap();
  await settle();
  assert.equal(audio.status, 'on');
  return audio;
}

afterEach(() => {
  for (const audio of engines.splice(0)) audio.teardown();
  FakeAudioContext.instances = [];
  FakeAudioContext.allowResume = true;
  FakeAudioContext.failCreate = false;
  FakeAudioContext.failNodes = false;
  activation.isActive = false;
});

test('a finger going down starts nothing; lifting it starts sound exactly once', async () => {
  const audio = engine();
  audio.attach(); // a second call adds no second set of listeners
  gesture('pointerdown', { pointerType: 'touch', active: false });
  assert.equal(FakeAudioContext.instances.length, 0, 'no context is created without user activation');
  assert.equal(audio.status, 'off');

  tap();
  await settle();
  assert.equal(FakeAudioContext.instances.length, 1);
  assert.equal(audio.status, 'on');
  const ctx = FakeAudioContext.instances[0];
  const voices = ctx.started.length;
  const scheduler = audio.scheduler;
  assert.ok(voices >= 9, 'the pad, drone and hiss are running');

  // More gestures and explicit unlocks never build a second graph or a second loop.
  for (let i = 0; i < 5; i++) {
    tap();
    gesture('keydown', { key: 'a' });
    audio.unlock();
  }
  await settle();
  assert.equal(FakeAudioContext.instances.length, 1);
  assert.equal(ctx.started.length, voices, 'no duplicate music voices');
  assert.equal(audio.scheduler, scheduler, 'one music scheduler');
});

test('a mouse press, or a key, starts sound on a desktop', async () => {
  const audio = engine();
  gesture('pointerdown', { pointerType: 'mouse' });
  await settle();
  assert.equal(audio.status, 'on');

  const other = engine();
  gesture('keydown', { key: 'Enter' });
  await settle();
  assert.equal(other.status, 'on');
});

test('when the browser refuses to start sound, the next gesture tries again', async () => {
  FakeAudioContext.allowResume = false;
  const audio = engine();
  tap();
  await settle();
  assert.equal(audio.status, 'paused');
  assert.equal(audio.unlocked, false);

  FakeAudioContext.allowResume = true;
  tap();
  await settle();
  assert.equal(audio.status, 'on');
  assert.equal(FakeAudioContext.instances.length, 1);
});

test('sound the browser stops by itself (a call, another app) is retried once, then resumed by the next tap', async () => {
  const audio = await started();
  const ctx = FakeAudioContext.instances[0];
  FakeAudioContext.allowResume = false;
  const before = ctx.resumeCalls;
  ctx.setState('interrupted');
  await settle();
  assert.equal(ctx.resumeCalls, before + 1, 'one automatic attempt, not a loop');
  assert.equal(audio.status, 'paused');

  // Long after the first unlock, gestures still bring sound back.
  FakeAudioContext.allowResume = true;
  tap();
  await settle();
  assert.equal(audio.status, 'on');
});

test('a hidden tab fades out and pauses; coming back resumes it, and a quick switch never leaves it paused', async () => {
  const audio = await started();
  const ctx = FakeAudioContext.instances[0];

  setVisible(false);
  assert.deepEqual([audio.duck.gain.last.type, audio.duck.gain.last.value], ['target', 0], 'fades rather than cutting off');
  assert.equal(ctx.state, 'running', 'still fading');
  await settle(200);
  assert.equal(ctx.state, 'suspended');
  gesture('click', { pointerType: 'mouse' }); // nothing can resume a hidden page
  await settle();
  assert.equal(ctx.state, 'suspended');

  setVisible(true);
  await settle();
  assert.equal(ctx.state, 'running');
  assert.deepEqual([audio.duck.gain.last.type, audio.duck.gain.last.value], ['target', 1]);

  setVisible(false);
  setVisible(true);
  await settle(200);
  assert.equal(ctx.state, 'running', 'the pending pause was cancelled');
  assert.equal(audio.duck.gain.last.value, 1);
});

test('sound can never break the game: no audio device, or a node that fails, never throws', async () => {
  FakeAudioContext.failCreate = true;
  const broken = engine();
  assert.doesNotThrow(() => tap());
  assert.doesNotThrow(() => broken.unlock());
  assert.equal(broken.status, 'unavailable');
  assert.doesNotThrow(() => {
    broken.play('ring');
    broken.setMood('game');
    broken.setIntensity(0.5);
    broken.setPrefs({ muted: true });
    broken.stop('ringer');
    broken.stopEffects();
  });

  FakeAudioContext.failCreate = false;
  const flaky = await started();
  FakeAudioContext.failNodes = true;
  assert.doesNotThrow(() => {
    flaky.play('ring');
    flaky.play('cadence', { pattern: 'LS', channel: 'ringer' });
    flaky.tick();
  });
  FakeAudioContext.failNodes = false;
  flaky.play('click');
  assert.equal(flaky.status, 'on', 'one failed sound does not stop the next');
});

test('volume and mute reach the mixer, including settings chosen before sound started', async () => {
  const audio = await started({ master: 0.5, music: 0.2, sfx: 1, muted: true });
  assert.equal(audio.master.gain.last.value, 0, 'muted from the start');
  assert.ok(Math.abs(audio.musicBus.gain.last.value - 0.04) < 1e-9);
  assert.equal(audio.sfxBus.gain.last.value, 1);

  audio.setPrefs({ muted: false });
  assert.ok(Math.abs(audio.master.gain.last.value - 0.35) < 1e-9);
  audio.setPrefs({ music: 0 });
  assert.equal(audio.musicBus.gain.last.value, 0);
  assert.equal(audio.prefs.sfx, 1);
});

test('music starts in the mood the game is already in, and plays nothing while paused', async () => {
  const audio = engine();
  audio.setMood('game');
  tap();
  await settle();
  assert.equal(audio.score.mood, 'game');
  assert.equal(audio.score.padFilter.frequency.value, MOODS.game.cutoff);

  const ctx = FakeAudioContext.instances[0];
  ctx.setState('suspended');
  const count = ctx.nodes.length;
  audio.play('ring');
  audio.tick();
  assert.equal(ctx.nodes.length, count, 'nothing is queued up to burst out later');
});

test('music is scheduled ahead of the clock, and after a stall it skips ahead instead of bunching up', async () => {
  const audio = await started();
  const ctx = FakeAudioContext.instances[0];
  ctx.currentTime = 5; // the page stalled past the second bar
  audio.tick();
  ctx.currentTime = 7;
  const before = ctx.started.length;
  audio.tick();
  const fresh = ctx.started.slice(before);
  assert.ok(fresh.length > 0, 'the next bar was scheduled');
  assert.ok(fresh.every((s) => s.startedAt >= 7), 'nothing scheduled in the past, so no burst of missed notes');
});

test('the countdown adds no automation churn: ten minutes of clock ticks change no sound parameter', async () => {
  const audio = await started();
  audio.setMood('game');
  const ctx = FakeAudioContext.instances[0];
  const events = () => ctx.nodes.reduce((n, node) => n + Object.values(node).filter((p) => p instanceof FakeParam).reduce((m, p) => m + p.events.length, 0), 0);
  const before = events();
  for (let i = 0; i <= 2_400; i++) audio.setIntensity(i / 2_400);
  assert.equal(events() - before, 0, 'the score reads the intensity bar by bar');
  assert.equal(audio.intensity, 1);
  assert.equal(audio.score.intensity, 1);
});

test('replaying a ring replaces the last one, and leaving a room silences every effect', async () => {
  const audio = await started();
  audio.play('cadence', { pattern: 'LLS', channel: 'ringer' });
  const first = audio.channels.get('ringer');
  audio.play('cadence', { pattern: 'LLS', channel: 'ringer' });
  const second = audio.channels.get('ringer');
  assert.notEqual(first, second);
  assert.deepEqual([first.out.gain.last.type, first.out.gain.last.value], ['linear', 0], 'the first ring fades out');
  await settle(300);
  assert.equal(first.out.disconnected, true, 'and is disconnected, scheduled tones and all');
  assert.equal(second.out.disconnected, false);

  audio.play('ring');
  const scene = audio.channels.get('scene');
  const music = audio.score.main.gain.events.length;
  audio.stopEffects();
  assert.equal(audio.channels.size, 0);
  assert.equal(scene.out.gain.last.value, 0);
  assert.equal(second.out.gain.last.value, 0);
  assert.equal(audio.score.main.gain.events.length, music, 'music carries on');
  assert.equal(audio.score.main.disconnected, false);

  audio.play('click');
  assert.ok(audio.channels.get('scene'), 'effects play again afterwards');
});
