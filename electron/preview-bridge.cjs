const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const { localURL } = require('./browser.cjs');

const REQUEST_SHAPES = new Set(['url', 'title,url', 'path', 'path,title']);
function previewTitle(value) {
  if (typeof value !== 'string' || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Título inválido.');
  return value.trim();
}

// Capability tokens belong to one project and never appear in a URL or UI.
class PreviewBridge {
  // resolvePath(root, path) devolve o endereço local da prévia de um arquivo ou pasta
  // do projeto (ou lança erro com status). Sem ele, a ponte aceita só URLs.
  constructor(dispatch, { resolvePath = null } = {}) { this.dispatch = dispatch; this.resolvePath = resolvePath; this.tokens = new Map(); this.pending = new Map(); this.server = null; this.port = null; }
  async start() {
    this.server = http.createServer((req, res) => this.receive(req, res));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.port = this.server.address().port;
  }
  environment(root) {
    if (!this.port) return { DK_TERMINAL_PROJECT: root, DK_TERMINAL_PREVIEW_UNAVAILABLE: '1' };
    let token = this.tokens.get(root);
    if (!token) { token = randomBytes(32).toString('hex'); this.tokens.set(root, token); }
    return { DK_TERMINAL_PREVIEW_PORT: String(this.port), DK_TERMINAL_PREVIEW_TOKEN: token, DK_TERMINAL_PROJECT: root };
  }
  receive(req, res) {
    const reply = (status, value) => { if (!res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); } };
    if (req.method !== 'POST' || req.url !== '/preview' || req.headers.host !== `127.0.0.1:${this.port}` || req.headers.origin || req.headers['content-type'] !== 'application/json') return reply(403, { error: 'Solicitação não autorizada.' });
    const token = req.headers.authorization;
    const entry = [...this.tokens].find(([, key]) => token === `Bearer ${key}`);
    if (!entry) return reply(403, { error: 'Sessão não autorizada.' });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; if (body.length > 10000) { reply(413, { error: 'Solicitação muito grande.' }); req.destroy(); } });
    req.on('end', () => { if (!res.writableEnded) void this.request(entry[0], body, reply); });
  }
  async request(root, body, reply) {
    let data, url, title;
    try {
      data = JSON.parse(body);
      const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort().join() : '';
      // Formatos aceitos: {url} (dk-visualizar do kit), {url,title}, {path}, {path,title}.
      if (!REQUEST_SHAPES.has(keys)) throw new Error();
      if (data.title !== undefined) title = previewTitle(data.title);
      if (data.url !== undefined) url = localURL(data.url);
      else if (typeof data.path !== 'string' || !data.path || data.path.length > 4096 || data.path.includes('\0')) throw new Error();
    } catch { return reply(400, { error: 'Endereço de prévia inválido.' }); }
    if (url === undefined) {
      if (!this.resolvePath) return reply(400, { error: 'Esta versão do SEA Dock não abre arquivos pela ponte de prévia.' });
      try { url = localURL(await this.resolvePath(root, data.path)); }
      catch (error) { return reply(Number.isInteger(error?.status) ? error.status : 500, { error: Number.isInteger(error?.status) ? error.message : 'Não foi possível preparar a prévia do arquivo.' }); }
      // O projeto pode ter sido fechado enquanto o arquivo era preparado.
      if (!this.tokens.has(root)) return reply(403, { error: 'Sessão não autorizada.' });
    }
    const id = randomUUID();
    const timer = setTimeout(() => { this.pending.delete(id); reply(504, { error: 'O SEA Dock não confirmou a prévia. Deixe a janela do app aberta e repita.' }); }, 8000);
    this.pending.set(id, { root, reply, timer, url });
    try { this.dispatch(title === undefined ? { id, root, url } : { id, root, url, title }); } catch { this.finish(id, false); }
  }
  finish(id, ok) {
    const item = this.pending.get(id); if (!item) return;
    this.pending.delete(id); clearTimeout(item.timer);
    item.reply(ok === true ? 200 : 409, ok === true ? { opened: true, url: item.url } : { error: 'Não foi possível abrir a prévia: selecione o projeto desta sessão na janela do SEA Dock e repita.' });
  }
  revoke(root) { this.tokens.delete(root); for (const [id, item] of this.pending) if (item.root === root) this.finish(id, false); }
  revokeAll() { for (const id of this.pending.keys()) this.finish(id, false); this.tokens.clear(); }
  close() { this.revokeAll(); this.server?.close(); }
}
module.exports = { PreviewBridge };
