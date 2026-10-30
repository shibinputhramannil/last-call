import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

export function securityHeaders(req) {
  const host = req.headers.host || '';
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self' ws://${host} wss://${host}`,
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const headers = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // Room codes live in the URL; never leak them to font hosts or other sites.
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  // Only over real HTTPS (see app.js isHttps), so local http://localhost keeps working.
  if (req.isHttps) headers['Strict-Transport-Security'] = 'max-age=15552000';
  return headers;
}

/**
 * Serves files from `mounts` ({ urlPrefix: absoluteDir }). Returns false when
 * nothing matched so the caller can send a 404.
 */
export function createStaticHandler(mounts) {
  const entries = Object.entries(mounts).sort((a, b) => b[0].length - a[0].length);

  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (decoded.includes('\0')) return false;

    for (const [prefix, dir] of entries) {
      if (!decoded.startsWith(prefix)) continue;
      let rel = decoded.slice(prefix.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(dir, '.' + path.posix.normalize('/' + rel));
      if (!file.startsWith(dir + path.sep)) return false;
      let info;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;

      const ext = path.extname(file).toLowerCase();
      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      const headers = {
        ...securityHeaders(req),
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ETag: etag,
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return true;
      }
      headers['Content-Length'] = info.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
      } else {
        createReadStream(file).pipe(res);
      }
      return true;
    }
    return false;
  };
}
