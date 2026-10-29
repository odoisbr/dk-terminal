const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { directory, executable } = require('./core.cjs');
const { inside } = require('./catalogs.cjs');
const { readGuide, agentGuideEnvironment } = require('./agent-guide.cjs');
const { compose } = require('./prompt-compose.cjs');
const { processSnapshot, descendants, stopRecordedProcesses } = require('./session-processes.cjs');

const KiB = 1024;
const LIMITS = Object.freeze({ ativos_por_projeto: 2, ativos_por_app: 3, fila_por_app: 4,
  prazo_ms: 900000, init_ms: 20000, interrupt_ms: 5000, sigkill_ms: 1000,
  linha_max: 1024 * KiB, texto_por_mensagem: 256 * KiB, input_aprovacao: 16 * KiB,
  tool_result: 64 * KiB, eventos_por_run: 500, store: 8 * 1024 * KiB, runs: 30,
  linhas_invalidas: 3 });
const FINAL = new Set(['concluido', 'interrompido', 'falhou', 'expirada']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARK = '…[truncado]';
const copy = value => JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function bounded(value, limit = 2 * KiB) {
  const bytes = Buffer.from(typeof value === 'string' ? value : '');
  if (bytes.length <= limit) return bytes.toString('utf8');
  let end = Math.max(0, limit - Buffer.byteLength(MARK));
  while (end && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + MARK;
}
const errorText = error => bounded(error instanceof Error ? error.message : String(error));
const contentText = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : '';
const summary = input => bounded(['command', 'file_path', 'url'].map(key => typeof input?.[key] === 'string' ? input[key] : '').filter(Boolean).join('\n'));
function usage(value = {}, cost) {
  const result = {};
  for (const key of ['input_tokens', 'output_tokens']) if (Number.isFinite(value[key])) result[key] = value[key];
  if (Number.isFinite(value.cache_read_input_tokens ?? value.cache_read)) result.cache_read = value.cache_read_input_tokens ?? value.cache_read;
  if (Number.isFinite(cost)) result.total_cost_usd = cost;
  return result;
}
function canonicalFile(file) {
  let parent = file;
  const tail = [];
  while (!fs.existsSync(parent)) { tail.unshift(path.basename(parent)); const next = path.dirname(parent); if (next === parent) break; parent = next; }
  return path.join(fs.realpathSync(parent), ...tail);
}

/** Pure wire normalization. Internal control events are consumed only by AgentRun.
 * Stream deltas are reconciled into replaceable text in the runner (40 ms).
 * Thinking, permission_suggestions and raw protocol messages never reach emit/store.
 */
function normalize(line) {
  const m = typeof line === 'string' ? JSON.parse(line) : line;
  if (!object(m)) return [];
  if (m.type === 'system' && m.subtype === 'init') return [{ type: 'init', sessionId: bounded(m.session_id, 160), model: bounded(m.model, 200), permissionMode: m.permissionMode,
    tools: Array.isArray(m.tools) ? m.tools.slice(0, 200).map(tool => bounded(tool, 160)) : [] }];
  if (m.type === 'control_request') {
    const r = m.request || {};
    return [{ type: 'control', cliRequestId: m.request_id, subtype: r.subtype, toolName: bounded(r.tool_name, 200), displayName: bounded(r.display_name, 200),
      input: r.input, description: bounded(r.description), blockedPath: bounded(r.blocked_path), decisionReason: bounded(r.decision_reason) }];
  }
  if (m.type === 'control_cancel_request') return [{ type: 'control_cancel', cliRequestId: m.request_id }];
  if (m.type === 'stream_event') {
    const e = m.event || {}, delta = e.delta || {};
    if (e.type === 'message_start') return [{ type: 'message_start', messageId: bounded(e.message?.id, 160) }];
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') return [{ type: 'tool_use', index: e.index,
      toolUseId: bounded(e.content_block.id, 160), name: bounded(e.content_block.name, 200), inputResumo: summary(e.content_block.input), inputBytes: Buffer.byteLength(JSON.stringify(e.content_block.input || {})), estado: 'iniciado' }];
    if (e.type === 'content_block_delta' && delta.type === 'text_delta') return [{ type: 'delta', value: typeof delta.text === 'string' ? delta.text : '' }];
    if (e.type === 'content_block_delta' && delta.type === 'input_json_delta') return [{ type: 'input_bytes', index: e.index, bytes: Buffer.byteLength(delta.partial_json || '') }];
    if (e.type === 'message_delta' && e.usage) return [{ type: 'usage', ...usage(e.usage) }];
    return [];
  }
  if (m.type === 'assistant') {
    const events = [], blocks = Array.isArray(m.message?.content) ? m.message.content : [];
    if (blocks.some(b => b.type === 'text')) events.push({ type: 'text_final', messageId: bounded(m.message.id, 160), value: contentText(blocks) });
    for (const b of blocks) if (b.type === 'tool_use') events.push({ type: 'tool_use', toolUseId: bounded(b.id, 160), name: bounded(b.name, 200), inputResumo: summary(b.input), inputBytes: Buffer.byteLength(JSON.stringify(b.input || {})), estado: 'concluido' });
    if (m.message?.usage) events.push({ type: 'usage', ...usage(m.message.usage) });
    return events;
  }
  if (m.type === 'user') {
    const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
    const results = blocks.filter(b => b.type === 'tool_result').map(b => ({ type: 'tool_result', toolUseId: bounded(b.tool_use_id, 160), content: bounded(contentText(b.content), LIMITS.tool_result), is_error: Boolean(b.is_error), truncado: Buffer.byteLength(contentText(b.content)) > LIMITS.tool_result }));
    return results.length ? results : [{ type: 'accepted' }];
  }
  if (m.type === 'result') return [{ type: 'result', subtype: bounded(m.subtype, 200), is_error: Boolean(m.is_error),
    num_turns: Number(m.num_turns) || 0, duration_ms: Number(m.duration_ms) || 0, total_cost_usd: Number(m.total_cost_usd) || 0,
    permission_denials: Array.isArray(m.permission_denials) ? m.permission_denials.slice(0, 100).map(d => ({ tool_name: bounded(d?.tool_name, 200), tool_use_id: bounded(d?.tool_use_id, 160) })) : [], session_id: bounded(m.session_id, 160) },
  { type: 'usage', ...usage(m.usage, m.total_cost_usd) }];
  return [];
}

const claude = Object.freeze({
  argv({ promptFile, sessionId, resume }) {
    return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--replay-user-messages',
      '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--permission-mode', 'manual', '--append-system-prompt-file', promptFile,
      '--setting-sources', 'user,local',
      resume ? '--resume' : '--session-id', sessionId];
  },
  write(child, message) {
    if (!child?.stdin?.writable || child.stdin.destroyed) throw new Error('A conexão com o Claude foi encerrada.');
    child.stdin.write(JSON.stringify(message) + '\n');
  },
  interrupt(child) { this.write(child, { type: 'control_request', request_id: `dk-${randomUUID()}`, request: { subtype: 'interrupt' } }); },
  kill(child, signal) {
    if (!child?.pid) return false;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else return child.exitCode === null && child.signalCode === null && child.kill(signal);
      return true;
    } catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
  },
  normalize,
});

/** Only probes --version/--help. A static pass is NOT proof of official host approval. */
class AgentRun {
  constructor({ env = process.env, storeFile, runsDir, emit = () => {}, previewEnvironment = () => ({}), sources = {}, limits = {} }) {
    if (typeof storeFile !== 'string' || !path.isAbsolute(storeFile) || typeof runsDir !== 'string' || !path.isAbsolute(runsDir)) throw new Error('O runner precisa de pastas privadas absolutas.');
    this.storeFile = canonicalFile(storeFile); this.runsDir = canonicalFile(runsDir);
    this.env = env; this.emit = emit; this.previewEnvironment = previewEnvironment; this.sources = sources;
    this.limits = { ...LIMITS };
    // Injectable smaller budgets/timers make synthetic tests deterministic. Public
    // prazoMs remains 1–120 min; byte/count limits cannot be raised by callers.
    for (const [key, value] of Object.entries(limits)) {
      if (!(key in LIMITS) || !Number.isSafeInteger(value) || value <= 0 || value > LIMITS[key]) throw new Error(`Limite inválido: ${key}`);
      this.limits[key] = value;
    }
    this.runs = new Map(); this.active = new Map(); this.queue = []; this.preparing = new Set();
    this.closingProjects = new Set(); this.generation = 0; this.projectGenerations = new Map();
    this.closed = false; this.canceling = false; this.capCache = new Map(); this.dynamicFailures = new Map();
    this._load();
    this.ready = this._cleanOrphans();
    this.ready.catch(() => {});
  }

  _environment(root) {
    const env = { ...this.env, ...(root ? this.previewEnvironment(root) : {}), ...agentGuideEnvironment(typeof this.sources.guide === 'string' ? this.sources.guide : null) };
    for (const key of Object.keys(env)) if (key.startsWith('DK_TERMINAL_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
    return env;
  }
  async _cleanOrphans() {
    await fs.promises.mkdir(this.runsDir, { recursive: true, mode: 0o700 });
    for (const entry of await fs.promises.readdir(this.runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const dir = path.join(this.runsDir, entry.name);
      // Only our named prompt is removed, never arbitrary contents or symlink targets.
      await fs.promises.unlink(path.join(dir, 'system-prompt.md')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.promises.rmdir(dir).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    }
  }
  _private(root) {
    if (inside(root, canonicalFile(this.storeFile)) || inside(root, canonicalFile(this.runsDir))) throw new Error('O histórico e o prompt devem ficar fora do projeto.');
  }
  _load() {
    try {
      const fd = fs.openSync(this.storeFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let saved;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > this.limits.store) return;
        const buffer = Buffer.alloc(this.limits.store + 1); let count = 0;
        while (count < buffer.length) { const size = fs.readSync(fd, buffer, count, buffer.length - count, count); if (!size) break; count += size; }
        if (count > this.limits.store) return;
        saved = JSON.parse(buffer.subarray(0, count).toString('utf8'));
      } finally { fs.closeSync(fd); }
      for (const raw of (Array.isArray(saved.runs) ? saved.runs : []).slice(-this.limits.runs)) {
        if (!UUID.test(raw?.runId) || typeof raw.root !== 'string' || !path.isAbsolute(raw.root)) continue;
        const run = { runId: raw.runId, root: raw.root, provider: 'claude', estado: FINAL.has(raw.estado) ? raw.estado : 'expirada',
          sessionId: UUID.test(raw.sessionId) ? raw.sessionId : null, title: bounded(raw.title, 120), model: bounded(raw.model, 200),
          createdAt: Number(raw.createdAt) || Date.now(), updatedAt: Number(raw.updatedAt) || Date.now(),
          texto: bounded(raw.texto, 64 * KiB), usage: usage(raw.usage, raw.usage?.total_cost_usd), parcial: Boolean(raw.parcial || !FINAL.has(raw.estado)),
          cleanupPartial: Boolean(raw.cleanupPartial), promptHash: bounded(raw.promptHash, 64), seq: 0, eventos: [] };
        if (run.texto) this._event(run, 'text_delta', { messageId: `${run.runId}:saved`, value: run.texto }, false);
        this.runs.set(run.runId, run);
      }
      fs.chmodSync(this.storeFile, 0o600);
    } catch { /* Invalid/missing history does not block the terminal fallback. */ }
  }
  _metadata(run) { const { eventos, seq, ...metadata } = run; return copy(metadata); }
  _save() {
    clearTimeout(this.saveTimer); this.saveTimer = null;
    // No live approvals, original tool inputs, CLI request IDs or prompt bodies on disk.
    const runs = [...this.runs.values()].map(run => this._metadata(run));
    let data = JSON.stringify({ version: 1, runs });
    while (Buffer.byteLength(data) + 1 > this.limits.store && runs.length) { runs.shift(); data = JSON.stringify({ version: 1, runs }); }
    const temp = `${this.storeFile}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, data + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.storeFile); fs.chmodSync(this.storeFile, 0o600);
    } catch {
      try { fs.unlinkSync(temp); } catch {}
      for (const worker of this.active.values()) this._event(worker.run, 'error', { message: 'Não foi possível salvar o histórico privado do runner.', fatal: false });
    }
  }
  _saveSoon() { if (!this.saveTimer) { this.saveTimer = setTimeout(() => this._save(), 1500); this.saveTimer.unref?.(); } }
  _event(run, type, fields = {}, publish = true) {
    const event = { runId: run.runId, root: run.root, seq: ++run.seq, at: Date.now(), type, ...copy(fields) };
    // Coalesce replaceable events so read() retains the latest text/decision.
    if (['text_delta', 'approval', 'tool_use'].includes(type)) {
      const key = { text_delta: 'messageId', approval: 'requestId', tool_use: 'toolUseId' }[type];
      run.eventos = run.eventos.filter(e => e.type !== type || e[key] !== event[key]);
    }
    run.eventos.push(event);
    while (run.eventos.length > this.limits.eventos_por_run) {
      // A project switch must still be able to recover its unanswered cards,
      // even after hundreds of tool events have arrived in the background.
      const index = run.eventos.findIndex(e => e.type !== 'approval' || e.status !== 'pending');
      run.eventos.splice(index < 0 ? 0 : index, 1);
    }
    run.updatedAt = Date.now();
    if (publish) { try { this.emit(copy(event)); } catch { /* Renderer teardown cannot break cleanup. */ } }
  }
  _status(run, estado, fields = {}) { run.estado = estado; this._event(run, 'status', { estado, ...fields }); this._saveSoon(); }
  _runFor(root, id) {
    const run = this.runs.get(id);
    if (!run || (run.root !== root && run.root !== directory(root))) throw new Error('Execução não encontrada neste projeto.');
    return run;
  }
  list(root) { root = directory(root); return [...this.runs.values()].filter(r => r.root === root).map(r => this._metadata(r)).sort((a, b) => b.updatedAt - a.updatedAt); }
  read(root, id) { const run = this._runFor(root, id); return { run: this._metadata(run), eventos: copy(run.eventos) }; }

  async capabilities(root) {
    const searchEnv = { ...this.env, PATH: (this.env.PATH || '').split(path.delimiter).filter(entry => path.isAbsolute(entry)).join(path.delimiter) };
    let binario = executable('claude', searchEnv), key = null;
    const base = { disponivel: false, versao: null, binario, motivo: 'Instale a CLI oficial do Claude. Abrir no terminal oficial.', aprovacao_host_provada: false };
    let result = base;
    if (binario) {
      try {
        binario = await fs.promises.realpath(binario);
        // Check before probing: even --version/--help executes project code.
        if (root && inside(root, binario)) {
          this.capabilityKey = null;
          return { claude: { ...base, binario, motivo: 'Binário do Claude dentro do projeto recusado. Abrir no terminal oficial.' }, codex: { disponivel: false, motivo: 'Use o painel Codex' } };
        }
        const stat = await fs.promises.stat(binario); key = `${binario}:${stat.mtimeMs}:${stat.size}`;
        if (!this.capCache.has(key)) {
          if (this.capCache.size >= 8) this.capCache.clear();
          const probe = arg => new Promise((resolve, reject) => execFile(binario, [arg], { env: this._environment(), timeout: 10000, maxBuffer: 64 * KiB, windowsHide: true }, (error, out) => error ? reject(error) : resolve(out)));
          this.capCache.set(key, (async () => {
            try {
              const version = await probe('--version'), help = await probe('--help');
              const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version);
              const versao = match ? match.slice(1).join('.') : null;
              const v = match?.slice(1).map(Number);
              const recent = v && (v[0] > 2 || v[0] === 2 && (v[1] > 1 || v[1] === 1 && v[2] >= 312));
              const flags = ['--permission-prompts', '--permission-prompt-tool', '--input-format', 'stream-json', '--include-partial-messages'];
              const optionHelp = flag => {
                const start = help.indexOf(flag);
                return start < 0 ? '' : help.slice(start).split(/\n\s{0,4}-[\w-]/, 1)[0];
              };
              const disponivel = Boolean(recent && flags.every(flag => help.includes(flag)) && optionHelp('--input-format').includes('stream-json') && /["']manual["']/.test(optionHelp('--permission-mode')));
              return { ...base, binario, versao, disponivel, motivo: disponivel ? 'Protocolo não confirmado com a CLI oficial.' : 'CLI sem capacidade de aprovação stdio manual confirmada. Abrir no terminal oficial.' };
            } catch {
              this.capCache.delete(key);
              return { ...base, binario, motivo: 'Não foi possível verificar a CLI. Abrir no terminal oficial.' };
            }
          })());
        }
        result = await this.capCache.get(key);
        if (this.dynamicFailures.has(key)) result = { ...result, disponivel: false, motivo: this.dynamicFailures.get(key) };
      } catch { result = base; }
    }
    this.capabilityKey = key;
    return { claude: copy(result), codex: { disponivel: false, motivo: 'Use o painel Codex' } };
  }

  /** Sources: guide file path or () => bounded text; catalogs/stages are the
   * existing module instances. Catalog IDs are qualified <catalogId>/<entryId>.
   */
  async preview(root, options = {}) {
    root = directory(root);
    const missing = motivo => ({ ausente: true, motivo });
    const camadas = {};
    try {
      const text = typeof this.sources.guide === 'function' ? await this.sources.guide() : readGuide(this.sources.guide);
      camadas.guia_dk = typeof text === 'string' && Buffer.byteLength(text) <= 32 * KiB ? text : missing('Guia excede 32 KiB.');
    } catch { camadas.guia_dk = missing('Guia indisponível.'); }
    for (const [option, layer] of [['skillId', 'skill_ativa'], ['designSystemId', 'design_system']]) {
      const id = options[option];
      if (!id) continue;
      try {
        if (typeof id !== 'string' || id.length > 200 || !id.includes('/')) throw new Error();
        const split = id.lastIndexOf('/');
        const data = await this.sources.catalogs.read(root, id.slice(0, split), id.slice(split + 1));
        const text = `${data.frontmatter ? '---\n' + JSON.stringify(data.frontmatter) + '\n---\n' : ''}${data.text || ''}`;
        if (Buffer.byteLength(text) > 64 * KiB) throw new Error();
        camadas[layer] = { text };
      } catch { camadas[layer] = missing('Catálogo indisponível ou não autorizado.'); }
    }
    try {
      const file = path.join(root, 'AGENTS.md'), stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * KiB) throw new Error();
      const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const current = await handle.stat();
        if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isFile()) throw new Error();
        const buffer = Buffer.alloc(1024 * KiB + 1); let count = 0;
        while (count < buffer.length) { const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count); if (!bytesRead) break; count += bytesRead; }
        if (count > 1024 * KiB) throw new Error();
        camadas.instrucoes_projeto = buffer.subarray(0, count).toString('utf8');
      } finally { await handle.close(); }
    } catch { camadas.instrucoes_projeto = missing('AGENTS.md ausente, não regular ou maior que 1 MiB.'); }
    if (this.sources.stages) {
      try {
        const snapshot = await this.sources.stages.read(root);
        const stage = snapshot.stages?.find(s => options.stage ? s.id === options.stage : s.liberada && s.estado !== 'concluido');
        if (stage) camadas.etapa_ativa = `${bounded(stage.id, 80)} — ${bounded(stage.nome, 200)}\n` + stage.criterios.filter(c => c.estado !== 'concluido').slice(0, 100).map(c => bounded(`${c.id}: ${c.descricao} — ${c.motivo}`, KiB)).join('\n');
      } catch { camadas.etapa_ativa = missing('Etapa indisponível.'); }
    }
    if (options.files !== undefined) {
      try {
        if (!Array.isArray(options.files) || options.files.length > 200) throw new Error();
        for (const file of options.files) {
          if (typeof file !== 'string' || file.length > 8192 || /[\x00-\x1f\x7f]/.test(file) || path.isAbsolute(file) || path.win32.isAbsolute(file) || file.replace(/\\/g, '/').split('/').includes('..')) throw new Error();
          const real = await fs.promises.realpath(path.resolve(root, file));
          if (!inside(root, real)) throw new Error();
        }
        camadas.arquivos = { caminhos: options.files };
      } catch { camadas.arquivos = missing('Arquivos recusados: até 200 caminhos relativos contidos na raiz.'); }
    }
    return compose({ root, camadas });
  }

  async start(root, options = {}) {
    root = directory(root); this._private(root);
    const identity = fs.statSync(root);
    const generation = this.generation, projectGeneration = this.projectGenerations.get(root);
    const valid = () => {
      if (this.closed || this.canceling || this.closingProjects.has(root) || generation !== this.generation || projectGeneration !== this.projectGenerations.get(root)) throw new Error('O runner ou projeto está sendo encerrado.');
      const current = fs.statSync(root);
      if (current.dev !== identity.dev || current.ino !== identity.ino || fs.realpathSync(root) !== root) throw new Error('A identidade do projeto mudou durante a preparação.');
    };
    valid();
    if (options.provider !== 'claude') throw new Error('Use o painel Codex.');
    if (options.modo && options.modo !== 'interativo') throw new Error('Somente leitura indisponível: este runner exige permission-mode manual. Abrir no terminal oficial.');
    if (typeof options.prompt !== 'string' || !options.prompt.trim()) throw new Error('Escreva uma mensagem de até 64 KiB.');
    const input = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: options.prompt }] }, parent_tool_use_id: null };
    if (Buffer.byteLength(JSON.stringify(input)) + 1 > 64 * KiB) throw new Error('Escreva uma mensagem de até 64 KiB (incluindo o envelope).');
    if (options.prazoMs !== undefined && (!Number.isSafeInteger(options.prazoMs) || options.prazoMs < 60000 || options.prazoMs > 7200000)) throw new Error('O prazo deve ficar entre 1 e 120 minutos.');
    if (options.sessionId !== undefined && !UUID.test(options.sessionId)) throw new Error('Sessão inválida.');
    for (const key of ['skillId', 'designSystemId', 'stage']) if (options[key] !== undefined && (typeof options[key] !== 'string' || options[key].length > 200)) throw new Error('Seleção de prompt inválida.');
    let release;
    const preparation = { root, done: new Promise(resolve => { release = resolve; }) };
    this.preparing.add(preparation);
    try {
      await this.ready; valid();
      const capability = (await this.capabilities(root)).claude, capabilityKey = this.capabilityKey;
      valid();
      if (!capability.disponivel) throw new Error(capability.motivo);
      const composed = await this.preview(root, options); valid(); this._private(root);
      const promptHash = createHash('sha256').update(JSON.stringify([options.skillId ?? null, options.designSystemId ?? null, options.stage ?? null])).update('\0').update(composed.text).digest('hex');
      if (options.sessionId) {
        const previous = [...this.runs.values()].find(r => r.sessionId === options.sessionId && r.root === root);
        if (!previous || previous.promptHash !== promptHash) throw new Error('Nova sessão necessária: o prompt, skill ou etapa mudou, ou a sessão não pertence ao projeto.');
        if ([...this.active.values(), ...this.queue].some(w => w.run.sessionId === options.sessionId)) throw new Error('Aguarde o turno desta sessão.');
      }
      const canStart = this.queue.length === 0 && this._slot(root);
      if (!canStart && this.queue.length >= this.limits.fila_por_app) throw new Error('A fila de agentes está cheia.');
      if (this.runs.size >= this.limits.runs) {
        const oldest = [...this.runs.values()].filter(r => FINAL.has(r.estado)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (!oldest) throw new Error('Encerre uma execução antes de iniciar outra.');
        this.runs.delete(oldest.runId);
      }
      const run = { runId: randomUUID(), root, provider: 'claude', estado: 'na_fila', sessionId: options.sessionId || randomUUID(),
        title: bounded(options.prompt.trim().split('\n')[0], 120), createdAt: Date.now(), updatedAt: Date.now(), texto: '', usage: {},
        promptHash, parcial: false, cleanupPartial: false, seq: 0, eventos: [] };
      const worker = { run, input, composed, binary: capability.binario, capabilityKey, resume: Boolean(options.sessionId), prazoMs: options.prazoMs ?? this.limits.prazo_ms,
        identity, pending: new Map(), texts: new Map(), dirty: new Set(), tools: new Map(), indexes: new Map(), lastActivity: Date.now(), unknown: 0, invalid: 0 };
      worker.done = new Promise(resolve => { worker.resolve = resolve; });
      this.runs.set(run.runId, run); this.queue.push(worker); this._status(run, 'na_fila'); this._save(); this._drain();
      return { runId: run.runId, estado: run.estado };
    } finally { this.preparing.delete(preparation); release(); }
  }
  _slot(root) { return this.active.size < this.limits.ativos_por_app && [...this.active.values()].filter(w => w.run.root === root).length < this.limits.ativos_por_projeto; }
  _drain() {
    if (this.closed || this.canceling) return;
    // Strict FIFO: do not let another project jump a blocked head of queue.
    while (this.queue.length && this._slot(this.queue[0].run.root) && !this.closingProjects.has(this.queue[0].run.root)) {
      const worker = this.queue.shift(); this.active.set(worker.run.runId, worker);
      this._status(worker.run, 'iniciando'); this._launch(worker);
    }
  }

  async _launch(w) {
    try {
      const dir = path.join(this.runsDir, w.run.runId);
      await fs.promises.mkdir(dir, { mode: 0o700 }); w.promptDir = dir;
      w.promptFile = path.join(dir, 'system-prompt.md');
      await fs.promises.writeFile(w.promptFile, w.composed.text, { mode: 0o600, flag: 'wx' });
      await fs.promises.chmod(w.promptFile, 0o600);
      w.composed = null;
      if (w.canceled) { await this._finish(w); return; }
      const current = await fs.promises.stat(w.run.root);
      if (current.dev !== w.identity.dev || current.ino !== w.identity.ino || await fs.promises.realpath(w.run.root) !== w.run.root) throw new Error('A identidade do projeto mudou antes do spawn.');
      if (inside(w.run.root, await fs.promises.realpath(w.binary))) throw new Error('Binário do Claude dentro do projeto recusado.');
      // Cancellation can race the asynchronous identity check as well as composition.
      if (w.canceled) { await this._finish(w); return; }
      const child = w.child = spawn(w.binary, claude.argv({ promptFile: w.promptFile, sessionId: w.run.sessionId, resume: w.resume }), {
        cwd: w.run.root, env: this._environment(w.run.root), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
      });
      w.closedPromise = new Promise(resolve => { w.resolveClosed = resolve; });
      child.stdin.on('error', () => {});
      const decoder = new StringDecoder('utf8'); let buffer = '';
      const receive = line => {
        try { this._receive(w, line); }
        catch (error) { this._fail(w, `Falha no protocolo do Claude: ${errorText(error)}`); }
      };
      const parse = text => {
        if (w.ended || w.canceled) return;
        buffer += text;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > this.limits.linha_max) { this._fail(w, 'Linha do Claude excede 1 MiB.'); buffer = ''; return; }
          if (line.trim()) receive(line);
          if (w.ended || w.canceled) { buffer = ''; return; }
        }
        if (Buffer.byteLength(buffer) > this.limits.linha_max) { this._fail(w, 'Linha do Claude excede 1 MiB.'); buffer = ''; }
      };
      child.stdout.on('data', chunk => { w.lastActivity = Date.now(); parse(decoder.write(chunk)); });
      child.stdout.on('end', () => { parse(decoder.end()); if (buffer.trim() && !w.ended && !w.canceled) receive(buffer); buffer = ''; });
      w.stderr = ''; let stderrTail = ''; const stderrDecoder = new StringDecoder('utf8');
      child.stderr.on('data', chunk => {
        const text = stderrDecoder.write(chunk);
        w.stderr = bounded(w.stderr + text, 64 * KiB);
        if (/unknown option|argument '.*' is invalid|Allowed choices are|too many arguments/i.test(stderrTail + text)) this._fail(w, `CLI recusou uma opção do protocolo. Abrir no terminal oficial.\n${w.stderr}`, true);
        stderrTail = text.slice(-32);
      });
      child.once('error', error => { this._fail(w, `Não foi possível iniciar a CLI: ${errorText(error)}`); });
      child.once('close', (code, signal) => {
        w.processClosed = true; w.resolveClosed();
        if (!w.ended && !w.canceled) this._fail(w, `Claude encerrou antes do result (${code ?? signal}).\n${w.stderr}`);
        this._finish(w);
      });
      w.initTimer = setTimeout(() => this._fail(w, `Claude não confirmou init manual no prazo. Abrir no terminal oficial.\n${w.stderr}`), this.limits.init_ms);
      claude.write(child, w.input); w.input = null;
    } catch (error) { this._fail(w, errorText(error)); if (!w.child) await this._finish(w); }
  }
  _fail(w, message, capability = false) {
    if (w.ended || w.canceled) return;
    // Preserve the bounded stderr (64 KiB) plus the diagnostic prefix.
    w.failure = bounded(message, 66 * KiB); this._event(w.run, 'error', { message: w.failure, fatal: true });
    if (capability) this.dynamicFailures.set(w.capabilityKey, w.failure);
    this._cancel(w);
  }
  _receive(w, line) {
    if (w.ended || w.canceled) return;
    let events;
    try { events = normalize(line); }
    catch {
      w.invalid++; this._event(w.run, 'error', { message: 'Linha JSON inválida recebida do Claude.', fatal: w.invalid >= this.limits.linhas_invalidas });
      if (w.invalid >= this.limits.linhas_invalidas) this._fail(w, 'Três linhas inválidas no protocolo do Claude.');
      return;
    }
    if (!events.length) w.unknown++;
    let result = null;
    for (const event of events) {
      if (w.canceled) break;
      const { type, ...fields } = event;
      if (type === 'init') {
        if (event.permissionMode !== 'manual') { this._fail(w, 'Claude iniciou com permissionMode diferente de manual.', true); break; }
        if (event.sessionId !== w.run.sessionId) { this._fail(w, 'Claude iniciou outra sessão.', true); break; }
        if (w.initialized) continue;
        clearTimeout(w.initTimer); w.initialized = true; w.run.model = event.model;
        this._status(w.run, 'executando', fields); this._armDeadline(w); continue;
      }
      if (!w.initialized) { this._fail(w, 'Evento antes da confirmação de init manual.', true); break; }
      switch (type) {
        case 'message_start': w.messageId = event.messageId || randomUUID(); break;
        case 'delta': this._text(w, w.messageId || (w.messageId = randomUUID()), event.value, false); break;
        case 'text_final': this._text(w, event.messageId || w.messageId || randomUUID(), event.value, true); break;
        case 'tool_use': {
          if (w.tools.size >= this.limits.eventos_por_run && !w.tools.has(event.toolUseId)) w.tools.delete(w.tools.keys().next().value);
          const tool = { ...fields }; delete tool.index;
          w.tools.set(tool.toolUseId, tool);
          if (event.index !== undefined) { if (w.indexes.size >= this.limits.eventos_por_run) w.indexes.clear(); w.indexes.set(event.index, tool.toolUseId); }
          this._event(w.run, type, tool); break;
        }
        case 'input_bytes': { const tool = w.tools.get(w.indexes.get(event.index)); if (tool) { tool.inputBytes += event.bytes; this._event(w.run, 'tool_use', tool); } break; }
        case 'tool_result': this._event(w.run, type, { ...fields, content: bounded(event.content, this.limits.tool_result), truncado: event.truncado || Buffer.byteLength(event.content) > this.limits.tool_result }); break;
        case 'accepted': this._event(w.run, 'status', { estado: w.run.estado, aceito: true }); break;
        case 'usage': Object.assign(w.run.usage, fields); this._event(w.run, type, fields); break;
        case 'control': this._permission(w, event); break;
        case 'control_cancel': {
          for (const [id, pending] of w.pending) if (pending.cliRequestId === event.cliRequestId) { this._decision(w, id, 'expired'); break; }
          this._waitingStatus(w); break;
        }
        case 'result': result = fields; break;
        default: w.unknown++; break;
      }
    }
    if (result && !w.canceled) {
      w.result = result; w.ended = true; this._flush(w); this._expire(w);
      clearTimeout(w.deadlineTimer); clearTimeout(w.initTimer);
      w.child.stdin.end(); this._finish(w);
    }
  }
  _text(w, id, text, replace) {
    if (!w.texts.has(id) && w.texts.size >= this.limits.eventos_por_run) w.texts.delete(w.texts.keys().next().value);
    const previous = w.texts.get(id) || '';
    w.texts.set(id, bounded(replace ? text : previous.endsWith(MARK) ? previous : previous + text, this.limits.texto_por_mensagem));
    w.dirty.add(id);
    if (!w.deltaTimer) w.deltaTimer = setTimeout(() => this._flush(w), 40);
  }
  _flush(w) {
    clearTimeout(w.deltaTimer); w.deltaTimer = null;
    for (const id of w.dirty) this._event(w.run, 'text_delta', { messageId: id, value: w.texts.get(id) });
    w.dirty.clear();
    w.run.texto = bounded([...w.texts.values()].join('\n\n'), 64 * KiB); this._saveSoon();
  }
  _response(w, id, choice, input) {
    claude.write(w.child, { type: 'control_response', response: { subtype: 'success', request_id: id,
      response: choice === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Recusado no SEA Dock' } } });
  }
  _permission(w, event) {
    const id = event.cliRequestId;
    if (typeof id !== 'string' || !id || Buffer.byteLength(id) > 200) { this._fail(w, 'Identificador de controle inválido.'); return; }
    if ([...w.pending.values()].some(p => p.cliRequestId === id)) { this._fail(w, 'Pedido de controle duplicado.'); return; }
    if (event.subtype !== 'can_use_tool') {
      claude.write(w.child, { type: 'control_response', response: { subtype: 'error', request_id: id, error: 'não suportado' } });
      this._event(w.run, 'error', { message: 'Interação não suportada pelo SEA Dock. Use a CLI oficial para este fluxo.', fatal: false }); return;
    }
    if (!object(event.input) || Buffer.byteLength(JSON.stringify(event.input)) > this.limits.input_aprovacao || w.pending.size >= this.limits.eventos_por_run) {
      this._response(w, id, 'deny'); this._event(w.run, 'error', { message: 'Pedido recusado: input acima de 16 KiB, inválido ou excesso de aprovações.', fatal: false }); return;
    }
    const { toolName, displayName, description, blockedPath, decisionReason, input } = event;
    const approval = { requestId: randomUUID(), kind: 'tool', status: 'pending', toolName, displayName, description, blockedPath, decisionReason, input, resumo: summary(input) };
    w.pending.set(approval.requestId, { approval, cliRequestId: id, input: copy(input) });
    this._event(w.run, 'approval', approval); this._waitingStatus(w);
  }
  _waitingStatus(w) {
    if (w.canceled || w.ended) return;
    this._status(w.run, [...w.pending.values()].some(p => p.approval.kind === 'prazo') ? 'prazo_vencido' : w.pending.size ? 'aguardando_aprovacao' : 'executando');
  }
  _armDeadline(w) {
    clearTimeout(w.deadlineTimer);
    w.deadlineTimer = setTimeout(() => {
      if (w.canceled || w.ended) return;
      const approval = { requestId: randomUUID(), kind: 'prazo', status: 'pending', prazoMs: this.limits.prazo_ms };
      w.pending.set(approval.requestId, { approval }); this._event(w.run, 'approval', approval); this._waitingStatus(w);
      // No decision means no timer and no termination.
    }, w.prazoMs);
  }
  _decision(w, id, status) {
    const pending = w.pending.get(id); if (!pending) return;
    w.pending.delete(id); this._event(w.run, 'approval', { ...pending.approval, status });
  }
  _expire(w) { for (const id of [...w.pending.keys()]) this._decision(w, id, 'expired'); }
  async approve(root, runId, requestId, choice) {
    this._runFor(root, runId);
    if (!['allow', 'deny'].includes(choice)) throw new Error('Escolha permitir uma vez ou recusar.');
    const w = this.active.get(runId), pending = w?.pending.get(requestId);
    if (!pending || w.canceled || w.ended) throw new Error('Esta solicitação já foi encerrada.');
    if (pending.approval.kind === 'tool') this._response(w, pending.cliRequestId, choice, pending.input);
    this._decision(w, requestId, choice === 'allow' ? 'allowed' : 'denied');
    if (pending.approval.kind === 'prazo') {
      if (choice === 'deny') return this.cancel(root, runId);
      w.prazoMs = this.limits.prazo_ms; this._armDeadline(w);
    }
    this._waitingStatus(w);
  }
  _signal(w, signal) {
    try {
      if (claude.kill(w.child, signal) && w.ended && !w.canceled) {
        w.run.cleanupPartial = true;
        w.cleanupReason = `Encerramento normal exigiu ${signal}.`;
      }
    } catch { w.run.cleanupPartial = true; w.cleanupReason = `Não foi possível enviar ${signal} à CLI.`; }
  }
  async _waitClosed(w, ms) {
    if (w.processClosed || !w.child?.pid) return;
    let timer; await Promise.race([w.closedPromise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); clearTimeout(timer);
  }
  _cancel(w) {
    if (w.canceled || w.ended) return w.done;
    w.canceled = true; w.run.parcial = true;
    this._status(w.run, 'interrompendo', { parcial: true });
    clearTimeout(w.initTimer); clearTimeout(w.deadlineTimer);
    // Ownership snapshot starts before any denial/interrupt can reparent children.
    const pid = w.child?.pid;
    w.cancelSnapshot = Number.isInteger(pid) ? processSnapshot().then(rows => rows?.some(r => r.pid === pid) ? descendants(rows, pid) : null).catch(() => null) : Promise.resolve([]);
    w.cancelFlow = (async () => {
      await w.cancelSnapshot;
      for (const p of w.pending.values()) if (p.cliRequestId) { try { this._response(w, p.cliRequestId, 'deny'); } catch {} }
      this._expire(w);
      if (!w.processClosed && w.child) {
        try { claude.interrupt(w.child); } catch {}
        await this._waitClosed(w, this.limits.interrupt_ms);
        if (!w.processClosed) { this._signal(w, 'SIGTERM'); await this._waitClosed(w, this.limits.sigkill_ms); }
        if (!w.processClosed) { this._signal(w, 'SIGKILL'); await this._waitClosed(w, 1000); }
      }
    })();
    // A launch in progress finishes cleanup after its asynchronous file write.
    if (w.child) this._finish(w);
    return w.done;
  }
  async cancel(root, runId) {
    const run = this._runFor(root, runId), w = this.active.get(runId) || this.queue.find(w => w.run === run);
    if (!w) return;
    if (this.queue.includes(w)) {
      this.queue.splice(this.queue.indexOf(w), 1); this._cancel(w); await this._finish(w); this._drain();
    } else { this._cancel(w); await w.done; }
  }
  async _finish(w) {
    if (w.finishing) return w.done;
    w.finishing = true;
    try {
      if (w.cancelFlow) await w.cancelFlow;
      else if (w.child && !w.processClosed) {
        await this._waitClosed(w, this.limits.interrupt_ms);
        if (!w.processClosed) { this._signal(w, 'SIGTERM'); await this._waitClosed(w, this.limits.sigkill_ms); }
        if (!w.processClosed) { this._signal(w, 'SIGKILL'); await this._waitClosed(w, 1000); }
      }
      if (w.cancelSnapshot) { const cleanup = await stopRecordedProcesses(await w.cancelSnapshot); w.run.cleanupPartial ||= cleanup.partial; }
      if (w.child?.pid && !w.processClosed) w.run.cleanupPartial = true;
      // Terminate remaining members of our own group after a normally exited leader.
      if (!w.canceled && w.child?.pid && claude.kill(w.child, 'SIGTERM')) {
        await new Promise(resolve => setTimeout(resolve, this.limits.sigkill_ms));
        if (claude.kill(w.child, 0)) w.run.cleanupPartial = true;
      }
    } catch { w.run.cleanupPartial = true; }
    finally {
      w.ended = true; clearTimeout(w.initTimer); clearTimeout(w.deadlineTimer); this._flush(w); this._expire(w);
      if (w.promptDir) {
        try { await fs.promises.unlink(w.promptFile); await fs.promises.rmdir(w.promptDir); }
        catch (error) { if (error.code !== 'ENOENT') w.run.cleanupPartial = true; }
      }
      w.composed = null; w.input = null; w.stderr = '';
      w.run.unknownEvents = w.unknown; w.run.invalidLines = w.invalid;
      const estado = w.failure ? 'falhou' : w.canceled ? 'interrompido' : w.result?.is_error ? 'falhou' : w.result ? 'concluido' : 'falhou';
      w.run.parcial ||= estado !== 'concluido';
      this.active.delete(w.run.runId);
      this._status(w.run, estado, { ...(w.result || {}), sessionId: w.run.sessionId, parcial: w.run.parcial, cleanupPartial: w.run.cleanupPartial, ...(w.failure || w.cleanupReason ? { motivo: w.failure || w.cleanupReason } : {}) });
      this._save();
      // snapshot is not retained recursively in the event ring.
      try { this.emit({ runId: w.run.runId, root: w.run.root, seq: ++w.run.seq, at: Date.now(), type: 'snapshot', ...this.read(w.run.root, w.run.runId) }); } catch {}
      w.resolve(); this._drain();
    }
  }
  resourceRoots() { return [...this.active.values()].filter(w => Number.isInteger(w.child?.pid) && !w.processClosed).map(w => ({ id: w.run.runId, pid: w.child.pid, root: w.run.root, kind: 'claude-run', lastActivity: w.lastActivity })); }
  async closeProject(root) {
    root = directory(root); this.closingProjects.add(root);
    this.projectGenerations.set(root, (this.projectGenerations.get(root) || 0) + 1);
    const workers = [...this.active.values(), ...this.queue].filter(w => w.run.root === root);
    try {
      await Promise.all([...workers.map(w => this.cancel(root, w.run.runId)), ...[...this.preparing].filter(p => p.root === root).map(p => p.done)]);
      this._save(); return workers.length;
    } finally { this.closingProjects.delete(root); this._drain(); }
  }
  async cancelAll() {
    this.generation++; this.canceling = true;
    const workers = [...this.active.values(), ...this.queue];
    try {
      const results = await Promise.allSettled([...workers.map(w => this.cancel(w.run.root, w.run.runId)), ...[...this.preparing].map(p => p.done)]);
      this._save(); return { partial: results.some(r => r.status === 'rejected') || workers.some(w => w.run.cleanupPartial) };
    } finally { this.canceling = false; }
  }
  async closeAll() { this.closed = true; await this.ready.catch(() => {}); return this.cancelAll(); }
}

module.exports = { AgentRun, normalize, claude, LIMITS };
