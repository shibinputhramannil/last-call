// Tiny DOM helpers. User-provided text is only ever set through textContent.

const SVG_NS = 'http://www.w3.org/2000/svg';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function apply(node, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.setAttribute('class', value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') {
      // The content security policy forbids style attributes; the CSSOM is allowed.
      for (const decl of String(value).split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) node.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** h('p', { class: 'x' }, 'text', child) */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  apply(node, props);
  append(node, children);
  return node;
}

export function s(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, props);
  append(node, children);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

/** True when motion should be minimal: the player's setting, or their device's if they chose "match my device". */
export const prefersReducedMotion = () => document.documentElement.dataset.motion === 'reduce';

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** "4 min 05 s" style, for score explanations. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m ? `${m} min ${String(sec).padStart(2, '0')} s` : `${sec} s`;
}

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

let announceTimer;
/** Speaks a short message to screen readers. */
export function announce(text) {
  const region = $('#sr-announce');
  if (!region) return;
  region.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => (region.textContent = text), 50);
}

export function toast(text, kind = 'info', ms = 4200) {
  const region = $('#toasts');
  const node = h('div', { class: `toast ${kind === 'error' ? 'is-error' : kind === 'good' ? 'is-good' : ''}`, role: 'status' }, text);
  region.append(node);
  while (region.children.length > 3) region.firstChild.remove();
  setTimeout(() => node.remove(), ms);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers / insecure contexts.
    const area = h('textarea', { 'aria-hidden': 'true' });
    area.value = text;
    area.style.setProperty('position', 'fixed');
    area.style.setProperty('opacity', '0');
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
