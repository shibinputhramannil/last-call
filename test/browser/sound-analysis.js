// Renders the game's own sound engine offline, faster than real time and with
// no speakers, then measures what a player would hear. Each function runs
// inside a page (passed to page.eval), so each is self-contained.
//
// This is how sound is checked here: nobody listens. The numbers stand in for
// ears on the things that make game audio unpleasant:
// - peakDb, clips: how loud the loudest sample is; whether any reach full scale.
// - rmsDb, swingDb: the average level, and how far the 400 ms level wanders.
// - startleDb: the biggest jump of a 50 ms window over the second before it.
// - clickScore: the biggest sample-to-sample discontinuity, relative to the
//   level around it. Smooth sound stays well under 1; a hard start or stop of
//   a note (or a deliberate crackle) shows as a spike above it.
// - hfShare: the share of energy above 4 kHz, where sound turns piercing.

/* global OfflineAudioContext */

/**
 * Renders `seconds` of the engine at `engineUrl`: its music in `mood` (unless
 * prefs.music is 0), and optionally one sound effect at 0.5 s.
 */
export async function renderSound({ engineUrl, mood = 'menu', intensity = 0, seconds = 30, prefs, effect = null, effectOpt = {}, rate = 32000, skip = 6 }) {
  const { AudioEngine } = await import(engineUrl);
  const off = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  const engine = new AudioEngine(prefs);
  engine.setMood(mood);
  engine.ctx = off; // as if the player's first tap had created it
  engine.build(off);
  clearInterval(engine.scheduler); // the render drives the music instead of a timer
  engine.setIntensity(intensity);
  const step = 0.25;
  for (let t = step; t < seconds; t += step) {
    const at = Math.round(t * 1000) / 1000;
    off.suspend(at).then(() => {
      if (effect && at === 0.5) {
        engine.fx = engine.channel('scene');
        engine.effect(effect, effectOpt);
        engine.fx = null;
      }
      engine.scheduleMusic(off.currentTime);
      off.resume();
    });
  }
  engine.scheduleMusic(0);
  const buffer = await off.startRendering();

  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const n = L.length;
  const db = (p) => (p > 1e-12 ? 10 * Math.log10(p) : -120);
  let peak = 0;
  let clips = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (v > peak) peak = v;
    if (v >= 0.999) clips++;
  }
  // Mean power in windows of `w` samples, of the mid signal.
  const windows = (w) => {
    const out = [];
    for (let s = 0; s + w <= n; s += w) {
      let p = 0;
      for (let i = s; i < s + w; i++) {
        const m = (L[i] + R[i]) / 2;
        p += m * m;
      }
      out.push(p / w);
    }
    return out;
  };
  const from = effect ? 0 : Math.floor(skip / 0.05); // music: skip its fade-in
  const p50 = windows(Math.round(rate * 0.05));
  const p400 = windows(Math.round(rate * 0.4)).slice(effect ? 0 : Math.floor(skip / 0.4));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const rmsDb = db(mean(p400));
  const loud = p400.map(db);
  const swingDb = loud.length ? Math.max(...loud) - Math.min(...loud) : 0;
  let startleDb = 0;
  for (let k = Math.max(from, 20); k < p50.length; k++) {
    const before = mean(p50.slice(k - 20, k));
    if (before > 1e-9) startleDb = Math.max(startleDb, db(p50[k]) - db(before));
  }
  // Discontinuities: the second difference against the local 50 ms level.
  let clickScore = 0;
  const w50 = Math.round(rate * 0.05);
  for (let i = Math.max(2, from * w50); i < n; i++) {
    const level = Math.sqrt(p50[Math.min(p50.length - 1, Math.floor(i / w50))]) + 1e-4;
    const d2 = Math.max(Math.abs(L[i] - 2 * L[i - 1] + L[i - 2]), Math.abs(R[i] - 2 * R[i - 1] + R[i - 2]));
    if (d2 / level > clickScore) clickScore = d2 / level;
  }
  // Energy above 4 kHz, from 2048-point spectra every quarter second.
  const size = 2048;
  let hi = 0;
  let all = 0;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let s = from * w50; s + size <= n; s += Math.round(rate / 4)) {
    for (let i = 0; i < size; i++) {
      re[i] = ((L[s + i] + R[s + i]) / 2) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
      im[i] = 0;
    }
    for (let i = 1, j = 0; i < size; i++) {
      let bit = size >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const a = (-2 * Math.PI) / len;
      for (let i = 0; i < size; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const cr = Math.cos(a * k);
          const ci = Math.sin(a * k);
          const xr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const xi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k + len / 2] = re[i + k] - xr;
          im[i + k + len / 2] = im[i + k] - xi;
          re[i + k] += xr;
          im[i + k] += xi;
        }
      }
    }
    for (let k = 1; k < size / 2; k++) {
      const e = re[k] * re[k] + im[k] * im[k];
      all += e;
      if ((k * rate) / size >= 4000) hi += e;
    }
  }
  const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    peakDb: round(db(peak * peak)),
    clips,
    rmsDb: round(rmsDb),
    swingDb: round(swingDb),
    startleDb: round(startleDb),
    clickScore: round(clickScore, 2),
    hfShare: round(all ? (100 * hi) / all : 0, 2),
  };
}
