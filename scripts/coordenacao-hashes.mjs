// Atualiza os SHA-256 de um contrato de coordenação (docs/coordenacoes/*.json) a partir do disco.
// Uso: node scripts/coordenacao-hashes.mjs <contrato.json> [--check]
// Sem --check, regrava o contrato; com --check, só devolve código 1 se algum hash divergir.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const LIMIT = 4 * 1024 * 1024;
export function digest(file) {
  const size = fs.statSync(file).size;
  if (size > LIMIT) throw new Error(`${file}: arquivo acima de 4 MiB.`);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function relative(root, rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`Caminho inválido: ${rel}`);
  const base = fs.realpathSync(root), target = path.resolve(base, rel);
  let existing = target;
  while (!fs.existsSync(existing) && existing !== base) {
    const parent = path.dirname(existing); if (parent === existing) break; existing = parent;
  }
  const resolved = fs.realpathSync(existing), relativePath = path.relative(base, resolved);
  if (relativePath === '..' || relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath)) throw new Error(`Caminho fora do projeto: ${rel}`);
  return target;
}
export function refresh(contract, root) {
  const changes = [], warnings = [];
  const update = (item, label) => {
    const file = relative(root, item.arquivo);
    if (item.ausente === true) { if (fs.existsSync(file)) warnings.push(`${label}: ${item.arquivo} já existe, mas o contrato o declara ausente.`); return; }
    if (!fs.existsSync(file)) { warnings.push(`${label}: ${item.arquivo} não existe no disco.`); return; }
    const hash = digest(file);
    if (item.sha256 !== hash) { changes.push(`${label}: ${item.arquivo}`); item.sha256 = hash; }
  };
  for (const item of contract.contexto || []) update(item, 'contexto');
  for (const task of contract.tarefas || []) {
    const tc = task.contrato_tarefa;
    if (!tc) continue;
    for (const item of tc.fontes || []) update(item, `${task.id}.fontes`);
    for (const item of tc.alvos || []) update(item, `${task.id}.alvos`);
  }
  return { changes, warnings };
}
let invokedDirectly = false;
try { invokedDirectly = !!process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (invokedDirectly) {
  const [file, flag] = process.argv.slice(2);
  if (!file) { console.error('Uso: node scripts/coordenacao-hashes.mjs <contrato.json> [--check]'); process.exit(2); }
  const root = process.cwd();
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { changes, warnings } = refresh(contract, root);
  for (const w of warnings) console.warn('aviso: ' + w);
  if (flag === '--check') { for (const c of changes) console.log('divergente: ' + c); process.exit(changes.length || warnings.length ? 1 : 0); }
  if (changes.length) fs.writeFileSync(file, JSON.stringify(contract, null, 2) + '\n');
  console.log(changes.length ? `${changes.length} hash(es) atualizado(s) em ${file}.` : `Hashes de ${file} já batem com o disco.`);
}
