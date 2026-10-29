const fs = require('node:fs');
const path = require('node:path');

// Ferramentas embutidas no pacote (hoje: o `sea` CLI com seu Ruby portátil).
// Entram no fim do PATH: uma instalação própria do usuário tem prioridade.
function bundledToolsPath({ isPackaged, resourcesPath, appPath }) {
  const base = isPackaged ? path.join(resourcesPath, 'sea-cli', 'bin') : path.join(appPath, 'vendor', 'sea-cli', 'bin');
  try { return fs.statSync(path.join(base, 'sea')).isFile() ? base : null; } catch { return null; }
}

function withBundledTools(env, dir) {
  if (!dir) return env;
  const entries = (env.PATH || '').split(path.delimiter).filter(Boolean);
  if (entries.includes(dir)) return env;
  return { ...env, PATH: [...entries, dir].join(path.delimiter) };
}

module.exports = { bundledToolsPath, withBundledTools };
