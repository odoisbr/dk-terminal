const fs = require('node:fs');
const path = require('node:path');

function listDirectory(root, relative = '') {
  if (typeof relative !== 'string' || relative.length > 8192 || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Caminho de pasta inválido.');
  const target = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const inside = value => value === root || value.startsWith(prefix);
  if (!inside(target) || !inside(fs.realpathSync(target))) throw new Error('A pasta está fora do projeto selecionado.');
  const directory = fs.opendirSync(target);
  const entries = [];
  let truncated = false;
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (entry.name === '.DS_Store') continue;
      if (entries.length === 500) { truncated = true; break; }
      entries.push({ name: entry.name, relative: path.join(relative, entry.name), kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file' });
    }
  } finally { directory.closeSync(); }
  entries.sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
  return { relative, entries, truncated };
}
module.exports = { listDirectory };
