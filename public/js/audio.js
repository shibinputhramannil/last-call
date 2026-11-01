// Procedural sound: no audio files, nothing plays until the player interacts.
// The music is the original score in music.js; the effects are made here.
//
// Browsers let sound start only inside a user gesture, and can stop it again at
// any time: a background tab, a phone call, another app taking the speaker. So
// the engine listens for gestures for as long as the page is open and resumes
// whenever it is allowed to. No sound problem ever reaches the game: every
// public method can be called at any time and never throws.

import { MOODS, Score } from './music.js';

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

/** Events that let sound start. A touch only counts when the finger lifts, so pointerdown counts for a mouse alone. */
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
/** The score is scheduled this far ahead of the audio clock, so a busy page never makes it late. */
const SCHEDULE_AHEAD = 1.5;
/** Time constant of the fade when the tab is hidden or shown, so sound never stops with a click. */
const FADE = 0.015;
/** The browser stopping sound by itself is retried at most this often without a gesture. */
const AUTO_RESUME_MS = 1_000;
/** Where sound effects go unless they ask for a channel of their own. */
const SCENE = 'scene';

export class AudioEngine {
  constructor(prefs) {
    this.prefs = { ...prefs };
    this.ctx = null;
    this.ready = false; // the graph is built and music is running on this.ctx
    this.failed = false;
    this.attached = false;
    this.mood = 'menu';
    this.intensity = 0;
    this.listeners = new Set();
    this.channels = new Map(); // name -> { out, verb }
    this.fx = null; // the channel the effect being built plays on
    this.scheduler = null;
    this.suspendTimer = null;
    this.lastAutoResume = 0;
  }

  get unlocked() {
    return this.ready && this.ctx.state === 'running';
  }

  /** 'off' before the first gesture, 'on', 'paused' (stopped by the browser; a tap restarts it) or 'unavailable'. */
  get status() {
    if (this.failed) return 'unavailable';
    if (!this.ready) return 'off';
    return this.unlocked ? 'on' : 'paused';
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  changed() {
    for (const fn of this.listeners) fn(this);
  }

  /** Listens for gestures and tab visibility for the life of the page. Safe to call more than once. */
  attach() {
    if (this.attached) return;
    this.attached = true;
    const onGesture = (e) => {
      if (e.type === 'pointerdown' && e.pointerType !== 'mouse') return;
      if (!this.unlocked) this.unlock();
    };
    for (const type of GESTURES) document.addEventListener(type, onGesture, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => this.onVisibility());
  }

  /** Starts or resumes sound. Call it inside a user gesture; at any other time it does no harm. */
  unlock() {
    if (this.failed) return;
    try {
      if (this.ctx) this.resume();
      else this.create();
    } catch {
      this.fail();
    }
  }

  create() {
    // Outside a gesture the context could only start suspended, so wait for one.
    const activation = globalThis.navigator?.userActivation;
    if (activation && !activation.isActive) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.fail();
      return;
    }
    // A slightly larger buffer than the default rides out busy moments without crackling.
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'balanced' });
    } catch {
      ctx = new AC();
    }
    this.ctx = ctx;
    ctx.onstatechange = () => this.onStateChange(ctx);
    this.resume(); // must happen inside the gesture
    // Building the reverb takes a moment; do it after this gesture, so the
    // game's own handling of the tap (joining, starting a stage) goes first.
    setTimeout(() => this.build(ctx), 0);
    this.changed();
  }

  build(ctx) {
    if (this.ctx !== ctx || this.ready) return;
    try {
      this.master = ctx.createGain();
      this.duck = ctx.createGain(); // fades for tab visibility, apart from the player's volume
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 3;
      this.master.connect(this.duck).connect(comp).connect(ctx.destination);
      if (document.visibilityState === 'hidden') this.duck.gain.value = 0;

      this.musicBus = ctx.createGain();
      this.sfxBus = ctx.createGain();
      this.musicBus.connect(this.master);
      // Effects pass a gentle top-end roll-off, so no click or ring turns piercing.
      const soften = ctx.createBiquadFilter();
      soften.type = 'lowpass';
      soften.frequency.value = 6000;
      soften.Q.value = 0.5;
      this.sfxBus.connect(soften).connect(this.master);

      const impulse = this.impulse(3.4, 2.6);
      this.musicVerb = ctx.createConvolver();
      this.musicVerb.buffer = impulse;
      this.musicVerb.connect(this.musicBus);
      this.sfxVerb = ctx.createConvolver();
      this.sfxVerb.buffer = impulse;
      this.sfxVerb.connect(this.sfxBus);

      this.noise = this.noiseBuffer(2);
      this.ready = true;
      this.applyVolumes(true);
      this.startMusic();
    } catch {
      this.fail();
      return;
    }
    this.changed();
  }

  /** Sound cannot work in this browser: stop trying, and let the game carry on silently. */
  fail() {
    this.failed = true;
    this.teardown();
    this.changed();
  }

  teardown() {
    clearInterval(this.scheduler);
    clearTimeout(this.suspendTimer);
    this.scheduler = null;
    this.suspendTimer = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.ready = false;
    this.channels.clear();
    try {
      Promise.resolve(ctx?.close()).catch(() => {});
    } catch {
      // already closed
    }
  }

  resume() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed' || document.visibilityState === 'hidden') return;
    clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    let pending;
    try {
      pending = ctx.resume();
    } catch {
      return;
    }
    Promise.resolve(pending).then(
      () => {
        if (this.ctx !== ctx) return;
        this.fadeTo(1);
        this.changed();
      },
      () => {
        // Not allowed yet; the next gesture tries again.
      },
    );
  }

  onStateChange(ctx) {
    if (this.ctx !== ctx) return;
    if (ctx.state === 'closed') {
      // Something closed it under us; the next gesture starts afresh.
      this.teardown();
    } else if (ctx.state !== 'running' && document.visibilityState === 'visible' && !this.suspendTimer && Date.now() - this.lastAutoResume > AUTO_RESUME_MS) {
      // The browser stopped sound by itself (a call, another app): try again
      // now. If that is refused, the next tap or key press resumes it.
      this.lastAutoResume = Date.now();
      this.resume();
    }
    this.changed();
  }

  onVisibility() {
    const ctx = this.ctx;
    if (!ctx) return;
    clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    if (document.visibilityState !== 'hidden') {
      this.resume();
      this.fadeTo(1);
      return;
    }
    // Fade out, then pause everything while nobody can hear it.
    this.fadeTo(0);
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (this.ctx !== ctx || document.visibilityState !== 'hidden' || ctx.state !== 'running') return;
      try {
        Promise.resolve(ctx.suspend()).catch(() => {});
      } catch {
        // already stopped
      }
    }, 120);
  }

  fadeTo(level) {
    this.guard(() => this.duck.gain.setTargetAtTime(level, this.ctx.currentTime, FADE));
  }

  /** Runs a change to the sound graph only once it exists, and never lets it throw. */
  guard(fn) {
    if (!this.ready) return;
    try {
      fn();
    } catch {
      // A sound that cannot be changed is left as it is.
    }
  }

  // ---- Volume -------------------------------------------------------------

  setPrefs(patch) {
    Object.assign(this.prefs, patch);
    this.applyVolumes();
    this.changed();
  }

  applyVolumes(immediate = false) {
    this.guard(() => {
      const t = this.ctx.currentTime;
      const curve = (v) => Math.max(0, Math.min(1, v)) ** 2;
      const set = (param, value) => (immediate ? param.setValueAtTime(value, t) : param.setTargetAtTime(value, t, 0.05));
      set(this.master.gain, this.prefs.muted ? 0 : curve(this.prefs.master) * 1.4);
      set(this.musicBus.gain, curve(this.prefs.music));
      set(this.sfxBus.gain, curve(this.prefs.sfx));
    });
  }

  // ---- Building blocks ----------------------------------------------------

  /** A room's echo: decaying noise whose highs die away first, so the reverb is warm rather than hissy. */
  impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < length; i++) {
        const k = 0.5 * (1 - i / length) + 0.04; // a one-pole low-pass that closes over the tail
        y += k * (Math.random() * 2 - 1 - y);
        data[i] = 2.2 * y * (1 - i / length) ** decay;
      }
    }
    return buffer;
  }

  noiseBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, Math.floor(rate * seconds), rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Short enveloped oscillator. */
  tone({ freq, type = 'sine', at = 0, dur = 0.2, gain = 0.1, attack = 0.005, bus = 'sfx', verb = 0, glideTo = null, detune = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.detune.value = detune;
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env);
    this.route(env, bus, verb);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** Filtered noise burst. It ramps in over `attack`, never starting at full level (that clicks). */
  burst({ at = 0, dur = 0.05, gain = 0.1, type = 'bandpass', freq = 2000, q = 1, bus = 'sfx', verb = 0, sweepTo = null, attack = 0.004 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(env);
    this.route(env, bus, verb);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  /** Inharmonic FM bell. */
  bell({ freq, at = 0, gain = 0.05, dur = 3.5, bus = 'music', verb = 0.8 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const carrier = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    carrier.frequency.value = freq;
    mod.frequency.value = freq * 2.76;
    modGain.gain.setValueAtTime(freq * 1.1, t); // a gentle strike: fewer bright overtones
    modGain.gain.exponentialRampToValueAtTime(1, t + dur);
    mod.connect(modGain).connect(carrier.frequency);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    carrier.connect(env);
    this.route(env, bus, verb);
    carrier.start(t);
    mod.start(t);
    carrier.stop(t + dur + 0.1);
    mod.stop(t + dur + 0.1);
  }

  route(node, bus, verb) {
    const music = bus === 'music';
    const fx = music ? null : this.fx || this.channel(SCENE);
    node.connect(music ? this.musicBus : fx.out);
    if (verb > 0) {
      const send = this.ctx.createGain();
      send.gain.value = verb;
      node.connect(send).connect(music ? this.musicVerb : fx.verb);
    }
  }

  /** A channel for sound effects, with its own reverb send, so it can be silenced as a whole. */
  channel(name) {
    let ch = this.channels.get(name);
    if (!ch) {
      ch = { out: this.ctx.createGain(), verb: this.ctx.createGain() };
      ch.out.connect(this.sfxBus);
      ch.verb.connect(this.sfxVerb);
      this.channels.set(name, ch);
    }
    return ch;
  }

  /** Silences a channel's sounds, including those still scheduled to play. */
  stop(name) {
    const ch = this.channels.get(name);
    if (!ch) return;
    this.channels.delete(name);
    this.guard(() => {
      const t = this.ctx.currentTime;
      for (const node of [ch.out, ch.verb]) {
        node.gain.cancelScheduledValues(t);
        node.gain.setValueAtTime(1, t);
        node.gain.linearRampToValueAtTime(0, t + 0.04);
      }
      setTimeout(() => {
        try {
          ch.out.disconnect();
          ch.verb.disconnect();
        } catch {
          // already gone
        }
      }, 250);
    });
  }

  /** Silences every sound effect, playing or scheduled, e.g. on leaving a room. Music carries on. */
  stopEffects() {
    for (const name of [...this.channels.keys()]) this.stop(name);
  }

  // ---- Music ----------------------------------------------------------------

  startMusic() {
    this.score = new Score(this.ctx, { out: this.musicBus, verb: this.musicVerb, noise: this.noise, mood: this.mood, intensity: this.intensity });
    this.score.start(this.ctx.currentTime + 0.05);
    this.scheduleMusic(this.ctx.currentTime);
    clearInterval(this.scheduler);
    this.scheduler = setInterval(() => this.tick(), 250);
  }

  tick() {
    const ctx = this.ctx;
    if (!this.ready || ctx.state !== 'running') return;
    try {
      this.scheduleMusic(ctx.currentTime);
    } catch {
      // Skip this round; the next tick tries again.
    }
  }

  /** Keeps the score scheduled a little ahead of the audio clock. */
  scheduleMusic(now) {
    this.score?.scheduleUntil(now + SCHEDULE_AHEAD);
  }

  setMood(mood) {
    if (!MOODS[mood] || mood === this.mood) return;
    this.mood = mood;
    if (mood !== 'game') this.setIntensity(0);
    this.guard(() => this.score.setMood(mood, this.ctx.currentTime));
  }

  /** 0..1, how close a countdown is to running out. The score reads it bar by bar. */
  setIntensity(value) {
    this.intensity = Math.max(0, Math.min(1, Number(value) || 0));
    this.score?.setIntensity(this.intensity);
  }

  // ---- Effects --------------------------------------------------------------

  /**
   * Plays a sound effect. With `opt.channel`, it replaces whatever was playing
   * on that channel (a ring that is replayed never overlaps the last one).
   */
  play(name, opt = {}) {
    if (!this.unlocked) return;
    try {
      if (opt.channel) this.stop(opt.channel);
      this.fx = this.channel(opt.channel || SCENE);
      this.effect(name, opt);
    } catch {
      // A sound that cannot play is skipped; the game carries on.
    } finally {
      this.fx = null;
    }
  }

  effect(name, opt) {
    switch (name) {
      case 'click':
        // A soft tick.
        this.tone({ freq: 1400, type: 'triangle', dur: 0.04, gain: 0.065 });
        break;
      case 'pickup':
        this.burst({ dur: 0.07, gain: 0.12, type: 'lowpass', freq: 1300 });
        this.tone({ freq: 140, glideTo: 70, dur: 0.14, gain: 0.1, type: 'triangle' });
        // UK-style dial tone: 350 Hz + 440 Hz, soft and brief.
        this.tone({ freq: 350, dur: 1.4, gain: 0.035, at: 0.25, attack: 0.05 });
        this.tone({ freq: 440, dur: 1.4, gain: 0.035, at: 0.25, attack: 0.05 });
        break;
      case 'ring':
        for (const at of [0, 0.6]) {
          for (let i = 0; i < 8; i++) {
            this.tone({ freq: 400, dur: 0.045, gain: 0.09, at: at + i * 0.05, attack: 0.006 });
            this.tone({ freq: 450, dur: 0.045, gain: 0.09, at: at + i * 0.05, attack: 0.006 });
          }
        }
        break;
      case 'pulse': {
        // Rotary dialling sends one click per unit; 0 sends ten.
        const count = opt.digit === 0 ? 10 : opt.digit;
        for (let i = 0; i < count; i++) {
          this.burst({ at: 0.12 + i * 0.07, dur: 0.02, gain: 0.22, freq: 1500, q: 2, attack: 0.003 });
          this.tone({ at: 0.12 + i * 0.07, freq: 170, dur: 0.035, gain: 0.08, type: 'triangle' });
        }
        break;
      }
      case 'relay':
        this.tone({ freq: 130, glideTo: 50, dur: 0.2, gain: 0.12, type: 'triangle' });
        this.burst({ dur: 0.09, gain: 0.1, type: 'lowpass', freq: 650 });
        break;
      case 'plug':
        this.burst({ dur: 0.035, gain: 0.12, freq: 1700, q: 2, attack: 0.002 });
        this.tone({ freq: 1600, dur: 0.2, gain: 0.018, at: 0.01, verb: 0.3 });
        this.tone({ freq: 120, glideTo: 60, dur: 0.1, gain: 0.1, type: 'triangle' });
        break;
      case 'unplug':
        this.burst({ dur: 0.06, gain: 0.32, freq: 900, sweepTo: 1700, q: 2.5 });
        break;
      case 'key':
        this.burst({ dur: 0.03, gain: 0.13, freq: 1900, q: 1.5, attack: 0.002 });
        this.tone({ freq: 110, dur: 0.06, gain: 0.09, type: 'triangle' });
        break;
      case 'success':
        [69, 73, 76, 81].forEach((n, i) => this.bell({ freq: midi(n), at: i * 0.13, gain: 0.06, dur: 2.4, bus: 'sfx', verb: 0.5 }));
        break;
      case 'fail':
        // "Number unobtainable": a low, beating tone. Unmistakable, never harsh.
        this.tone({ freq: 147, type: 'triangle', dur: 0.6, gain: 0.095, attack: 0.02 });
        this.tone({ freq: 156, type: 'triangle', dur: 0.6, gain: 0.095, attack: 0.02 });
        break;
      case 'incoming':
        this.tone({ freq: 784, dur: 0.1, gain: 0.08 });
        this.tone({ freq: 1175, dur: 0.14, gain: 0.06, at: 0.08 });
        break;
      case 'sent':
        this.tone({ freq: 988, dur: 0.06, gain: 0.055 });
        break;
      case 'hint':
        this.burst({ dur: 0.35, gain: 0.2, freq: 380, sweepTo: 1100, q: 1.2, attack: 0.03 });
        break;
      case 'join':
        this.tone({ freq: 523, dur: 0.25, gain: 0.075 });
        this.tone({ freq: 784, dur: 0.35, gain: 0.065, at: 0.12 });
        break;
      case 'drop':
        this.tone({ freq: 523, dur: 0.25, gain: 0.075 });
        this.tone({ freq: 349, dur: 0.4, gain: 0.075, at: 0.15 });
        break;
      case 'cadence': {
        // A party-line ring: long and short bursts of the 400/450 Hz ringing tone.
        let at = 0;
        for (const part of opt.pattern || '') {
          const dur = part === 'L' ? 0.55 : 0.2;
          this.tone({ freq: 400, dur, gain: 0.065, at, attack: 0.015 });
          this.tone({ freq: 450, dur, gain: 0.065, at, attack: 0.015 });
          at += dur + 0.18;
        }
        break;
      }
      case 'toggle':
        this.burst({ dur: 0.04, gain: 0.12, type: 'lowpass', freq: 1100 });
        this.tone({ freq: opt.up ? 180 : 120, glideTo: opt.up ? 220 : 90, dur: 0.08, gain: 0.07, type: 'triangle' });
        break;
      case 'page':
        this.burst({ dur: 0.14, gain: 0.12, freq: 850, sweepTo: 420, q: 1.1, attack: 0.01 });
        break;
      case 'star': {
        const notes = [72, 76, 79];
        this.bell({ freq: midi(notes[Math.min(2, opt.index || 0)]), gain: 0.08, dur: 2.2, bus: 'sfx', verb: 0.5 });
        break;
      }
      case 'stage':
        [64, 69, 73, 76].forEach((n, i) => this.bell({ freq: midi(n), at: i * 0.11, gain: 0.05, dur: 2.4, bus: 'sfx', verb: 0.6 }));
        [45, 52, 57].forEach((n) => this.tone({ freq: midi(n), type: 'triangle', dur: 2.6, gain: 0.03, attack: 0.4, at: 0.3, verb: 0.8 }));
        break;
      case 'win':
        this.effect('success', opt);
        [57, 61, 64].forEach((n) => this.tone({ freq: midi(n), type: 'triangle', dur: 4, gain: 0.035, attack: 0.8, at: 0.5, verb: 0.8 }));
        break;
      case 'lose':
        [64, 60, 57, 52].forEach((n, i) => this.tone({ freq: midi(n), type: 'triangle', dur: 1.2, gain: 0.065, at: i * 0.35, verb: 0.8 }));
        break;
      default:
        break;
    }
  }

}
