'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveFile, readBounded } = require('./files.cjs');

const PRIVILEGES = { scheme: 'dk-preview', privileges: { standard: true, secure: true, corsEnabled: true } };
const TOKEN = /^[0-9a-f]{32}$/;
const CSS_LIMIT = 1024 * 1024;
const ASSET_LIMIT = 4 * 1024 * 1024;
const TYPES = new Map([
  ['.css', 'text/css'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
]);
const COMMON = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const deny = status => new Response(null, { status, headers: COMMON });

function documentCsp(token, nonce) {
  const source = `dk-preview://${token}`;
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${source} 'unsafe-inline'; img-src ${source} data:; font-src ${source} data:; media-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors dk-app://app; sandbox allow-scripts`;
}

function validRelative(relative) {
  return typeof relative === 'string' && relative.length > 0 && relative.length <= 8192
    && !/[%\0\\]/.test(relative)
    && !path.posix.isAbsolute(relative) && !path.win32.isAbsolute(relative)
    && !relative.split('/').some(part => {
      const normalized = part.normalize('NFKC').toLowerCase();
      return !normalized || normalized.startsWith('.') || normalized === 'node_modules';
    });
}

function parseRequestUrl(raw) {
  if (typeof raw !== 'string' || /[\x00-\x20\x7f]/.test(raw)) return { status: 400 };
  // Inspect the supplied path before URL removes literal/encoded dot segments.
  const match = /^dk-preview:\/\/([^/?#]*)(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/i.exec(raw);
  if (!match) return { status: 404 };
  const rawPath = match[2] || '';
  if (/%(?:2e|2f|5c|00)/i.test(rawPath) || rawPath.includes('\\') || rawPath.includes('//')) return { status: 400 };
  let relative, url;
  try {
    relative = decodeURIComponent(rawPath.slice(1));
    url = new URL(raw);
  } catch { return { status: 400 }; }
  if (!validRelative(relative)) return { status: 400 };
  // No credentials, port, escaped host or other aliases for a session token.
  if (!TOKEN.test(match[1]) || url.host !== match[1] || url.username || url.password) return { status: 404 };
  return { url, relative };
}

function sameRoot(session) {
  const stat = fs.lstatSync(session.root);
  return stat.isDirectory() && stat.dev === session.dev && stat.ino === session.ino;
}

/**
 * @typedef {object} PreviewSession
 * @property {string} token Active token: 32 lowercase hexadecimal characters.
 * @property {string} root Absolute realpath of the project root (any spelling; compared via realpath.native).
 * @property {number} dev Root device from lstatSync (number, not bigint).
 * @property {number} ino Root inode from lstatSync (number, not bigint).
 * @property {string} relative Decoded document path relative to root, in POSIX form.
 * @property {number} gen Current generation: a safe integer >= 0.
 * @property {string} nonce Script nonce for the current generation.
 * @property {() => Buffer} document Returns the served copy of the current generation.
 * @property {(bytes: number) => boolean} countRequest Counts one request and reserves
 * bytes (a nonnegative integer); false above 2000 requests or 64 MiB. Both counters
 * reset each generation and cover the document and subresources. Rejections before
 * reservation count with zero bytes; a reservation remains charged if reading fails.
 */
/**
 * @typedef {object} PreviewSessions
 * @property {(token: string) => (PreviewSession | null)} byToken Returns the active
 * session with its current generation and budget, or null for unknown/revoked tokens.
 */
/**
 * All work stays synchronous inside the async handler so no await splits checks.
 * @param {PreviewSessions} sessions
 * @returns {(request: Request & { initiatorOrigin: string }) => Promise<Response>}
 */
function createHandler(sessions) {
  // Key by token/generation, since byToken may return a fresh view of a session.
  const exhausted = new Map();
  return async request => {
    let session, counted = false;
    const reserve = bytes => {
      counted = true;
      const allowed = session.countRequest(bytes);
      if (!allowed) exhausted.set(session.token, session.gen);
      return allowed;
    };
    const reject = status => {
      if (status === 404 && session && !counted) {
        try { if (!reserve(0)) return deny(429); } catch { /* Internal failures stay opaque. */ }
      }
      return deny(status);
    };
    try {
      if (request.method !== 'GET') return deny(405);
      const { url, relative, status } = parseRequestUrl(request.url);
      if (status) return deny(status);
      const active = sessions.byToken(url.host);
      if (!active || active.token !== url.host) {
        exhausted.delete(url.host);
        return deny(404);
      }
      session = active;
      // After the first refusal, even missing resources must avoid stat/realpath.
      if (exhausted.get(session.token) === session.gen) return deny(429);
      exhausted.delete(session.token);

      let body;
      const headers = { ...COMMON };
      if (relative === session.relative) {
        if (request.initiatorOrigin !== 'dk-app://app') return reject(404);
        const generations = url.searchParams.getAll('g');
        if (generations.length !== 1 || generations[0] !== String(session.gen)) return deny(410);
        if (!sameRoot(session)) return reject(404);
        body = session.document();
        if (!Buffer.isBuffer(body)) return reject(404);
        if (!reserve(body.length)) return deny(429);
        headers['Content-Type'] = 'text/html; charset=utf-8';
        headers['Content-Security-Policy'] = documentCsp(session.token, session.nonce);
      } else {
        if (request.initiatorOrigin !== 'null') return reject(404);
        const type = TYPES.get(path.extname(relative).toLowerCase());
        if (!type || !sameRoot(session)) return reject(404);
        const file = resolveFile(session.root, relative);
        // Native realpath also resolves filesystem spelling/case aliases on APFS.
        file.absolute = fs.realpathSync.native(file.absolute);
        if (!validRelative(path.relative(fs.realpathSync.native(session.root), file.absolute).split(path.sep).join('/'))) return reject(404);
        const realType = TYPES.get(path.extname(file.absolute).toLowerCase());
        // Only equivalent MIME types (e.g. .jpg/.jpeg) may alias one another.
        if (!realType || realType !== type) return reject(404);
        const limit = realType === 'text/css' ? CSS_LIMIT : ASSET_LIMIT;
        if (file.stat.size > limit) return reject(404);
        if (!reserve(file.stat.size)) return deny(429);
        // Residual TOCTOU: intermediate directories can change between resolveFile
        // and readBounded; O_NOFOLLOW protects only the last component. Root dev/ino
        // is checked before and after reading. Growth beyond the reservation is refused.
        body = readBounded(file, Math.min(limit, file.stat.size));
        if (!body) return reject(404);
        headers['Content-Type'] = realType;
        if (realType === 'image/svg+xml') headers['Content-Security-Policy'] = SVG_CSP;
        if (realType.startsWith('font/')) headers['Access-Control-Allow-Origin'] = '*';
      }
      if (!sameRoot(session)) return reject(404);
      return new Response(body, { status: 200, headers });
    } catch { return reject(404); }
  };
}

/**
 * @param {{ token: string, relative: string, gen: number }} sessionInfo
 * @returns {string} Canonical document URL; throws TypeError for invalid session info.
 */
function documentUrl({ token, relative, gen }) {
  if (typeof token !== 'string' || !TOKEN.test(token) || !validRelative(relative)
    || !Number.isSafeInteger(gen) || gen < 0) throw new TypeError('Invalid preview session info.');
  const encoded = relative.split('/').map(encodeURIComponent).join('/');
  return `dk-preview://${token}/${encoded}?g=${gen}`;
}

// sessionInfo is the current { token, relative, gen }; compare the canonical URL
// byte for byte, including encoding and query, so fragments/aliases cannot navigate.
function frameNavigationAllowed(url, sessionInfo) {
  if (typeof url !== 'string') return false;
  try { return url === documentUrl(sessionInfo); } catch { return false; }
}

// Scheme recognition is intentionally broader than authorization (e.g. downloads).
function isPreviewUrl(url) {
  if (typeof url !== 'string') return false;
  try { return new URL(url).protocol === 'dk-preview:'; } catch { return false; }
}

module.exports = { PRIVILEGES, documentCsp, documentUrl, createHandler, frameNavigationAllowed, isPreviewUrl };
