// The Settings panel: sound, motion, readability and the opening story.
// Preferences live in this browser and apply immediately.

import { $, $$ } from './dom.js';
import { loadPrefs, savePrefs } from './store.js';

const TEXT_SCALE = { standard: 1, large: 1.15, larger: 1.3 };
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Puts preferences on the root element, where the stylesheet and scripts read them. */
export function applyPrefs(prefs) {
  const root = document.documentElement;
  const reduce = prefs.motion === 'reduce' || (prefs.motion === 'system' && motionQuery.matches);
  root.dataset.motion = reduce ? 'reduce' : 'full';
  root.style.setProperty('--text-scale', String(TEXT_SCALE[prefs.textSize] || 1));
  root.dataset.contrast = prefs.contrast === 'high' ? 'high' : 'standard';
  root.dataset.manualFont = prefs.manualFont === 'plain' ? 'plain' : 'typewriter';
}

export function setupSettings({ audio, onReplayOpening, onShare }) {
  let prefs = loadPrefs();
  applyPrefs(prefs);
  audio.setPrefs(prefs.audio);
  motionQuery.addEventListener('change', () => applyPrefs(prefs));

  const button = $('#settings-btn');
  const panel = $('#settings');
  const mute = $('#set-mute');
  const sliders = { master: $('#set-master'), music: $('#set-music'), sfx: $('#set-sfx') };
  const note = $('#set-audio-note');

  const save = (patch) => {
    prefs = { ...prefs, ...patch };
    savePrefs(prefs);
    applyPrefs(prefs);
    sync();
  };
  const saveAudio = (patch) => {
    audio.setPrefs(patch);
    save({ audio: { ...audio.prefs } });
  };

  function sync() {
    mute.checked = prefs.audio.muted;
    for (const [key, el] of Object.entries(sliders)) {
      el.value = String(Math.round(prefs.audio[key] * 100));
      el.setAttribute('aria-valuetext', `${el.value} percent`);
    }
    for (const radio of $$('[name="set-motion"]')) radio.checked = radio.value === prefs.motion;
    for (const radio of $$('[name="set-text"]')) radio.checked = radio.value === prefs.textSize;
    $('#set-contrast').checked = prefs.contrast === 'high';
    $('#set-manual-font').checked = prefs.manualFont !== 'plain';
    note.textContent = {
      on: prefs.audio.muted ? 'Sound is muted.' : 'Sound is on.',
      off: 'Sound starts after you first tap, click or press a key.',
      paused: 'Your browser paused the sound. Tap or press a key to turn it back on.',
      unavailable: 'Sound is not available in this browser. Everything else works as normal.',
    }[audio.status];
    button.classList.toggle('is-muted', prefs.audio.muted);
  }

  mute.addEventListener('change', () => {
    audio.unlock();
    saveAudio({ muted: mute.checked });
  });
  for (const [key, el] of Object.entries(sliders)) {
    el.addEventListener('input', () => {
      saveAudio({ [key]: Number(el.value) / 100, ...(key === 'master' ? { muted: false } : {}) });
      if (key === 'sfx') audio.play('click');
    });
  }
  for (const radio of $$('[name="set-motion"]')) radio.addEventListener('change', () => save({ motion: radio.value }));
  for (const radio of $$('[name="set-text"]')) radio.addEventListener('change', () => save({ textSize: radio.value }));
  $('#set-contrast').addEventListener('change', (e) => save({ contrast: e.target.checked ? 'high' : 'standard' }));
  $('#set-manual-font').addEventListener('change', (e) => save({ manualFont: e.target.checked ? 'typewriter' : 'plain' }));
  $('#set-replay').addEventListener('click', () => {
    close(false);
    onReplayOpening();
  });
  $('#set-share').addEventListener('click', () => onShare());

  function open() {
    sync();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    $('#settings-title').focus();
  }
  function close(returnFocus = true) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
  }

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  $('#settings-close').addEventListener('click', () => close());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      e.stopPropagation();
      close();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) close(false);
  });
  audio.onChange(sync);
  sync();

  return { open, close };
}
