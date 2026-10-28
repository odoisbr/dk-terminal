const fs = require('node:fs');
const path = require('node:path');
const STATES = new Set(['pronto', 'bloqueado', 'em_execucao', 'concluido', 'falhou']);
function projectGraph(value, file) {
  if (!value || !value.contrato || !Array.isArray(value.contrato.tarefas) || !value.tarefas || value.contrato.tarefas.length > 128) throw new Error('Estado sem contrato de tarefas reconhecido ou com mais de 128 tarefas.');
  const nodes = value.contrato.tarefas.map(task => {
    if (!task || typeof task.id !== 'string' || task.id.length > 128 || !Array.isArray(task.depende_de) || task.depende_de.length > 128 || task.depende_de.some(id => typeof id !== 'string')) throw new Error('Tarefa inválida.');
    const runtime = value.tarefas[task.id] || {};
    return { id: task.id, label: String(task.objetivo || task.id).slice(0, 300), category: String(task.categoria || '').slice(0, 80), dependencies: task.depende_de,
      state: STATES.has(runtime.estado) ? runtime.estado : 'desconhecido', attempts: Number.isInteger(runtime.tentativas) ? runtime.tentativas : 0,
      blocked: typeof runtime.bloqueio === 'string' ? runtime.bloqueio.slice(0, 160) : '', depth: 0 };
  });
  const indexed = new Map(nodes.map(node => [node.id, node]));
  if (indexed.size !== nodes.length) throw new Error('IDs de tarefas repetidos.');
  const done = new Set();
  while (done.size < nodes.length) {
    let progressed = false;
    for (const node of nodes) {
      if (done.has(node.id)) continue;
      if (node.dependencies.some(id => !indexed.has(id))) throw new Error('Dependência sem tarefa correspondente.');
      if (node.dependencies.every(id => done.has(id))) { node.depth = Math.max(-1, ...node.dependencies.map(id => indexed.get(id).depth)) + 1; done.add(node.id); progressed = true; }
    }
    if (!progressed) throw new Error('O registro contém um ciclo de dependências.');
  }
  return { id: String(value.id || file).slice(0, 100), file, objective: String(value.contrato.objetivo || '').slice(0, 400), state: String(value.status || 'desconhecido').slice(0, 40), revision: Number.isInteger(value.revision) ? value.revision : 0, nodes };
}
class Orchestration {
  constructor(changed) { this.changed = changed; this.watcher = null; this.timer = null; }
  directory(root) { return path.join(root, '.dk', 'coordenacoes'); }
  inside(root, file) { const rel = path.relative(root, fs.realpathSync(file)); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }
  list(root) {
    const dir = this.directory(root), graphs = [], warnings = [];
    if (!fs.existsSync(dir)) return { graphs, warnings };
    if (!this.inside(root, dir)) throw new Error('O registro de orquestração está fora do projeto.');
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith('.json')).slice(0, 16);
    for (const entry of files) {
      try {
        const file = path.join(dir, entry.name);
        if (!this.inside(root, file) || fs.statSync(file).size > 1024 * 1024) throw new Error('Registro fora do limite de leitura.');
        graphs.push(projectGraph(JSON.parse(fs.readFileSync(file, 'utf8')), entry.name));
      } catch (error) { warnings.push(`${entry.name}: ${error.message}`); }
    }
    return { graphs, warnings };
  }
  watch(root) {
    this.close(); if (!root) return;
    const dir = [this.directory(root), path.join(root, '.dk'), root].find(file => fs.existsSync(file));
    if (!this.inside(root, dir)) return;
    try {
      this.watcher = fs.watch(dir, { persistent: false }, () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.watch(root); this.changed({ path: root }); }, 300);
      });
      this.watcher.on('error', () => this.close());
    } catch {}
  }
  close() { this.watcher?.close(); this.watcher = null; clearTimeout(this.timer); this.timer = null; }
}
module.exports = { Orchestration, projectGraph };
