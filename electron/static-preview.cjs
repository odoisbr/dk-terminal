const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.pdf': 'application/pdf' };
const blocked = new Set(['node_modules']);
const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

function staticEntry(root) {
  try {
    const base = fs.realpathSync(root), entry = fs.realpathSync(path.join(base, 'index.html'));
    return inside(base, entry) && fs.statSync(entry).isFile();
  } catch { return false; }
}

// No directory listings, hidden files, cross-project symlinks, or arbitrary Host
// headers. The preview remains local and never executes project commands.
function createStaticServer(root, events) {
  const base = fs.realpathSync(root);
  if (!staticEntry(base)) throw new Error('O projeto não possui index.html acessível na raiz.');
  const sockets = new Set();
  let stopping = false;
  const server = http.createServer((req, res) => {
    const deny = code => { if (!res.headersSent) res.writeHead(code, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(); };
    if (!server.address() || req.headers.host !== `127.0.0.1:${server.address().port}`) return deny(403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405);
    let pathname;
    try { pathname = decodeURIComponent((req.url || '').split('?')[0]); } catch { return deny(400); }
    if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) return deny(400);
    const parts = pathname.split('/').filter(Boolean);
    if (parts.some(part => part.startsWith('.') || blocked.has(part.toLowerCase()))) return deny(403);
    const relative = parts.join('/') || 'index.html';
    let fd;
    try {
      let file = fs.realpathSync(path.join(base, relative));
      if (!inside(base, file)) return deny(403);
      if (fs.statSync(file).isDirectory()) file = fs.realpathSync(path.join(file, 'index.html'));
      if (!inside(base, file)) return deny(403);
      // A symlink may resolve to a hidden file even if its visible name is safe.
      if (path.relative(base, file).split(path.sep).some(part => part.startsWith('.') || blocked.has(part.toLowerCase()))) return deny(403);
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) { fs.closeSync(fd); return deny(404); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') { fs.closeSync(fd); return res.end(); }
      const stream = fs.createReadStream(null, { fd, autoClose: true });
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    } catch { if (fd !== undefined) try { fs.closeSync(fd); } catch {} return deny(404); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('error', error => events.error(error));
  server.on('close', () => events.close());
  server.listen(0, '127.0.0.1', () => {
    if (stopping) { server.close(); return; }
    events.ready(`http://127.0.0.1:${server.address().port}`);
  });
  return { close() { stopping = true; server.close(); for (const socket of sockets) socket.destroy(); } };
}
module.exports = { staticEntry, createStaticServer, TYPES };
