const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const { localURL } = require('./browser.cjs');

// Capability tokens belong to one project and never appear in a URL or UI.
class PreviewBridge {
  constructor(dispatch) { this.dispatch = dispatch; this.tokens = new Map(); this.pending = new Map(); this.server = null; this.port = null; }
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
    req.on('end', () => {
      if (res.writableEnded) return;
      let url;
      try { const data = JSON.parse(body); if (!data || Object.keys(data).join() !== 'url') throw new Error(); url = localURL(data.url); }
      catch { return reply(400, { error: 'Endereço de prévia inválido.' }); }
      const id = randomUUID(), root = entry[0];
      const timer = setTimeout(() => { this.pending.delete(id); reply(504, { error: 'O DK Terminal não confirmou a prévia.' }); }, 8000);
      this.pending.set(id, { root, reply, timer });
      try { this.dispatch({ id, root, url }); } catch { this.finish(id, false); }
    });
  }
  finish(id, ok) {
    const item = this.pending.get(id); if (!item) return;
    this.pending.delete(id); clearTimeout(item.timer);
    item.reply(ok === true ? 200 : 409, ok === true ? { opened: true } : { error: 'Não foi possível abrir a prévia no projeto ativo.' });
  }
  revoke(root) { this.tokens.delete(root); for (const [id, item] of this.pending) if (item.root === root) this.finish(id, false); }
  revokeAll() { for (const id of this.pending.keys()) this.finish(id, false); this.tokens.clear(); }
  close() { this.revokeAll(); this.server?.close(); }
}
module.exports = { PreviewBridge };
