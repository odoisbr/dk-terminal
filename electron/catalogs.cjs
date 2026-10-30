const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const FILE_LIMIT = 64 * 1024;
const FRONTMATTER_LIMIT = 8 * 1024;
const JSON_LIMIT = 4 * 1024 * 1024;
const ENTRY_LIMIT = 64;
const DIRECTORY_LIMIT = 512;
const WATCHER_LIMIT = 16;
const DEBOUNCE_MS = 400;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CATALOG_ID = /^(?:kit-skills|project-design|plugin:[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63})$/;
const FIELDS = ['name', 'description', 'argument-hint', 'allowed-tools', 'forma-da-saida'];
const STAGES = new Set(['audit', 'levantar', 'entender', 'entregar', 'prototipar', 'handoff', 'git']);
const MISSING_KIT = 'Plugin DK não instalado; catálogo do kit indisponível.';
const WATCH_FAILURE = 'Monitoramento de catálogos indisponível; use Recarregar.';
const OUTSIDE = 'Caminho fora da origem do catálogo.';
const TOO_LARGE = 'Arquivo do catálogo excede 64 KiB.';

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function diagnostic(error) {
  const messages = {
    ENOENT: 'Arquivo ou diretório do catálogo não encontrado.',
    ENOTDIR: 'Origem do catálogo deve ser um diretório.',
    EACCES: 'Sem permissão para ler a origem do catálogo.',
    EPERM: 'Sem permissão para ler a origem do catálogo.',
    ELOOP: 'Link simbólico recusado durante a abertura do catálogo.',
    ERR_ENCODING_INVALID_ENCODED_DATA: 'Arquivo do catálogo contém UTF-8 inválido.',
  };
  return messages[error.code] || (error.code ? 'Não foi possível ler a origem do catálogo.' : error.message);
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function relativePath(value) {
  // core/base_prototipo.py:_caminho_ruim permite ponto e barra final.
  return typeof value === 'string' && Boolean(value.trim()) && !/[\x00-\x1f]/.test(value) &&
    !value.startsWith('/') && !value.replace(/\\/g, '/').split('/').includes('..');
}
function projectPath(root) {
  if (typeof root !== 'string' || root.length > 8192 || root.includes('\0') || !path.isAbsolute(root)) throw new Error('Pasta de projeto inválida.');
  return path.resolve(root);
}
function stageGate(description) {
  const match = /use quando a etapa\s+([a-zà-ú-]+)\s+do dk estiver ativa/i.exec(typeof description === 'string' ? description : '');
  const stage = match ? match[1].toLowerCase() : '';
  return { stage: STAGES.has(stage) ? stage : '', gate: Boolean(match) };
}
function allowedFields(value) {
  const data = {};
  if (object(value)) for (const key of FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (typeof item === 'string') data[key] = item;
    else if (key === 'allowed-tools' && Array.isArray(item) && item.every(part => typeof part === 'string')) data[key] = [...item];
  }
  return data;
}
function parseFrontmatter(text) {
  const opening = /^---\r?\n/.exec(text);
  if (!opening) return { data: {}, body: text, parser: 'yaml', error: null };
  const rest = text.slice(opening[0].length), closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  const raw = closing ? rest.slice(0, closing.index) : rest;
  const body = closing ? rest.slice(closing.index + closing[0].length) : '';
  if (Buffer.byteLength(raw, 'utf8') > FRONTMATTER_LIMIT) return { data: {}, body, parser: 'regex', error: 'Frontmatter excede 8 KiB.' };
  try {
    if (!closing) throw new Error('delimitador final ausente');
    const value = yaml.parse(raw, { maxAliasCount: 8, uniqueKeys: true });
    if (value != null && !object(value)) throw new Error('deve ser um objeto');
    return { data: allowedFields(value), body, parser: 'yaml', error: null };
  } catch {
    // Mesma expressão de core/skills.py:36–44; o erro continua visível.
    const fields = {};
    for (const match of raw.matchAll(/^([a-z][a-z-]*):\s*(.*?)(?=\n[a-z][a-z-]*:|(?![\s\S]))/gms)) {
      fields[match[1]] = match[2].trim().replace(/^["']+|["']+$/g, '');
    }
    return { data: allowedFields(fields), body, parser: 'regex', error: 'Frontmatter YAML inválido; leitura por regex.' };
  }
}

function stamp(stat) {
  return stat ? [stat.dev, stat.ino, stat.mode, stat.mtimeMs, stat.ctimeMs, stat.size].join(':') : null;
}
async function lstat(file, stamps) {
  try {
    const stat = await fs.promises.lstat(file);
    stamps?.set(file, stamp(stat)); return stat;
  } catch (error) {
    if (error.code === 'ENOENT') stamps?.set(file, null);
    throw error;
  }
}
async function checked(file, boundary, stamps, directory = false) {
  if (!inside(boundary, file)) throw new Error(OUTSIDE);
  const parts = path.relative(boundary, file).split(path.sep).filter(Boolean);
  const paths = [boundary];
  for (const part of parts) paths.push(path.join(paths.at(-1), part));
  const identities = [];
  let realBoundary;
  for (const [index, target] of paths.entries()) {
    const stat = await lstat(target, stamps);
    if (stat.isSymbolicLink()) throw new Error(`Link simbólico recusado: ${path.basename(target)}.`);
    if (index === 0) realBoundary = await fs.promises.realpath(boundary);
    if (index < paths.length - 1 || directory) {
      if (!stat.isDirectory()) throw new Error('Origem do catálogo deve ser um diretório.');
    } else if (!stat.isFile()) throw new Error('Item do catálogo deve ser um arquivo regular.');
    if (!inside(realBoundary, await fs.promises.realpath(target))) throw new Error(OUTSIDE);
    identities.push([target, stamp(stat)]);
  }
  return identities;
}
async function readBounded(file, boundary, limit, stamps) {
  const identities = await checked(file, boundary, stamps);
  const before = await lstat(file, stamps);
  if (before.size > limit) throw new Error(limit === FILE_LIMIT ? TOO_LARGE : 'Registro do projeto excede 4 MiB.');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (stamp(stat) !== stamp(before) || !stat.isFile()) throw new Error('Arquivo do catálogo mudou durante a leitura.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > limit) throw new Error(limit === FILE_LIMIT ? TOO_LARGE : 'Registro do projeto excede 4 MiB.');
    if (count !== stat.size || stamp(await handle.stat()) !== stamp(stat)) throw new Error('Arquivo do catálogo mudou durante a leitura.');
    for (const [target, identity] of identities) if (stamp(await lstat(target, stamps)) !== identity) throw new Error('Origem do catálogo mudou durante a leitura.');
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)), bytes: count, mtimeMs: stat.mtimeMs };
  } finally { await handle.close(); }
}

// Validação estrutural portada de core/base_prototipo.py. Não executa Git nem
// interpreta as regras declaradas; elas permanecem material de referência.
function validateBase(base) {
  const errors = [];
  if (!object(base)) return ['prototipo: deve ser um objeto'];
  if (!relativePath(base.pasta)) errors.push('pasta: caminho relativo à raiz, sem "/" inicial nem ".."');
  const ds = base.design_system;
  if (!object(ds)) errors.push('design_system: obrigatório, deve ser um objeto');
  else {
    const mode = Object.hasOwn(ds, 'modo') ? ds.modo : 'vendorizado';
    if (!['vendorizado', 'submodule'].includes(mode)) errors.push('design_system.modo: use vendorizado ou submodule');
    for (const key of ['pacote', 'versao']) if (typeof ds[key] !== 'string' || !ds[key].trim()) errors.push(`design_system.${key}: obrigatório, texto`);
    if (!relativePath(ds.caminho)) errors.push('design_system.caminho: caminho relativo, sem "/" inicial nem ".."');
    if (!Array.isArray(ds.carga) || !ds.carga.length) errors.push('design_system.carga: obrigatório, lista não vazia de nomes de arquivo');
    else ds.carga.forEach((file, i) => { if (!relativePath(file)) errors.push(`design_system.carga[${i}]: nome de arquivo relativo, sem "/" inicial nem ".."`); });
    if (mode === 'submodule') {
      if (typeof ds.repositorio !== 'string' || !ds.repositorio.trim() || /[\x00-\x1f]/.test(ds.repositorio)) errors.push('design_system.repositorio: obrigatório, URL do submódulo como consta em .gitmodules');
      if (typeof ds.commit !== 'string' || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(ds.commit)) errors.push('design_system.commit: obrigatório, SHA completo de 40 ou 64 caracteres hexadecimais');
      if (typeof ds.caminho === 'string' && (ds.caminho !== ds.caminho.trim() || ds.caminho.includes('\\') || ds.caminho.split('/').some(part => ['', '.', '..'].includes(part)))) errors.push('design_system.caminho: submodule exige caminho canônico relativo, sem ponto ou barra invertida');
    }
    if (ds.involucro != null && (typeof ds.involucro !== 'string' || !/^\.[A-Za-z_][\w-]*$/.test(ds.involucro))) errors.push('design_system.involucro: uma classe, como ".tl"');
  }
  if (Object.hasOwn(base, 'tokens_do_projeto') && (!Array.isArray(base.tokens_do_projeto) || base.tokens_do_projeto.some(file => !relativePath(file)))) errors.push('tokens_do_projeto: deve ser uma lista de caminhos relativos');
  if (Object.hasOwn(base, 'fontes') && (!Array.isArray(base.fontes) || base.fontes.some(item => typeof item !== 'string'))) errors.push('fontes: deve ser uma lista de textos');
  if (Object.hasOwn(base, 'gabarito') && !object(base.gabarito)) errors.push('gabarito: deve ser um objeto');
  if (base.regras != null && !object(base.regras)) errors.push('regras: deve ser um objeto');
  else if (base.regras) for (const [kind, fields] of [['exigido', ['arquivo', 'trecho']], ['proibido', ['padrao']]]) {
    const items = base.regras[kind];
    if (items == null) continue;
    if (!Array.isArray(items)) { errors.push(`regras.${kind}: deve ser uma lista`); continue; }
    items.forEach((item, i) => {
      const ref = `regras.${kind}[${i}]`;
      if (!object(item)) { errors.push(`${ref}: deve ser um objeto`); return; }
      for (const field of fields) if (typeof item[field] !== 'string' || !item[field]) errors.push(`${ref}.${field}: obrigatório, texto`);
      if (kind === 'exigido' && typeof item.arquivo === 'string' && !relativePath(item.arquivo)) errors.push(`${ref}.arquivo: caminho relativo, sem "/" inicial nem ".."`);
      // Python e JS têm dialetos de regex distintos. Não compilamos/rodamos
      // o padrão Python aqui; validar sua sintaxe cabe ao kit.
      if (Object.hasOwn(item, 'em') && typeof item.em !== 'string') errors.push(`${ref}.em: deve ser um glob, texto`);
      if (Object.hasOwn(item, 'motivo') && typeof item.motivo !== 'string') errors.push(`${ref}.motivo: deve ser texto`);
    });
  }
  return errors;
}

class Catalogs {
  constructor(onChange = null) {
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.activeRoot = null; this.cache = null; this.options = null; this.watchers = []; this.watchGeneration = 0; this.timer = null; this.epoch = 0; this.pending = null; this.recalculation = null; this.dirty = false; this.watchFailure = null;
  }
  _stopWatchers() {
    this.watchGeneration++;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
  close() {
    this.epoch++; clearTimeout(this.timer); this.timer = null;
    this._stopWatchers(); this.activeRoot = null; this.cache = null; this.options = null; this.pending = null; this.recalculation = null; this.dirty = false; this.watchFailure = null;
  }
  closeProject(root) { if (typeof root === 'string' && path.resolve(root) === this.activeRoot) this.close(); }
  invalidate(root) {
    if (typeof root !== 'string' || path.resolve(root) !== this.activeRoot) return;
    this.dirty = true; this._changed(this.activeRoot, this.epoch);
  }
  _changed(root, epoch) {
    this.dirty = true;
    if (this.recalculation?.epoch === epoch && this.recalculation.root === root) {
      this.recalculation.notify = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.activeRoot === root && this.epoch === epoch) this.onChange?.({ path: root });
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }
  async _unchanged(stamps) {
    for (const [file, previous] of stamps) {
      try { if (stamp(await fs.promises.lstat(file)) !== previous) return false; }
      catch (error) { if (error.code !== 'ENOENT' || previous !== null) return false; }
    }
    return true;
  }
  async list(root, { kit = null, plugins = [], refresh = false } = {}) {
    root = projectPath(root);
    if (root !== this.activeRoot) { this.close(); this.activeRoot = root; }
    // plugins aceita diretamente Extensions.records (Map), sem redescobrir
    // manifestos ou varrer skills-ativas. file/boundary vêm do cache de M0.
    const records = plugins instanceof Map ? [...plugins.values()] : plugins;
    if (!Array.isArray(records)) throw new Error('Lista de plugins inválida.');
    this.options = { kit, plugins: records };
    return this._enqueue(root, (current, epoch) => this._list(root, { kit, plugins: records, refresh }, current, epoch));
  }
  _enqueue(root, operation) {
    const epoch = this.epoch;
    const current = () => { if (epoch !== this.epoch || root !== this.activeRoot) throw new Error('Projeto alterado durante a leitura de catálogos.'); };
    // Serializa também read: o snapshot e seus specs ficam juntos até o fim
    // da operação. Só troca/fechamento de projeto cancela trabalho pendente.
    const pending = (this.pending || Promise.resolve()).catch(() => {}).then(() => { current(); return operation(current, epoch); });
    this.pending = pending;
    const clear = () => { if (this.pending === pending) this.pending = null; };
    pending.then(clear, clear);
    return pending;
  }
  async _list(root, { kit, plugins: records, refresh = false }, current, epoch) {
    const signature = JSON.stringify([kit, records.map(record => [record.file, record.boundary, record.item?.id, record.item?.name, record.item?.contributes?.catalogs])]);
    if (!refresh && !this.dirty && this.cache?.signature === signature && await this._unchanged(this.cache.stamps)) {
      current();
      return structuredClone(this.cache.snapshot);
    }
    current();
    const recalculation = { root, epoch, notify: this.timer !== null };
    this.recalculation = recalculation;
    clearTimeout(this.timer); this.timer = null;
    this._stopWatchers(); this.dirty = false;
    try {
      return await this._rebuild(root, { kit, records, refresh, signature }, current, epoch);
    } finally {
      if (this.recalculation === recalculation) {
        this.recalculation = null;
        if (recalculation.notify && root === this.activeRoot && epoch === this.epoch) this.onChange?.({ path: root });
      }
    }
  }
  async _rebuild(root, { kit, records, refresh, signature }, current, epoch) {
    if (refresh) this.watchFailure = null;
    const stamps = new Map(), entries = new Map(), watchDirs = new Map();
    try { await checked(root, root, stamps, true); } catch (error) { throw new Error(diagnostic(error)); }
    current();
    const snapshot = { root, kit: null, catalogs: [], errors: [], watching: false };
    const watch = (dir, boundary, { recursive = true, names = null } = {}) => {
      // A raiz nunca deve estender a observação ao código do projeto.
      // Uma origem na própria raiz acrescenta as pastas de entrada pelo nome;
      // pastas novas nessa origem exigem Recarregar.
      if (dir === root) { recursive = false; names = ['DESIGN.md', '.dk', ...(Array.isArray(names) ? names : [])]; }
      const previous = watchDirs.get(dir);
      if (previous) {
        previous.recursive ||= recursive;
        if (!previous.names || !names) previous.names = null;
        else for (const name of names) previous.names.add(name);
      } else watchDirs.set(dir, { boundary, recursive, names: names && new Set(names) });
    };
    watch(root, root);
    const catalog = (id, kind, type, label, dir, pluginId) => ({ id, kind, origin: { type, label, ...(pluginId ? { pluginId } : {}) }, root: dir, entries: [], errors: [], truncated: false });
    const add = async (cat, name, file, boundary, { optional = false, title = name, errors = [], declaration = false } = {}) => {
      const entry = { id: `${cat.id}/${name}`, name, title, description: '', stage: '', gate: false,
        path: path.relative(cat.root, file).split(path.sep).join('/'), bytes: 0, mtimeMs: 0, frontmatter: { parser: 'yaml' }, errors: [...errors] };
      const spec = { file, boundary, declaration, errors: [...errors] };
      try {
        const read = await readBounded(file, boundary, FILE_LIMIT, stamps), parsed = parseFrontmatter(read.text);
        entry.bytes = read.bytes; entry.mtimeMs = read.mtimeMs; entry.frontmatter = { ...parsed.data, parser: parsed.parser };
        entry.title = parsed.data.name || title;
        entry.description = (parsed.data.description || '').slice(0, 300);
        Object.assign(entry, stageGate(parsed.data.description));
        if (parsed.error) entry.errors.push(parsed.error);
      } catch (error) {
        if (error.code === 'ENOENT' && optional) return;
        if (!(error.code === 'ENOENT' && declaration)) entry.errors.push(diagnostic(error));
        const observed = stamps.get(file);
        if (observed != null) {
          const stat = await fs.promises.lstat(file).catch(() => null);
          if (stat) { entry.bytes = stat.size; entry.mtimeMs = stat.mtimeMs; }
        }
      }
      cat.entries.push(entry); entries.set(entry.id, spec);
    };
    const scan = async (cat, boundary) => {
      try {
        await checked(cat.root, boundary, stamps, true);
        if (cat.origin.type !== 'kit') watch(cat.root, boundary);
        const folders = [];
        const stream = await fs.promises.opendir(cat.root);
        let count = 0;
        try {
          for await (const entry of stream) {
            if (++count > DIRECTORY_LIMIT) { cat.truncated = true; cat.errors.push('Limite de 512 entradas do diretório atingido.'); break; }
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            if (!NAME.test(entry.name)) { cat.errors.push(`Nome de item inválido: ${entry.name}.`); continue; }
            folders.push(entry.name);
          }
        } finally { try { await stream.close(); } catch {} }
        folders.sort();
        if (folders.length > ENTRY_LIMIT) { cat.truncated = true; cat.errors.push('mais de 64 itens; os demais não foram carregados'); }
        for (const name of folders.slice(0, ENTRY_LIMIT)) {
          const dir = path.join(cat.root, name);
          if (cat.root === root && cat.origin.type !== 'kit') { watch(root, boundary, { names: [name] }); watch(dir, boundary, { recursive: false }); }
          await add(cat, name, path.join(dir, cat.kind === 'skills' ? 'SKILL.md' : 'DESIGN.md'), boundary);
        }
      } catch (error) {
        cat.errors.push(diagnostic(error));
        // Uma origem ausente usa só o ancestral existente mais próximo.
        if (cat.origin.type !== 'kit') await watchAncestor(cat.root, boundary);
      }
    };
    const watchAncestor = async (target, boundary) => {
      if (!inside(boundary, target)) return;
      let dir = path.dirname(target);
      while (inside(boundary, dir)) {
        try {
          await checked(dir, boundary, stamps, true);
          watch(dir, boundary, { recursive: false, names: [path.relative(dir, target).split(path.sep)[0]] });
          return;
        }
        catch (error) { if (error.code !== 'ENOENT') return; }
        if (dir === boundary) return;
        dir = path.dirname(dir);
      }
    };
    if (kit && typeof kit.path === 'string' && path.isAbsolute(kit.path)) {
      try {
        await checked(kit.path, kit.path, stamps, true);
        snapshot.kit = { path: kit.path, ...(kit.version === undefined ? {} : { version: kit.version }) };
        const cat = catalog('kit-skills', 'skills', 'kit', 'Kit', path.join(kit.path, 'skills'));
        await scan(cat, kit.path); snapshot.catalogs.push(cat);
      } catch (error) { snapshot.errors.push(MISSING_KIT, diagnostic(error)); }
    } else snapshot.errors.push(MISSING_KIT);

    const project = catalog('project-design', 'design-systems', 'project', 'Projeto', root);
    const projectFile = path.join(root, '.dk', 'projeto.json');
    try {
      await checked(path.dirname(projectFile), root, stamps, true);
      watch(path.dirname(projectFile), root, { recursive: false, names: ['projeto.json'] });
    } catch {} // A criação de .dk é percebida pelo watcher da raiz.
    try {
      const read = await readBounded(projectFile, root, JSON_LIMIT, stamps), value = JSON.parse(read.text);
      if (!object(value)) throw new Error('Registro do projeto deve ser um objeto JSON.');
      // Limite de itens também para a declaração JSON, sem recursão na pilha.
      const queue = [value]; let count = 0;
      while (queue.length) {
        const item = queue.pop();
        if (++count > 5000) throw new Error('Registro do projeto excede 5000 itens.');
        if (item && typeof item === 'object') {
          const children = Object.values(item);
          if (count + queue.length + children.length > 5000) throw new Error('Registro do projeto excede 5000 itens.');
          queue.push(...children);
        }
      }
      if (Object.hasOwn(value, 'prototipo')) {
        const errors = validateBase(value.prototipo), ds = value.prototipo?.design_system;
        const validPath = relativePath(ds?.caminho);
        const dsPath = validPath ? path.posix.normalize(ds.caminho) : null;
        const file = validPath ? path.join(root, dsPath, 'DESIGN.md') : projectFile;
        if (validPath) {
          try {
            await checked(path.dirname(file), root, stamps, true);
            watch(path.dirname(file), root);
          } catch (error) {
            errors.push(error.code === 'ENOENT' ? 'Diretório do design system declarado ausente.' : diagnostic(error));
            if (error.code === 'ENOENT') await watchAncestor(path.dirname(file), root);
          }
        }
        if (!errors.length) for (const load of ds.carga) {
          try { await checked(path.join(root, dsPath, path.posix.normalize(load)), root, stamps); }
          catch (error) { errors.push(error.code === 'ENOENT' ? `design_system.carga: arquivo ausente: ${load}.` : diagnostic(error)); }
        }
        if (validPath) await add(project, 'declarado', file, root, { declaration: true, errors, title: `Declarado · ${ds.pacote || ''}@${ds.versao || ''}` });
        else {
          project.entries.push({ id: 'project-design/declarado', name: 'declarado', title: 'Declarado', description: '', stage: '', gate: false,
            path: '.dk/projeto.json', bytes: read.bytes, mtimeMs: read.mtimeMs, frontmatter: { parser: 'yaml' }, errors });
          entries.set('project-design/declarado', { file: null, boundary: root, errors });
        }
      } else project.errors.push('Design system do projeto não declarado.');
    } catch (error) {
      project.errors.push(error.code === 'ENOENT' ? 'Design system do projeto não declarado.' : error instanceof SyntaxError ? 'JSON do projeto inválido.' : diagnostic(error));
    }
    await add(project, 'raiz', path.join(root, 'DESIGN.md'), root, { optional: true, title: 'DESIGN.md' });
    snapshot.catalogs.push(project);

    for (const record of [...records].sort((a, b) => (a.item?.id || '').localeCompare(b.item?.id || ''))) {
      const item = record.item;
      if (!item || !NAME.test(item.id) || !Array.isArray(item.contributes?.catalogs)) continue;
      for (const contribution of [...item.contributes.catalogs].sort((a, b) => a.id.localeCompare(b.id))) {
        const id = `plugin:${item.id}/${contribution.id}`;
        if (!NAME.test(contribution.id) || id.length > 128 || !['skills', 'design-systems'].includes(contribution.kind)) continue;
        const base = contribution.source === 'project' ? root : typeof record.file === 'string' ? path.dirname(record.file) : null;
        const boundary = contribution.source === 'project' ? root : record.boundary || base;
        const dir = base && relativePath(contribution.path) ? path.join(base, path.posix.normalize(contribution.path)) : base || root;
        const cat = catalog(id, contribution.kind, 'plugin', `Plugin ${item.name}`, dir, item.id);
        if (!base || !relativePath(contribution.path) || !['plugin', 'project'].includes(contribution.source)) cat.errors.push(OUTSIDE);
        else await scan(cat, boundary);
        snapshot.catalogs.push(cat);
      }
    }
    current();
    this.cache = { snapshot, entries, stamps, signature };
    if (this.onChange) await this._watch(root, epoch, watchDirs, snapshot);
    current();
    return structuredClone(snapshot);
  }
  async _watch(root, epoch, dirs, snapshot) {
    const generation = this.watchGeneration;
    const current = () => epoch === this.epoch && root === this.activeRoot && generation === this.watchGeneration;
    const failure = () => {
      if (!current()) return;
      this._stopWatchers(); snapshot.watching = false;
      this.watchFailure = WATCH_FAILURE;
      if (!snapshot.errors.includes(WATCH_FAILURE)) snapshot.errors.push(WATCH_FAILURE);
    };
    // Só origens usam recursão; raiz, registro e ancestrais ausentes observam
    // nomes explícitos. Os stamps continuam sendo revalidados em list/read.
    if (this.watchFailure || dirs.size > WATCHER_LIMIT) { failure(); return; }
    for (const [dir, { boundary, recursive, names }] of dirs) {
      try {
        await checked(dir, boundary, null, true);
        if (!current()) return;
        const changed = (_event, filename) => {
          const relative = filename == null ? null : filename.toString();
          if (names && !names.has(relative)) return;
          if (relative?.split(/[\\/]/).some(part => part === 'node_modules' || part === '.git')) return;
          if (current()) this._changed(root, epoch);
        };
        let watcher;
        try { watcher = fs.watch(dir, { persistent: false, recursive }, changed); }
        catch (error) {
          if (error.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw error;
          watcher = fs.watch(dir, { persistent: false }, changed);
        }
        watcher.on('error', () => {
          if (!current()) return;
          failure(); this._changed(root, epoch);
        });
        this.watchers.push(watcher);
      } catch { failure(); return; }
    }
    snapshot.watching = this.watchers.length > 0;
  }
  async read(root, catalogId, entryId) {
    // entryId é o nome curto (entry.name, até 64 caracteres); entry.id no
    // snapshot é a identidade qualificada <catalogId>/<nome> para a UI.
    if (typeof catalogId !== 'string' || catalogId.length > 128 || !CATALOG_ID.test(catalogId)) throw new Error('Catálogo não encontrado.');
    if (typeof entryId !== 'string' || !NAME.test(entryId)) throw new Error('Item do catálogo não encontrado.');
    root = projectPath(root);
    if (root !== this.activeRoot || !this.options) throw new Error('Catálogo não encontrado.');
    const options = this.options;
    return this._enqueue(root, (current, epoch) => this._read(root, catalogId, entryId, options, current, epoch));
  }
  async _read(root, catalogId, entryId, options, current, epoch) {
    const snapshot = await this._list(root, options, current, epoch);
    current();
    if (!snapshot.catalogs.some(cat => cat.id === catalogId)) throw new Error('Catálogo não encontrado.');
    const spec = this.cache.entries.get(`${catalogId}/${entryId}`);
    if (!spec) throw new Error('Item do catálogo não encontrado.');
    if (spec.errors.length) throw new Error(spec.errors.join('; '));
    let result;
    try {
      const read = await readBounded(spec.file, spec.boundary, FILE_LIMIT);
      const parsed = parseFrontmatter(read.text);
      result = { catalogId, entryId, frontmatter: { ...parsed.data, parser: parsed.parser }, text: parsed.body, bytes: read.bytes };
    } catch (error) {
      if (!spec.declaration || error.code !== 'ENOENT') throw new Error(diagnostic(error));
      result = { catalogId, entryId, frontmatter: { parser: 'yaml' }, text: '', bytes: 0 };
    }
    if (epoch !== this.epoch || root !== this.activeRoot) throw new Error('Projeto alterado durante a leitura de catálogos.');
    return result;
  }
}

module.exports = { Catalogs, parseFrontmatter, stageGate, inside };
