const path = require('node:path');

const KiB = 1024;
const TOTAL_LIMIT = 96 * KiB;
const FILE_LIMIT = 200;
const LAYERS = [
  { id: 'guia_dk', fonte: 'dock-tools/agents/AGENTS.md', limit: 32 * KiB },
  { id: 'skill_ativa', fonte: 'catalog skills', limit: 24 * KiB },
  { id: 'design_system', fonte: 'catalog design-systems DESIGN.md', limit: 24 * KiB },
  { id: 'craft', fonte: 'craft', limit: 0 },
  { id: 'instrucoes_projeto', fonte: 'AGENTS.md', limit: 16 * KiB },
  { id: 'etapa_ativa', fonte: 'stages.read', limit: 4 * KiB },
  { id: 'arquivos', fonte: 'arquivos selecionados', limit: 8 * KiB },
];

function projectRoot(root) {
  if (typeof root !== 'string' || /[\x00-\x1f\x7f]/.test(root)) throw new TypeError('Raiz do projeto inválida.');
  const api = path.win32.isAbsolute(root) && !path.posix.isAbsolute(root) ? path.win32 : path.posix;
  if (!api.isAbsolute(root)) throw new TypeError('A raiz do projeto deve ser absoluta.');
  // Uma raiz Windows sem unidade/share faria path.resolve consultar o cwd.
  if (api === path.win32 && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(root)) throw new TypeError('A raiz Windows deve conter unidade ou share UNC.');
  return { root: api.normalize(root), api };
}

function relativePath(value, boundary) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) return null;
  const portable = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(value) || /^[a-z]:/i.test(value) || portable.split('/').includes('..')) return null;
  const normalized = path.posix.normalize(portable);
  if (normalized === '.') return null;
  const relative = boundary.api.relative(boundary.root, boundary.api.resolve(boundary.root, normalized));
  if (boundary.api.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${boundary.api.sep}`)) return null;
  return normalized;
}

function marker(id, bytes, original) { return `\n[camada ${id} truncada: ${bytes} de ${original} bytes]`; }

// Os limites incluem o marcador. Para arquivos, só preserva caminhos inteiros.
function fit(text, limit, id, original = Buffer.byteLength(text, 'utf8'), force = false, lines = false) {
  const buffer = Buffer.from(text, 'utf8');
  if (!force && buffer.length <= limit) return { text, bytes: buffer.length, bytesOriginais: original, truncado: false };
  if (Buffer.byteLength(marker(id, 0, original), 'utf8') > limit) throw new RangeError('Limite insuficiente para o marcador de truncamento.');
  function boundary(size) {
    let end = Math.min(size, buffer.length);
    while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
    if (lines && end < buffer.length) end = Math.max(0, buffer.lastIndexOf(10, end));
    return end;
  }
  let low = 0, high = Math.min(buffer.length, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2), end = boundary(middle);
    if (end + Buffer.byteLength(marker(id, end, original), 'utf8') <= limit) low = middle;
    else high = middle - 1;
  }
  const end = boundary(low), result = buffer.subarray(0, end).toString('utf8') + marker(id, end, original);
  return { text: result, bytes: Buffer.byteLength(result, 'utf8'), bytesOriginais: original, truncado: true };
}

/** Retorna texto limitado em bytes, incluindo o marcador; id padrão: "texto".
 * Se o marcador completo não couber, lança RangeError, sem ocultar o corte.
 */
function truncate(text, limit, id = 'texto') {
  if (typeof text !== 'string') throw new TypeError('Texto deve ser uma string.');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Limite de bytes inválido.');
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(id)) throw new TypeError('Identificador de camada inválido.');
  return fit(text, limit, id).text;
}

function header(camadas) {
  const list = predicate => camadas.filter(predicate).map(item => item.id).join(', ') || 'nenhuma';
  return '# System prompt — SEA Dock\n' +
    `Presentes: ${list(item => !item.ausente)}\n` +
    `Ausentes: ${list(item => item.ausente)}\n` +
    `Truncadas: ${list(item => item.truncado)}\n`;
}

function prepare(definition, input, root) {
  const source = typeof input === 'string' ? { text: input } : Array.isArray(input) ? { caminhos: input } : input;
  const metadata = { id: definition.id, fonte: definition.fonte, bytes: 0, bytesOriginais: 0, truncado: false, ausente: true };
  const absent = motivo => ({ metadata: { ...metadata, motivo }, text: '', force: false });
  if (definition.id === 'craft') return absent('Fora do escopo de M2.');
  if (!source || typeof source !== 'object') return absent('Fonte não fornecida.');
  if (source.fonte !== undefined) {
    // "fonte" é um rótulo relativo ou identificador de catálogo, nunca um
    // caminho absoluto. Não reproduz o caminho recusado nem no preview.
    if (typeof source.fonte !== 'string' || Buffer.byteLength(source.fonte, 'utf8') > KiB || !relativePath(source.fonte, root)) {
      metadata.fonte = null;
      return absent('Caminho da fonte recusado: use caminho relativo dentro da raiz, sem .. ou controles.');
    }
    metadata.fonte = source.fonte;
  }
  if (source.autorizado === false) return absent('Fonte não autorizada pelo chamador.');
  if (source.ausente === true) return absent(typeof source.motivo === 'string' ? source.motivo : 'Fonte ausente.');
  let text = source.text, original, force = false;
  if (definition.id === 'arquivos') {
    if (!Array.isArray(source.caminhos) || !source.caminhos.length) return absent('Nenhum arquivo selecionado.');
    const paths = source.caminhos.map(file => relativePath(file, root));
    // Recusa atômica: um caminho inválido torna a camada ausente com motivo.
    if (paths.includes(null)) return absent('Lista de arquivos recusada: use caminhos relativos dentro da raiz, sem .. ou controles.');
    original = Buffer.byteLength(paths.join('\n'), 'utf8');
    text = paths.slice(0, FILE_LIMIT).join('\n');
    force = paths.length > FILE_LIMIT;
  }
  if (typeof text !== 'string' || !text.length) return absent('Fonte sem texto.');
  metadata.ausente = false;
  metadata.bytesOriginais = original ?? Buffer.byteLength(text, 'utf8');
  return { metadata, text, force };
}

const section = id => `\n\n## ${id}\n\n`;

/** Compositor puro: nenhuma leitura, escrita, consulta de ambiente ou realpath.
 * camadas: objeto por id ou lista de {id, fonte?, text?, ausente?, motivo?,
 * autorizado?}; strings são atalho para {text}. A camada arquivos recebe
 * {caminhos: string[]} (ou diretamente string[]), SEM conteúdo de arquivos.
 * O chamador verifica autorização, arquivos regulares, symlinks e realpaths
 * ANTES de fornecer as fontes; aqui a contenção é apenas lexical.
 * bytes conta o corpo emitido, incluindo marcador; totalBytes inclui também
 * cabeçalho e separadores. bytesOriginais mede o texto recebido antes do corte.
 */
function compose({ root, camadas = {} }) {
  const boundary = projectRoot(root);
  let sources = camadas;
  if (Array.isArray(camadas)) {
    sources = Object.create(null);
    for (const source of camadas) {
      if (!source || !LAYERS.some(layer => layer.id === source.id)) continue;
      if (Object.hasOwn(sources, source.id)) throw new TypeError('Camada duplicada.');
      sources[source.id] = source;
    }
  }
  if (!sources || typeof sources !== 'object') throw new TypeError('Camadas inválidas.');
  const layers = LAYERS.map(definition => prepare(definition, Object.hasOwn(sources, definition.id) ? sources[definition.id] : null, boundary));
  const present = layers.filter(layer => !layer.metadata.ausente);
  // Reserva o maior cabeçalho possível; os limites incluem os marcadores.
  const headerBudget = Buffer.byteLength(header(layers.map(({ metadata }) => ({ ...metadata, truncado: !metadata.ausente }))), 'utf8');
  const minima = layers.map(({ metadata }) => metadata.ausente ? 0 : Buffer.byteLength(marker(metadata.id, 0, metadata.bytesOriginais), 'utf8'));
  const bodyBudget = TOTAL_LIMIT - headerBudget - present.reduce((sum, layer) => sum + Buffer.byteLength(section(layer.metadata.id), 'utf8'), 0);
  const results = layers.map((layer, index) => layer.metadata.ausente ? null : fit(layer.text, LAYERS[index].limit, layer.metadata.id, layer.metadata.bytesOriginais, layer.force, layer.metadata.id === 'arquivos'));
  let excess = results.reduce((sum, result) => sum + (result?.bytes ?? 0), 0) - bodyBudget;
  // Preserva primeiro etapa_ativa (4 KiB) e arquivos (8 KiB). O excedente
  // sai das camadas grandes em prioridade inversa: design_system,
  // skill_ativa, instrucoes_projeto, guia_dk, sem mudar a ordem de apresentação.
  for (const id of ['design_system', 'skill_ativa', 'instrucoes_projeto', 'guia_dk']) {
    if (excess <= 0) break;
    const index = LAYERS.findIndex(layer => layer.id === id), layer = layers[index], result = results[index];
    if (!result || result.bytes <= minima[index]) continue;
    const limit = Math.max(minima[index], result.bytes - excess);
    results[index] = fit(layer.text, limit, id, layer.metadata.bytesOriginais, layer.force);
    excess -= result.bytes - results[index].bytes;
  }
  const bodies = [];
  for (const [index, layer] of layers.entries()) {
    if (layer.metadata.ausente) continue;
    const result = results[index];
    Object.assign(layer.metadata, { bytes: result.bytes, truncado: result.truncado });
    bodies.push(section(layer.metadata.id) + result.text);
  }
  const metadata = layers.map(layer => layer.metadata), text = header(metadata) + bodies.join('');
  return { text, camadas: metadata, totalBytes: Buffer.byteLength(text, 'utf8') };
}

module.exports = { compose, truncate, header };
