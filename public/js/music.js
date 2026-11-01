// The background score: original music for Last Call, made as it plays.
//
// Slow, warm chords under a soft bass; now and then a short phrase on a glassy
// bell; in a stage, a quiet arpeggio, and a heartbeat as the countdown runs
// low. Each bar is chosen from hand-written progressions and motifs, with
// variations and rests, so a long session never hears a passage looped. Every
// note fades in and out (nothing starts or stops abruptly), and the score is
// scheduled a little ahead on the audio clock, never in bursts.

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

export const BPM = 66;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const CHORD_BARS = 2;
const SECTION_CHORDS = 4;
const SECTION_BARS = CHORD_BARS * SECTION_CHORDS;

/**
 * Each chord: its pad voicing, a bass root, and the notes a melody may use over
 * it (a consonant set an octave or so above middle C, never shrill).
 */
const CHORDS = {
  Am: { pad: [57, 60, 64, 71], bass: 45, tones: [69, 72, 74, 76, 79, 81] },
  F: { pad: [53, 57, 60, 64], bass: 41, tones: [69, 72, 74, 76, 77, 81] },
  C: { pad: [55, 60, 62, 64], bass: 48, tones: [67, 69, 72, 74, 76, 79] },
  G: { pad: [55, 59, 62, 67], bass: 43, tones: [67, 69, 71, 74, 76, 79] },
  Dm: { pad: [57, 60, 62, 65], bass: 50, tones: [69, 72, 74, 76, 77, 81] },
  Em: { pad: [55, 59, 64, 67], bass: 40, tones: [67, 69, 71, 74, 76, 79] },
  Bb: { pad: [58, 62, 65, 69], bass: 46, tones: [69, 70, 72, 74, 77, 81] },
  E: { pad: [56, 59, 62, 64], bass: 40, tones: [68, 69, 71, 74, 76, 80] },
  Fm: { pad: [56, 60, 63, 68], bass: 41, tones: [68, 72, 75, 77, 80, 84] },
  D: { pad: [57, 62, 66, 69], bass: 50, tones: [66, 69, 71, 74, 76, 78] },
};

/** Four chords to a section, two bars each. */
const PROGRESSIONS = {
  calm: [
    ['Am', 'F', 'C', 'G'],
    ['Am', 'Em', 'F', 'C'],
    ['Dm', 'Am', 'F', 'G'],
    ['F', 'C', 'Dm', 'Am'],
    ['Am', 'F', 'Dm', 'E'],
    ['F', 'G', 'Am', 'Am'],
  ],
  quest: [
    ['Am', 'Bb', 'Am', 'E'],
    ['Dm', 'F', 'G', 'Am'],
    ['Am', 'G', 'F', 'E'],
    ['F', 'G', 'Am', 'Am'],
    ['Am', 'C', 'Bb', 'F'],
    ['Dm', 'Bb', 'F', 'E'],
  ],
  bright: [
    ['C', 'G', 'Am', 'F'],
    ['F', 'C', 'G', 'C'],
    ['Am', 'F', 'C', 'G'],
    ['F', 'G', 'C', 'Am'],
  ],
  home: [
    ['C', 'F', 'G', 'C'],
    ['F', 'G', 'C', 'Am'],
    ['D', 'G', 'C', 'C'],
  ],
  dusk: [
    ['Am', 'Fm', 'Am', 'E'],
    ['Dm', 'Am', 'Fm', 'Am'],
    ['F', 'Fm', 'C', 'E'],
  ],
};

/**
 * Melodic cells: [step in the chord's melody notes, length in beats]. Each is
 * played transposed, sometimes mirrored, sometimes an octave lower.
 */
const MOTIFS = [
  [[3, 1], [2, 0.5], [1, 0.5], [3, 2]],
  [[0, 1.5], [1, 0.5], [2, 1], [3, 1]],
  [[5, 1], [4, 1], [3, 2]],
  [[1, 0.5], [3, 0.5], [4, 1], [3, 2]],
  [[3, 1], [5, 1], [4, 0.5], [3, 0.5], [2, 1]],
  [[0, 2], [3, 1], [1, 1]],
  [[4, 1], [3, 1], [1, 1], [0, 1]],
  [[1, 1], [2, 1], [3, 1], [5, 1]],
  [[2, 1.5], [1, 0.5], [0, 2]],
  [[3, 0.5], [4, 0.5], [3, 0.5], [1, 0.5], [2, 2]],
];

/** How each part of the game sounds: progression set, how often the bell speaks, brightness, layers. */
export const MOODS = {
  menu: { prog: 'calm', melody: 0.55, cutoff: 1100, air: 1, arp: 0 },
  lobby: { prog: 'calm', melody: 0.6, cutoff: 1250, air: 0.9, arp: 0 },
  game: { prog: 'quest', melody: 0.45, cutoff: 1200, air: 0.7, arp: 0.35 },
  result: { prog: 'bright', melody: 0.65, cutoff: 1500, air: 0.6, arp: 0.2 },
  won: { prog: 'home', melody: 0.8, cutoff: 1800, air: 0.5, arp: 0.45 },
  lost: { prog: 'dusk', melody: 0.3, cutoff: 750, air: 1, arp: 0 },
};

// Levels before the player's music volume. Quiet on purpose: this is a backdrop.
const LEVEL = 2.4;
const PAD = 0.016;
const BASS = 0.07;
const BELL = 0.035;
const ARP = 0.012;
const BEAT_GAIN = 0.05;
const AIR = 0.012;
const ARP_PATTERNS = [
  [0, 1, 2, 3, 2, 1, 0, 1],
  [0, 2, 1, 3, 0, 2, 1, 3],
  [3, 2, 1, 0, 1, 2, 3, 2],
  [0, 1, 2, 1, 3, 2, 1, 2],
];

export class Score {
  /**
   * `out` receives the score, `verb` (optional) a reverb send, `noise` (optional)
   * a noise buffer for the room tone. `rng` makes it reproducible in tests;
   * `record`, if given, collects every scheduled note.
   */
  constructor(ctx, { out, verb = null, noise = null, mood = 'menu', intensity = 0, rng = Math.random, record = null }) {
    this.ctx = ctx;
    this.rng = rng;
    this.record = record;
    this.mood = MOODS[mood] ? mood : 'menu';
    this.intensity = intensity;
    this.next = null; // start time of the next bar to schedule
    this.bars = 0;
    this.chordInSection = SECTION_CHORDS;
    this.progression = null;
    this.phrases = new Map(); // bar in section -> phrase
    this.recent = []; // recent phrase signatures, to avoid repeats
    this.sectionsSinceRest = 0;
    this.arpPattern = ARP_PATTERNS[0];

    const m = MOODS[this.mood];
    this.main = ctx.createGain();
    this.main.gain.value = 0;
    this.main.connect(out);
    this.send = ctx.createGain();
    this.send.gain.value = 0.35;
    this.main.connect(this.send);
    if (verb) this.send.connect(verb);

    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.Q.value = 0.6;
    this.padFilter.frequency.value = m.cutoff;
    this.padFilter.connect(this.main);
    this.bellBus = ctx.createBiquadFilter();
    this.bellBus.type = 'lowpass';
    this.bellBus.frequency.value = 3200;
    this.bellBus.connect(this.main);
    this.arpBus = ctx.createBiquadFilter();
    this.arpBus.type = 'lowpass';
    this.arpBus.frequency.value = 1500;
    this.arpBus.connect(this.main);
    this.low = ctx.createGain(); // bass and heartbeat, kept out of the reverb
    this.low.connect(out);
    this.lowLevel = this.low.gain;
    this.lowLevel.value = 0;

    this.noise = noise;
    this.air = ctx.createGain();
    this.air.gain.value = AIR * m.air;
    this.air.connect(this.main);
  }

  /** Fades the score in from `at`. */
  start(at) {
    if (this.next != null) return;
    this.next = at;
    this.main.gain.setValueAtTime(0, at);
    this.main.gain.setTargetAtTime(LEVEL, at, 1.5);
    this.lowLevel.setValueAtTime(0, at);
    this.lowLevel.setTargetAtTime(LEVEL, at, 1.5);
    if (this.noise) {
      // A low, slowly breathing room tone: no hiss.
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 380;
      const breath = this.ctx.createOscillator();
      const depth = this.ctx.createGain();
      breath.frequency.value = 0.045;
      depth.gain.value = AIR * 0.4;
      breath.connect(depth).connect(this.air.gain);
      src.connect(lp).connect(this.air);
      src.start(at);
      breath.start(at);
    }
  }

  /** Moves to another mood: levels glide, and the next chord starts its music. */
  setMood(mood, at) {
    if (!MOODS[mood] || mood === this.mood) return;
    this.mood = mood;
    const m = MOODS[mood];
    this.padFilter.frequency.setTargetAtTime(m.cutoff, at, 2);
    this.air.gain.setTargetAtTime(AIR * m.air, at, 2);
    this.chordInSection = SECTION_CHORDS; // a new section, in the new mood's progressions
  }

  /** 0..1, how close a countdown is to running out. Read bar by bar: no automation churn. */
  setIntensity(value) {
    this.intensity = Math.max(0, Math.min(1, Number(value) || 0));
  }

  /**
   * Schedules every bar that starts before `time`. If the page stalled and the
   * score fell behind, it skips to the next bar instead of playing the missed
   * ones all at once.
   */
  scheduleUntil(time) {
    if (this.next == null) return;
    const now = this.ctx.currentTime;
    if (this.next < now) {
      const missed = Math.ceil((now - this.next) / BAR);
      this.next += missed * BAR;
      this.bars += missed;
      this.chordInSection = Math.min(SECTION_CHORDS, this.chordInSection + Math.ceil(missed / CHORD_BARS));
    }
    while (this.next < time) {
      this.bar(this.next, this.bars % CHORD_BARS);
      this.next += BAR;
      this.bars++;
    }
  }

  // ---- One bar ----------------------------------------------------------------

  bar(t, inChord) {
    const m = MOODS[this.mood];
    // In a stage (and at the win) the bass walks a little: a note every bar.
    const walking = this.mood === 'game' || this.mood === 'won';
    if (inChord === 0) {
      if (this.chordInSection >= SECTION_CHORDS) this.newSection();
      const name = this.progression[this.chordInSection];
      this.chord = CHORDS[name];
      this.barInSection = this.chordInSection * CHORD_BARS;
      this.chordInSection++;
      this.log(t, 'chord', name);
      this.pad(t, this.chord.pad, CHORD_BARS * BAR);
      this.bass(t, this.chord.bass, walking ? BAR : CHORD_BARS * BAR);
    } else {
      this.barInSection++;
      if (walking) this.bass(t, this.chord.bass, BAR, 0.6);
    }
    const phrase = this.phrases.get(this.barInSection);
    if (phrase) this.melody(t, phrase);
    const arp = m.arp + (this.mood === 'game' ? 0.4 * this.intensity : 0);
    if (arp > 0) this.arpeggio(t, arp);
    if (this.mood === 'game' && this.intensity > 0.05) this.heartbeat(t);
  }

  newSection() {
    const pool = PROGRESSIONS[MOODS[this.mood].prog];
    const choices = pool.filter((p) => p !== this.progression);
    this.progression = choices[Math.floor(this.rng() * choices.length)];
    this.chordInSection = 0;
    this.arpPattern = ARP_PATTERNS[Math.floor(this.rng() * ARP_PATTERNS.length)];
    // Plan the bell's phrases. Every few sections it rests altogether.
    this.phrases = new Map();
    const rest = this.sectionsSinceRest >= 2 && this.rng() < 0.4;
    this.sectionsSinceRest = rest ? 0 : this.sectionsSinceRest + 1;
    if (rest) return;
    const density = MOODS[this.mood].melody;
    for (let barInSection = 0; barInSection < SECTION_BARS; barInSection += CHORD_BARS) {
      if (this.rng() >= density) continue;
      this.phrases.set(barInSection, this.newPhrase());
    }
  }

  /** A motif with a fresh variation: never one of the last six heard (unless luck runs out). */
  newPhrase() {
    let phrase;
    let sign;
    for (let tries = 0; tries < 8; tries++) {
      phrase = {
        motif: Math.floor(this.rng() * MOTIFS.length),
        shift: Math.floor(this.rng() * 3) - 1,
        mirror: this.rng() < 0.3,
        low: this.rng() < 0.2,
        lag: this.rng() < 0.4 ? 0.5 : 0, // sometimes enter half a beat late
      };
      sign = `${phrase.motif}:${phrase.shift}:${phrase.mirror}:${phrase.low}`;
      if (!this.recent.includes(sign)) break;
    }
    this.recent = [...this.recent.slice(-5), sign];
    return phrase;
  }

  melody(t, phrase) {
    const tones = this.chord.tones;
    let at = phrase.lag * BEAT;
    for (const [step, beats] of MOTIFS[phrase.motif]) {
      const s = phrase.mirror ? tones.length - 1 - step : step;
      const i = Math.max(0, Math.min(tones.length - 1, s + phrase.shift));
      const note = tones[i] - (phrase.low ? 12 : 0);
      this.bell(t + at, note, beats);
      at += beats * BEAT;
    }
  }

  // ---- Voices -------------------------------------------------------------------

  log(t, layer, note) {
    this.record?.push({ t, layer, note, mood: this.mood });
  }

  /** A swelling chord of soft triangle waves, released into the next. */
  pad(t, notes, length) {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.setTargetAtTime(PAD, t, 0.8);
    env.gain.setTargetAtTime(0, t + length, 0.9);
    env.connect(this.padFilter);
    const end = t + length + 6 * 0.9;
    for (const note of notes) {
      for (const cents of [-5, 5]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = midi(note);
        osc.detune.value = cents;
        osc.connect(env);
        osc.start(t);
        osc.stop(end);
      }
    }
  }

  /** A round bass note, with its octave so small speakers can carry it. */
  bass(t, note, length, level = 1) {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.setTargetAtTime(BASS * level, t, 0.12);
    env.gain.setTargetAtTime(BASS * level * 0.55, t + 0.6, 1.2);
    env.gain.setTargetAtTime(0, t + length - 0.25, 0.35);
    env.connect(this.low);
    for (const [ratio, gain] of [
      [1, 1],
      [2, 0.35],
    ]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = midi(note) * ratio;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(env);
      osc.start(t);
      osc.stop(t + length + 2.5);
    }
    this.log(t, 'bass', note);
  }

  /** A glassy bell: soft attack, long ring, its overtone fading first. */
  bell(t, note, beats) {
    const ctx = this.ctx;
    const ring = Math.max(1.4, beats * BEAT * 1.8);
    for (const [ratio, level, decay] of [
      [1, BELL, ring / 4],
      [2, BELL * 0.22, ring / 9],
    ]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = midi(note) * ratio;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(level, t + 0.015);
      env.gain.setTargetAtTime(0, t + 0.015, decay);
      osc.connect(env).connect(this.bellBus);
      osc.start(t);
      osc.stop(t + 0.015 + 8 * decay);
    }
    this.log(t, 'bell', note);
  }

  /** A quiet plucked arpeggio over the chord, an octave up, in eighth notes. */
  arpeggio(t, density) {
    const notes = this.chord.pad.map((n) => n + 12);
    this.arpPattern.forEach((step, i) => {
      if (this.rng() >= density) return;
      const at = t + i * (BEAT / 2);
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midi(notes[step % notes.length]);
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(ARP, at + 0.008);
      env.gain.setTargetAtTime(0, at + 0.008, 0.16);
      osc.connect(env).connect(this.arpBus);
      osc.start(at);
      osc.stop(at + 0.008 + 8 * 0.16);
      this.log(at, 'arp', notes[step % notes.length]);
    });
  }

  /** A soft double heartbeat that quickens with the countdown's pressure. */
  heartbeat(t) {
    const every = this.intensity > 0.5 ? 1 : 2; // beats
    const level = BEAT_GAIN * (0.4 + 0.6 * this.intensity);
    for (let b = 0; b < 4; b += every) {
      for (const [offset, scale] of [
        [0, 1],
        [0.24, 0.7],
      ]) {
        const at = t + b * BEAT + offset;
        for (const [ratio, gain] of [
          [1, 1],
          [2, 0.3],
        ]) {
          const osc = this.ctx.createOscillator();
          osc.frequency.setValueAtTime(66 * ratio, at);
          osc.frequency.exponentialRampToValueAtTime(44 * ratio, at + 0.18);
          const env = this.ctx.createGain();
          env.gain.setValueAtTime(0, at);
          env.gain.linearRampToValueAtTime(level * scale * gain, at + 0.012);
          env.gain.setTargetAtTime(0, at + 0.012, 0.06);
          osc.connect(env).connect(this.low);
          osc.start(at);
          osc.stop(at + 0.6);
        }
      }
      this.log(t + b * BEAT, 'heartbeat', 0);
    }
  }
}
