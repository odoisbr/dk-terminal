const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 4 * 1024 * 1024;
const IMAGE_TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' });

function resolveFile(root, relative) {
  if (typeof root !== 'string' || typeof relative !== 'string' || !relative || relative.length > 8192 || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Caminho de arquivo inválido.');
  const base = fs.realpathSync(root);
  if (!fs.statSync(base).isDirectory()) throw new Error('A raiz do projeto não é uma pasta.');
  const contains = target => { const rel = path.relative(base, target); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  const lexical = path.resolve(base, relative);
  if (!contains(lexical)) throw new Error('O arquivo está fora do projeto selecionado.');
  const absolute = fs.realpathSync(lexical);
  if (!contains(absolute)) throw new Error('O arquivo está fora do projeto selecionado.');
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error('Selecione um arquivo para abrir no editor.');
  return { base, absolute, relative, stat };
}
const revision = data => createHash('sha256').update(data).digest('hex');
function readBounded(file, limit) {
  const descriptor = fs.openSync(file.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit) return null;
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (!count) return buffer.subarray(0, offset);
      offset += count;
    }
    throw new Error('O arquivo mudou durante a leitura. Tente abri-lo novamente.');
  } finally { fs.closeSync(descriptor); }
}
function decodeText(data) {
  if (data.includes(0)) return null;
  const bom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? data.subarray(3) : data);
    const crlf = decoded.includes('\r\n');
    const lf = /(^|[^\r])\n/.test(decoded);
    return { content: decoded.replace(/\r\n/g, '\n'), bom, newline: crlf ? '\r\n' : '\n', eol: crlf ? (lf ? 'mixed' : 'crlf') : (lf ? 'lf' : 'none'), loneCR: /\r(?!\n)/.test(decoded) };
  } catch { return null; }
}
function description(file, data, override = {}) {
  let writable = (file.stat.mode & 0o222) !== 0;
  try { fs.accessSync(file.absolute, fs.constants.W_OK); } catch { writable = false; }
  return { path: file.absolute, relative: file.relative, name: path.basename(file.relative), size: data?.length ?? file.stat.size, readOnly: !writable, revision: data ? revision(data) : null, ...override };
}
function readProjectFile(root, relative) {
  const file = resolveFile(root, relative), mime = IMAGE_TYPES[path.extname(relative).toLowerCase()];
  if (mime) {
    if (file.stat.size > IMAGE_LIMIT) return description(file, null, { kind: 'binary', readOnly: true, reason: 'Esta imagem excede o limite de visualização de 4 MB.' });
    const data = readBounded(file, IMAGE_LIMIT);
    if (!data) return description(file, null, { kind: 'binary', readOnly: true, reason: 'Esta imagem excede o limite de visualização de 4 MB.' });
    return description(file, data, { kind: 'image', readOnly: true, mime, dataUrl: `data:${mime};base64,${data.toString('base64')}` });
  }
  if (file.stat.size > TEXT_LIMIT) return description(file, null, { kind: 'binary', readOnly: true, reason: 'Este arquivo excede o limite de edição de 2 MB.' });
  const data = readBounded(file, TEXT_LIMIT);
  if (!data) return description(file, null, { kind: 'binary', readOnly: true, reason: 'Este arquivo excede o limite de edição de 2 MB.' });
  const text = decodeText(data);
  if (!text) return description(file, data, { kind: 'binary', readOnly: true, reason: 'Este formato binário ou codificação não pode ser editado como UTF-8.' });
  return description(file, data, { kind: 'text', ...text });
}
function conflict() { const error = new Error('O arquivo foi alterado fora do DK. Suas alterações foram mantidas no editor; recarregue o arquivo antes de tentar salvar novamente.'); error.code = 'FILE_CONFLICT'; return error; }
function writeAtomic(root, relative, file, data, expectedRevision) {
  const temporary = path.join(path.dirname(file.absolute), `.${path.basename(file.absolute)}.dk-terminal-${process.pid}-${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, file.stat.mode & 0o7777);
    fs.writeFileSync(descriptor, data);
    fs.fchmodSync(descriptor, file.stat.mode & 0o7777);
    fs.fsyncSync(descriptor);
    const opened = descriptor; descriptor = undefined; fs.closeSync(opened);
    // Recheck after preparing the replacement, before committing it.
    const current = resolveFile(root, relative);
    const latest = current.absolute === file.absolute ? readBounded(current, TEXT_LIMIT) : null;
    if (!latest || revision(latest) !== expectedRevision) throw conflict();
    fs.renameSync(temporary, file.absolute);
  } finally {
    try { if (descriptor !== undefined) fs.closeSync(descriptor); }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}
function saveProjectFile(root, relative, text, expectedRevision) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > TEXT_LIMIT || typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error('Conteúdo ou revisão de arquivo inválida.');
  const file = resolveFile(root, relative);
  if (file.stat.size > TEXT_LIMIT) throw new Error('O arquivo excede o limite de edição de 2 MB.');
  fs.accessSync(file.absolute, fs.constants.W_OK);
  if ((file.stat.mode & 0o222) === 0) throw new Error('Este arquivo é somente leitura.');
  const original = readBounded(file, TEXT_LIMIT);
  if (!original || revision(original) !== expectedRevision) throw conflict();
  const decoded = decodeText(original);
  if (!decoded || IMAGE_TYPES[path.extname(relative).toLowerCase()]) throw new Error('Este arquivo está disponível somente para visualização.');
  let output = text.replace(/\r\n/g, '\n');
  if (decoded.newline === '\r\n') output = output.replace(/\n/g, '\r\n');
  const data = Buffer.from((decoded.bom ? '\ufeff' : '') + output, 'utf8');
  if (data.length > TEXT_LIMIT) throw new Error('O conteúdo excede o limite de edição de 2 MB.');
  writeAtomic(root, relative, file, data, expectedRevision);
  return description(file, data, { kind: 'text', content: text.replace(/\r\n/g, '\n'), bom: decoded.bom, newline: decoded.newline });
}
function saveProjectBytes(root, relative, bytes, expectedRevision) {
  if (!Buffer.isBuffer(bytes) || bytes.length > TEXT_LIMIT || typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error('Conteúdo ou revisão de arquivo inválida.');
  const file = resolveFile(root, relative);
  if (file.stat.size > TEXT_LIMIT) throw new Error('O arquivo excede o limite de edição de 2 MB.');
  fs.accessSync(file.absolute, fs.constants.W_OK);
  if ((file.stat.mode & 0o222) === 0) throw new Error('Este arquivo é somente leitura.');
  const original = readBounded(file, TEXT_LIMIT);
  if (!original || revision(original) !== expectedRevision) throw conflict();
  if (!decodeText(original) || IMAGE_TYPES[path.extname(relative).toLowerCase()]) throw new Error('Este arquivo está disponível somente para visualização.');
  const decoded = decodeText(bytes);
  if (!decoded) throw new Error('O conteúdo não pode ser editado como UTF-8.');
  writeAtomic(root, relative, file, bytes, expectedRevision);
  return description(file, bytes, { kind: 'text', ...decoded });
}
module.exports = { readProjectFile, saveProjectFile, saveProjectBytes, resolveFile, readBounded };
