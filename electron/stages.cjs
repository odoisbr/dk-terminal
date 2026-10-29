const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');

// Portado do DK 1.7.0-rc.14: registry, lacunas, cobertura, projeto e base_prototipo.
const LIMIT = Object.freeze({ yaml: 256 * 1024, registry: 4 * 1024 * 1024, items: 5000,
  checklist: 256 * 1024, document: 2 * 1024 * 1024, documents: 32, text: 8 * 1024 * 1024,
  adoption: 16 * 1024 * 1024, adoptionTotal: 64 * 1024 * 1024,
  depth: 4, prototype: 2000, directory: 512, watchers: 16, id: 256 });
const FILES = { regras: ['business-rules.json', 'regras.json'], requisitos: ['requirements.json', 'requisitos.json'],
  fontes: ['sources.json'], evidencias: ['evidence.json'], rastreabilidade: ['traceability.json'],
  pendencias: ['pending.json', 'pendencias.json'], decisoes: ['decisions.json'] };
const DOCUMENTS = new Set(['.html', '.md', '.txt', '.rst', '.adoc', '.markdown', '.pdf', '.docx']);
const PROTOTYPE_IGNORED = new Set(['node_modules', '.git', 'design-system']);
const DEFAULTS = { apoio: '0-apoio', levantamento: '1-levantamento', design: '2-design', entregaveis: '3-entregaveis' };
const DEFINITIONS = [
  ['levantar', 'Levantar', [['L1', 'Registro de regras com ≥1 item'], ['L2', 'Registro de requisitos com ≥1 item'],
    ['L3', 'Todo requisito e regra com procedência'], ['L4', 'Nenhuma lacuna CRÍTICA em AUSENTE|PENDENTE']]],
  ['entender', 'Entender', [['E1', 'Toda referência de sources existe em fontes ou evidências'],
    ['E2', 'Nenhuma regra sem requisito e nenhum RF sem regra'], ['E3', 'Nenhuma prova documental resolvida só por relato']]],
  ['entregar', 'Entregar', [['D1', 'Documento de requisitos existe (canônico ou adotado)'], ['D2', 'Documento de visão existe'],
    ['D3', 'Todo requisito citado em algum entregável'], ['D4', 'checklist-dod presente (só contexto portal)']]],
  ['prototipar', 'Prototipar', [['P1', 'Pasta do protótipo contém telas HTML'], ['P2', 'Base declarada e design system presente']]],
];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && !!v.trim();
const truthy = v => Array.isArray(v) ? v.length > 0 : object(v) ? Object.keys(v).length > 0 : !!v;
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
function relative(value) {
  if (!nonempty(value) || /[\\\x00-\x1f]/.test(value) || value.startsWith('~') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').includes('..') || path.posix.normalize(value) === '.') {
    throw new Error(`Caminho fora do projeto ou inválido: ${String(value).slice(0, 200)}.`);
  }
  return path.posix.normalize(value);
}
function adoptionPath(root, value) {
  // projeto._caminho_dentro aceita também caminho absoluto contido na raiz.
  if (!nonempty(value) || /[\\\x00-\x1f]/.test(value) || path.win32.isAbsolute(value) && !path.isAbsolute(value)) throw new Error('Caminho de adoção inválido.');
  const file = path.resolve(root, value);
  if (!inside(root, file)) throw new Error('Caminho de adoção fora da raiz do projeto.');
  return file;
}
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const signature = s => s ? `${s.dev}:${s.ino}:${s.mode}:${s.mtimeMs}:${s.ctimeMs}:${s.size}` : null;

// manifesto.validar_selecao/carregar: mensagens do contrato, sem acesso ao disco.
function selectionErrors(selection, flow = false) {
  if (!Array.isArray(selection)) return ['entregaveis deve ser lista explícita; [] significa nenhum'];
  const errors = [], seen = new Set();
  for (const item of selection) {
    if (!object(item)) { errors.push('cada seleção deve ser um objeto'); continue; }
    const group = item.grupo ?? null;
    if (group !== null) {
      if (group !== 'fluxos' || Object.keys(item).some(k => !['grupo', 'itens'].includes(k)) || !Array.isArray(item.itens)) {
        errors.push('grupo fluxos exige itens explícitos'); continue;
      }
      errors.push(...selectionErrors(item.itens, true));
    }
    for (const selected of group === null ? [item] : item.itens) {
      if (!object(selected) || Object.hasOwn(selected, 'grupo')) { errors.push('grupo não pode conter grupos'); continue; }
      if (!nonempty(selected.id) || !nonempty(selected.revisao)) errors.push('seleção exige id e revisao explícitos');
      const formats = selected.formatos;
      if (group === null && !flow && (!Array.isArray(formats) || !formats.length || formats.some(f => typeof f !== 'string' || !f) || new Set(formats).size !== formats.length)) errors.push('artefato exige formatos explícitos não repetidos');
      const key = JSON.stringify([group || 'artefatos', selected.id]);
      if (typeof selected.id === 'string') {
        if (seen.has(key)) errors.push('ID selecionado duas vezes: ' + selected.id);
        seen.add(key);
      }
    }
  }
  return errors;
}
function manifestRelative(value) {
  if (!nonempty(value) || /[\\\x00]/.test(value)) throw new Error('caminho deve ser texto relativo não vazio');
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) throw new Error('caminho fora do projeto: ' + value);
  const normalized = path.posix.normalize(value).replace(/\/$/, '');
  if (normalized === '.') throw new Error('caminho deve identificar arquivo ou pasta');
  return normalized;
}
function validateManifest(manifest, config = {}, configError = null) {
  if (manifest.schema !== 2) return;
  const errors = [], paths = [];
  if (!object(config)) { configError = 'configuração deve ser objeto'; config = {}; }
  for (const key of ['pastas', 'registros', 'repos', 'publicacao', 'painel', 'prototipo']) {
    if (Object.hasOwn(manifest, key) && !object(manifest[key])) errors.push(key + ' deve ser objeto');
  }
  for (const key of ['cliente', 'projeto', 'slug']) if (!nonempty(manifest[key])) errors.push(key + ' é obrigatório');
  errors.push(...selectionErrors(manifest.entregaveis));
  for (const key of ['responsavel', 'situacao', 'atualizado_em']) if (Object.hasOwn(manifest, key) && typeof manifest[key] !== 'string') errors.push(key + ' deve ser texto');
  if (Object.hasOwn(manifest, 'edit_mode') && !['git', 'web'].includes(manifest.edit_mode)) errors.push('edit_mode deve ser git ou web');
  const phase = v => Number.isInteger(v) && v >= 1 && v <= 8;
  if (Object.hasOwn(manifest, 'fase_atual') && !phase(manifest.fase_atual)) errors.push('fase_atual deve ser inteiro de 1 a 8');
  const phases = manifest.fases_concluidas;
  if (Object.hasOwn(manifest, 'fases_concluidas') && (!Array.isArray(phases) || phases.some(v => !phase(v)) || new Set(phases).size !== phases.length)) errors.push('fases_concluidas exige lista não repetida de inteiros de 1 a 8');
  if (object(manifest.painel)) for (const key of ['abas', 'metricas']) {
    const vals = manifest.painel[key];
    if (Object.hasOwn(manifest.painel, key) && (!Array.isArray(vals) || vals.some(v => typeof v !== 'string' || !v) || new Set(vals).size !== vals.length)) errors.push(`painel.${key} exige lista de textos únicos`);
  }
  if (object(manifest.publicacao)) {
    const pub = manifest.publicacao;
    if (Object.hasOwn(pub, 'ref') && (!nonempty(pub.ref) || pub.ref.startsWith('-'))) errors.push('publicacao.ref deve ser texto não vazio válido');
    if (Object.hasOwn(pub, 'perfil') && !['sea', 'generico'].includes(pub.perfil)) errors.push('publicacao.perfil deve ser sea ou generico');
  }
  for (const [field, defaults] of [['pastas', DEFAULTS], ['registros', {}]]) {
    const values = manifest[field] === undefined ? defaults : manifest[field];
    const normalized = {};
    if (object(values)) for (const [key, value] of Object.entries(values)) {
      try { normalized[key] = manifestRelative(value); } catch (e) { errors.push(e.message); }
    }
    paths.push(...Object.values(normalized));
    if (Object.hasOwn(config, field) && !object(config[field])) errors.push(field + ' deve ser objeto');
    else for (const [key, value] of Object.entries(config[field] || {})) {
      if (Object.hasOwn(normalized, key) && value !== normalized[key]) errors.push(`${field}.${key} diverge de projeto.yml`); // DK-CAMINHOS-CONFLITO
    }
  }
  if (configError) errors.push(configError);
  if (errors.length) throw new Error('projeto.yml v2 inválido: ' + errors.join('; '));
  return paths;
}

function validateYamlData(data) {
  // Como manifesto.ler_yaml: aliases são permitidos, ciclos e valores fora de JSON não.
  let nodes = 0;
  const ancestors = new Set();
  function visit(value, depth) {
    if (++nodes > 100000 || depth > 100) throw new Error('YAML excede limite de nós/profundidade.');
    if (value !== null && typeof value === 'object') {
      if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Valor YAML fora do contrato JSON.');
      if (ancestors.has(value)) throw new Error('Âncora YAML cíclica não permitida.');
      ancestors.add(value);
      for (const child of Object.values(value)) visit(child, depth + 1);
      ancestors.delete(value);
    } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null || typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Valor YAML fora do contrato JSON.');
    }
  }
  visit(data, 0);
}

// Todos os acessos são assíncronos, limitados e registrados (inclusive ausências).
// O_NOFOLLOW e identidades antes/depois reduzem corridas; Node não oferece openat portátil.
class Reader {
  constructor(root) { this.root = root; this.stamps = new Map(); this.scannedDirs = new Set(); this.recursiveDirs = new Set(); }
  async stat(file) {
    try { const s = await fs.promises.lstat(file); this.stamps.set(file, signature(s)); return s; }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.stamps.set(file, null); return null; }
  }
  async resolve(file, links = 0) {
    if (!inside(this.root, file)) throw new Error('Caminho fora do projeto.');
    if (links > 40) throw new Error('Ciclo ou excesso de links simbólicos.');
    let current = this.root;
    const components = path.relative(this.root, file).split(path.sep).filter(Boolean);
    for (let i = -1; i < components.length; i++) {
      if (i >= 0) current = path.join(current, components[i]);
      const stat = await this.stat(current);
      if (!stat) { this.stamps.set(file, null); return null; }
      if (stat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(current), await fs.promises.readlink(current));
        if (!inside(this.root, target)) throw new Error(`symlink/caminho fora do projeto: ${path.relative(this.root, current)}`);
        return this.resolve(path.join(target, ...components.slice(i + 1)), links + 1);
      }
      if (i < components.length - 1 && !stat.isDirectory()) throw new Error('Componente do caminho deve ser diretório.');
    }
    const canonical = await fs.promises.realpath(file);
    if (!inside(this.root, canonical)) throw new Error('Caminho fora do projeto.');
    return { file: canonical, stat: await this.stat(canonical) };
  }
  async check(file) { return (await this.resolve(file))?.stat || null; }
  async bytes(file, max) {
    const resolved = await this.resolve(file);
    if (!resolved) return null;
    const before = resolved.stat;
    if (!before.isFile()) throw new Error(`Arquivo regular obrigatório: ${file}.`);
    if (before.size > max) throw new Error(`Arquivo excede o limite de ${max} bytes: ${file}.`);
    const handle = await fs.promises.open(resolved.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const start = await handle.stat();
      if (signature(start) !== signature(before)) throw new Error('Arquivo mudou durante a leitura.');
      const buffer = Buffer.alloc(Math.min(start.size + 1, max + 1));
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > max) throw new Error(`Arquivo excede o limite de ${max} bytes: ${file}.`);
      const after = await this.resolve(file);
      if (count !== start.size || signature(await handle.stat()) !== signature(start) || after?.file !== resolved.file || signature(after?.stat) !== signature(start)) throw new Error('Arquivo mudou durante a leitura.');
      return buffer.subarray(0, count);
    } finally { await handle.close(); }
  }
  async text(file, max) {
    const bytes = await this.bytes(file, max);
    if (bytes === null) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`Texto UTF-8 inválido ou ilegível: ${file}.`); }
  }
  async json(file, max = LIMIT.registry) {
    const text = await this.text(file, max);
    if (text === null) return null;
    try { return JSON.parse(text); } catch { throw new Error(`JSON inválido: ${file}.`); }
  }
  async entries(dir, max = LIMIT.directory) {
    this.scannedDirs.add(dir);
    const resolved = await this.resolve(dir);
    if (!resolved) return [];
    const stat = resolved.stat;
    this.scannedDirs.add(resolved.file);
    if (!stat.isDirectory()) throw new Error(`Diretório obrigatório: ${dir}.`);
    const entries = [], handle = await fs.promises.opendir(resolved.file);
    try {
      for await (const entry of handle) {
        entries.push(entry);
        if (entries.length > max) throw new Error(`Diretório excede o limite de ${max} entradas: ${dir}.`);
      }
    } finally { if (!handle.closed) await handle.close().catch(e => { if (e.code !== 'ERR_DIR_CLOSED') throw e; }); }
    const after = await this.resolve(dir);
    if (after?.file !== resolved.file || signature(after?.stat) !== signature(stat)) throw new Error('Diretório mudou durante a leitura.');
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }
}

async function resolveRegistry(root, manifesto = {}, reader = null, config = undefined) {
  if (!reader) { root = await fs.promises.realpath(root); reader = new Reader(root); }
  const v2 = manifesto.schema === 2;
  if (v2) {
    if (config === undefined) {
      const file = path.join(root, '.dk', 'projeto.json');
      config = await reader.check(file) ? await reader.json(file) : {};
    }
    const paths = validateManifest(manifesto, config), errors = [];
    // manifesto.carregar → Fonte.caminho: todo caminho declarado participa do
    // contrato, inclusive pastas padrão; ausência e symlinks internos são válidos.
    for (const rel of paths) {
      try { await reader.resolve(path.join(root, rel)); }
      catch { errors.push('symlink/caminho fora do projeto: ' + rel); }
    }
    if (errors.length) throw new Error('projeto.yml v2 inválido: ' + errors.join('; '));
  }
  const registros = {};
  for (const [name, names] of Object.entries(FILES)) {
    const key = name === 'rastreabilidade' ? 'relacoes' : name;
    if (v2) {
      registros[name] = Object.hasOwn(manifesto.registros || {}, key)
        ? { arquivo: path.join(root, relative(manifesto.registros[key])) }
        : { arquivo: null, motivo: `registros.${key} não declarado no v2` };
    } else {
      let file = path.join(root, 'registry', names.at(-1)), error;
      for (const name of names) {
        const candidate = path.join(root, 'registry', name);
        try { if (await reader.check(candidate)) { file = candidate; break; } }
        catch (e) { file = candidate; error = e.message; break; }
      }
      registros[name] = { arquivo: file, ...(error ? { error } : {}) };
    }
  }
  let esquema = v2 ? 'canonico' : 'ausente';
  if (!v2) {
    for (const name of ['requirements.json', 'business-rules.json', 'requisitos.json', 'regras.json']) {
      let exists;
      try { exists = await reader.check(path.join(root, 'registry', name)); } catch { exists = true; }
      if (exists) { esquema = name.includes('-') || name === 'requirements.json' ? 'canonico' : 'dk'; break; }
    }
  }
  return { esquema, registros };
}

async function readRegistry(file, reader = null) {
  if (!reader) {
    let root;
    try { root = await fs.promises.realpath(path.dirname(file)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    file = path.join(root, path.basename(file));
    reader = new Reader(root);
  }
  if (!await reader.check(file)) return [];
  const data = await reader.json(file);
  let items = data;
  if (object(items)) {
    const keys = ['itens', 'items'].filter(k => Object.hasOwn(items, k));
    if (keys.length !== 1) throw new Error('Envelope exige exatamente uma chave: itens ou items.');
    items = items[keys[0]];
  }
  if (!Array.isArray(items) || items.some(i => !object(i))) throw new Error('Registro deve conter uma lista de objetos.');
  if (items.length > LIMIT.items) throw new Error('Registro excede o limite de 5000 itens.');
  for (const item of items) {
    if ('sources' in item && !(typeof item.sources === 'string' || Array.isArray(item.sources) && item.sources.every(v => typeof v === 'string'))) throw new Error('sources deve ser texto ou lista de textos.');
    const f = item.fonte;
    if ('fonte' in item && !(typeof f === 'string' || Array.isArray(f) && f.every(v => typeof v === 'string') || object(f) && typeof f.arquivo === 'string' && typeof f.citacao === 'string' && (f.arquivo.trim() || f.citacao.trim()) && (!('quem' in f) || typeof f.quem === 'string'))) throw new Error('fonte deve ser texto, lista de textos ou objeto com arquivo e citacao.');
  }
  return items;
}

function corpusFrom(registros) {
  const fields = { regras: ['enunciado', 'title', 'description'], requisitos: ['titulo', 'descricao', 'title', 'description'], pendencias: ['enunciado', 'resposta_decidida'], decisoes: ['decision', 'decisao'] };
  const approved = new Set(['confirmado', 'confirmada', 'aprovado', 'aprovada', 'aceito', 'aceita', 'validado', 'validada']);
  const decided = new Set(['decidido', 'decidida', 'vigente', ...approved]);
  return Object.entries(fields).flatMap(([name, keys]) => (registros[name] || []).map(item => {
    const status = String(item.status || '').toLowerCase();
    const fonte = truthy(item.sources) || truthy(item.origem) || truthy(item.fonte);
    let resolvida = name === 'pendencias' && ['decidida', 'resolvida', 'confirmada', 'aprovada'].includes(status) && truthy(item.resposta_decidida);
    const texto = keys.filter(k => name !== 'pendencias' || k !== 'resposta_decidida' || resolvida)
      .map(k => name === 'decisoes' ? typeof item[k] === 'string' ? item[k] : '' : String(item[k] || '')).join(' ');
    if (name === 'decisoes') resolvida = !!texto.trim() && fonte && decided.has(status);
    return { id: String(item.id || name), texto, estado: !['pendencias', 'decisoes'].includes(name) || resolvida ? 'resposta' : 'pendente', validada: fonte && (resolvida || approved.has(status)) };
  }));
}

function lacunas(corpus, checklist) {
  const itens = Array.isArray(checklist) ? checklist : checklist?.itens;
  if (!Array.isArray(itens) || !itens.length || itens.length > LIMIT.items || itens.some(i => !object(i) || !nonempty(i.id) || !nonempty(i.prioridade) || !Array.isArray(i.sinais) || !i.sinais.length || i.sinais.some(s => !nonempty(s)))) throw new Error('Checklist de discovery inválido.');
  const partes = Array.isArray(corpus) ? corpus : corpusFrom(corpus);
  return itens.map((item, index) => {
    const patterns = item.sinais.map(s => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(s)}`, 'iu'));
    const matches = partes.filter(p => patterns.some(re => re.test(p.texto)));
    const respostas = matches.filter(p => p.estado === 'resposta'), pendencias = matches.filter(p => p.estado === 'pendente');
    const referencias = [...respostas, ...pendencias].map(p => p.id);
    const status = !referencias.length ? 'AUSENTE' : pendencias.length && !respostas.length ? 'PENDENTE' : respostas.filter(p => p.validada).length >= 2 && !pendencias.length ? 'COBERTO' : 'PARCIAL';
    const evidencia = status === 'AUSENTE' ? `nenhum registro menciona: ${item.sinais.slice(0, 4).join(', ')}` : status === 'PENDENTE' ? `pergunta registrada, sem resposta: ${pendencias.slice(0, 4).map(p => p.id).join(', ')}` : status === 'COBERTO' ? `conferir conteúdo e aprovação em: ${respostas.slice(0, 4).map(p => p.id).join(', ')}` : `sinal ainda não resolve a pergunta; conferir: ${referencias.slice(0, 4).join(', ')}`;
    return { id: `L-${String(index + 1).padStart(2, '0')}`, item: item.id, tema: item.tema, pergunta: item.pergunta, status, prioridade: item.prioridade, evidencia, registros: referencias };
  });
}

function deliverableFolders(manifesto) {
  const pastas = manifesto.schema === 2 && manifesto.pastas !== undefined ? manifesto.pastas : DEFAULTS;
  if (!object(pastas)) throw new Error('pastas deve ser objeto.');
  const folders = {};
  for (const [tipo, suffix] of [['requisitos', 'requisitos'], ['visao', 'visao'], ['ata', 'atas']]) folders[tipo] = pastas.levantamento === undefined ? null : `${relative(pastas.levantamento)}/${suffix}`;
  folders['checklist-dod'] = pastas.entregaveis === undefined ? null : relative(pastas.entregaveis);
  return folders;
}

async function documents(root, pastas, reader) {
  const porTipo = {}, errors = {}, byFolder = new Map(), adoptedFiles = new Map();
  const track = file => {
    const folder = path.dirname(file);
    if (!byFolder.has(folder)) byFolder.set(folder, new Set());
    byFolder.get(folder).add(file);
  };
  for (const [tipo, folder] of Object.entries(pastas)) {
    porTipo[tipo] = [];
    try {
      if (folder === null) continue;
      const dir = path.join(root, relative(folder));
      for (const entry of await reader.entries(dir)) {
        if (!DOCUMENTS.has(path.extname(entry.name).toLowerCase())) continue;
        const resolved = await reader.resolve(path.join(dir, entry.name));
        if (!resolved?.stat.isFile()) continue;
        track(resolved.file);
        if (!porTipo[tipo].includes(resolved.file)) porTipo[tipo].push(resolved.file);
      }
    } catch (e) { errors[tipo] = e.message; }
  }
  try {
    const adoptionFile = path.join(root, '.dk', 'adocoes.json');
    if (await reader.check(adoptionFile)) {
      let adopted = await reader.json(adoptionFile);
      if (object(adopted)) adopted = adopted.itens ?? adopted.adocoes;
      if (!Array.isArray(adopted) || adopted.length > LIMIT.items || adopted.some(i => !object(i))) throw new Error('adocoes.json deve conter uma lista de até 5000 objetos.');
      // Planeja por caminho real antes de abrir qualquer conteúdo para hash.
      for (const item of adopted) {
        if (!Object.hasOwn(pastas, item.tipo)) continue;
        try {
          if (!['adotado', 'validado', 'pendente'].includes(item.status || 'pendente')) throw new Error('Status de adoção inválido.');
          const resolved = await reader.resolve(adoptionPath(root, item.caminho));
          if (!resolved) continue;
          if (!resolved.stat.isFile()) throw new Error('Adoção deve ser arquivo regular.');
          const { file, stat } = resolved;
          track(file);
          if (!adoptedFiles.has(file)) adoptedFiles.set(file, { stat, items: [] });
          adoptedFiles.get(file).items.push(item);
          porTipo[item.tipo] = porTipo[item.tipo].filter(p => p !== file);
          if (['adotado', 'validado'].includes(item.status)) porTipo[item.tipo].push(file);
        } catch (e) { errors[item.tipo] = e.message; }
      }
    }
  } catch (e) { for (const tipo of Object.keys(pastas)) errors[tipo] = e.message; }
  const overFolder = file => byFolder.get(path.dirname(file)).size > LIMIT.documents;
  const folderError = 'Mais de 32 documentos em uma pasta de entregáveis.';
  for (const [tipo, files] of Object.entries(porTipo)) if (files.some(overFolder)) errors[tipo] = folderError;
  let hashBytes = 0;
  for (const [file, { stat, items }] of adoptedFiles) {
    if (overFolder(file)) { for (const item of items) errors[item.tipo] = folderError; continue; }
    const hashed = items.filter(i => i.sha256);
    if (!hashed.length) continue;
    try {
      if (stat.size > LIMIT.adoption) throw new Error(`Arquivo excede o limite de ${LIMIT.adoption} bytes: ${file}.`);
      if (hashBytes + stat.size > LIMIT.adoptionTotal) throw new Error('Hashes de adoções excedem o limite de 64 MiB por leitura.');
      // A reserva permanece consumida mesmo se a leitura falhar.
      hashBytes += stat.size;
      const bytes = await reader.bytes(file, Math.min(LIMIT.adoption, stat.size));
      if (bytes === null) throw new Error(`Adoção desapareceu: ${file}.`);
      const digest = createHash('sha256').update(bytes).digest('hex');
      for (const item of hashed) if (digest !== item.sha256) errors[item.tipo] = `SHA-256 divergente em ${item.caminho}.`;
    } catch (e) { for (const item of hashed) errors[item.tipo] = e.message; }
  }
  return { porTipo, errors };
}

async function deliverableText(root, pastas, reader = null, resolved = null) {
  if (!reader) { root = await fs.promises.realpath(root); reader = new Reader(root); }
  const docs = resolved || await documents(root, pastas, reader);
  const errors = ['requisitos', 'visao', 'ata'].map(t => docs.errors[t]).filter(Boolean);
  if (errors.length) throw new Error(errors.join('; '));
  const files = [...new Set(['requisitos', 'visao', 'ata'].flatMap(t => docs.porTipo[t] || []))];
  const partes = [];
  let bytes = 0;
  for (const file of files) {
    if (['.pdf', '.docx'].includes(path.extname(file).toLowerCase())) continue;
    const stat = await reader.check(file);
    if (!stat) throw new Error(`Documento desapareceu: ${file}.`);
    if (bytes + stat.size > LIMIT.text) throw new Error('Texto dos entregáveis excede o limite de 8 MiB.');
    const text = await reader.text(file, LIMIT.document);
    if (text === null) throw new Error(`Documento desapareceu: ${file}.`);
    bytes += Buffer.byteLength(text);
    partes.push(text);
  }
  return partes.join('\n');
}

const immediate = () => new Promise(resolve => setImmediate(resolve));
const wordAt = (text, offset) => {
  const c = text.charCodeAt(offset);
  return c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 95;
};
async function citedIds(text, ids) {
  if (ids.some(id => id.length > LIMIT.id)) throw new Error(`ID de requisito excede o limite de ${LIMIT.id} caracteres para D3.`);
  // Trie compacta: cada prefixo é comparado uma vez por ocorrência, sem 5000
  // buscas no corpus inteiro. O trabalho inclui todo rótulo, mesmo sem match.
  // As fronteiras são exatamente (?<![A-Za-z0-9_])ID(?![A-Za-z0-9_]).
  const roots = new Map(), found = new Set();
  let work = 0;
  for (const id of new Set(ids)) {
    let edges = roots, rest = id;
    while (rest) {
      const edge = edges.get(rest[0]);
      if (!edge) { edges.set(rest[0], { label: rest, id, children: new Map() }); break; }
      let common = 0;
      while (common < rest.length && common < edge.label.length && rest[common] === edge.label[common]) {
        common++;
        if (++work % 16384 === 0) await immediate();
      }
      if (common < edge.label.length) {
        const tail = { ...edge, label: edge.label.slice(common) };
        edge.label = edge.label.slice(0, common);
        edge.id = null;
        edge.children = new Map([[tail.label[0], tail]]);
      }
      rest = rest.slice(common);
      if (!rest) edge.id = id;
      edges = edge.children;
    }
    if (++work % 256 === 0) await immediate();
  }
  for (let start = 0; start < text.length; start++) {
    if (start % 16384 === 0) await immediate();
    if (wordAt(text, start - 1)) continue;
    let offset = start, edge = roots.get(text[start]);
    while (edge) {
      const { label } = edge;
      work += label.length;
      if (work >= 4096) { work = 0; await immediate(); }
      if (!text.startsWith(label, offset)) break;
      offset += label.length;
      if (edge.id && !wordAt(text, offset)) found.add(edge.id);
      edge = edge.children.get(text[offset]);
    }
  }
  return found;
}

function validateBase(base) {
  if (!object(base)) return ['prototipo: deve ser um objeto'];
  const errors = [], badPath = (value, field) => { try { relative(value); } catch { errors.push(`${field}: caminho relativo, sem absoluto nem ".."`); } };
  badPath(base.pasta, 'pasta');
  const ds = base.design_system;
  if (!object(ds)) errors.push('design_system: obrigatório, objeto');
  else {
    const mode = ds.modo ?? 'vendorizado';
    if (!['vendorizado', 'submodule'].includes(mode)) errors.push('design_system.modo: use vendorizado ou submodule');
    for (const key of ['pacote', 'versao']) if (!nonempty(ds[key])) errors.push(`design_system.${key}: obrigatório, texto`);
    badPath(ds.caminho, 'design_system.caminho');
    if (!Array.isArray(ds.carga) || !ds.carga.length) errors.push('design_system.carga: obrigatório, lista não vazia de nomes de arquivo');
    else ds.carga.forEach((p, i) => badPath(p, `design_system.carga[${i}]`));
    if (mode === 'submodule') {
      if (!nonempty(ds.repositorio) || /[\x00-\x1f]/.test(ds.repositorio)) errors.push('design_system.repositorio: obrigatório, URL do submódulo');
      if (typeof ds.commit !== 'string' || !/^([a-f0-9]{40}|[a-f0-9]{64})$/i.test(ds.commit)) errors.push('design_system.commit: obrigatório, SHA completo de 40 ou 64 caracteres');
      if (typeof ds.caminho === 'string' && (ds.caminho !== ds.caminho.trim() || /\\/.test(ds.caminho) || ds.caminho.split('/').some(p => ['', '.', '..'].includes(p)))) errors.push('design_system.caminho: submodule exige caminho canônico relativo');
    }
    if (ds.involucro !== undefined && (typeof ds.involucro !== 'string' || !/^\.[A-Za-z_][\w-]*$/.test(ds.involucro))) errors.push('design_system.involucro: uma classe, como ".tl"');
  }
  if (base.tokens_do_projeto !== undefined) {
    if (!Array.isArray(base.tokens_do_projeto)) errors.push('tokens_do_projeto: deve ser uma lista de caminhos');
    else base.tokens_do_projeto.forEach((p, i) => badPath(p, `tokens_do_projeto[${i}]`));
  }
  if (base.fontes !== undefined && (!Array.isArray(base.fontes) || base.fontes.some(f => typeof f !== 'string'))) errors.push('fontes: deve ser uma lista de textos');
  for (const key of ['gabarito', 'regras']) if (base[key] !== undefined && !object(base[key])) errors.push(`${key}: deve ser um objeto`);
  if (object(base.regras)) for (const [kind, fields] of [['exigido', ['arquivo', 'trecho']], ['proibido', ['padrao']]]) {
    const items = base.regras[kind];
    if (items === undefined) continue;
    if (!Array.isArray(items)) { errors.push(`regras.${kind}: deve ser uma lista`); continue; }
    items.forEach((item, i) => {
      const ref = `regras.${kind}[${i}]`;
      if (!object(item)) { errors.push(`${ref}: deve ser um objeto`); return; }
      for (const field of fields) if (typeof item[field] !== 'string' || !item[field]) errors.push(`${ref}.${field}: obrigatório, texto`);
      if (kind === 'exigido') badPath(item.arquivo, `${ref}.arquivo`);
      // São expressões Python; a sintaxe fica para dk prototipar --verificar.
      for (const field of ['em', 'motivo']) if (item[field] !== undefined && typeof item[field] !== 'string') errors.push(`${ref}.${field}: deve ser texto`);
    });
  }
  return errors;
}

function prototypeFolder(root, manifesto = {}, projetoJson = {}) {
  const base = projetoJson.prototipo;
  if (base !== undefined) {
    const errors = validateBase(base);
    if (errors.length) throw new Error(errors.join('; '));
    return path.join(root, relative(base.pasta));
  }
  if (manifesto.schema === 2 && manifesto.pastas !== undefined) {
    if (!object(manifesto.pastas) || manifesto.pastas.design === undefined) return null;
    return path.join(root, relative(manifesto.pastas.design), 'prototipo');
  }
  return path.join(root, DEFAULTS.design, 'prototipo');
}

async function prototypeFiles(folder, reader) {
  if (!folder) return [];
  const resolved = await reader.resolve(folder);
  if (!resolved) return [];
  if (resolved.stat.isDirectory()) reader.recursiveDirs.add(resolved.file);
  const files = [];
  let count = 0;
  async function walk(dir, depth) {
    for (const entry of await reader.entries(dir, LIMIT.prototype)) {
      if (PROTOTYPE_IGNORED.has(entry.name)) continue;
      if (++count > LIMIT.prototype) throw new Error('Protótipo excede o limite de 2000 entradas.');
      const file = path.join(dir, entry.name), stat = await reader.check(file);
      if (!stat) throw new Error('Protótipo mudou durante a leitura.');
      if (stat.isDirectory()) {
        if (depth >= LIMIT.depth) throw new Error('Protótipo excede a profundidade de 4.');
        await walk(file, depth + 1);
      } else if (stat.isFile() && /\.html?$/i.test(entry.name)) files.push(file);
    }
  }
  await walk(folder, 0);
  return files;
}

function criterion(id, estado, motivo, arquivo, regra, detalhes = []) {
  const def = DEFINITIONS.find(([, , cs]) => cs.some(c => c[0] === id));
  return { id, descricao: def[2].find(c => c[0] === id)[1], estado, motivo, fonte: { arquivo, regra }, detalhes: detalhes.slice(0, 8),
    fix: ['E1', 'E2'].includes(id) ? { kind: 'action', action: 'entender' } : { kind: 'skill', skill: `dk:dk-${def[0]}` }, aplica_se: true };
}
function stageSnapshot(root, values, metadata = {}) {
  const stages = [];
  for (const [id, nome, defs] of DEFINITIONS) {
    const criterios = defs.map(([id]) => values[id]).filter(Boolean);
    const estado = criterios.some(c => c.estado === 'indisponivel') ? 'indisponivel' : criterios.every(c => c.estado === 'concluido') ? 'concluido' : 'pendente';
    const previous = stages.at(-1);
    const liberada = !previous || previous.liberada && previous.estado === 'concluido';
    stages.push({ id, nome, skill: `dk:dk-${id}`, ordem: stages.length + 1, estado, liberada,
      bloqueio: liberada ? null : `Conclua a etapa ${previous.nome} para liberar ${nome}.`, criterios });
  }
  return { root, isDk: false, formato: 'ausente', esquema: 'ausente', kit: null, declarado: {}, computedAt: new Date().toISOString(), stages, errors: [], watching: false, ...metadata };
}

async function evaluateTracked(root, { kitPath } = {}) {
  if (typeof root !== 'string' || !root || root.length > 8192 || root.includes('\0')) throw new Error('Pasta do projeto inválida.');
  root = await fs.promises.realpath(root);
  const reader = new Reader(root), values = {}, errors = [];
  const tracked = { reader, kitReader: null };
  const finish = metadata => ({ snapshot: stageSnapshot(root, values, { errors: [...new Set(errors)], ...metadata }), ...tracked });
  const set = (id, state, reason, file = '', rule = '', details = []) => { values[id] = criterion(id, state, reason, file, rule, details); if (state === 'indisponivel') errors.push(`${id}: ${reason}`); };
  const all = (state, reason) => { for (const [, , cs] of DEFINITIONS) for (const [id] of cs) set(id, state, reason, 'projeto.yml', 'Leitura do projeto'); };
  let manifest = {}, config = {}, configError = null, formato = 'ausente';
  try {
    const yaml = await reader.text(path.join(root, 'projeto.yml'), LIMIT.yaml);
    const configStat = await reader.check(path.join(root, '.dk', 'projeto.json'));
    if (yaml === null && !configStat) { all('pendente', 'Esta pasta não contém um projeto DK.'); return finish({}); }
    if (yaml !== null) {
      manifest = YAML.parse(yaml, { maxAliasCount: 50, uniqueKeys: true, merge: true });
      validateYamlData(manifest);
      if (!object(manifest)) throw new Error('projeto.yml deve conter um objeto.');
      if (manifest.schema !== undefined && manifest.schema !== 1 && manifest.schema !== 2 && !object(manifest.schema)) throw new Error('schema não suportado no projeto.yml.');
      formato = manifest.schema === 2 ? 'v2' : 'project' in manifest ? 'legacyEN' : 'v1-pt';
    }
  } catch (e) { all('indisponivel', e.message); return finish({ isDk: true, formato }); }
  try {
    const file = path.join(root, '.dk', 'projeto.json');
    config = await reader.check(file) ? await reader.json(file) : {};
    if (!object(config)) throw new Error('.dk/projeto.json deve conter um objeto.');
  } catch (e) { configError = e.message; config = {}; }
  const declarado = {};
  for (const [key, old] of [['fase_atual', 'current_phase'], ['fases_concluidas', 'completed_phases']]) {
    const value = manifest[key] ?? manifest.project?.[old];
    if (value !== undefined) declarado[key] = value;
  }
  let registry, contractError = null;
  try {
    validateManifest(manifest, config, configError);
    registry = await resolveRegistry(root, manifest, reader, config);
  } catch (e) {
    contractError = e.message;
    registry = { esquema: manifest.schema === 2 ? 'canonico' : 'ausente', registros: Object.fromEntries(Object.keys(FILES).map(name => [name, { arquivo: null, error: contractError }])) };
  }
  const records = {};
  for (const [name, source] of Object.entries(registry.registros)) {
    try {
      if (source.error) throw new Error(source.error);
      const items = source.arquivo ? await readRegistry(source.arquivo, reader) : [];
      if (['regras', 'requisitos'].includes(name) && items.some(i => !nonempty(i.id))) throw new Error('Cada registro deve ter id em texto não vazio.');
      if (name === 'rastreabilidade' && items.some(i => !nonempty(i.from) || !nonempty(i.to) || !nonempty(i.relation))) throw new Error('Relação exige from, to e relation em texto.');
      for (const item of items) {
        if (!['regras', 'requisitos', 'rastreabilidade'].includes(name)) item.id = String(item.id || name);
        if ('sources' in item && !('fonte' in item)) item.fonte = Array.isArray(item.sources) ? item.sources.join(', ') : item.sources;
      }
      records[name] = { ...source, items };
    } catch (e) { records[name] = { ...source, items: [], error: e.message }; }
  }
  const data = Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.items]));
  const fileOf = names => names.map(n => records[n].arquivo ? path.relative(root, records[n].arquivo) : `registros.${n}`).join(' + ');
  function dependent(id, names, rule) {
    const bad = names.find(n => records[n].error);
    if (bad) { set(id, 'indisponivel', records[bad].error, fileOf(names), rule); return true; }
    const missing = names.filter(n => records[n].motivo);
    if (missing.length) { set(id, 'pendente', missing.map(n => records[n].motivo).join('; '), fileOf(names), rule); return true; }
    return false;
  }
  for (const [id, name] of [['L1', 'regras'], ['L2', 'requisitos']]) {
    if (!dependent(id, [name], 'Lista de objetos com id; ao menos um item')) set(id, data[name].length ? 'concluido' : 'pendente', data[name].length ? `${data[name].length} itens registrados.` : records[name].motivo || 'Registro ausente ou vazio.', fileOf([name]), 'Lista de objetos com id; ao menos um item');
  }
  function needsRegisters(id, rule, names = ['regras', 'requisitos']) {
    if (dependent(id, names, rule)) return true;
    const deps = names.filter(n => ['regras', 'requisitos'].includes(n));
    if (deps.some(n => !data[n].length)) { set(id, 'pendente', 'Depende de L1/L2: registros ausentes ou vazios.', fileOf(names), rule); return true; }
    return false;
  }
  const items = [...data.requisitos, ...data.regras];
  if (!needsRegisters('L3', 'Procedência não vazia em cada requisito e regra')) {
    const missing = items.filter(i => !(registry.esquema === 'canonico' ? i.sources?.length : Array.isArray(i.fonte) ? i.fonte.length : object(i.fonte) ? i.fonte.arquivo?.trim() || i.fonte.citacao?.trim() : i.fonte?.trim())).map(i => i.id);
    set('L3', missing.length ? 'pendente' : 'concluido', missing.length ? 'Itens sem procedência.' : 'Todos os itens têm procedência.', fileOf(['regras', 'requisitos']), registry.esquema === 'canonico' ? 'sources não vazio' : 'fonte não vazia', missing);
  }
  let kit = null;
  const checklistFile = kitPath ? path.join(kitPath, 'templates', 'checklist-discovery.json') : '';
  const blockedL4 = dependent('L4', ['regras', 'requisitos', 'pendencias', 'decisoes'], 'lacunas.py: CRITICA em AUSENTE ou PENDENTE');
  try {
    if (!kitPath) throw new Error('Plugin DK não instalado; checklist do kit indisponível.');
    const kitRoot = await fs.promises.realpath(kitPath), kr = new Reader(kitRoot);
    tracked.kitReader = kr;
    const cli = await kr.check(path.join(kitRoot, 'cli', 'dk'));
    if (!cli?.isFile()) throw new Error('Kit ausente ou inválido: cli/dk não encontrado.');
    const checklist = await kr.json(path.join(kitRoot, 'templates', 'checklist-discovery.json'), LIMIT.checklist);
    if (!checklist) throw new Error('Checklist do kit ausente.');
    kit = { path: kitRoot };
    if (!blockedL4) {
      const found = lacunas(data, checklist);
      const critical = found.filter(i => ['CRITICA', 'CRÍTICA'].includes(i.prioridade) && ['AUSENTE', 'PENDENTE'].includes(i.status));
      const empty = !data.regras.length && !data.requisitos.length;
      set('L4', critical.length || empty ? 'pendente' : 'concluido', empty ? 'Registros vazios.' : critical.length ? 'Lacunas críticas sem resposta.' : 'Nenhuma lacuna crítica ausente ou pendente.', checklistFile, 'lacunas.py: CRITICA em AUSENTE ou PENDENTE', critical);
    }
  } catch (e) { if (!blockedL4) set('L4', 'indisponivel', e.message, checklistFile, 'Checklist de discovery do kit'); }
  if (!needsRegisters('E1', 'Referências em sources ∈ fontes ∪ evidências', ['regras', 'requisitos', 'fontes', 'evidencias'])) {
    if (registry.esquema !== 'canonico' || !data.fontes.length && !data.evidencias.length) set('E1', 'pendente', 'O registro não oferece procedência.', fileOf(['fontes', 'evidencias']), 'sources ∈ fontes ∪ evidências');
    else {
      const ids = new Set([...data.fontes, ...data.evidencias].map(i => i.id));
      const broken = [...new Set(items.flatMap(i => (typeof i.sources === 'string' ? [i.sources] : i.sources || []).filter(ref => !ids.has(ref)).map(ref => `${i.id}→${ref}`)))].sort();
      set('E1', broken.length ? 'pendente' : 'concluido', broken.length ? 'Referências de procedência inexistentes.' : 'Todas as referências existem.', fileOf(['regras', 'requisitos', 'fontes', 'evidencias']), 'sources ∈ fontes ∪ evidências', broken);
    }
  }
  if (!needsRegisters('E2', 'cobertura.py: requisito↔regra', ['regras', 'requisitos', ...(registry.esquema === 'canonico' ? ['rastreabilidade'] : [])])) {
    const edges = data.rastreabilidade.filter(i => i.relation === 'implementa_regra');
    if (registry.esquema === 'canonico' && !edges.length) set('E2', 'pendente', 'O registro não oferece requisito↔regra (sem aresta implementa_regra).', fileOf(['rastreabilidade']), 'Sinal implementa_regra necessário');
    else {
      const covered = new Set(registry.esquema === 'canonico' ? edges.map(i => i.to) : data.requisitos.map(i => i.deriva_de));
      const linked = new Set(edges.map(i => i.from)), ids = new Set(data.regras.map(i => i.id));
      const orphan = data.regras.filter(i => !covered.has(i.id)).map(i => i.id);
      const without = data.requisitos.filter(i => registry.esquema === 'canonico' ? ['RF', 'FUNCIONAL'].includes(String(i.type ?? 'RF').toUpperCase()) && !linked.has(i.id) : !ids.has(i.deriva_de)).map(i => i.id);
      set('E2', orphan.length || without.length ? 'pendente' : 'concluido', orphan.length || without.length ? 'Regras ou requisitos sem vínculo.' : 'Todas as ligações estão cobertas.', fileOf(['regras', 'requisitos', ...(registry.esquema === 'canonico' ? ['rastreabilidade'] : [])]), registry.esquema === 'canonico' ? 'implementa_regra; somente RF|FUNCIONAL exige aresta' : 'deriva_de aponta para regra existente', [...orphan, ...without]);
    }
  }
  if (!needsRegisters('E3', 'Sem obrigação documental resolvida só por relato', ['regras', 'requisitos', 'pendencias'])) {
    const pending = data.pendencias.filter(p => p.status === 'resolvida_por_relato' && truthy(p.pendencia_de_prova) && /escrita|escrito|documental/i.test(String(p.enunciado || ''))).map(p => p.id);
    set('E3', pending.length ? 'pendente' : 'concluido', pending.length ? 'Confirmação documental ainda pendente.' : data.pendencias.length ? 'Nenhuma prova documental resolvida só por relato.' : 'Sem pendências registradas.', fileOf(['pendencias']), 'resolvida_por_relato + pendencia_de_prova + escrita|escrito|documental', pending);
  }
  try {
    if (contractError) throw new Error(contractError);
    const folders = deliverableFolders(manifest), docs = await documents(root, folders, reader);
    for (const [id, tipo] of [['D1', 'requisitos'], ['D2', 'visao'], ['D4', 'checklist-dod']]) {
      if (id === 'D4' && !configError && config.contexto !== 'portal') continue;
      const error = docs.errors[tipo] || (id === 'D4' ? configError : null);
      set(id, error ? 'indisponivel' : docs.porTipo[tipo].length ? 'concluido' : 'pendente', error || (docs.porTipo[tipo].length ? 'Documento presente.' : folders[tipo] === null ? `Declare pastas.${tipo === 'checklist-dod' ? 'entregaveis' : 'levantamento'}.` : `Nenhum documento em ${folders[tipo]}.`), folders[tipo] || 'projeto.yml', 'Documento regular canônico ou adoção válida; SHA-256 se declarado');
    }
    // Lê os documentos mesmo quando L2 falta: falhas não ficam escondidas por dependências.
    try {
      const text = await deliverableText(root, folders, reader, docs);
      if (!needsRegisters('D3', 'ID literal com limites [A-Za-z0-9_]', ['requisitos'])) {
        const cited = await citedIds(text, data.requisitos.map(i => i.id));
        const missing = data.requisitos.filter(i => !cited.has(i.id)).map(i => i.id);
        set('D3', !text.trim() || missing.length ? 'pendente' : 'concluido', !text.trim() ? 'Sem texto legível nos entregáveis (PDF/DOCX não são lidos).' : missing.length ? 'Requisitos não citados nos entregáveis.' : 'Todo requisito aparece em algum entregável.', ['requisitos', 'visao', 'ata'].map(t => folders[t]).filter(Boolean).join(' + '), 'ID literal com limites [A-Za-z0-9_]; PDF/DOCX excluídos', missing);
      }
    } catch (e) { set('D3', 'indisponivel', e.message, 'entregáveis', 'Texto ≤2 MiB/arquivo e ≤8 MiB total'); }
  } catch (e) { for (const id of ['D1', 'D2', 'D3', ...(config.contexto === 'portal' || configError ? ['D4'] : [])]) set(id, 'indisponivel', e.message, 'projeto.yml', 'Pastas dos entregáveis'); }
  let folder;
  try {
    if (configError) throw new Error(configError);
    if (config.prototipo === undefined && contractError) throw new Error(contractError);
    folder = prototypeFolder(root, manifest, config);
    const files = await prototypeFiles(folder, reader);
    set('P1', files.length ? 'concluido' : 'pendente', files.length ? `${files.length} telas HTML encontradas.` : folder ? 'Pasta do protótipo sem telas HTML.' : 'Declare pastas.design.', folder ? path.relative(root, folder) : 'projeto.yml', 'HTML/HTM; profundidade ≤4; ≤2000 entradas', files.map(f => path.relative(root, f)));
  } catch (e) { set('P1', 'indisponivel', e.message, '.dk/projeto.json', 'Base e pasta do protótipo válidas'); }
  try {
    if (configError) throw new Error(configError);
    if (config.prototipo === undefined) set('P2', 'pendente', 'Base do protótipo não declarada.', '.dk/projeto.json', 'prototipo.design_system declarado');
    else {
      const errors = validateBase(config.prototipo);
      if (errors.length) throw new Error(errors.join('; '));
      const ds = config.prototipo.design_system, dir = path.join(root, relative(ds.caminho)), stat = await reader.check(dir);
      if (!stat?.isDirectory()) throw new Error('design_system.caminho: diretório não encontrado.');
      for (const load of ds.carga) {
        const file = path.join(dir, relative(load)), stat = await reader.check(file);
        if (!stat?.isFile()) throw new Error(`design_system.carga: arquivo não encontrado: ${load}.`);
      }
      set('P2', 'concluido', 'Base declarada e design system presente.', '.dk/projeto.json', 'base_prototipo.validar; carga existente; critérios estruturais', ds.modo === 'submodule' ? ['Submodule: somente existência; verificação Git por dk prototipar --verificar.'] : []);
    }
  } catch (e) { set('P2', 'indisponivel', e.message, '.dk/projeto.json', 'base_prototipo.validar e existência da carga'); }
  return finish({ isDk: true, formato, esquema: registry.esquema, kit, declarado });
}

async function evaluate(root, options = {}) { return (await evaluateTracked(root, options)).snapshot; }

class Stages {
  constructor(onChange) { this.onChange = onChange; this.activeRoot = null; this.cache = null; this.watchers = []; this.timer = null; this.epoch = 0; this.pending = null; }
  _stop() { clearTimeout(this.timer); this.timer = null; for (const watcher of this.watchers) watcher.close(); this.watchers = []; }
  close() { this.epoch++; this._stop(); this.activeRoot = null; this.cache = null; this.pending = null; }
  closeProject(root) { if (path.resolve(root) === this.activeRoot) this.close(); }
  async _unchanged(cache) {
    for (const [file, stamp] of cache.stamps) {
      let stat;
      try { stat = await fs.promises.lstat(file); } catch (e) { if (e.code !== 'ENOENT') return false; }
      if (signature(stat) !== stamp) return false;
    }
    return true;
  }
  async read(root, { kitPath = null, refresh = false } = {}) {
    if (typeof root !== 'string' || !root || root.length > 8192 || root.includes('\0')) throw new Error('Pasta do projeto inválida.');
    root = path.resolve(root);
    if (this.activeRoot !== root) { this.close(); this.activeRoot = root; }
    const epoch = this.epoch;
    const current = () => {
      if (epoch !== this.epoch || root !== this.activeRoot) throw new Error('Projeto alterado durante a leitura das etapas.');
    };
    const operation = async () => {
      const cache = this.cache;
      if (!refresh && cache && cache.kitPath === kitPath && await this._unchanged(cache)) {
        current();
        if (this.cache === cache) return cache.snapshot;
      }
      current();
      const result = await evaluateTracked(root, { kitPath });
      current();
      this._stop();
      const stamps = new Map([...result.reader.stamps, ...(result.kitReader?.stamps || [])]);
      this.cache = { snapshot: result.snapshot, stamps, kitPath };
      await this._watch(result.reader, root, epoch);
      current();
      return result.snapshot;
    };
    // Serializa leituras da mesma raiz; a geração impede ressuscitar cache após close/troca.
    const previous = this.pending;
    const request = (async () => { if (previous) await previous.catch(() => {}); if (epoch !== this.epoch) throw new Error('Projeto alterado durante a leitura das etapas.'); return operation(); })();
    this.pending = request;
    try { return await request; } finally { if (this.pending === request) this.pending = null; }
  }
  async _watch(reader, root, epoch) {
    if (typeof this.onChange !== 'function') return;
    const dirs = new Map(), recursive = reader.recursiveDirs;
    try {
      for (const file of [...reader.stamps.keys()]) {
        if (!inside(reader.root, file)) continue;
        let resolved;
        // Um caminho recusado afeta seu critério; observe o ancestral seguro.
        try { resolved = await reader.resolve(file); } catch { resolved = null; }
        let dir = resolved?.stat.isDirectory() ? resolved.file : path.dirname(resolved?.file || file);
        while (true) {
          try { const parent = await reader.resolve(dir); if (parent?.stat.isDirectory()) { dir = parent.file; break; } } catch { /* suba até um ancestral seguro */ }
          if (dir === reader.root) throw new Error('Raiz indisponível para monitoramento.');
          dir = path.dirname(dir);
        }
        if ([...recursive].some(base => inside(base, dir))) continue;
        if (!dirs.has(dir)) dirs.set(dir, new Set());
        const child = path.relative(dir, file).split(path.sep)[0];
        if (child) dirs.get(dir).add(child);
      }
      for (const dir of recursive) dirs.set(dir, new Set());
      if (dirs.size > LIMIT.watchers) throw new Error('Limite de 16 watchers por projeto.');
      for (const [dir, names] of dirs) {
        if (epoch !== this.epoch) return;
        const watcher = fs.watch(dir, { persistent: false, recursive: recursive.has(dir) }, async (_event, name) => {
          if (epoch !== this.epoch || this.activeRoot !== root) return;
          if (name && recursive.has(dir)) {
            const rel = String(name), file = path.join(dir, rel);
            if (rel.split(/[\\/]/).some(part => PROTOTYPE_IGNORED.has(part))) return;
            // Diretórios já percorridos incluem os removidos/renomeados. Para
            // novos diretórios, confira o tipo sem bloquear o event loop.
            if (!/\.html?$/i.test(rel) && !reader.scannedDirs.has(file)) {
              try { if (!(await fs.promises.stat(file)).isDirectory()) return; }
              catch { return; }
            }
          } else if (name && !reader.scannedDirs.has(dir) && names.size && !names.has(String(name))) return;
          if (epoch !== this.epoch || this.activeRoot !== root) return;
          this.cache = null;
          clearTimeout(this.timer);
          this.timer = setTimeout(() => { this.timer = null; if (epoch === this.epoch && this.activeRoot === root) this.onChange({ path: root }); }, 400);
        });
        watcher.on('error', () => { if (epoch === this.epoch) this._watchFailure(); });
        this.watchers.push(watcher);
      }
      // FSEvents inicializa em outra thread e pode recusar a instalação por
      // evento (EMFILE), depois de fs.watch retornar. Dê a esse erro inicial
      // uma janela curta antes de anunciar watching=true.
      await new Promise(resolve => setTimeout(resolve, 20));
      if (epoch !== this.epoch) return;
      if (this.cache) this.cache.snapshot.watching = this.watchers.length > 0;
    } catch { if (epoch === this.epoch) this._watchFailure(); }
  }
  _watchFailure() {
    this._stop();
    if (this.cache) { this.cache.snapshot.watching = false; this.cache.snapshot.errors.push('Monitoramento de etapas indisponível; use Recarregar.'); }
  }
}

module.exports = { Stages, resolveRegistry, readRegistry, lacunas, deliverableText, prototypeFolder, evaluate };
