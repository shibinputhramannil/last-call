// Lets Node run browser modules that import by web path ("/shared/x.js"), as
// public/js/*.js do. Register before importing one:
//   import { register } from 'node:module';
//   register('./support/web-imports.js', import.meta.url);

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/shared/') || specifier.startsWith('/js/')) {
    const file = specifier.startsWith('/js/') ? path.join(ROOT, 'public', specifier) : path.join(ROOT, specifier);
    return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
