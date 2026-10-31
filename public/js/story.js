// The opening: a short story told one page at a time, with Back, Next and an
// always-visible Skip. Shown on a first visit; replayable from Settings.

import { OPENING } from '/shared/story.js';
import { $, h, clear, announce, prefersReducedMotion } from './dom.js';

// Each page's lamp: amber for the exchange, violet for the manual, and so on.
const LAMPS = ['amber', 'amber', 'amber', 'violet', 'green', 'amber'];

export function runOpening({ audio, onDone }) {
  const screen = $('#screen-story');
  const page = $('#story-page');
  const back = $('#story-back');
  const next = $('#story-next');
  const skip = $('#story-skip');
  const dots = $('#story-dots');
  const lamp = $('#story-lamp');
  let index = 0;
  let finished = false;

  clear(dots);
  OPENING.forEach(() => dots.append(h('li', {})));

  function show(i, direction = 1) {
    index = Math.max(0, Math.min(OPENING.length - 1, i));
    const p = OPENING[index];
    const last = index === OPENING.length - 1;
    clear(page).append(h('p', { class: 'story-kicker' }, p.kicker), h('p', { class: 'story-text' }, p.text));
    page.dataset.dir = direction > 0 ? 'next' : 'back';
    if (!prefersReducedMotion()) {
      page.classList.remove('is-turning');
      void page.offsetWidth;
      page.classList.add('is-turning');
    }
    lamp.dataset.color = LAMPS[index] || 'amber';
    back.disabled = index === 0;
    next.textContent = last ? 'Pick up the receiver' : 'Next';
    next.classList.toggle('is-final', last);
    [...dots.children].forEach((dot, d) => dot.classList.toggle('is-on', d <= index));
    dots.setAttribute('aria-label', `Page ${index + 1} of ${OPENING.length}`);
    announce(`${p.kicker}. ${p.text}`);
  }

  function finish() {
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onKey);
    next.removeEventListener('click', onNext);
    back.removeEventListener('click', onBack);
    skip.removeEventListener('click', finish);
    audio.unlock();
    audio.play('pickup');
    onDone();
  }

  function onNext() {
    audio.unlock();
    if (index === OPENING.length - 1) finish();
    else {
      audio.play('page');
      show(index + 1, 1);
    }
  }
  function onBack() {
    if (index > 0) {
      audio.play('page');
      show(index - 1, -1);
    }
  }
  function onKey(e) {
    if (screen.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.querySelector('#settings:not([hidden])')) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onNext();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onBack();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish();
    }
  }

  next.addEventListener('click', onNext);
  back.addEventListener('click', onBack);
  skip.addEventListener('click', finish);
  document.addEventListener('keydown', onKey);
  show(0);
  next.focus();
}
