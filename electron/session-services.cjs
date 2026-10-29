const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_PIDS = 512;
const LSTART = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

// Saída de `ps -axo pid=,ppid=,pgid=,lstart=,command=` com LC_ALL=C.
function parseProcessList(output) {
  const rows = [];
  for (const line of String(output).split('\n')) {
    const match = LSTART.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4].replace(/\s+/g, ' '), command: match[5].trim() });
  }
  return rows;
}

// Saída de `lsof -F pcnt`: um bloco por processo (p, c) e um por arquivo (f, t, n).
function parseListeners(output) {
  const found = new Map();
  let pid = null, type = null;
  for (const raw of String(output).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const field = line[0], value = line.slice(1);
    if (field === 'p') { pid = /^\d+$/.test(value) ? Number(value) : null; type = null; }
    else if (field === 'f') type = null;
    else if (field === 't') type = value;
    else if (field === 'n' && pid) {
      const match = /^(.*):(\d{1,5})$/.exec(value);
      if (!match) continue;
      const port = Number(match[2]);
      if (port < 1 || port > 65535) continue;
      const address = match[1].replace(/^\[(.*)\]$/, '$1');
      const key = `${pid}:${port}`;
      const entry = found.get(key) || { pid, port, addresses: [] };
      if (!entry.addresses.includes(address)) entry.addresses.push(address);
      if (type && !entry.type) entry.type = type;
      found.set(key, entry);
    }
  }
  return [...found.values()];
}

// Endereço para a prévia: 127.0.0.1 atende IPv4 e sockets IPv6 em modo duplo.
function listenerURL(addresses, port) {
  const loopbackV4 = addresses.some(address => ['*', '0.0.0.0', '127.0.0.1'].includes(address) || address.startsWith('127.'));
  if (loopbackV4 || addresses.includes('::')) return `http://127.0.0.1:${port}`;
  if (addresses.includes('::1')) return `http://[::1]:${port}`;
  if (addresses.includes('localhost')) return `http://localhost:${port}`;
  return null;
}

// Árvore de cada sessão: o processo do PTY e todos os descendentes.
function sessionTrees(rows, roots) {
  const children = new Map();
  for (const row of rows) { const list = children.get(row.ppid) || []; list.push(row); children.set(row.ppid, list); }
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const owner = new Map();
  for (const root of roots) {
    const leader = byPid.get(root.pid);
    if (!leader || owner.has(leader.pid)) continue;
    owner.set(leader.pid, { session: root, depth: 0 });
    const pending = [[leader.pid, 0]];
    while (pending.length) {
      const [pid, depth] = pending.pop();
      for (const child of children.get(pid) || []) {
        if (owner.has(child.pid)) continue;
        owner.set(child.pid, { session: root, depth: depth + 1 });
        pending.push([child.pid, depth + 1]);
      }
    }
  }
  return owner;
}

function summarize(command) {
  const text = String(command || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Processo';
  const [first, ...rest] = text.split(' ');
  const summary = [first.includes('/') ? path.basename(first) : first, ...rest].join(' ');
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary;
}

// Monta a lista exibida: um item por processo que escuta, com portas ordenadas.
function buildDetected(rows, roots, listeners) {
  const owner = sessionTrees(rows, roots);
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const grouped = new Map();
  for (const listener of listeners) {
    const row = byPid.get(listener.pid), info = owner.get(listener.pid);
    if (!row || !info) continue;
    const entry = grouped.get(row.pid) || { pid: row.pid, pgid: row.pgid, started: row.started, command: summarize(row.command), sessionId: info.session.id, sessionLabel: info.session.label || 'Terminal', ports: [], urls: [] };
    if (!entry.ports.includes(listener.port)) {
      entry.ports.push(listener.port);
      const url = listenerURL(listener.addresses, listener.port);
      if (url) entry.urls.push(url);
    }
    grouped.set(row.pid, entry);
  }
  return [...grouped.values()].map(entry => {
    const order = entry.ports.map((port, index) => ({ port, url: entry.urls[index] })).sort((a, b) => a.port - b.port);
    return { ...entry, ports: order.map(item => item.port), urls: order.map(item => item.url).filter(Boolean), url: order.find(item => item.url)?.url || null };
  }).sort((a, b) => a.ports[0] - b.ports[0] || a.pid - b.pid);
}

const tool = (candidates) => candidates.find(file => fs.existsSync(file)) || candidates[0];
function run(file, args, timeout = 4000) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/bin:/sbin', LC_ALL: 'C' } }, (error, stdout) => {
      // lsof termina com código 1 quando nada corresponde ao filtro.
      if (error && !(typeof error.code === 'number' && stdout !== undefined)) return resolve(null);
      resolve(String(stdout || ''));
    });
  });
}
async function readProcesses() {
  const output = await run(tool(['/bin/ps', '/usr/bin/ps']), ['-axo', 'pid=,ppid=,pgid=,lstart=,command=']);
  return output === null ? null : parseProcessList(output);
}
async function readListeners(pids) {
  if (!pids.length) return [];
  const output = await run(tool(['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof']), ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(','), '-F', 'pcnt']);
  return output === null ? null : parseListeners(output);
}

class SessionServices {
  constructor(options) {
    this.roots = options.roots;          // root => [{ id, pid, label }]
    this.readProcesses = options.readProcesses || readProcesses;
    this.readListeners = options.readListeners || readListeners;
    this.signal = options.signal || ((pid, value) => process.kill(pid, value));
    this.platform = options.platform || process.platform;
    this.inflight = new Map();
  }
  async detect(root) {
    if (!['darwin', 'linux'].includes(this.platform)) return { items: [], supported: false };
    if (this.inflight.has(root)) return this.inflight.get(root);
    const work = (async () => {
      const roots = this.roots(root);
      if (!roots.length) return { items: [], supported: true };
      const rows = await this.readProcesses();
      if (!rows) throw new Error('Não foi possível listar os processos das sessões.');
      const owner = sessionTrees(rows, roots);
      const pids = [...owner.keys()].slice(0, MAX_PIDS);
      const listeners = await this.readListeners(pids);
      if (!listeners) throw new Error('Não foi possível consultar as portas em uso.');
      return { items: buildDetected(rows, roots, listeners), supported: true };
    })();
    this.inflight.set(root, work);
    try { return await work; } finally { this.inflight.delete(root); }
  }
  // Confere de novo, logo antes do sinal, que o processo ainda é o mesmo e ainda
  // pertence a uma sessão do projeto. Só envia ao grupo quando todo o grupo está
  // dentro da árvore da sessão e não é o grupo do próprio shell.
  async terminate(root, pid, started) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || typeof started !== 'string' || started.length > 64) throw new Error('Processo inválido.');
    const roots = this.roots(root);
    const rows = await this.readProcesses();
    if (!rows) throw new Error('Não foi possível conferir o processo.');
    const owner = sessionTrees(rows, roots);
    const row = rows.find(item => item.pid === pid);
    if (!row || row.started !== started || !owner.has(pid)) throw new Error('O processo já foi encerrado ou não pertence às sessões deste projeto.');
    const info = owner.get(pid);
    const shell = rows.find(item => item.pid === info.session.pid);
    const members = rows.filter(item => item.pgid === row.pgid);
    const groupInside = row.pgid > 1 && members.length > 0 && members.every(item => owner.has(item.pid) && owner.get(item.pid).depth > 0);
    const useGroup = groupInside && (!shell || shell.pgid !== row.pgid);
    try { this.signal(useGroup ? -row.pgid : pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    return { pid, group: useGroup ? row.pgid : null };
  }
}

module.exports = { SessionServices, parseListeners, parseProcessList, buildDetected, sessionTrees, listenerURL, summarize };
