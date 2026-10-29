const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { executable } = require('./core.cjs');
const { staticEntry, createStaticServer } = require('./static-preview.cjs');
const { detectPackageManager } = require('./dependency-cache.cjs');

function jsonFile(root, file) {
  if (!fs.existsSync(file)) return null;
  const base = fs.realpathSync(root), target = fs.realpathSync(file);
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Definição de serviços fora do projeto.');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('A definição de serviços precisa ser um arquivo comum.');
    const limit = 256 * 1024;
    if (stat.size > limit) throw new Error('Definição de serviços muito grande. O limite é 256 KB.');
    const buffer = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < buffer.length) {
      const bytes = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset > limit) throw new Error('Definição de serviços muito grande. O limite é 256 KB.');
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
function definitions(root) {
  const result = [];
  const pkg = jsonFile(root, path.join(root, 'package.json'));
  if (pkg && pkg.scripts && typeof pkg.scripts === 'object') {
    const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
    const detected = detectPackageManager(root);
    const manager = detected.ok ? detected.manager : ['npm', 'pnpm', 'yarn', 'bun'].includes(declared) ? declared :
      fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' :
      fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb')) ? 'bun' : 'npm';
    for (const name of Object.keys(pkg.scripts)) {
      if (/^(dev|start|serve|preview|watch|worker|api)(:[a-zA-Z0-9_-]+)*$/.test(name) && typeof pkg.scripts[name] === 'string') {
        result.push({ id: `script:${name}`, name, command: manager, args: ['run', name], managerError: !detected.ok && !detected.workspace ? detected.error : null });
      }
    }
  }
  const custom = jsonFile(root, path.join(root, 'dk-terminal.services.json'));
  if (custom) {
    if (!Array.isArray(custom.services)) throw new Error('dk-terminal.services.json precisa de uma lista services.');
    for (const item of custom.services) {
      if (!item || typeof item.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,79}$/.test(item.name) ||
          typeof item.command !== 'string' || !item.command || item.command.length > 8192 || item.command.includes('\0') ||
          (item.role !== undefined && item.role !== 'frontend' && item.role !== 'backend') ||
          !Array.isArray(item.args) || item.args.length > 64 || item.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) {
        throw new Error('Serviço inválido em dk-terminal.services.json. Use name, command e args.');
      }
      result.push({ id: `custom:${item.name}`, name: item.name, command: item.command, args: item.args, role: item.role });
    }
  }
  // Static preview is an explicit option alongside any framework services.
  if (result.length < 24 && staticEntry(root)) result.push({ id: 'static:preview', name: 'Prévia estática', role: 'frontend', static: true });
  if (result.length > 24) throw new Error('O limite é 24 serviços definidos por projeto.');
  if (new Set(result.map(item => item.id)).size !== result.length) throw new Error('Existem nomes de serviço repetidos.');
  return result;
}

class Services {
  constructor(changed, env) { this.changed = changed; this.env = env; this.running = new Map(); }
  key(root, id) { return `${root}\0${id}`; }
  snapshot(entry) {
    return { id: entry.id, name: entry.name, status: entry.status, role: entry.role || null, pid: entry.child?.pid || null, exitCode: entry.exitCode ?? null, url: entry.url || null, log: entry.log || '' };
  }
  list(root) {
    const defs = definitions(root);
    const result = defs.map(def => this.running.get(this.key(root, def.id)) || { ...def, status: 'stopped' });
    for (const entry of this.running.values()) if (entry.root === root && !result.some(item => item.id === entry.id)) result.push(entry);
    return result.map(entry => this.snapshot(entry));
  }
  emit(entry) { this.changed({ path: entry.root, service: this.snapshot(entry) }); }
  start(root, id) {
    const key = this.key(root, id);
    const previous = this.running.get(key);
    if (previous && ['running', 'starting', 'stopping'].includes(previous.status)) throw new Error('Este serviço já está ativo.');
    if ([...this.running.values()].filter(x => ['running', 'starting', 'stopping'].includes(x.status)).length >= 8) throw new Error('O limite é oito serviços ativos.');
    const def = definitions(root).find(item => item.id === id);
    if (!def) throw new Error('Este serviço não existe no projeto.');
    if (def.managerError) throw new Error(def.managerError);
    if (def.static) {
      const entry = { ...def, root, status: 'starting', log: 'Prévia estática local, sem instalação de dependências.', server: null };
      this.running.set(key, entry);
      try {
        entry.server = createStaticServer(root, {
          ready: url => { if (entry.status !== 'starting') return; entry.url = url; entry.status = 'running'; this.emit(entry); },
          error: error => { entry.status = 'failed'; entry.log = error.message; this.emit(entry); },
          close: () => { if (entry.status !== 'failed') entry.status = 'stopped'; entry.url = null; this.emit(entry); },
        });
      } catch (error) { this.running.delete(key); throw error; }
      this.emit(entry);
      return this.snapshot(entry);
    }
    let command = executable(def.command, this.env);
    if (path.isAbsolute(def.command)) {
      try { fs.accessSync(def.command, fs.constants.X_OK); if (fs.statSync(def.command).isFile()) command = def.command; } catch {}
    }
    if (!command) throw new Error(`${def.command} não foi encontrado. Instale a ferramenta ou configure seu PATH.`);
    const env = { ...this.env };
    for (const name of Object.keys(env)) if (name.startsWith('DK_TERMINAL_') || name === 'ELECTRON_RUN_AS_NODE') delete env[name];
    const entry = { ...def, root, status: 'starting', log: '', child: null, timer: null };
    this.running.set(key, entry);
    const child = spawn(command, def.args, { cwd: root, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    entry.child = child;
    const output = chunk => {
      entry.log = (entry.log + chunk.toString('utf8')).slice(-32 * 1024);
      const url = entry.log.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?:\/[^\s\x1b]*)?/);
      if (url) entry.url = url[0];
      // One event per burst instead of re-rendering the sidebar for every log line.
      if (!entry.timer) entry.timer = setTimeout(() => { entry.timer = null; this.emit(entry); }, 250);
    };
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('spawn', () => { entry.status = 'running'; this.emit(entry); });
    child.once('error', error => { entry.status = 'failed'; entry.log = error.message; this.emit(entry); });
    child.once('close', (code, signal) => {
      entry.closed = true;
      entry.exitCode = code; clearTimeout(entry.timer); entry.timer = null;
      // The leader can exit before its children, including children with detached stdio.
      // Keep the stop timer while its process group still exists.
      if (entry.status === 'stopping' && entry.killTimer && process.platform !== 'win32') {
        let groupAlive = true;
        try { process.kill(-child.pid, 0); } catch (error) { if (error.code === 'ESRCH') groupAlive = false; }
        if (!groupAlive) { clearTimeout(entry.killTimer); entry.killTimer = null; entry.status = 'stopped'; }
      } else {
        clearTimeout(entry.killTimer); entry.killTimer = null;
        entry.status = code === 0 || entry.status === 'stopping' || signal === 'SIGTERM' ? 'stopped' : 'failed';
      }
      this.emit(entry);
    });
    this.emit(entry);
    return this.snapshot(entry);
  }
  stop(root, id) {
    const entry = this.running.get(this.key(root, id));
    if (!entry || !['running', 'starting'].includes(entry.status)) throw new Error('Este serviço não está rodando.');
    entry.status = 'stopping'; this.emit(entry);
    if (entry.static) { entry.server.close(); return this.snapshot(entry); }
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-entry.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      entry.killTimer = setTimeout(() => {
        entry.killTimer = null;
        try { process.kill(-entry.child.pid, 'SIGKILL'); } catch {}
        if (entry.closed) { entry.status = 'stopped'; this.emit(entry); }
      }, 4000);
      entry.killTimer.unref();
    }
    return this.snapshot(entry);
  }
  closeAll() {
    for (const entry of this.running.values()) {
      clearTimeout(entry.timer); clearTimeout(entry.killTimer);
      if (entry.static && ['running', 'starting', 'stopping'].includes(entry.status)) { entry.server.close(); continue; }
      if (['running', 'starting', 'stopping'].includes(entry.status) && entry.child?.pid) {
        entry.status = 'stopping';
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else try { process.kill(-entry.child.pid, 'SIGKILL'); } catch {}
      }
    }
  }
}
module.exports = { Services, definitions };
