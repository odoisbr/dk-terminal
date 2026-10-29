const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { TYPES } = require('./static-preview.cjs');

// Prévia de arquivos e pastas pedida pelo comando `dock-preview`. Um servidor por
// projeto, só em 127.0.0.1, atrás de um prefixo secreto (o endereço é a capacidade):
// outro usuário da máquina não enumera o projeto só por descobrir a porta.
// Toda solicitação revalida o caminho real: sem symlink para fora da raiz, sem
// arquivos ocultos e sem node_modules.
const MARKDOWN = new Set(['.md', '.markdown']);
const MAX_MARKDOWN = 2 * 1024 * 1024;
const MAX_LISTING = 500;
const blocked = new Set(['node_modules']);
const COMMON = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const GENERATED_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

class PreviewTargetError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const forbiddenPart = part => part.startsWith('.') || blocked.has(part.toLowerCase());
const previewable = file => MARKDOWN.has(path.extname(file).toLowerCase()) || Object.prototype.hasOwnProperty.call(TYPES, path.extname(file).toLowerCase());
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const encodePath = relative => relative.split(path.sep).filter(Boolean).map(encodeURIComponent).join('/');

// Resolve o alvo pedido pela sessão e devolve o caminho relativo à raiz real.
function resolveTarget(root, target) {
  if (typeof target !== 'string' || !target || target.length > 4096 || target.includes('\0')) throw new PreviewTargetError(400, 'Caminho de prévia inválido.');
  let base;
  try { base = fs.realpathSync(root); } catch { throw new PreviewTargetError(409, 'A pasta do projeto desta sessão não está mais acessível.'); }
  const requested = path.isAbsolute(target) ? target : path.join(base, target);
  let real;
  try { real = fs.realpathSync(requested); } catch { throw new PreviewTargetError(404, `Arquivo ou pasta não encontrado: ${target}. Confira o caminho a partir da pasta atual.`); }
  if (!inside(base, real)) throw new PreviewTargetError(403, `O alvo fica fora do projeto desta sessão (${base}). Só arquivos dentro do projeto podem ser apresentados.`);
  const relative = path.relative(base, real);
  if (relative.split(path.sep).filter(Boolean).some(forbiddenPart)) throw new PreviewTargetError(403, 'Arquivos ocultos e node_modules não são servidos na prévia. Use um arquivo visível do projeto.');
  const stat = fs.statSync(real);
  if (stat.isDirectory()) return { base, relative, directory: true };
  if (!stat.isFile()) throw new PreviewTargetError(415, 'O alvo precisa ser um arquivo comum ou uma pasta.');
  if (!previewable(real)) throw new PreviewTargetError(415, `Tipo de arquivo sem prévia (${path.extname(real) || 'sem extensão'}). Use HTML, imagem (png, jpg, svg, gif, webp), PDF, Markdown ou uma pasta.`);
  return { base, relative, directory: false };
}

function inline(text) {
  // Escapa primeiro; trechos de código ficam fora das demais substituições.
  const codes = [];
  let html = escapeHTML(text).replace(/`([^`]+)`/g, (_m, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000`; });
  const safe = href => /^(?:https?:|mailto:|#|\.{0,2}\/|[^:]*$)/i.test(href) ? href : '#';
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img alt="${alt}" src="${safe(src)}">`);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => `<a href="${safe(href)}">${label}</a>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return html.replace(/\u0000(\d+)\u0000/g, (_m, index) => `<code>${codes[Number(index)]}</code>`);
}

// Markdown suficiente para apresentar documentos de projeto, sem HTML do autor.
function renderMarkdown(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [], list = null, fence = null;
  const flushParagraph = () => { if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`); paragraph = []; };
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };
  for (const line of lines) {
    if (fence !== null) {
      if (/^\s*```/.test(line)) { out.push(`<pre><code>${escapeHTML(fence.join('\n'))}</code></pre>`); fence = null; } else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flushParagraph(); closeList(); fence = []; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/), ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim()) { flushParagraph(); closeList(); }
    else if (heading) { flushParagraph(); closeList(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
    else if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { flushParagraph(); closeList(); out.push('<hr>'); }
    else if (/^\s*>/.test(line)) { flushParagraph(); closeList(); out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`); }
    else if (bullet || ordered) {
      flushParagraph();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((bullet || ordered)[1])}</li>`);
    } else { closeList(); paragraph.push(line.trim()); }
  }
  if (fence !== null) out.push(`<pre><code>${escapeHTML(fence.join('\n'))}</code></pre>`);
  flushParagraph(); closeList();
  return out.join('\n');
}

function page(title, body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHTML(title)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d2327;--muted:#5b6770;--line:#d9dee2;--card:#f5f7f8}
@media (prefers-color-scheme:dark){:root{--bg:#15191b;--fg:#e4eaec;--muted:#97a3a9;--line:#2c3439;--card:#1d2326}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 24px}img{max-width:100%}a{color:#1f7a8c}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto}code{font:13px 'SFMono-Regular',Menlo,monospace}
blockquote{margin:0;padding-left:14px;border-left:3px solid var(--line);color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;padding:0;list-style:none}
.grid li{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--card)}
.grid a{display:block;padding:10px 12px;text-decoration:none;word-break:break-word}.grid img{display:block;width:100%;height:160px;object-fit:contain;background:var(--bg)}
.note{color:var(--muted)}
</style></head><body><main>${body}</main></body></html>`;
}

function gallery(base, directory) {
  const relative = path.relative(base, directory);
  const items = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
    if (items.length >= MAX_LISTING) break;
    if (forbiddenPart(entry.name)) continue;
    let real, stat;
    try { real = fs.realpathSync(path.join(directory, entry.name)); stat = fs.statSync(real); } catch { continue; }
    if (!inside(base, real) || path.relative(base, real).split(path.sep).filter(Boolean).some(forbiddenPart)) continue;
    const href = encodeURIComponent(entry.name) + (stat.isDirectory() ? '/' : '');
    if (stat.isDirectory()) items.push(`<li><a href="${href}">${escapeHTML(entry.name)}/</a></li>`);
    else if (stat.isFile() && previewable(entry.name)) {
      const image = /^image\//.test(TYPES[path.extname(entry.name).toLowerCase()] || '');
      items.push(`<li><a href="${href}">${image ? `<img loading="lazy" alt="" src="${href}">` : ''}${escapeHTML(entry.name)}</a></li>`);
    }
  }
  const name = relative || path.basename(base);
  const body = `<h1>${escapeHTML(name)}</h1>` + (items.length ? `<ul class="grid">${items.join('')}</ul>` : '<p class="note">Nenhum arquivo com prévia nesta pasta.</p>');
  return page(name, body);
}

function createFileServer(root) {
  const base = fs.realpathSync(root);
  const secret = randomBytes(16).toString('hex');
  const prefix = `/${secret}`;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const send = (status, headers, body) => { if (!res.headersSent) res.writeHead(status, { ...COMMON, ...headers }); res.end(body); };
    const deny = status => send(status, {});
    if (!server.address() || req.headers.host !== `127.0.0.1:${server.address().port}`) return deny(403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405);
    const raw = (req.url || '').split('?')[0];
    let pathname;
    try { pathname = decodeURIComponent(raw); } catch { return deny(400); }
    if (pathname === prefix) return send(301, { Location: `${prefix}/` });
    if (!pathname.startsWith(prefix + '/')) return deny(404);
    pathname = pathname.slice(prefix.length);
    if (pathname.includes('\0') || pathname.includes('\\')) return deny(400);
    const parts = pathname.split('/').filter(Boolean);
    if (parts.some(forbiddenPart)) return deny(403);
    let fd;
    try {
      let file = fs.realpathSync(path.join(base, ...parts));
      if (!inside(base, file)) return deny(403);
      if (path.relative(base, file).split(path.sep).filter(Boolean).some(forbiddenPart)) return deny(403);
      if (fs.statSync(file).isDirectory()) {
        if (!raw.endsWith('/')) return send(301, { Location: `${raw}/` });
        const index = path.join(file, 'index.html');
        let entry = null;
        try { entry = fs.realpathSync(index); if (!inside(base, entry) || !fs.statSync(entry).isFile() || path.relative(base, entry).split(path.sep).some(forbiddenPart)) entry = null; } catch {}
        if (!entry) {
          const html = gallery(base, file);
          return send(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': GENERATED_CSP }, req.method === 'HEAD' ? undefined : html);
        }
        file = entry;
      }
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) { fs.closeSync(fd); return deny(404); }
      const extension = path.extname(file).toLowerCase();
      if (MARKDOWN.has(extension)) {
        if (stat.size > MAX_MARKDOWN) { fs.closeSync(fd); return send(413, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Markdown muito grande para a prévia (limite de 2 MB).'); }
        const text = fs.readFileSync(fd, 'utf8'); fs.closeSync(fd); fd = undefined;
        const html = page(path.basename(file), renderMarkdown(text));
        return send(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': GENERATED_CSP }, req.method === 'HEAD' ? undefined : html);
      }
      res.writeHead(200, { ...COMMON, 'Content-Type': TYPES[extension] || 'application/octet-stream', 'Content-Length': stat.size });
      if (req.method === 'HEAD') { fs.closeSync(fd); return res.end(); }
      const stream = fs.createReadStream(null, { fd, autoClose: true });
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    } catch { if (fd !== undefined) try { fs.closeSync(fd); } catch {} return deny(404); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}${prefix}`));
  });
  return { base, ready, close() { server.close(); for (const socket of sockets) socket.destroy(); } };
}

class FilePreviews {
  constructor() { this.servers = new Map(); }
  async url(root, target) {
    const resolved = resolveTarget(root, target);
    let entry = this.servers.get(root);
    if (!entry || entry.base !== resolved.base) {
      entry?.close();
      entry = createFileServer(resolved.base);
      this.servers.set(root, entry);
      entry.ready.catch(() => { if (this.servers.get(root) === entry) this.servers.delete(root); });
    }
    let origin;
    try { origin = await entry.ready; } catch { throw new PreviewTargetError(503, 'O servidor de prévia de arquivos não pôde iniciar. Tente novamente.'); }
    const suffix = encodePath(resolved.relative);
    return `${origin}/${suffix}${resolved.directory && suffix ? '/' : ''}`;
  }
  close(root) { const entry = this.servers.get(root); if (entry) { this.servers.delete(root); entry.close(); } }
  closeAll() { for (const root of [...this.servers.keys()]) this.close(root); }
}

module.exports = { FilePreviews, PreviewTargetError, resolveTarget, renderMarkdown, createFileServer };
