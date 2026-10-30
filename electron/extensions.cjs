const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { executable } = require('./core.cjs');
const { agentLaunchArgs, readGuide, codexConfigHasInstructions } = require('./agent-guide.cjs');

const MANIFEST_LIMIT = 16 * 1024;
const ASAR_HEADER_LIMIT = 4 * 1024 * 1024;
const ROOT_LIMIT = 32;
const DIRECTORY_ENTRY_LIMIT = 512;
const ARGUMENT_BYTES_LIMIT = 8 * 1024;
const DEBOUNCE_MS = 300;
const ID = /^[a-z][a-z0-9-]{1,63}$/;
const CONTRIBUTION_ID = /^[a-z][a-z0-9-]{1,31}$/;
const COMMAND = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const PERMISSIONS = new Set(['fs:project', 'process:spawn', 'preview:bridge', 'agent:run']);
const ICONS = new Set(['home', 'folder', 'terminal', 'plus', 'arrow', 'check', 'search', 'close', 'code', 'settings', 'scan', 'activity', 'file', 'chevron', 'up', 'down', 'trash', 'play', 'stop', 'panel', 'expand', 'restore', 'refresh', 'split', 'splitDown', 'detach', 'single', 'graph', 'globe']);
const BLOCKED_KEYS = new Set(['script', 'main', 'module', 'html', 'js', 'css', 'preload', 'renderer']);
const VERIFICATION_SNAPSHOT = Symbol('verification snapshot');

// This remains the original v1 parser: the terminal and its existing extensions
// keep using their startup snapshot and CLI authentication unchanged.
function manifest(value, builtin = false) {
  if (builtin && value?.id === 'browser' && value.schema === 1 && value.type === 'browser' && value.permission === 'browser.preview') {
    return { id: 'browser', name: 'Browser', version: '0.1.0', description: 'Prévia isolada de projetos locais.', type: 'browser', permission: 'browser.preview', args: [] };
  }
  if (!value || value.schema !== 1 || !/^[a-z][a-z0-9-]{1,63}$/.test(value.id) ||
      typeof value.name !== 'string' || !value.name || value.name.length > 60 ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || value.permission !== 'terminal' ||
      typeof value.command !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value.command) ||
      !Array.isArray(value.args) || value.args.length > 32 || value.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) ||
      Object.hasOwn(value, 'script') || Object.hasOwn(value, 'main')) throw new Error('Manifesto de extensão inválido. A versão 1 aceita somente comandos de terminal declarativos.');
  return { id: value.id, name: value.name, version: value.version, description: String(value.description || '').slice(0, 300), command: value.command, args: value.args, permission: 'terminal' };
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).every(key => allowed.includes(key)); }
function text(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0'); }
function id(value) { return typeof value === 'string' && CONTRIBUTION_ID.test(value); }
function noExecutableFields(value) {
  const pending = [[value, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (depth > 20) throw new Error('Manifesto tem aninhamento excessivo.');
    if (!item || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item)) {
      if (!Array.isArray(item) && BLOCKED_KEYS.has(key.toLowerCase())) throw new Error(`Campo executável não permitido: ${key}.`);
      if (child && typeof child === 'object') pending.push([child, depth + 1]);
    }
  }
}
function safeRelative(value) {
  if (!text(value, 1024) || value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..');
}
function common(item, allowed) {
  if (!keys(item, allowed) || !id(item.id) || !text(item.title, 40)) throw new Error('Identificação ou campos inválidos.');
  if (item.icon !== undefined && (typeof item.icon !== 'string' || !ICONS.has(item.icon))) throw new Error('Ícone inválido.');
  return { id: item.id, title: item.title, ...(item.icon === undefined ? {} : { icon: item.icon }) };
}
function pluginManifest(value) {
  noExecutableFields(value);
  if (!keys(value, ['schema', 'id', 'name', 'version', 'description', 'permissions', 'contributes']) || value.schema !== 2 ||
      typeof value.id !== 'string' || !ID.test(value.id) || !text(value.name, 60) ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) ||
      (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 300 || value.description.includes('\0')))) {
    throw new Error('Manifesto de plugin v2 inválido.');
  }
  const permissions = value.permissions === undefined ? [] : value.permissions;
  if (!Array.isArray(permissions) || permissions.length > PERMISSIONS.size) throw new Error('Lista de permissões inválida.');
  const seenPermissions = new Set();
  for (const permission of permissions) {
    if (typeof permission !== 'string' || !PERMISSIONS.has(permission)) throw new Error(`Permissão desconhecida: ${String(permission).slice(0, 100)}.`);
    if (seenPermissions.has(permission)) throw new Error(`Permissão repetida: ${permission}.`);
    seenPermissions.add(permission);
  }
  const raw = value.contributes === undefined ? {} : value.contributes;
  if (!keys(raw, ['actions', 'views', 'panels', 'stages', 'catalogs'])) throw new Error('Contribuições inválidas.');
  const output = { actions: [], views: [], panels: [], stages: [], catalogs: [] }, errors = [];
  const limits = { actions: 16, views: 8, panels: 8, stages: 12, catalogs: 8 };
  const seen = new Set();
  for (const type of Object.keys(limits)) {
    const entries = raw[type] === undefined ? [] : raw[type];
    if (!Array.isArray(entries) || entries.length > limits[type]) { errors.push(`${type}: lista inválida ou acima do limite.`); continue; }
    for (const entry of entries) {
      try {
        let result;
        if (type === 'actions') {
          result = common(entry, ['id', 'title', 'description', 'icon', 'command', 'args']);
          if (!seenPermissions.has('process:spawn')) throw new Error('A ação exige process:spawn.');
          if (entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > 200 || entry.description.includes('\0'))) throw new Error('Descrição inválida.');
          if (typeof entry.command !== 'string' || !COMMAND.test(entry.command) || !Array.isArray(entry.args) || entry.args.length > 32 ||
              entry.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) ||
              entry.args.reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0) > ARGUMENT_BYTES_LIMIT) throw new Error('Comando ou argumentos inválidos.');
          result = { ...result, description: entry.description || '', command: entry.command, args: [...entry.args] };
        } else if (type === 'views' || type === 'panels') {
          result = common(entry, ['id', 'title', 'icon', 'content', ...(type === 'panels' ? ['location'] : [])]);
          if (type === 'panels' && entry.location !== 'sidebar') throw new Error('Local do painel inválido.');
          if (!keys(entry.content, ['action', 'catalog']) || Object.keys(entry.content).length !== 1 ||
              !id(entry.content.action || entry.content.catalog)) throw new Error('Referência inválida.');
          result = { ...result, content: { ...entry.content }, ...(type === 'panels' ? { location: entry.location } : {}), active: false };
        } else if (type === 'stages') {
          result = common(entry, ['id', 'title', 'order', 'criteria']);
          if (!Number.isInteger(entry.order) || entry.order < 0 || entry.order > 99 || !Array.isArray(entry.criteria) || entry.criteria.length > 16 ||
              entry.criteria.some(criterion => !keys(criterion, ['id', 'label']) || !id(criterion.id) || !text(criterion.label, 80)) ||
              new Set(entry.criteria.map(criterion => criterion.id)).size !== entry.criteria.length) throw new Error('Critérios inválidos.');
          result = { ...result, order: entry.order, criteria: entry.criteria.map(criterion => ({ ...criterion })), active: false };
        } else {
          result = common(entry, ['id', 'title', 'kind', 'source', 'path']);
          if (!['skills', 'design-systems'].includes(entry.kind) || !['plugin', 'project'].includes(entry.source) || !safeRelative(entry.path) ||
              (entry.source === 'project' && !seenPermissions.has('fs:project'))) throw new Error('Catálogo ou caminho inválido.');
          result = { ...result, kind: entry.kind, source: entry.source, path: entry.path, active: false };
        }
        if (seen.has(result.id)) throw new Error('ID de contribuição repetido.');
        seen.add(result.id); output[type].push(result);
      } catch (error) { errors.push(`${type}: ${error.message}`); }
    }
  }
  for (const type of ['views', 'panels']) output[type] = output[type].filter(entry => {
    const kind = entry.content.action ? 'actions' : 'catalogs';
    if (output[kind].some(item => item.id === (entry.content.action || entry.content.catalog))) return true;
    errors.push(`${type}: referência inexistente em ${entry.id}.`); return false;
  });
  return { id: value.id, name: value.name, version: value.version, description: value.description || '', permissions: [...permissions], contributes: output, errors };
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino && a.isDirectory() && b.isDirectory(); }
async function checkProjectIdentity(requested, identity) {
  try {
    const realpath = await fs.promises.realpath(requested);
    const stat = await fs.promises.stat(requested);
    const canonicalStat = await fs.promises.stat(realpath);
    // Path spelling can differ in case or Unicode normalization. Pin both the
    // requested directory and the native containment root to the authorized inode.
    if (!stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino || !sameIdentity(stat, canonicalStat)) throw new Error();
    return realpath;
  } catch { throw new Error('O projeto mudou durante a leitura.'); }
}
async function directoryIdentity(target, boundary) {
  const stat = await fs.promises.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Diretório inválido ou link simbólico não permitido.');
  const real = await fs.promises.realpath(target);
  if (!inside(boundary, real)) throw new Error('Diretório fora da raiz permitida.');
  return stat;
}
async function regularExists(file) {
  try { await fs.promises.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function readBounded(file, directories, boundary) {
  // Refuse symlinks at every controlled component and compare directory and
  // file identities around the open. Node lacks portable openat, so this is
  // not a guarantee against an adversary replacing directories concurrently.
  const before = [];
  for (const directory of directories) before.push(await directoryIdentity(directory, boundary));
  const link = await fs.promises.lstat(file);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error('Manifesto deve ser arquivo regular, sem link simbólico.');
  const resolved = await fs.promises.realpath(file);
  if (!inside(boundary, resolved)) throw new Error('Manifesto fora da raiz permitida.');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== link.dev || stat.ino !== link.ino) throw new Error('Manifesto mudou durante a leitura.');
    if (stat.size > MANIFEST_LIMIT) throw new Error('Manifesto muito grande.');
    const buffer = Buffer.alloc(MANIFEST_LIMIT + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MANIFEST_LIMIT) throw new Error('Manifesto muito grande.');
    const after = await fs.promises.lstat(file);
    const end = await handle.stat();
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino ||
        end.dev !== stat.dev || end.ino !== stat.ino || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || count !== stat.size) throw new Error('Manifesto mudou durante a leitura.');
    for (let i = 0; i < directories.length; i++) if (!sameIdentity(before[i], await directoryIdentity(directories[i], boundary))) throw new Error('Diretório mudou durante a leitura.');
    const bytes = buffer.subarray(0, count);
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), revision: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

async function trustedPackagedAsar(info, root) {
  // Only Electron's own packaged application root may use the physical ASAR
  // reader. A project or a user-supplied path ending in .asar is never enough.
  if (info.index !== 0 || info.origin !== 'app' || !process.versions.electron) return null;
  let app, originalFs;
  try { ({ app } = require('electron')); originalFs = require('original-fs'); } catch { return null; }
  if (!app || !app.isPackaged || typeof process.resourcesPath !== 'string') return null;
  const appPath = path.resolve(app.getAppPath());
  if (appPath !== path.resolve(process.resourcesPath, 'app.asar') || path.resolve(info.value) !== path.join(appPath, 'extensions')) return null;
  const stat = await originalFs.promises.lstat(appPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Pacote ASAR inválido ou substituído por link.');
  const archive = await originalFs.promises.realpath(appPath);
  if (path.resolve(root) !== path.join(archive, 'extensions')) throw new Error('Raiz do pacote ASAR inválida.');
  return { archive, originalFs, cache: null };
}
async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const part = await handle.read(buffer, read, length - read, position + read);
    if (!part.bytesRead) throw new Error('Pacote ASAR truncado.');
    read += part.bytesRead;
  }
  return buffer;
}
function asarEntry(header, components) {
  let entry = header;
  for (const part of components) {
    if (!object(entry) || ['link', 'unpacked', 'offset', 'size'].some(key => Object.hasOwn(entry, key)) ||
        !Object.hasOwn(entry, 'files') || !object(entry.files) || !Object.hasOwn(entry.files, part)) throw new Error('Entrada ASAR inválida ou externa.');
    entry = entry.files[part];
  }
  if (!object(entry) || ['files', 'link', 'unpacked'].some(key => Object.hasOwn(entry, key)) ||
      !Object.hasOwn(entry, 'size') || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MANIFEST_LIMIT ||
      !Object.hasOwn(entry, 'offset') || typeof entry.offset !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(entry.offset)) throw new Error('Manifesto ASAR inválido ou acima do limite.');
  return entry;
}
async function readPackedManifest(trusted, file) {
  const { archive, originalFs } = trusted;
  const relative = path.relative(path.join(archive, 'extensions'), file);
  const parts = relative.split(path.sep);
  if (path.isAbsolute(relative) || parts.length !== 2 || parts.some(part => !part || part === '.' || part === '..') ||
      !['extension.json', 'plugin.json'].includes(parts[1])) throw new Error('Manifesto fora da raiz ASAR permitida.');
  const before = await originalFs.promises.lstat(archive, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Pacote ASAR inválido ou substituído por link.');
  const handle = await originalFs.promises.open(archive, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !sameExecutableStat(before, stat) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Pacote ASAR mudou durante a leitura.');
    const archiveSize = Number(stat.size);
    let header = trusted.cache && sameExecutableStat(trusted.cache.stat, stat) ? trusted.cache : null;
    if (!header) {
      if (archiveSize < 16) throw new Error('Cabeçalho ASAR inválido.');
      const prefix = await readExactly(handle, 8, 0);
      const headerSize = prefix.readUInt32LE(4);
      if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > ASAR_HEADER_LIMIT || headerSize % 4 !== 0 || 8 + headerSize > archiveSize) throw new Error('Cabeçalho ASAR inválido ou acima do limite.');
      const packed = await readExactly(handle, headerSize, 8);
      const payloadSize = packed.readUInt32LE(0), jsonSize = packed.readInt32LE(4);
      if (payloadSize !== headerSize - 4 || jsonSize < 2 || jsonSize > headerSize - 8) throw new Error('Cabeçalho ASAR inválido.');
      const json = new TextDecoder('utf-8', { fatal: true }).decode(packed.subarray(8, 8 + jsonSize));
      header = { value: JSON.parse(json), size: headerSize, stat };
    }
    const entry = asarEntry(header.value, ['extensions', ...parts]);
    const offset = Number(entry.offset), position = 8 + header.size + offset, end = position + entry.size;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(position) || !Number.isSafeInteger(end) || position < 8 + header.size || end > archiveSize) throw new Error('Posição de manifesto ASAR inválida.');
    const physicalBytes = await readExactly(handle, entry.size, position);
    // The physical header is used for classification only. Read the entry via
    // Electron's virtual FS so future ASAR integrity enforcement is not bypassed.
    const virtualLink = await fs.promises.lstat(file);
    const virtualPath = await fs.promises.realpath(file);
    if (virtualLink.isSymbolicLink() || !virtualLink.isFile() || virtualLink.size !== entry.size || path.resolve(virtualPath) !== path.resolve(file)) throw new Error('Manifesto ASAR inválido ou externo.');
    const virtualHandle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const virtualStat = await virtualHandle.stat();
      if (!virtualStat.isFile() || virtualStat.size !== entry.size) throw new Error('Tamanho do manifesto ASAR divergente.');
      bytes = await readExactly(virtualHandle, entry.size, 0);
      const extra = await virtualHandle.read(Buffer.alloc(1), 0, 1, entry.size);
      const virtualEnd = await virtualHandle.stat();
      if (extra.bytesRead !== 0 || !virtualEnd.isFile() || virtualEnd.size !== entry.size) throw new Error('Manifesto ASAR mudou durante a leitura.');
    } finally { await virtualHandle.close(); }
    if (!bytes.equals(physicalBytes)) throw new Error('Conteúdo do manifesto ASAR divergente.');
    const revision = createHash('sha256').update(bytes).digest('hex');
    if (Object.hasOwn(entry, 'integrity') && (!object(entry.integrity) || entry.integrity.algorithm !== 'SHA256' ||
        typeof entry.integrity.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.integrity.hash) || entry.integrity.hash !== revision)) throw new Error('Integridade do manifesto ASAR inválida.');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const after = await originalFs.promises.lstat(archive, { bigint: true });
    const final = await handle.stat({ bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || !sameExecutableStat(before, after) || !sameExecutableStat(stat, final)) throw new Error('Pacote ASAR mudou durante a leitura.');
    // ASAR entry hashes and physical metadata detect corruption and changes;
    // they do not establish package signatures or make filesystem races atomic.
    trusted.cache = header;
    return { value, revision };
  } finally { await handle.close(); }
}
async function resolveExecutable(name, env, platform = process.platform) {
  for (const entry of String(env?.PATH || '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const target = path.join(entry, platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name);
    try { if ((await fs.promises.stat(target)).isFile()) { await fs.promises.access(target, fs.constants.X_OK); return target; } } catch {}
  }
  return null;
}
function sameExecutableStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function executableIdentity(file) {
  // CLI paths often are legitimate symlinks. Preserve that path for spawning,
  // but record the target and compare the link and target around collection.
  // Stat checks narrow races; they cannot make path-based execution atomic.
  // The Windows implementation has not been validated on a Windows machine.
  try {
    const linkBefore = await fs.promises.lstat(file, { bigint: true });
    if (!linkBefore.isFile() && !linkBefore.isSymbolicLink()) throw new Error('Executável não é um arquivo comum.');
    const realpathBefore = await fs.promises.realpath(file);
    const targetBefore = await fs.promises.stat(file, { bigint: true });
    const resolved = await fs.promises.stat(realpathBefore, { bigint: true });
    const linkAfter = await fs.promises.lstat(file, { bigint: true });
    const realpathAfter = await fs.promises.realpath(file);
    const targetAfter = await fs.promises.stat(file, { bigint: true });
    if (!targetBefore.isFile() || !targetAfter.isFile() || !resolved.isFile() || realpathBefore !== realpathAfter ||
        !sameExecutableStat(linkBefore, linkAfter) || !sameExecutableStat(targetBefore, targetAfter) || !sameExecutableStat(targetBefore, resolved)) {
      throw new Error('Executável mudou durante a verificação.');
    }
    return { realpath: realpathBefore, dev: String(targetBefore.dev), ino: String(targetBefore.ino), size: String(targetBefore.size),
      mode: String(targetBefore.mode), mtimeNs: String(targetBefore.mtimeNs), ctimeNs: String(targetBefore.ctimeNs) };
  } catch (error) {
    if (error.message === 'Executável mudou durante a verificação.' || error.message === 'Executável não é um arquivo comum.') throw error;
    throw new Error('Não foi possível verificar o executável; ele pode ter mudado ou ficado indisponível.');
  }
}
function preview(command, args) {
  return [command, ...args.map(arg => JSON.stringify(arg))].join(' ').slice(0, 200);
}
function pluginInfo(record, availability) {
  const item = record.item;
  const actions = item.contributes.actions.map(action => ({ id: action.id, title: action.title, description: action.description,
    ...(action.icon === undefined ? {} : { icon: action.icon }), commandPreview: preview(action.command, action.args), available: !action.tooLarge && Boolean(availability.get(action.command)) }));
  const inert = type => item.contributes[type].map(entry => ({ ...entry }));
  return { id: item.id, name: item.name, version: item.version, description: item.description, schema: record.schema, origin: record.origin,
    permissions: [...item.permissions], revision: record.revision, contributes: { actions, views: inert('views'), panels: inert('panels'), stages: inert('stages'), catalogs: inert('catalogs') }, errors: [...item.errors] };
}
function legacyItem(item) {
  const tooLarge = item.args.reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0) > ARGUMENT_BYTES_LIMIT;
  return { id: item.id, name: item.name, version: item.version, description: item.description,
    permissions: item.type === 'browser' ? [] : ['process:spawn'], errors: tooLarge ? ['Ação indisponível: argumentos excedem o limite de confirmação de 8 KiB.'] : [],
    contributes: { actions: item.type === 'browser' ? [] : [{ id: 'open', title: `Abrir ${item.name}`, description: item.description, command: item.command, args: [...item.args], tooLarge }], views: [], panels: [], stages: [], catalogs: [] } };
}

function readonlyMap(entries) {
  const map = new Map(entries);
  for (const method of ['set', 'delete', 'clear']) {
    Object.defineProperty(map, method, { value() { throw new TypeError('Snapshot somente para leitura.'); } });
  }
  return Object.freeze(map);
}

class Extensions {
  constructor(roots, env, onChange = null, snapshot = null) {
    this.env = env; this.items = new Map(); this.errors = [];
    this.roots = [...roots]; this.legacyFolders = new Map(); this.onChange = typeof onChange === 'function' ? onChange : null;
    this.activeRoot = null; this.requestedRoot = null; this.records = new Map(); this.watchers = []; this.timer = null; this.epoch = 0; this.watchFailure = null;
    this.watched = new Map(); this.inflight = null;
    if (snapshot?.token === VERIFICATION_SNAPSHOT) {
      this.roots = Object.freeze(this.roots);
      this.items = snapshot.items; this.legacyFolders = snapshot.legacyFolders; this.errors = snapshot.errors;
      return;
    }
    for (const [index, root] of roots.entries()) {
      if (!fs.existsSync(root)) continue;
      for (const folder of fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).slice(0, 32)) {
        const file = path.join(root, folder.name, 'extension.json');
        try {
          if (fs.statSync(file).size > 16 * 1024) throw new Error('Manifesto muito grande.');
          const item = manifest(JSON.parse(fs.readFileSync(file, 'utf8')), index === 0);
          if (this.items.has(item.id)) throw new Error('ID já instalado.');
          this.items.set(item.id, item); this.legacyFolders.set(`${index}\0${folder.name}`, item);
        } catch (error) {
          // A v2-only folder is not a malformed v1 extension.
          if (error.code === 'ENOENT' && fs.existsSync(path.join(root, folder.name, 'plugin.json'))) continue;
          this.errors.push(`${folder.name}: ${error.message}`);
        }
      }
    }
  }
  forVerification(env = this.env) {
    // Clone the already loaded v1 records without touching disk. Both maps
    // refer to the same immutable copies; mutable session state and watchers
    // belong only to the new host. listPlugins/pluginSpec still reread the
    // current manifests asynchronously and compare them with this snapshot.
    const copies = new Map();
    const copy = item => {
      if (!copies.has(item)) copies.set(item, Object.freeze({ ...item, args: Object.freeze([...item.args]) }));
      return copies.get(item);
    };
    const snapshot = {
      token: VERIFICATION_SNAPSHOT,
      items: readonlyMap([...this.items].map(([key, item]) => [key, copy(item)])),
      legacyFolders: readonlyMap([...this.legacyFolders].map(([key, item]) => [key, copy(item)])),
      errors: Object.freeze([...this.errors]),
    };
    return new Extensions(this.roots, Object.freeze({ ...env }), null, snapshot);
  }
  list() { return [...this.items.values()].map(item => ({ id: item.id, name: item.name, description: item.description, version: item.version, kind: item.type === 'browser' ? 'browser' : 'terminal', available: item.type === 'browser' || !!executable(item.command, this.env) })); }
  spec(id) {
    const item = this.items.get(id);
    if (!item) throw new Error('Extensão não encontrada.');
    if (item.type === 'browser') throw new Error('Use o painel Browser para abrir a prévia.');
    const file = executable(item.command, this.env);
    if (!file) throw new Error(`${item.name} não foi encontrado. Instale a ferramenta oficial para usá-la aqui.`);
    // Claude Code, Codex e Antigravity recebem o guia do SEA Dock por opção de
    // linha de comando (agentGuide é definido pelo processo principal).
    const guideFile = this.agentGuide || null;
    const command = path.basename(item.command).toLowerCase();
    const args = agentLaunchArgs(item.command, item.args, { guideFile, guideText: command === 'codex' ? readGuide(guideFile) : '', codexHasInstructions: command === 'codex' && codexConfigHasInstructions(this.env) });
    return { label: item.name, kind: 'extension', file, args };
  }
  _stopWatchers() {
    clearTimeout(this.timer); this.timer = null;
    for (const watcher of this.watchers) { try { watcher.close(); } catch {} }
    this.watchers = [];
    this.watched.clear();
  }
  _pruneWatchers(keep) {
    for (const [dir, entry] of this.watched) if (!keep(dir)) {
      try { entry.watcher.close(); } catch {}
      this.watched.delete(dir);
    }
    this.watchers = [...this.watched.values()].map(entry => entry.watcher);
  }
  _notifyChange(root, epoch) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (epoch !== this.epoch || this.activeRoot !== root) return;
      if (this.inflight) this.inflight.dirty = true;
      else this.onChange({ path: this.requestedRoot });
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }
  closeProject(root) {
    if (typeof root !== 'string') return;
    const resolved = path.resolve(root);
    if (resolved === this.requestedRoot || resolved === this.activeRoot) this.close();
  }
  close() {
    this.epoch++; this._stopWatchers(); this.activeRoot = null; this.requestedRoot = null; this.records = new Map(); this.watchFailure = null;
    this.inflight = null;
  }
  async listPlugins(root = null, identity = null) { return this._load(root, identity); }
  async reloadPlugins(root = null, identity = null) { return this._load(root, identity, true); }
  async _readPackedManifest(trusted, file) { return readPackedManifest(trusted, file); }
  async _load(root, identity, reload = false) {
    if (root !== null && (typeof root !== 'string' || root.length > 8192 || root.includes('\0') || !path.isAbsolute(root))) throw new Error('Pasta de projeto inválida.');
    const requested = root === null ? null : path.resolve(root);
    const authorized = identity && { realpath: identity.realpath, dev: identity.dev, ino: identity.ino };
    const pending = this.inflight;
    if (pending && pending.requested === requested &&
        ((!authorized && !pending.authorized) || (authorized && pending.authorized &&
          authorized.dev === pending.authorized.dev && authorized.ino === pending.authorized.ino))) {
      if (reload && this.watchFailure) { this.watchFailure = null; pending.dirty = true; }
      return pending.promise;
    }
    if (this.requestedRoot !== requested || pending) this.close();
    if (reload) this.watchFailure = null;
    this.requestedRoot = requested;
    const flight = { requested, authorized, identity: authorized, epoch: this.epoch, dirty: false, promise: null };
    this.inflight = flight;
    flight.promise = (async () => {
      try {
        // Standalone hosts also pin the inode before resolving the path. IPC
        // callers supply the identity already authorized by the main process.
        if (requested !== null && !flight.identity) {
          const stat = await fs.promises.stat(requested);
          const realpath = await fs.promises.realpath(requested);
          if (!stat.isDirectory()) throw new Error('Pasta de projeto inválida.');
          flight.identity = { realpath, dev: stat.dev, ino: stat.ino };
        }
        let result = await this._scan(flight);
        if (flight.dirty) {
          flight.dirty = false;
          result = await this._scan(flight);
        }
        return result;
      } catch (error) {
        if (this.inflight === flight) { this._stopWatchers(); this.records = new Map(); this.activeRoot = null; }
        throw error;
      } finally {
        if (this.inflight === flight) {
          this.inflight = null;
          // Continuous edits get a subsequent debounced notification, never
          // an unbounded loop or a notification swallowed by coalescing.
          if (flight.dirty && this.activeRoot && this.onChange) this._notifyChange(this.activeRoot, flight.epoch);
        }
      }
    })();
    return flight.promise;
  }
  async _scan({ requested, identity, epoch }) {
    if (epoch !== this.epoch) throw new Error('Projeto alterado durante a leitura de plugins.');
    const project = requested === null ? null : await checkProjectIdentity(requested, identity);
    if (epoch !== this.epoch) throw new Error('Projeto alterado durante a leitura de plugins.');
    this.records = new Map();
    this.activeRoot = project;
    const records = new Map(), errors = [], watchDirs = [];
    const roots = this.roots.map((value, index) => ({ value, origin: index === 0 ? 'app' : 'user', index }));
    if (project) roots.push({ value: path.join(project, '.dk', 'plugins'), origin: 'project', project });
    for (const item of roots) await this._readRoot(item, records, errors, watchDirs, epoch);
    if (epoch !== this.epoch || this.activeRoot !== project) throw new Error('Projeto alterado durante a leitura de plugins.');
    const availability = new Map();
    for (const record of records.values()) for (const action of record.item.contributes.actions) {
      if (!availability.has(action.command)) availability.set(action.command, await resolveExecutable(action.command, this.env));
    }
    if (epoch !== this.epoch || this.activeRoot !== project) throw new Error('Projeto alterado durante a leitura de plugins.');
    if (project) await checkProjectIdentity(requested, identity);
    if (epoch !== this.epoch || this.activeRoot !== project) throw new Error('Projeto alterado durante a leitura de plugins.');
    this._pruneWatchers(dir => watchDirs.some(entry => entry.dir === dir));
    this.records = records;
    if (this.watchFailure) errors.push(this.watchFailure);
    return { plugins: [...records.values()].map(record => pluginInfo(record, availability)), errors };
  }
  async _readRoot(info, records, errors, watchDirs, epoch) {
    let root, trusted = null;
    const watch = async (dir, filter) => {
      watchDirs.push({ dir, filter });
      if (this.onChange) await this._watch(info.project, epoch, [{ dir, filter }]);
    };
    try {
      if (info.project) {
        await watch(info.project, '.dk');
        const dk = path.join(info.project, '.dk');
        if (!(await regularExists(dk))) return;
        await directoryIdentity(dk, info.project);
        await watch(dk, 'plugins');
        if (!(await regularExists(info.value))) return;
        await directoryIdentity(info.value, info.project);
        root = info.value;
      } else {
        try { root = await fs.promises.realpath(info.value); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        await directoryIdentity(root, root);
        trusted = await trustedPackagedAsar(info, root);
      }
      if (info.project) await watch(root);
      const entries = [];
      let scanned = 0;
      const stream = await fs.promises.opendir(root);
      try {
        for await (const entry of stream) {
          if (++scanned > DIRECTORY_ENTRY_LIMIT) { errors.push(`${info.origin}: limite de entradas do diretório atingido.`); break; }
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (entries.length === ROOT_LIMIT) { errors.push(`${info.origin}: mais de ${ROOT_LIMIT} pastas; as demais não foram carregadas.`); break; }
          entries.push(entry.name);
        }
      } finally { try { await stream.close(); } catch {} }
      if (info.project && epoch === this.epoch) {
        const allowed = new Set([...watchDirs.map(entry => entry.dir), ...entries.map(name => path.join(root, name))]);
        this._pruneWatchers(dir => allowed.has(dir));
      }
      for (const name of entries) {
        const folder = path.join(root, name);
        try {
          await directoryIdentity(folder, info.project || root);
          if (info.project) await watch(folder, ['plugin.json', 'extension.json']);
          const v2 = path.join(folder, 'plugin.json'), v1 = path.join(folder, 'extension.json');
          const hasV2 = await regularExists(v2), hasV1 = await regularExists(v1);
          if (hasV2 && hasV1) throw new Error('Pasta com dois manifestos.');
          if (!hasV2 && (!hasV1 || info.origin === 'project')) continue;
          const file = hasV2 ? v2 : v1;
          const directories = info.project ? [path.join(info.project, '.dk'), root, folder] : [root, folder];
          const read = trusted ? await this._readPackedManifest(trusted, file) : await readBounded(file, directories, info.project || root);
          let item, schema;
          if (hasV2) { item = pluginManifest(read.value); schema = 2; }
          else {
            const legacy = this.legacyFolders.get(`${info.index}\0${name}`);
            const current = manifest(read.value, info.index === 0);
            if (!legacy) throw new Error('Extensão v1 indisponível ou recusada na inicialização.');
            if (JSON.stringify(current) !== JSON.stringify(legacy)) throw new Error('Extensão v1 mudou; reinicie o aplicativo para atualizá-la.');
            item = legacyItem(legacy); schema = 1;
          }
          if (records.has(item.id)) throw new Error(`ID já instalado (origem ${records.get(item.id).origin}).`);
          const record = { item, schema, origin: info.origin, revision: read.revision, file, directories, boundary: info.project || root, trusted, legacy: schema === 1 ? this.legacyFolders.get(`${info.index}\0${name}`) : null };
          records.set(item.id, record);
          for (const error of item.errors) errors.push(`${info.origin}/${name}: ${error}`);
        } catch (error) { errors.push(`${info.origin}/${name}: ${error.message}`); }
      }
    } catch (error) { errors.push(`${info.origin}: ${error.message}`); }
  }
  async _watch(root, epoch, dirs) {
    if (this.watchFailure) return;
    for (const { dir, filter } of dirs) {
      try {
        const stat = await directoryIdentity(dir, root);
        if (epoch !== this.epoch || this.activeRoot !== root || this.watchFailure) return;
        const previous = this.watched.get(dir);
        if (previous && sameIdentity(previous.stat, stat)) continue;
        // fs.watch follows the old inode across renames. Replace watchers on
        // changed ancestors and their descendants before reading the new tree.
        this._pruneWatchers(candidate => !inside(dir, candidate));
        if (this.watchers.length >= ROOT_LIMIT + 3) throw new Error('Limite de observadores atingido.');
        const watcher = fs.watch(dir, { persistent: false }, (_event, file) => {
          if (epoch !== this.epoch || this.activeRoot !== root || this.watched.get(dir)?.watcher !== watcher) return;
          if (filter && file != null && !(Array.isArray(filter) ? filter : [filter]).includes(String(file))) return;
          if (this.inflight) this.inflight.dirty = true;
          else this._notifyChange(root, epoch);
        });
        watcher.on('error', () => {
          if (epoch !== this.epoch || this.activeRoot !== root || this.watched.get(dir)?.watcher !== watcher) return;
          this._stopWatchers(); this.watchFailure = 'Monitoramento de plugins indisponível; use Recarregar para atualizar manualmente.';
          this.onChange({ path: this.requestedRoot });
        });
        this.watched.set(dir, { stat, watcher });
        this.watchers.push(watcher);
      } catch {
        if (epoch !== this.epoch || this.activeRoot !== root) return;
        this._stopWatchers(); this.watchFailure = 'Monitoramento de plugins indisponível; use Recarregar para atualizar manualmente.';
        break;
      }
    }
  }
  async pluginSpec(root, pluginId, actionId, expectedRevision) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || root.length > 8192 ||
        typeof pluginId !== 'string' || !ID.test(pluginId) || typeof actionId !== 'string' || !CONTRIBUTION_ID.test(actionId)) throw new Error('Ação de plugin inválida.');
    const epoch = this.epoch;
    const project = await fs.promises.realpath(root);
    if (epoch !== this.epoch || project !== this.activeRoot) throw new Error('Projeto não está selecionado.');
    const record = this.records.get(pluginId);
    if (!record) throw new Error('Plugin não encontrado; recarregue a lista.');
    if (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || expectedRevision !== record.revision)) throw new Error('Plugin mudou; recarregue e confirme a nova versão.');
    const read = record.trusted ? await this._readPackedManifest(record.trusted, record.file) : await readBounded(record.file, record.directories, record.boundary);
    if (read.revision !== record.revision) throw new Error('Plugin mudou; recarregue e confirme a nova versão.');
    let item;
    if (record.schema === 2) item = pluginManifest(read.value);
    else {
      const parsed = manifest(read.value, record.origin === 'app');
      if (JSON.stringify(parsed) !== JSON.stringify(record.legacy)) throw new Error('Extensão mudou; reinicie o aplicativo.');
      item = legacyItem(parsed);
    }
    const action = item.contributes.actions.find(entry => entry.id === actionId);
    if (!action || !item.permissions.includes('process:spawn')) throw new Error('Ação não encontrada ou sem permissão para executar.');
    if (action.tooLarge) throw new Error('Argumentos excedem o limite de confirmação de 8 KiB.');
    const file = await resolveExecutable(action.command, this.env);
    if (!file) throw new Error('Programa não encontrado no PATH.');
    const identity = await executableIdentity(file);
    if (epoch !== this.epoch || project !== this.activeRoot || this.records.get(pluginId) !== record) throw new Error('Projeto ou plugin mudou; recarregue e confirme novamente.');
    return { label: `${item.name}: ${action.title}`, kind: 'extension', file, args: [...action.args], revision: record.revision, executableIdentity: identity,
      origin: record.origin, pluginId, actionId, pluginName: item.name, actionTitle: action.title, description: action.description, permissions: [...item.permissions] };
  }
}
module.exports = { Extensions, manifest, pluginManifest, resolveExecutable };
