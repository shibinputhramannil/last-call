// A small Chrome DevTools Protocol driver for the browser checks. It needs no
// extra packages, only an installed Chrome, Chromium or Edge (set CHROME_PATH
// to pick one). Each page gets its own browser context, so players never
// share storage.

/* global document */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

export function findChrome() {
  if (process.env.CHROME_PATH) return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  return CANDIDATES.find((p) => p && existsSync(p)) || null;
}

export async function launchChrome(executable) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'lastcall-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio'];
  if (process.getuid?.() === 0) args.push('--no-sandbox'); // Chrome refuses to sandbox as root, e.g. in containers
  const proc = spawn(executable, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start within 20 s')), 20_000);
    proc.stderr.on('data', (chunk) => {
      out += chunk;
      const m = out.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code})`));
    });
  });
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return new Browser(ws, proc, profile);
}

class Browser {
  constructor(ws, proc, profile) {
    this.ws = ws;
    this.proc = proc;
    this.profile = profile;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id) {
        const call = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) call?.reject(new Error(`${msg.error.message} ${msg.error.data || ''}`.trim()));
        else call?.resolve(msg.result);
        return;
      }
      for (const l of this.listeners) if (l.method === msg.method && l.sessionId === msg.sessionId) l.fn(msg.params);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** A page in a fresh browser context (its own storage), sized like a phone. */
  async newPage(viewport) {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId);
    page.targetId = targetId;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    page.errors = [];
    this.listeners.push({ method: 'Runtime.exceptionThrown', sessionId, fn: (p) => page.errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text) });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.viewport(viewport);
    return page;
  }

  async close() {
    try {
      await Promise.race([this.send('Browser.close'), new Promise((r) => setTimeout(r, 3_000))]);
    } catch {
      // already gone
    }
    this.proc.kill();
    this.ws.terminate();
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 300)); // Windows holds the profile briefly after exit
      }
    }
  }
}

class Page {
  constructor(browser, sessionId) {
    this.browser = browser;
    this.sessionId = sessionId;
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  close() {
    return this.browser.send('Target.closeTarget', { targetId: this.targetId });
  }

  /** Runs `fn(...args)` in the page and returns its (JSON) result. */
  async eval(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async waitFor(fn, args = [], timeout = 10_000) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await this.eval(fn, ...args).catch(() => null);
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${String(fn).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor(() => document.readyState === 'complete', [], 20_000);
  }

  /** Resizes like a phone turning; the orientation media query follows the size. */
  async viewport({ width, height }) {
    const landscape = width > height;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
    });
    await new Promise((r) => setTimeout(r, 350)); // the docked chat animates its height for 0.25 s
  }

  /** A real touch: finger down and up at a point. */
  async tap(x, y) {
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async type(text) {
    await this.send('Input.insertText', { text });
  }

  async press(key, code = key, keyCode = 0) {
    const text = key === 'Enter' ? '\r' : undefined;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  }
}
