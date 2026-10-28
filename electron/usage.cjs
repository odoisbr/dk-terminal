const { spawn } = require('node:child_process');
const { executable } = require('./core.cjs');

function durationLabel(minutes) {
  if (minutes === 300) return 'Sessão · 5 horas';
  if (minutes === 10080) return 'Semana · 7 dias';
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440} dias`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60} horas`;
  return minutes ? `${minutes} minutos` : 'Janela de uso';
}
function codexSnapshot(accountResult, result) {
  const account = accountResult?.account;
  const windows = [];
  const buckets = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.entries(result.rateLimitsByLimitId) : result?.rateLimits ? [['codex', result.rateLimits]] : [];
  for (const [key, bucket] of buckets) {
    for (const field of ['primary', 'secondary']) {
      const limit = bucket?.[field];
      if (!Number.isFinite(limit?.usedPercent) || limit.usedPercent < 0 || limit.usedPercent > 100) continue;
      const minutes = Number.isFinite(limit.windowDurationMins) && limit.windowDurationMins > 0 ? limit.windowDurationMins : null;
      windows.push({ id: `${key}:${field}`, label: `${bucket.limitName || (key !== 'codex' ? key : '')}${bucket.limitName || key !== 'codex' ? ' · ' : ''}${durationLabel(minutes)}`, usedPercent: limit.usedPercent, resetsAt: Number.isFinite(limit.resetsAt) && limit.resetsAt > 0 ? limit.resetsAt * 1000 : null });
    }
  }
  return { id: 'codex', name: 'Codex', account: typeof account?.email === 'string' ? account.email : '', plan: typeof account?.planType === 'string' ? account.planType : '', windows, message: windows.length ? '' : account?.type === 'apiKey' ? 'Acesso por API. A ferramenta não informou cotas de assinatura.' : 'A ferramenta não informou cotas para esta conta.', source: 'Codex app-server', checkedAt: Date.now() };
}
function claudeSnapshot(screen, account = {}) {
  const lines = screen.split('\n').map(line => line.replace(/[│┃╭╮╰╯─━]/g, '').trim()).filter(Boolean);
  const windows = [];
  let label = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(current session|current week|sess[aã]o atual|semana atual)/i.test(line)) label = line.replace(/\s{2,}.*/, '');
    const match = line.match(/(\d+(?:\.\d+)?)\s*%\s*(used|left|utilizad[oa]|restante)/i);
    if (!match || !label) continue;
    const number = Number(match[1]);
    if (number < 0 || number > 100) continue;
    const usedPercent = /left|restante/i.test(match[2]) ? 100 - number : number;
    const reset = lines.slice(i, i + 4).find(text => /^(resets?|reinicia)/i.test(text)) || '';
    windows.push({ id: `claude:${windows.length}`, label: label.replace(/^Current session$/i, 'Sessão atual').replace(/^Current week/i, 'Semana atual'), usedPercent, resetsAt: null, resetLabel: reset });
    label = '';
  }
  return { id: 'claude', name: 'Claude Code', account: typeof account.email === 'string' ? account.email : '', plan: typeof account.subscriptionType === 'string' ? account.subscriptionType : '', windows, message: windows.length ? '' : 'Consulte /usage na CLI oficial. As cotas não ficaram disponíveis para leitura neste ambiente.', source: 'Claude Code · /usage', checkedAt: Date.now() };
}
function terminate(child) {
  if (!child) return;
  try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch {}
  child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
}
function readCodex(env, root, register) {
  return new Promise((resolve, reject) => {
    const command = executable('codex', env);
    if (!command) return reject(new Error('Codex não encontrado neste computador.'));
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    register(child);
    let buffer = '', size = 0, account;
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); terminate(child); register(null); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('O Codex demorou para informar as cotas.')), 15000);
    const write = value => { if (!settled && child.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n'); };
    child.on('error', () => finish(new Error('Não foi possível consultar o Codex.')));
    child.stdin.on('error', () => finish(new Error('A consulta do Codex foi interrompida.')));
    child.on('exit', () => { if (!settled) finish(new Error('O Codex encerrou a consulta sem informar as cotas.')); });
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) return finish(new Error('Resposta de cotas acima do limite.'));
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.error && [1, 2, 3].includes(value.id)) return finish(new Error('A ferramenta não disponibilizou as cotas. Confira o login no Codex.'));
        if (value.id === 1) { write({ method: 'initialized' }); write({ id: 2, method: 'account/read', params: { refreshToken: false } }); }
        if (value.id === 2) { account = value.result; write({ id: 3, method: 'account/rateLimits/read' }); }
        if (value.id === 3) return finish(null, codexSnapshot(account, value.result));
      }
    });
    write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dk_terminal', title: 'DK Terminal', version: '0.1.0' } } });
  });
}
function readClaude(env, root, register) {
  return new Promise((resolve, reject) => {
    const command = executable('claude', env);
    if (!command) return reject(new Error('Claude Code não encontrado neste computador.'));
    const { Terminal } = require('@xterm/headless');
    const pty = require('node-pty');
    const terminal = new Terminal({ cols: 150, rows: 50, scrollback: 100, allowProposedApi: true });
    const terminalEnv = { ...env, TERM: 'xterm-256color' };
    delete terminalEnv.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(terminalEnv)) if (key.startsWith('DK_TERMINAL_')) delete terminalEnv[key];
    let child;
    try { child = pty.spawn(command, ['--safe-mode', '/usage'], { cwd: root, env: terminalEnv, name: 'xterm-256color', cols: 150, rows: 50 }); }
    catch { terminal.dispose(); return reject(new Error('Não foi possível consultar o Claude Code.')); }
    register(child);
    let settled = false, size = 0, quiet;
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(quiet);
      const b = terminal.buffer.active, lines = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) || '');
      try { child.kill(); } catch {} terminal.dispose(); register(null);
      resolve(claudeSnapshot(lines.join('\n')));
    };
    const timer = setTimeout(finish, 12000);
    child.onData(data => {
      size += data.length;
      if (size > 512 * 1024) return finish();
      terminal.write(data, () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          const b = terminal.buffer.active, lines = [];
          for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) || '');
          if (claudeSnapshot(lines.join('\n')).windows.length) finish();
        }, 900);
      });
    });
    child.onExit(finish);
  });
}
class Usage {
  constructor(env) { this.env = env; this.cache = null; this.pending = null; this.active = null; this.closed = false; }
  read(root, refresh = false) {
    if (this.pending) return this.pending;
    if (this.cache && (!refresh || Date.now() - this.cache.checkedAt < 60000)) return Promise.resolve(this.cache);
    this.closed = false;
    this.pending = (async () => {
      const providers = [];
      for (const [id, name, read] of [['codex', 'Codex', readCodex], ['claude', 'Claude Code', readClaude]]) {
        if (this.closed) break;
        try { providers.push(await read(this.env, root, child => { this.active = child; })); }
        catch (error) { providers.push({ id, name, windows: [], message: error.message, checkedAt: Date.now() }); }
      }
      this.cache = { checkedAt: Date.now(), providers };
      return this.cache;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  close() { this.closed = true; terminate(this.active); this.active = null; }
}
module.exports = { Usage, codexSnapshot, claudeSnapshot, durationLabel };
