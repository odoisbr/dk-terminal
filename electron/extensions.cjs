const fs = require('node:fs');
const path = require('node:path');
const { executable } = require('./core.cjs');
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
class Extensions {
  constructor(roots, env) {
    this.env = env; this.items = new Map(); this.errors = [];
    for (const [index, root] of roots.entries()) {
      if (!fs.existsSync(root)) continue;
      for (const folder of fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).slice(0, 32)) {
        const file = path.join(root, folder.name, 'extension.json');
        try {
          if (fs.statSync(file).size > 16 * 1024) throw new Error('Manifesto muito grande.');
          const item = manifest(JSON.parse(fs.readFileSync(file, 'utf8')), index === 0);
          if (this.items.has(item.id)) throw new Error('ID já instalado.');
          this.items.set(item.id, item);
        } catch (error) { this.errors.push(`${folder.name}: ${error.message}`); }
      }
    }
  }
  list() { return [...this.items.values()].map(item => ({ id: item.id, name: item.name, description: item.description, version: item.version, kind: item.type === 'browser' ? 'browser' : 'terminal', available: item.type === 'browser' || !!executable(item.command, this.env) })); }
  spec(id) {
    const item = this.items.get(id);
    if (!item) throw new Error('Extensão não encontrada.');
    if (item.type === 'browser') throw new Error('Use o painel Browser para abrir a prévia.');
    const file = executable(item.command, this.env);
    if (!file) throw new Error(`${item.name} não foi encontrado. Instale a ferramenta oficial para usá-la aqui.`);
    return { label: item.name, kind: 'extension', file, args: [...item.args] };
  }
}
module.exports = { Extensions, manifest };
