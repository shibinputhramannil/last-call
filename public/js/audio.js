// Procedural sound: no audio files, nothing plays until the player interacts.

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// A dark, slowly turning progression (A minor, F, D minor, E).
const CHORDS = [
  [45, 48, 52],
  [41, 45, 48],
  [38, 41, 45],
  [40, 44, 47],
];
const WON_CHORD = [45, 49, 52];
const BELL_NOTES = [69, 72, 74, 76, 79, 81];

const MOODS = {
  menu: { filter: 380, pad: 0.05, bells: [7, 14], clanks: [22, 45] },
  lobby: { filter: 420, pad: 0.05, bells: [6, 12], clanks: [20, 40] },
  game: { filter: 520, pad: 0.055, bells: [5, 11], clanks: [14, 30] },
  won: { filter: 900, pad: 0.06, bells: [2.5, 5], clanks: [999, 999] },
  lost: { filter: 240, pad: 0.04, bells: [12, 20], clanks: [8, 16] },
};

export class AudioEngine {
  constructor(prefs) {
    this.prefs = { ...prefs };
    this.ctx = null;
    this.mood = 'menu';
    this.intensity = 0;
    this.listeners = new Set();
  }

  get unlocked() {
    return this.ctx != null && this.ctx.state === 'running';
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  changed() {
    for (const fn of this.listeners) fn(this);
  }

  /** Must run inside a user gesture (click / keydown). Safe to call repeatedly. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().then(() => this.changed());
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);

    const impulse = this.impulse(3.4, 2.6);
    this.musicVerb = ctx.createConvolver();
    this.musicVerb.buffer = impulse;
    this.musicVerb.connect(this.musicBus);
    this.sfxVerb = ctx.createConvolver();
    this.sfxVerb.buffer = impulse;
    this.sfxVerb.connect(this.sfxBus);

    this.noise = this.noiseBuffer(2);
    this.applyVolumes(true);
    this.startMusic();

    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.visibilityState === 'hidden') this.ctx.suspend();
      else this.ctx.resume();
    });
    ctx.resume().then(() => this.changed());
    this.changed();
  }

  // ---- Volume -------------------------------------------------------------

  setPrefs(patch) {
    Object.assign(this.prefs, patch);
    this.applyVolumes();
    this.changed();
  }

  applyVolumes(immediate = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const curve = (v) => Math.max(0, Math.min(1, v)) ** 2;
    const set = (param, value) => (immediate ? param.setValueAtTime(value, t) : param.setTargetAtTime(value, t, 0.05));
    set(this.master.gain, this.prefs.muted ? 0 : curve(this.prefs.master) * 1.4);
    set(this.musicBus.gain, curve(this.prefs.music));
    set(this.sfxBus.gain, curve(this.prefs.sfx));
  }

  // ---- Building blocks ----------------------------------------------------

  impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
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

  /** Filtered noise burst. */
  burst({ at = 0, dur = 0.05, gain = 0.1, type = 'bandpass', freq = 2000, q = 1, bus = 'sfx', verb = 0, sweepTo = null }) {
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
    env.gain.setValueAtTime(gain, t);
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
    modGain.gain.setValueAtTime(freq * 1.6, t);
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
    node.connect(bus === 'music' ? this.musicBus : this.sfxBus);
    if (verb > 0) {
      const send = this.ctx.createGain();
      send.gain.value = verb;
      node.connect(send).connect(bus === 'music' ? this.musicVerb : this.sfxVerb);
    }
  }

  // ---- Music ----------------------------------------------------------------

  startMusic() {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = MOODS.menu.filter;
    this.padFilter.Q.value = 2;
    this.padGain = ctx.createGain();
    this.padGain.gain.setValueAtTime(0.0001, t);
    this.padGain.gain.exponentialRampToValueAtTime(MOODS.menu.pad, t + 4);
    this.padFilter.connect(this.padGain);
    this.route(this.padGain, 'music', 0.7);

    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.05;
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain).connect(this.padFilter.frequency);
    lfo.start();

    this.voices = CHORDS[0].map((note) => {
      const pair = [-7, 7].map((cents) => {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = midi(note);
        osc.detune.value = cents;
        osc.connect(this.padFilter);
        osc.start();
        return osc;
      });
      return pair;
    });

    // Low drone with a slow, uneasy tremolo.
    const sub = ctx.createOscillator();
    sub.frequency.value = midi(33);
    const subGain = ctx.createGain();
    subGain.gain.value = 0.07;
    const trem = ctx.createOscillator();
    const tremGain = ctx.createGain();
    trem.frequency.value = 0.17;
    tremGain.gain.value = 0.03;
    trem.connect(tremGain).connect(subGain.gain);
    sub.connect(subGain);
    this.route(subGain, 'music', 0);
    sub.start();
    trem.start();

    // Line hiss.
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noise;
    hiss.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3500;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.012;
    hiss.connect(hp).connect(hissGain);
    this.route(hissGain, 'music', 0);
    hiss.start();

    this.chordIndex = 0;
    const now = ctx.currentTime;
    this.next = { chord: now + 14, bell: now + 3, clank: now + 9, crackle: now + 1, beat: now + 1 };
    this.scheduler = setInterval(() => this.tick(), 200);
  }

  tick() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const mood = MOODS[this.mood];
    const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);

    if (now >= this.next.chord && this.mood !== 'won') {
      this.chordIndex = (this.chordIndex + 1) % CHORDS.length;
      this.setChord(CHORDS[this.chordIndex], 2.5);
      this.next.chord = now + 12 + Math.random() * 6;
    }
    if (now >= this.next.bell) {
      const note = BELL_NOTES[Math.floor(Math.random() * BELL_NOTES.length)] - (this.mood === 'lost' ? 12 : 0);
      this.bell({ freq: midi(note), gain: 0.028 + Math.random() * 0.02 });
      this.next.bell = now + rand(mood.bells);
    }
    if (now >= this.next.clank) {
      // Something heavy shifts somewhere in the building.
      this.burst({ bus: 'music', dur: 0.5, gain: 0.08, freq: 300 + Math.random() * 500, q: 9, verb: 1.2 });
      this.tone({ bus: 'music', freq: 140 + Math.random() * 60, type: 'triangle', dur: 1.4, gain: 0.03, verb: 1 });
      this.next.clank = now + rand(mood.clanks);
    }
    if (now >= this.next.crackle) {
      this.burst({ bus: 'music', dur: 0.012, gain: 0.04 + Math.random() * 0.05, type: 'highpass', freq: 2500 });
      this.next.crackle = now + 0.3 + Math.random() * 2.5;
    }
    if (this.intensity > 0.05 && now >= this.next.beat) {
      // A heartbeat that quickens as the clock runs down.
      const g = 0.05 + 0.12 * this.intensity;
      this.tone({ bus: 'music', freq: 62, glideTo: 40, dur: 0.18, gain: g });
      this.tone({ bus: 'music', freq: 58, glideTo: 38, dur: 0.16, gain: g * 0.7, at: 0.22 });
      this.next.beat = now + 1.2 - 0.5 * this.intensity;
    }
  }

  setChord(notes, glide) {
    const t = this.ctx.currentTime;
    this.voices.forEach((pair, i) => {
      for (const osc of pair) osc.frequency.setTargetAtTime(midi(notes[i % notes.length]), t, glide / 3);
    });
  }

  setMood(mood) {
    if (!MOODS[mood] || mood === this.mood) return;
    this.mood = mood;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const m = MOODS[mood];
    this.padFilter.frequency.setTargetAtTime(m.filter, t, 1.5);
    this.padGain.gain.setTargetAtTime(m.pad, t, 1.5);
    if (mood === 'won') this.setChord(WON_CHORD, 3);
    if (mood === 'lost') this.setChord(CHORDS[2].map((n) => n - 1), 4);
    if (mood !== 'game') this.setIntensity(0);
    this.next.bell = t + 1.5;
  }

  setIntensity(value) {
    this.intensity = Math.max(0, Math.min(1, value));
    if (this.ctx && this.mood === 'game') {
      this.padFilter.frequency.setTargetAtTime(MOODS.game.filter + 500 * this.intensity, this.ctx.currentTime, 2);
    }
  }

  // ---- Effects --------------------------------------------------------------

  play(name, opt = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    switch (name) {
      case 'click':
        this.tone({ freq: 1700, type: 'square', dur: 0.03, gain: 0.025 });
        break;
      case 'pickup':
        this.burst({ dur: 0.06, gain: 0.25, freq: 1800, q: 2 });
        this.tone({ freq: 140, glideTo: 70, dur: 0.12, gain: 0.12, type: 'triangle' });
        // UK-style dial tone: 350 Hz + 440 Hz.
        this.tone({ freq: 350, dur: 1.6, gain: 0.05, at: 0.25, attack: 0.03 });
        this.tone({ freq: 440, dur: 1.6, gain: 0.05, at: 0.25, attack: 0.03 });
        break;
      case 'ring':
        for (const at of [0, 0.6]) {
          for (let i = 0; i < 8; i++) {
            this.tone({ freq: 400, dur: 0.045, gain: 0.05, at: at + i * 0.05 });
            this.tone({ freq: 450, dur: 0.045, gain: 0.05, at: at + i * 0.05 });
          }
        }
        break;
      case 'pulse': {
        // Rotary dialling sends one click per unit; 0 sends ten.
        const count = opt.digit === 0 ? 10 : opt.digit;
        for (let i = 0; i < count; i++) {
          this.burst({ at: 0.12 + i * 0.07, dur: 0.018, gain: 0.22, freq: 2600, q: 3 });
          this.tone({ at: 0.12 + i * 0.07, freq: 190, dur: 0.03, gain: 0.05, type: 'triangle' });
        }
        break;
      }
      case 'relay':
        this.tone({ freq: 130, glideTo: 45, dur: 0.2, gain: 0.2, type: 'triangle' });
        this.burst({ dur: 0.09, gain: 0.25, type: 'lowpass', freq: 700 });
        break;
      case 'plug':
        this.burst({ dur: 0.03, gain: 0.3, freq: 3000, q: 4 });
        this.tone({ freq: 2100, dur: 0.18, gain: 0.03, at: 0.01, verb: 0.3 });
        this.tone({ freq: 120, glideTo: 60, dur: 0.1, gain: 0.12, type: 'triangle' });
        break;
      case 'unplug':
        this.burst({ dur: 0.05, gain: 0.2, freq: 1500, sweepTo: 4000, q: 3 });
        break;
      case 'key':
        this.burst({ dur: 0.025, gain: 0.2, freq: 3200, q: 2 });
        this.tone({ freq: 90, dur: 0.05, gain: 0.08, type: 'triangle' });
        break;
      case 'success':
        [69, 73, 76, 81].forEach((n, i) => this.bell({ freq: midi(n), at: i * 0.13, gain: 0.07, dur: 2.5, bus: 'sfx', verb: 0.6 }));
        break;
      case 'fail':
        // "Number unobtainable": a flat, beating buzz.
        this.tone({ freq: 98, type: 'sawtooth', dur: 0.75, gain: 0.07, attack: 0.02 });
        this.tone({ freq: 104, type: 'sawtooth', dur: 0.75, gain: 0.07, attack: 0.02 });
        break;
      case 'incoming':
        this.tone({ freq: 880, dur: 0.09, gain: 0.04 });
        this.tone({ freq: 1320, dur: 0.12, gain: 0.035, at: 0.08 });
        break;
      case 'sent':
        this.tone({ freq: 1200, dur: 0.05, gain: 0.02 });
        break;
      case 'hint':
        this.burst({ dur: 0.35, gain: 0.07, freq: 700, sweepTo: 3200, q: 0.8 });
        break;
      case 'join':
        this.tone({ freq: 523, dur: 0.25, gain: 0.04 });
        this.tone({ freq: 784, dur: 0.35, gain: 0.04, at: 0.12 });
        break;
      case 'drop':
        this.tone({ freq: 523, dur: 0.25, gain: 0.04 });
        this.tone({ freq: 349, dur: 0.4, gain: 0.04, at: 0.15 });
        break;
      case 'win':
        this.play('success');
        [57, 61, 64].forEach((n) => this.tone({ freq: midi(n), type: 'triangle', dur: 4, gain: 0.04, attack: 0.8, at: 0.5, verb: 0.8 }));
        break;
      case 'lose':
        [64, 60, 57, 52].forEach((n, i) => this.tone({ freq: midi(n), type: 'triangle', dur: 1.2, gain: 0.05, at: i * 0.35, verb: 0.8 }));
        break;
      default:
        break;
    }
  }
}
