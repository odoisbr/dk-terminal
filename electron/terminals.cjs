const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const pty = require('node-pty');
const { dimensions, shellSpec } = require('./core.cjs');
const { terminalEnvironment } = require('./terminal-environment.cjs');
const { stopTerminalTree } = require('./session-processes.cjs');

class Terminals {
  constructor(send, env) { this.send = send; this.env = env; this.sessions = new Map(); }

  create(project, spec = null, workingDirectory = project.path, cwdFallback = false) {
    if (this.sessions.size >= 16) throw new Error('Feche uma sessão antes de abrir outra. O limite é 16.');
    const id = randomUUID();
    const session = { id, cwd: project.path, workingDirectory, label: spec?.label || 'Terminal', spec, pty: null, state: 'pending', pending: 0, paused: false, lastActivity: Date.now() };
    this.sessions.set(id, session);
    return { id, cwd: session.cwd, label: session.label, kind: spec ? spec.kind || 'action' : 'shell', cwdFallback };
  }

  async split(root, id, extensions, agent) {
    const original = this.get(id);
    if (original.cwd !== root) throw new Error('Este terminal pertence a outro projeto.');
    const current = await this.currentDirectory(original);
    if (this.sessions.get(id) !== original) throw new Error('O terminal original foi encerrado.');
    let spec = agent ? extensions.spec(agent) : original.spec?.kind === 'extension' ? original.spec : null;
    if (!agent && !spec && original.state === 'running') {
      let program = '';
      try { program = path.basename(original.pty.process || '').toLowerCase(); } catch {}
      if (program === 'claude' || program === 'codex') {
        try { spec = extensions.spec(program); } catch {}
      }
    }
    // The new shell is grouped with the original project even if it has cd'ed elsewhere.
    return this.create({ path: root }, spec, current || original.workingDirectory, !current);
  }

  async currentDirectory(session) {
    if (session.state !== 'running' || !Number.isInteger(session.pty?.pid) || session.pty.pid <= 0) return null;
    try {
      let directory;
      if (process.platform === 'linux') directory = await fs.promises.realpath(`/proc/${session.pty.pid}/cwd`);
      else if (process.platform === 'darwin') directory = await new Promise(resolve => {
        execFile('/usr/sbin/lsof', ['-a', '-p', String(session.pty.pid), '-d', 'cwd', '-Fn0'], { timeout: 2500, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'en_US.UTF-8' } }, (error, stdout) => {
          if (error) return resolve(null);
          const name = stdout.split('\0').map(value => value.replace(/^\n+/, '')).find(value => value.startsWith('n'));
          resolve(name ? name.slice(1) : null);
        });
      });
      if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
      const canonical = await fs.promises.realpath(directory);
      return (await fs.promises.stat(canonical)).isDirectory() ? canonical : null;
    } catch { return null; }
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Sessão encerrada.');
    return session;
  }

  start(id, size) {
    const session = this.get(id);
    const { cols, rows } = dimensions(size);
    if (session.state !== 'pending') throw new Error('Sessão já iniciada.');
    const spec = session.spec || shellSpec(this.env);
    const env = terminalEnvironment(this.env);
    try {
      session.pty = pty.spawn(spec.file, spec.args, { name: 'xterm-256color', cols, rows, cwd: session.workingDirectory, env });
      session.state = 'running';
      session.pty.onData(data => {
        if (session.state !== 'running') return;
        session.lastActivity = Date.now();
        session.pending += data.length;
        this.send('terminal:data', { id, data });
        if (!session.paused && session.pending > 256 * 1024) { session.pty.pause(); session.paused = true; }
      });
      session.pty.onExit(({ exitCode, signal }) => {
        if (session.state === 'closing') return;
        session.state = 'exited';
        this.send('terminal:exit', { id, exitCode, signal });
      });
    } catch (error) { session.state = 'exited'; throw new Error(`Não foi possível abrir o terminal: ${error.message}`); }
  }

  write(id, data) {
    const session = this.get(id);
    if (typeof data !== 'string' || data.length > 64 * 1024) throw new Error('Entrada inválida.');
    if (session.state === 'running') { session.lastActivity = Date.now(); session.pty.write(data); }
  }

  resize(id, size) {
    const { cols, rows } = dimensions(size);
    const session = this.get(id);
    if (session.state === 'running') session.pty.resize(cols, rows);
  }

  acknowledge(id, count) {
    const session = this.get(id);
    if (!Number.isInteger(count) || count < 0 || count > 1024 * 1024) throw new Error('Confirmação de saída inválida.');
    session.pending = Math.max(0, session.pending - count);
    if (session.paused && session.pending < 64 * 1024 && session.state === 'running') { session.pty.resume(); session.paused = false; }
  }

  async close(id) {
    const session = this.get(id);
    if (session.closePromise) return session.closePromise;
    const running = session.state === 'running';
    session.state = 'closing';
    session.closePromise = (async () => {
      let result = {partial:false};
      try {
        if (running && Number.isInteger(session.pty?.pid) && session.pty.pid > 0) {
          result = await stopTerminalTree(session.pty.pid, () => session.pty.kill());
        } else if (running) {
          try { session.pty?.kill(); } catch {}
          result = {partial:true};
        }
        return result;
      } finally {
        if (this.sessions.get(id) === session) this.sessions.delete(id);
      }
    })();
    return session.closePromise;
  }

  async closeProject(root) {
    const owned = [...this.sessions.values()].filter(session => session.cwd === root);
    const results = await Promise.all(owned.map(session => this.close(session.id)));
    return {closed:owned.length, partial:results.some(result=>result.partial)};
  }

  resourceRoots() { return [...this.sessions.values()].filter(session => session.state === 'running' && Number.isInteger(session.pty?.pid)).map(session => ({ id: session.id, pid: session.pty.pid, lastActivity: session.lastActivity, kind: 'terminal' })); }

  async closeAllAndWait() {
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)));
    return {partial:results.some(result=>result.status==='rejected' || result.value.partial)};
  }

  // Quit/crash handlers cannot wait for asynchronous process inspection.
  // Close PTYs synchronously there; explicit tab/project closes use close().
  closeAll() {
    for (const session of this.sessions.values()) {
      if (session.state === 'running' || session.state === 'closing') { try { session.pty?.kill(); } catch {} }
    }
    this.sessions.clear();
  }
}
module.exports = { Terminals };
