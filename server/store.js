import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Room persistence. With DATA_DIR set, each room is written to its own JSON
 * file (atomically: temp file, then rename) shortly after it changes, and every
 * room is read back when the server starts, so a restart or redeploy resumes
 * games in progress. Without DATA_DIR nothing is written and rooms live only in
 * memory (browsers still keep signed campaign progress and room tickets).
 */
export function createStore({ dataDir = null, log } = {}) {
  if (!dataDir) return memoryStore();
  const roomsDir = path.join(dataDir, 'rooms');
  mkdirSync(roomsDir, { recursive: true });
  const file = (code) => path.join(roomsDir, `${code}.json`);

  return {
    persistent: true,
    loadAll() {
      const out = [];
      for (const name of readdirSync(roomsDir)) {
        if (!/^[A-Z0-9]{6}\.json$/.test(name)) continue;
        try {
          out.push(JSON.parse(readFileSync(path.join(roomsDir, name), 'utf8')));
        } catch (err) {
          log?.warn('skipped an unreadable saved room', { file: name, err: err.message });
        }
      }
      return out;
    },
    save(code, data) {
      const target = file(code);
      const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(temp, JSON.stringify(data));
      renameSync(temp, target);
    },
    remove(code) {
      rmSync(file(code), { force: true });
    },
  };
}

function memoryStore() {
  return { persistent: false, loadAll: () => [], save() {}, remove() {} };
}

/**
 * The secret that signs progress and tickets: SAVE_SECRET if set, otherwise
 * one generated once and kept in DATA_DIR, otherwise a random one for this
 * process only (signed saves then stop verifying after a restart).
 */
export function resolveSecret({ secret, dataDir }) {
  if (secret) return { secret, source: 'env' };
  if (dataDir) {
    const keyFile = path.join(dataDir, 'save-secret.key');
    try {
      const existing = readFileSync(keyFile, 'utf8').trim();
      if (existing.length >= 32) return { secret: existing, source: 'data-dir' };
    } catch {
      // first run
    }
    mkdirSync(dataDir, { recursive: true });
    const created = randomBytes(32).toString('base64url');
    writeFileSync(keyFile, created, { mode: 0o600 });
    return { secret: created, source: 'data-dir' };
  }
  return { secret: randomBytes(32).toString('base64url'), source: 'ephemeral' };
}
