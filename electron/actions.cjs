const { spawn } = require('node:child_process');
const { actionSpec } = require('./core.cjs');

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const DEADLINE = 60 * 1000;
function environment(source) {
  const env = { ...source, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', NO_COLOR: '1', TERM: 'dumb' };
  for (const name of Object.keys(env)) if (name.startsWith('DK_TERMINAL_') || name === 'ELECTRON_RUN_AS_NODE') delete env[name];
  return env;
}

class Actions {
  constructor({ env = process.env, kit = null, timeoutMs = DEADLINE } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE) throw new Error('Prazo da ação inválido.');
    this.env = { ...env };
    this.kit = kit; this.timeoutMs = timeoutMs; this.running = new Set();
  }

  run(action, project, kit = this.kit) {
    const env = environment(this.env);
    const spec = actionSpec(action, project, kit, env);
    if (this.running.size >= 4) throw new Error('Aguarde uma das ações em andamento terminar.');
    const startedAt = new Date().toISOString();
    return new Promise(resolve => {
      const entry = { root: project.path, action, child: null, timedOut: false, cancelled: false, truncated: false, stopTimer: null };
      const stdout = [], stderr = [];
      let size = 0, settled = false, deadline;
      const finish = (code, signal = null, error = null) => {
        if (settled) return; settled = true;
        clearTimeout(deadline); clearTimeout(entry.stopTimer); this.running.delete(entry);
        const output = Buffer.concat(stdout).toString('utf8'), errorOutput = Buffer.concat(stderr).toString('utf8');
        let data = null, jsonParsed = false;
        if (!entry.truncated && output.trim()) {
          try { data = JSON.parse(output); jsonParsed = true; } catch {}
        }
        resolve({
          action, label: spec.label, root: project.path, code, signal, data, jsonParsed,
          output, stderr: error ? [errorOutput, error.message].filter(Boolean).join('\n') : errorOutput,
          startedAt, finishedAt: new Date().toISOString(),
          status: entry.timedOut ? 'timed_out' : entry.cancelled ? 'cancelled' : entry.truncated ? 'truncated' : error || code !== 0 ? 'failed' : 'completed',
          timedOut: entry.timedOut, cancelled: entry.cancelled, truncated: entry.truncated,
        });
      };
      const collect = target => chunk => {
        if (settled || entry.truncated) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = OUTPUT_LIMIT - size;
        if (remaining > 0) { const kept = buffer.subarray(0, remaining); target.push(kept); size += kept.length; }
        if (buffer.length > remaining) { entry.truncated = true; this.stop(entry); }
      };
      this.running.add(entry);
      try {
        entry.child = spawn(spec.file, spec.args, {
          cwd: project.path, env, stdio: ['ignore', 'pipe', 'pipe'],
          shell: false, detached: process.platform !== 'win32', windowsHide: true,
        });
        entry.child.stdout.on('data', collect(stdout)); entry.child.stderr.on('data', collect(stderr));
        entry.child.once('error', error => finish(null, null, error));
        entry.child.once('close', (code, signal) => finish(code, signal));
        deadline = setTimeout(() => { entry.timedOut = true; this.stop(entry); }, this.timeoutMs);
        deadline.unref();
      } catch (error) { finish(null, null, error); }
    });
  }

  stop(entry) {
    if (!entry.child?.pid || entry.stopTimer) return;
    const kill = signal => {
      try {
        if (process.platform === 'win32') entry.child.kill(signal);
        else process.kill(-entry.child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') try { entry.child.kill(signal); } catch {} }
    };
    kill('SIGTERM');
    entry.stopTimer = setTimeout(() => kill('SIGKILL'), 1000); entry.stopTimer.unref();
  }

  cancel(root, action) {
    let count = 0;
    for (const entry of this.running) if (entry.root === root && (action === undefined || entry.action === action)) {
      entry.cancelled = true; this.stop(entry); count++;
    }
    return count;
  }

  closeAll() {
    for (const entry of this.running) { entry.cancelled = true; this.stop(entry); }
  }
}

module.exports = { Actions };
