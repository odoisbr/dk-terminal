const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { version } = require('../package.json');
const { directory, executable } = require('./core.cjs');
const { processSnapshot, descendants, stopRecordedProcesses } = require('./session-processes.cjs');

const LIMIT = 64 * 1024;
const MAX_MESSAGES = 200;
const MAX_SESSIONS = 30;
const MAX_STORE = 8 * 1024 * 1024;
const RPC_TIMEOUT = 30000;
const CANCEL_TIMEOUT = 5000;
const VALID_STATUS = new Set(['idle', 'starting', 'running', 'completed', 'interrupted', 'failed']);

function bounded(value, limit = LIMIT) {
  const text = typeof value === 'string' ? value : '';
  const bytes = Buffer.from(text);
  return bytes.length <= limit ? text : bytes.subarray(0, limit - 3).toString('utf8').replace(/\uFFFD$/, '') + '…';
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function errorText(error) { return bounded(error instanceof Error ? error.message : String(error), 2000); }
function inside(root, file) { const relative = path.relative(root, file); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function canonicalFile(file) {
  let parent = file;
  const tail = [];
  while (!fs.existsSync(parent)) { tail.unshift(path.basename(parent)); const next = path.dirname(parent); if (next === parent) break; parent = next; }
  return path.join(fs.realpathSync(parent), ...tail);
}

/** One short-lived official app-server process per active turn; no credentials or config overrides. */
class CodexChat {
  constructor({ env = process.env, storeFile, emit = () => {}, previewEnvironment = () => ({}) }) {
    if (typeof storeFile !== 'string' || !path.isAbsolute(storeFile)) throw new Error('O histórico do Codex precisa de uma pasta privada.');
    this.env = env;
    this.previewEnvironment = previewEnvironment;
    this.storeFile = canonicalFile(storeFile);
    this.emit = emit;
    this.sessions = new Map();
    this.active = new Map();
    this.saveTimer = null;
    this.closed = false;
    this._load();
  }

  _load() {
    try {
      if (fs.statSync(this.storeFile).size > MAX_STORE) return;
      const saved = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
      if (!Array.isArray(saved.sessions)) return;
      for (const raw of saved.sessions.slice(-MAX_SESSIONS)) {
        if (!raw || typeof raw.id !== 'string' || typeof raw.root !== 'string' || !path.isAbsolute(raw.root)) continue;
        const messages = Array.isArray(raw.messages) ? raw.messages.slice(-MAX_MESSAGES).flatMap(value => {
          if (!value || typeof value.id !== 'string' || !['user', 'assistant', 'tool', 'system', 'permission'].includes(value.kind)) return [];
          const message = { id: bounded(value.id, 160), kind: value.kind, createdAt: Number(value.createdAt) || Date.now() };
          for (const key of ['text', 'output', 'command', 'cwd', 'label', 'toolType', 'status', 'reason', 'requestId']) {
            if (typeof value[key] === 'string') message[key] = bounded(value[key]);
          }
          if (value.kind === 'permission' && message.status === 'pending') message.status = 'expired';
          if (typeof value.exitCode === 'number') message.exitCode = value.exitCode;
          return [message];
        }) : [];
        this.sessions.set(raw.id, {
          id: raw.id, root: raw.root, title: bounded(raw.title || 'Nova conversa', 120),
          createdAt: Number(raw.createdAt) || Date.now(), updatedAt: Number(raw.updatedAt) || Date.now(),
          vendorThreadId: typeof raw.vendorThreadId === 'string' ? bounded(raw.vendorThreadId, 200) : null,
          model: typeof raw.model === 'string' ? bounded(raw.model, 200) : null,
          running: false, status: raw.running ? 'interrupted' : VALID_STATUS.has(raw.status) ? raw.status : 'idle', messages,
        });
      }
      fs.chmodSync(this.storeFile, 0o600);
    } catch { /* A missing or invalid history does not prevent using the terminal. */ }
  }

  _saveSoon() {
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this._save(); }, 1500);
      this.saveTimer.unref?.();
    }
  }

  _save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const sessions = [...this.sessions.values()];
    let data = JSON.stringify({ version: 1, sessions });
    // Bound the complete private history as well as each conversation and tool output.
    while (Buffer.byteLength(data) >= MAX_STORE) {
      const candidate = sessions.filter(session => session.messages.length > 1).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!candidate) break;
      candidate.messages.shift();
      data = JSON.stringify({ version: 1, sessions });
    }
    const temp = `${this.storeFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, data + '\n', { mode: 0o600, flag: 'w' });
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, this.storeFile);
      fs.chmodSync(this.storeFile, 0o600);
    } catch {
      try { fs.unlinkSync(temp); } catch {}
      for (const session of this.sessions.values()) if (session.running) this._event(session, 'error', { message: 'Não foi possível salvar o histórico privado do Codex.' });
    }
  }

  _metadata(session) {
    const { messages, vendorThreadId, ...metadata } = session;
    return copy(metadata);
  }

  _snapshot(session) { return { session: this._metadata(session), messages: copy(session.messages) }; }
  _event(session, type, value = {}) { this.emit({ sessionId: session.id, root: session.root, type, ...copy(value) }); }
  _session(root, id) {
    const session = this.sessions.get(id);
    if (!session || (session.root !== root && session.root !== directory(root))) throw new Error('Conversa não encontrada neste projeto.');
    if (inside(session.root, this.storeFile)) throw new Error('O histórico do Codex deve ficar fora da pasta do projeto.');
    return session;
  }
  _append(session, message) {
    const item = { id: randomUUID(), createdAt: Date.now(), ...message };
    session.messages.push(item);
    session.messages = session.messages.slice(-MAX_MESSAGES);
    session.updatedAt = Date.now();
    this._event(session, 'message', { message: item });
    this._saveSoon();
    return item;
  }
  _status(session, status) {
    session.status = status;
    session.running = ['starting', 'running'].includes(status);
    session.updatedAt = Date.now();
    this._event(session, 'status', { session: this._metadata(session) });
    this._saveSoon();
  }

  create(root) {
    if (this.closed) throw new Error('O Codex está sendo encerrado.');
    root = directory(root);
    if (inside(root, this.storeFile)) throw new Error('O histórico do Codex deve ficar fora da pasta do projeto.');
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].filter(session => !session.running).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest) throw new Error('Encerre uma conversa antes de criar outra.');
      this.sessions.delete(oldest.id);
    }
    const now = Date.now();
    const session = { id: randomUUID(), root, title: 'Nova conversa', createdAt: now, updatedAt: now, vendorThreadId: null, model: null, running: false, status: 'idle', messages: [] };
    this.sessions.set(session.id, session);
    this._save();
    return this._metadata(session);
  }

  list(root) {
    root = directory(root);
    return [...this.sessions.values()].filter(session => session.root === root).sort((a, b) => b.updatedAt - a.updatedAt).map(session => this._metadata(session));
  }

  read(root, id) { return this._snapshot(this._session(root, id)); }

  async send(root, id, text) {
    if (this.closed) throw new Error('O Codex está sendo encerrado.');
    const session = this._session(root, id);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > LIMIT) throw new Error('Escreva uma mensagem de até 64 KB.');
    if (this.active.has(id)) throw new Error('Aguarde a resposta ou interrompa a conversa.');
    if (this.active.size >= 2) throw new Error('Já existem duas conversas em andamento.');
    const binary = executable('codex', this.env);
    if (!binary) throw new Error('Instale a CLI oficial do Codex e entre na sua conta para usar a conversa.');
    if (session.title === 'Nova conversa') session.title = bounded(text.trim().split('\n')[0], 100);
    this._append(session, { kind: 'user', text: text.trim() });
    this._status(session, 'starting');
    const worker = { session, binary, itemPrefix: randomUUID(), pending: new Map(), permissions: new Map(), deltas: new Map(), deltaTimer: null, nextId: 0, child: null, turnId: null, canceled: false, terminal: false, cancelTimer: null, lastActivity: Date.now() };
    worker.done = new Promise(resolve => { worker.finishTurn = result => { if (worker.terminal) return; worker.terminal = true; resolve(result); }; });
    this.active.set(id, worker);
    worker.run = this._run(worker, text.trim());
    // The main process IPC returns immediately; streaming arrives through emit().
  }

  _write(worker, message) {
    if (!worker.child || worker.child.stdin.destroyed || !worker.child.stdin.writable) throw new Error('A conexão com o Codex foi encerrada.');
    worker.lastActivity = Date.now();
    worker.child.stdin.write(JSON.stringify(message) + '\n');
  }

  _rpc(worker, method, params, timeout = RPC_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const id = ++worker.nextId;
      const timer = setTimeout(() => { worker.pending.delete(id); reject(new Error(`O Codex não respondeu a ${method}.`)); }, timeout);
      worker.pending.set(id, { resolve, reject, timer });
      try { this._write(worker, { id, method, params }); }
      catch (error) { clearTimeout(timer); worker.pending.delete(id); reject(error); }
    });
  }

  async _run(worker, text) {
    const { session } = worker;
    let outcome = 'failed';
    try {
      const env = { ...this.env };
      for (const key of Object.keys(env)) if (key.startsWith('DK_TERMINAL_')) delete env[key];
      Object.assign(env, this.previewEnvironment(session.root));
      delete env.ELECTRON_RUN_AS_NODE;
      const child = worker.child = spawn(worker.binary, ['app-server', '--listen', 'stdio://'], {
        cwd: session.root, env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true,
      });
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      let buffer = '';
      child.stdout.on('data', chunk => {
        worker.lastActivity = Date.now();
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) { worker.finishTurn({ error: 'O Codex enviou uma resposta maior que o limite.' }); this._kill(worker, 'SIGTERM'); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try { this._receive(worker, JSON.parse(line)); }
          catch { worker.finishTurn({ error: 'O Codex enviou uma resposta inválida.' }); this._kill(worker, 'SIGTERM'); return; }
        }
      });
      const disconnected = message => {
        for (const request of worker.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
        worker.pending.clear();
        worker.finishTurn({ error: message });
      };
      child.once('error', () => disconnected('Não foi possível iniciar a CLI oficial do Codex.'));
      child.once('close', () => disconnected('A conexão com o Codex foi encerrada antes da resposta.'));
      await this._rpc(worker, 'initialize', { clientInfo: { name: 'dk_terminal', title: 'SEA Dock', version } });
      if (worker.canceled) throw new Error('Conversa interrompida.');
      this._write(worker, { method: 'initialized' });
      const thread = session.vendorThreadId
        ? await this._rpc(worker, 'thread/resume', { threadId: session.vendorThreadId, cwd: session.root, excludeTurns: true })
        : await this._rpc(worker, 'thread/start', { cwd: session.root });
      if (!thread?.thread || typeof thread.thread.id !== 'string') throw new Error('O Codex não retornou uma conversa válida.');
      session.vendorThreadId = thread.thread.id;
      if (typeof thread.model === 'string') session.model = bounded(thread.model, 200);
      this._save();
      if (worker.canceled) throw new Error('Conversa interrompida.');
      const result = await this._rpc(worker, 'turn/start', { threadId: session.vendorThreadId, input: [{ type: 'text', text }] });
      if (typeof result?.turn?.id === 'string') worker.turnId = result.turn.id;
      if (!worker.turnId) throw new Error('O Codex não retornou uma resposta válida.');
      this._status(session, 'running');
      if (worker.canceled) this._interrupt(worker);
      const completion = await worker.done;
      if (worker.canceled || completion.status === 'interrupted') outcome = 'interrupted';
      else if (completion.status === 'completed') outcome = 'completed';
      else throw new Error(completion.error || 'O Codex não conseguiu concluir a resposta.');
    } catch (error) {
      if (worker.canceled) outcome = 'interrupted';
      else {
        const message = errorText(error);
        this._append(session, { kind: 'system', text: message, status: 'failed' });
        this._event(session, 'error', { message });
      }
    } finally {
      this._flushDeltas(worker);
      for (const permission of worker.permissions.values()) {
        permission.message.status = 'expired';
        this._event(session, 'permission', { permission: permission.message });
      }
      worker.permissions.clear();
      if (worker.cancelTimer) clearTimeout(worker.cancelTimer);
      await this._dispose(worker);
      this.active.delete(session.id);
      this._status(session, outcome);
      this._save();
      this._event(session, 'snapshot', { snapshot: this._snapshot(session) });
    }
  }

  _receive(worker, message) {
    if (!message || typeof message !== 'object') return;
    if (typeof message.method !== 'string') {
      const pending = worker.pending.get(message.id);
      if (!pending) return;
      worker.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(errorText(message.error.message || 'Erro no protocolo do Codex.')));
      else pending.resolve(message.result);
      return;
    }
    const params = message.params || {};
    const { session } = worker;
    if (Object.hasOwn(message, 'id')) { this._permission(worker, message); return; }
    if (params.threadId && session.vendorThreadId && params.threadId !== session.vendorThreadId) return;
    if (message.method === 'turn/started' && typeof params.turn?.id === 'string') worker.turnId = params.turn.id;
    if (worker.turnId && params.turnId && params.turnId !== worker.turnId) return;
    switch (message.method) {
      case 'item/started': case 'item/completed': this._item(worker, params.item); break;
      case 'item/agentMessage/delta': this._delta(worker, params, 'assistant', 'text'); break;
      case 'item/commandExecution/outputDelta': this._delta(worker, params, 'tool', 'output'); break;
      case 'turn/completed':
        if (!worker.turnId || params.turn?.id === worker.turnId) worker.finishTurn({ status: params.turn?.status, error: bounded(params.turn?.error?.message, 2000) });
        break;
      case 'error':
        // Retriable server errors may be followed by a successful response.
        if (params.willRetry) break;
        if (params.error?.message) {
          const message = bounded(params.error.message, 2000);
          this._append(session, { kind: 'system', text: message, status: 'failed' });
          this._event(session, 'error', { message });
        }
        break;
      // Reasoning deltas and raw reasoning content intentionally never enter history or UI.
      default: break;
    }
  }

  _item(worker, item) {
    if (!item || typeof item.id !== 'string') return;
    this._flushDeltas(worker);
    const { session } = worker;
    const id = `${session.id}:${worker.itemPrefix}:${item.id}`;
    let message = session.messages.find(value => value.id === id);
    if (item.type === 'agentMessage') {
      const text = bounded(item.text);
      if (!message) message = this._append(session, { id, kind: 'assistant', text });
      else { message.text = text; this._event(session, 'message', { message }); }
    } else if (item.type === 'commandExecution' || item.type === 'fileChange') {
      const fields = item.type === 'commandExecution'
        ? { command: bounded(item.command), cwd: bounded(item.cwd), output: bounded(item.aggregatedOutput ?? message?.output), exitCode: item.exitCode ?? null }
        : { output: bounded((Array.isArray(item.changes) ? item.changes : []).map(change => `${bounded(change.path, 2000)}\n${bounded(change.diff)}`).join('\n\n')) };
      const update = { kind: 'tool', toolType: item.type, label: item.type === 'commandExecution' ? 'Terminal' : 'Alterações em arquivos', status: bounded(item.status, 80), ...fields };
      if (!message) message = this._append(session, { id, ...update });
      else Object.assign(message, update);
      this._event(session, 'tool', { tool: message });
    }
    this._saveSoon();
  }

  _delta(worker, params, kind, field) {
    if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') return;
    const { session } = worker;
    const id = `${session.id}:${worker.itemPrefix}:${params.itemId}`;
    let message = session.messages.find(value => value.id === id);
    if (!message) message = this._append(session, { id, kind, [field]: '', ...(kind === 'tool' ? { toolType: 'commandExecution', label: 'Terminal' } : {}) });
    const value = bounded((message[field] || '') + params.delta);
    if (message[field] === value) return;
    message[field] = value;
    // Replacement text also handles truncation without keeping an unbounded delta buffer in the UI.
    worker.deltas.set(id, { messageId: id, field, value });
    if (!worker.deltaTimer) worker.deltaTimer = setTimeout(() => this._flushDeltas(worker), 40);
    this._saveSoon();
  }

  _flushDeltas(worker) {
    if (worker.deltaTimer) clearTimeout(worker.deltaTimer);
    worker.deltaTimer = null;
    for (const delta of worker.deltas.values()) this._event(worker.session, 'delta', delta);
    worker.deltas.clear();
  }

  _permission(worker, request) {
    const { session } = worker;
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method);
    const params = request.params || {};
    const correctThread = !session.vendorThreadId || params.threadId === session.vendorThreadId;
    const correctTurn = !worker.turnId || params.turnId === worker.turnId;
    if (!supported || !correctThread || !correctTurn || worker.canceled) {
      this._write(worker, { id: request.id, error: { code: -32601, message: 'Esta interação ainda não é suportada pelo SEA Dock.' } });
      const text = `O Codex solicitou uma interação que este painel não suporta (${bounded(request.method, 200)}). Use a CLI oficial para continuar esse fluxo.`;
      this._append(session, { kind: 'system', text, status: 'failed' });
      this._event(session, 'error', { message: text });
      return;
    }
    const command = request.method === 'item/commandExecution/requestApproval';
    const item = session.messages.find(value => value.id === `${session.id}:${worker.itemPrefix}:${params.itemId}`);
    const requestId = randomUUID();
    const message = this._append(session, {
      kind: 'permission', requestId, status: 'pending', toolType: command ? 'commandExecution' : 'fileChange',
      label: command ? params.kind === 'writeStdin' ? 'Permitir esta entrada no terminal?' : 'Permitir esta execução?' : 'Permitir estas alterações?',
      command: bounded(params.command || item?.command), cwd: bounded(params.cwd),
      reason: bounded([params.reason, params.grantRoot ? `Acesso solicitado: ${params.grantRoot}` : ''].filter(Boolean).join('\n')),
      output: bounded(item?.output),
    });
    worker.permissions.set(requestId, { serverId: request.id, message });
    this._event(session, 'permission', { permission: message });
  }

  async approve(root, id, requestId, choice) {
    const session = this._session(root, id);
    if (!['accept', 'decline'].includes(choice)) throw new Error('Escolha permitir uma vez ou recusar.');
    const worker = this.active.get(id);
    const permission = worker?.permissions.get(requestId);
    if (!permission || worker.canceled) throw new Error('Esta solicitação já foi encerrada.');
    this._write(worker, { id: permission.serverId, result: { decision: choice } });
    permission.message.status = choice === 'accept' ? 'accepted' : 'declined';
    worker.permissions.delete(requestId);
    this._event(session, 'permission', { permission: permission.message });
    this._saveSoon();
  }

  _interrupt(worker) {
    if (worker.interruptSent || !worker.turnId || !worker.session.vendorThreadId) return;
    worker.interruptSent = true;
    this._rpc(worker, 'turn/interrupt', { threadId: worker.session.vendorThreadId, turnId: worker.turnId }, CANCEL_TIMEOUT).catch(() => {});
  }

  async cancel(root, id) {
    this._session(root, id);
    const worker = this.active.get(id);
    if (!worker || worker.canceled) return;
    worker.canceled = true;
    const pid=worker.child?.pid;
    worker.cancelSnapshot=Number.isInteger(pid) && pid>0 ? processSnapshot().then(rows=>rows?.some(row=>row.pid===pid) ? descendants(rows,pid) : null).catch(()=>null) : Promise.resolve([]);
    for (const permission of worker.permissions.values()) {
      try { this._write(worker, { id: permission.serverId, result: { decision: 'cancel' } }); } catch {}
      permission.message.status = 'expired';
      this._event(worker.session, 'permission', { permission: permission.message });
    }
    worker.permissions.clear();
    // Capture ownership before asking the app server to exit, since children
    // can otherwise be reparented and no longer identifiable.
    await worker.cancelSnapshot;
    if(this.active.get(id)!==worker || worker.terminal)return;
    this._interrupt(worker);
    worker.cancelTimer = setTimeout(() => {
      for (const request of worker.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Conversa interrompida.')); }
      worker.pending.clear();
      worker.finishTurn({ status: 'interrupted' });
      this._kill(worker, 'SIGTERM');
    }, CANCEL_TIMEOUT);
    if (!worker.turnId) this._kill(worker, 'SIGTERM');
  }

  _kill(worker, signal) {
    const child = worker.child;
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') { if (child.exitCode === null && child.signalCode === null) child.kill(signal); }
      else process.kill(-child.pid, signal);
    } catch {}
  }

  async _dispose(worker) {
    for (const request of worker.pending.values()) { clearTimeout(request.timer); request.reject(new Error('A conversa foi encerrada.')); }
    worker.pending.clear();
    const child = worker.child;
    if (child) {
      if (child.exitCode !== null || child.signalCode !== null) { if(!worker.cancelSnapshot)this._kill(worker, 'SIGTERM'); }
      else {
        child.stdin.end();
        await new Promise(resolve => {
          let done = false;
          const finish = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(killTimer); resolve(); };
          const timer = setTimeout(() => this._kill(worker, 'SIGTERM'), 250);
          const killTimer = setTimeout(() => { this._kill(worker, 'SIGKILL'); finish(); }, 750);
          child.once('close', finish);
        });
      }
    }
    if(worker.cancelSnapshot) {
      const result=await stopRecordedProcesses(await worker.cancelSnapshot);
      worker.cleanupPartial=Boolean(worker.cleanupPartial || result.partial);
      if(result.partial)this._append(worker.session,{kind:'system',text:'Não foi possível confirmar o encerramento de todos os processos associados ao Codex.',status:'failed'});
    }
  }

  resourceRoots() { return [...this.active.values()].filter(worker => Number.isInteger(worker.child?.pid) && !worker.terminal).map(worker => ({ id: worker.session.id, pid: worker.child.pid, root: worker.session.root, kind: 'codex', lastActivity: worker.lastActivity })); }

  async closeProject(root) {
    root = directory(root);
    const workers = [...this.active.values()].filter(worker => worker.session.root === root);
    await Promise.all(workers.map(async worker => {
      await this.cancel(root, worker.session.id);
      if(worker.child && worker.child.exitCode===null && worker.child.signalCode===null) this._kill(worker, 'SIGTERM');
      await worker.run;
    }));
    this._save();
    return workers.length;
  }

  async closeAll() {
    this.closed = true;
    const workers=[...this.active.values()];
    const results=await Promise.allSettled(workers.map(async worker => {
      try { await this.cancel(worker.session.root, worker.session.id); } catch { worker.cleanupPartial=true; }
      if(worker.child && worker.child.exitCode===null && worker.child.signalCode===null) this._kill(worker, 'SIGTERM');
      await worker.run;
    }));
    this._save();
    return {partial:results.some(result=>result.status==='rejected') || workers.some(worker=>worker.cleanupPartial)};
  }
}

module.exports = { CodexChat };
