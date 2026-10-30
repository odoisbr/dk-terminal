'use strict';

// visual:event reports only involuntary revocations: project-changed (project
// switched/closed), too-complex (deadline), worker-failed (worker error/exit),
// renderer-gone (renderer/window lost). Opening another file, close and reload
// revoke silently; their caller already owns the transition.
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomBytes, createHash } = require('node:crypto');
const { resolveFile, readBounded, saveProjectBytes } = require('./files.cjs');
const { documentUrl } = require('./visual-protocol.cjs');

const DOCUMENT_LIMIT = 2 * 1024 * 1024;
const WITHOUT_GENERATION = Symbol('reload');
const messages = {
  'file-unavailable': 'Não foi possível acessar o arquivo do editor visual.',
  unavailable: 'O editor visual está indisponível.',
};
const failure = (reason, message) => ({ ok: false, reason,
  message: reason === 'FILE_CONFLICT' ? message : messages[reason] || reason });
const involuntary = new Set(['project-changed', 'too-complex', 'worker-failed', 'renderer-gone']);
const error = reason => Object.assign(new Error(reason), { reason });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const emptyState = () => ({ open: false, relative: null, dirty: false, canUndo: false, canRedo: false, truncated: false, gen: null });
let bridgeSource;
function readBridge() {
  if (bridgeSource === undefined) {
    // App code inside app.asar: Electron's fs supports stat/readFile, but not
    // necessarily open with O_NOFOLLOW. Project files still use readBounded.
    const file = path.join(__dirname, 'visual-bridge.js'), stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) throw error('unavailable');
    const bytes = fs.readFileSync(file);
    if (bytes.length > 64 * 1024) throw error('unavailable');
    bridgeSource = bytes.toString('utf8');
  }
  return bridgeSource;
}

class VisualSessions {
  // context(owner) reads only lifecycle state; validateProject(root) performs
  // expensive project checks. IPC always revalidates; byToken caches per gen.
  constructor({ context, validateProject = () => {}, emit = () => {}, changed = () => {}, source,
    log = message => console.error(message),
    workerFactory = options => new Worker(path.join(__dirname, 'visual-patch-worker.cjs'), options), timeoutMs = 5000 } = {}) {
    this.context = context; this.validateProject = validateProject; this.emit = emit; this.changed = changed;
    try { this.source = source === undefined ? readBridge() : source; }
    catch { this.source = null; log('Editor visual indisponível: não foi possível carregar a ponte.'); }
    this.workerFactory = workerFactory; this.timeoutMs = Math.min(timeoutMs, 5000);
    this.windows = new Map(); this.tokens = new Map();
  }

  _identity(owner, requested) {
    try {
      if (!owner || owner.isDestroyed?.()) throw error('renderer-gone');
      const active = this.context(owner);
      if (!active || typeof requested !== 'string' || !path.isAbsolute(requested)) throw error('project-changed');
      this.validateProject(active.root);
      const root = fs.realpathSync.native(requested);
      if (root !== fs.realpathSync.native(active.root)) throw error('project-changed');
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory()) throw error('project-changed');
      return { root, activeRoot: active.root, dev: stat.dev, ino: stat.ino, projectGeneration: active.generation };
    } catch (cause) { throw error(cause.reason || 'project-changed'); }
  }

  _validate(s, gen, cached = false) {
    if (this.windows.get(s.owner) !== s) throw error(s.revoked || 'revoked');
    try {
      if (s.owner.isDestroyed?.()) throw error('renderer-gone');
      const active = this.context(s.owner);
      if (!active || active.root !== s.activeRoot || active.generation !== s.projectGeneration) throw error('project-changed');
      if (!cached || s.validatedGen !== s.gen) {
        const current = this._identity(s.owner, s.root);
        if (current.root !== s.root || current.dev !== s.dev || current.ino !== s.ino ||
            current.projectGeneration !== s.projectGeneration) throw error('project-changed');
        s.validatedGen = s.gen;
      }
      const stat = fs.lstatSync(s.root); // A canonical root cannot become a symlink.
      if (!stat.isDirectory() || stat.dev !== s.dev || stat.ino !== s.ino) throw error('project-changed');
    } catch (cause) {
      const reason = cause.reason === 'renderer-gone' ? 'renderer-gone' : 'project-changed';
      this.revokeWindow(s.owner, reason); throw error(reason);
    }
    if (gen !== undefined && (!Number.isSafeInteger(gen) || gen !== s.gen)) throw error('stale-gen');
  }

  byWindow(owner) {
    const s = this.windows.get(owner);
    if (!s) return null;
    try { this._validate(s); return s.token ? s : null; } catch { return null; }
  }
  byToken(token) {
    const s = this.tokens.get(token);
    if (!s) return null;
    try { this._validate(s, undefined, true); return s; } catch { return null; }
  }
  dirty(owner) { const s = this.byWindow(owner); return !!s && s.hash !== s.revision; }
  _state(s) {
    return { open: true, relative: s.relative, dirty: s.hash !== s.revision, ...s.history, gen: s.gen };
  }
  state(owner, root) {
    try {
      this._identity(owner, root);
      const s = this.byWindow(owner);
      return s ? this._state(s) : emptyState();
    } catch { this.byWindow(owner); return emptyState(); }
  }

  revokeWindow(owner, reason = 'revoked') {
    const s = this.windows.get(owner);
    if (!s) return;
    this.windows.delete(owner); this.tokens.delete(s.token); s.revoked = reason;
    for (const pending of s.pending.values()) { clearTimeout(pending.timer); pending.reject(error(reason)); }
    s.pending.clear(); s.served = null; s.validatedGen = null;
    void s.worker.terminate().catch(() => {});
    this.changed(owner);
    if (involuntary.has(reason)) this.emit(owner, { type: 'revoked', reason });
  }
  revokeProject(root, reason = 'project-changed') {
    let canonical;
    try { canonical = fs.realpathSync.native(root); } catch { canonical = root; }
    for (const s of this.windows.values()) if (s.root === canonical || s.root === root) this.revokeWindow(s.owner, reason);
  }
  closeAll() { for (const owner of this.windows.keys()) this.revokeWindow(owner); }
  close(owner, root) {
    // Invalid/stale roots must not close another project's current session.
    try { this._identity(owner, root); this.byWindow(owner); this.revokeWindow(owner); }
    catch { this.byWindow(owner); }
    return { ok: true };
  }

  _serving(gen) {
    const nonce = randomBytes(16).toString('hex'), chan = randomBytes(16).toString('hex');
    // Literal substitution: bridge text (including $ sequences) is preserved.
    return { nonce, chan, gen, bridgeSource: this.source.split('__DK_CHAN__').join(chan).split('__DK_GEN__').join(String(gen)) };
  }
  _publish(s, view, serving) {
    s.served = Buffer.from(view.served); s.hash = view.hash; s.history = view.history;
    s.gen = serving.gen; s.nonce = serving.nonce; s.chan = serving.chan;
    s.validatedGen = null;
    s.requests = 0; s.bytes = 0; s.exhausted = false;
    s.info = { url: documentUrl(s), gen: s.gen, chan: s.chan, ...view.info };
    this.changed(s.owner);
    return { ok: true, doc: s.info, state: this._state(s) };
  }
  _call(s, command, args = {}) {
    this._validate(s);
    const id = ++s.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.revokeWindow(s.owner, 'too-complex'), this.timeoutMs);
      s.pending.set(id, { resolve, reject, timer });
      try { s.worker.postMessage({ id, command, ...args }); }
      catch { this.revokeWindow(s.owner, 'worker-failed'); }
    });
  }
  _result(cause) {
    if (cause.code === 'FILE_CONFLICT') return failure('FILE_CONFLICT', cause.message);
    return failure(cause.reason || (cause.code ? 'file-unavailable' : 'value-invalid'));
  }

  async open(owner, root, relative, options) {
    let s;
    try {
      if (this.source === null) return failure('unavailable');
      const identity = this._identity(owner, root);
      this.byWindow(owner);
      if (options?.codeEditorDirty === true) return failure('dirty-code-editor');
      if (!options || typeof options.codeEditorDirty !== 'boolean') return failure('value-invalid');
      // Use the protocol's exact path grammar for both supplied and real paths.
      documentUrl({ token: '0'.repeat(32), relative, gen: 0 });
      if (!/\.html?$/i.test(relative)) return failure('value-invalid');
      const file = resolveFile(identity.root, relative);
      file.absolute = fs.realpathSync.native(file.absolute);
      relative = path.relative(identity.root, file.absolute).split(path.sep).join('/');
      documentUrl({ token: '0'.repeat(32), relative, gen: 0 });
      if (!/\.html?$/i.test(relative)) return failure('value-invalid');
      const bytes = readBounded(file, DOCUMENT_LIMIT);
      if (!bytes) return failure('too-large');
      this.revokeWindow(owner);
      let worker;
      try { worker = this.workerFactory({ workerData: identity, resourceLimits: { maxOldGenerationSizeMb: 256 } }); }
      catch { throw error('worker-failed'); }
      s = { ...identity, owner, relative, worker, pending: new Map(), sequence: 0, tail: Promise.resolve(),
        token: null, gen: 0, revision: digest(bytes), served: null };
      s.document = () => s.served;
      s.countRequest = bytes => {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || s.exhausted) return false;
        s.requests++; s.bytes += bytes;
        s.exhausted = s.requests > 2000 || s.bytes > 64 * 1024 * 1024;
        return !s.exhausted;
      };
      this.windows.set(owner, s);
      worker.on('message', ({ id, result }) => {
        const pending = s.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer); s.pending.delete(id);
        pending.resolve(result.ok ? result : failure(result.reason, result.message));
      });
      const gone = () => { if (this.windows.get(owner) === s) this.revokeWindow(owner, 'worker-failed'); };
      worker.on('error', gone); worker.on('exit', gone);
      const serving = this._serving(0);
      const result = await this._call(s, 'prepare', { bytes, relative, serving });
      this._validate(s);
      if (!result.ok) { this.revokeWindow(owner, result.reason); return failure(result.reason, result.message); }
      s.token = randomBytes(16).toString('hex'); this.tokens.set(s.token, s);
      return this._publish(s, result, serving);
    } catch (cause) {
      if (s && this.windows.get(owner) === s) this.revokeWindow(owner, cause.reason || 'revoked');
      this.byWindow(owner);
      return this._result(cause);
    }
  }

  _run(owner, root, gen, action) {
    let s;
    try {
      if (this.source === null) return Promise.resolve(failure('unavailable'));
      this._identity(owner, root);
      s = this.windows.get(owner);
      if (!s?.token) throw error('not-open');
      if (gen !== WITHOUT_GENERATION && !Number.isSafeInteger(gen)) throw error('stale-gen');
      this._validate(s, gen === WITHOUT_GENERATION ? undefined : gen);
    } catch (cause) { this.byWindow(owner); return Promise.resolve(this._result(cause)); }
    const pending = s.tail.then(async () => {
      this._validate(s, gen === WITHOUT_GENERATION ? undefined : gen);
      return action(s);
    }).catch(cause => this._result(cause));
    s.tail = pending;
    return pending;
  }
  inspect(owner, root, gen, node) {
    return this._run(owner, root, gen, async s => {
      const result = await this._call(s, 'inspect', { node });
      this._validate(s, gen); return result;
    });
  }
  _change(owner, root, gen, command, op) {
    return this._run(owner, root, gen, async s => {
      // Only contract operations cross the boundary, never renderer patches.
      if (command === 'apply') {
        const keys = { text: 'node,type,value', attr: 'name,node,type,value', css: 'node,prop,type,value' };
        if (!op || !Object.hasOwn(keys, op.type) || Object.keys(op).sort().join(',') !== keys[op.type] ||
            !Number.isSafeInteger(op.node)) return failure('value-invalid');
      }
      if (!Number.isSafeInteger(s.gen + 1)) throw error('stale-gen');
      const serving = this._serving(s.gen + 1);
      const result = await this._call(s, command, { op, serving });
      this._validate(s, gen);
      return result.ok ? this._publish(s, result, serving) : failure(result.reason, result.message);
    });
  }
  apply(owner, root, gen, op) { return this._change(owner, root, gen, 'apply', op); }
  undo(owner, root, gen) { return this._change(owner, root, gen, 'undo'); }
  redo(owner, root, gen) { return this._change(owner, root, gen, 'redo'); }
  save(owner, root, gen) {
    return this._run(owner, root, gen, async s => {
      const result = await this._call(s, 'encode');
      this._validate(s, gen);
      if (!result.ok) return result;
      const saved = saveProjectBytes(s.root, s.relative, Buffer.from(result.bytes), s.revision);
      s.revision = saved.revision; this.changed(owner);
      return { ok: true, state: this._state(s), revision: saved.revision };
    });
  }
  reload(owner, root) {
    return this._run(owner, root, WITHOUT_GENERATION, s => this.open(owner, root, s.relative, { codeEditorDirty: false }));
  }
}

module.exports = { VisualSessions };
