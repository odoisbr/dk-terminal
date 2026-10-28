const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-mermaid-unit-'));
let javascript;
try {
  const compiler = path.join(__dirname, '../node_modules/.bin/tsc');
  const result = spawnSync(compiler, ['--ignoreConfig', '--skipLibCheck', '--target', 'es2022', '--module', 'es2022', '--outDir', output, path.join(__dirname, '../src/mermaid-edit.ts')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Falha ao compilar o teste Mermaid.');
  javascript = fs.readFileSync(path.join(output, 'mermaid-edit.js'), 'utf8');
} finally { fs.rmSync(output, { recursive: true, force: true }); }
const loaded = import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));

test('edit uses the last declared label and never rewrites text inside another label', async () => {
  const { changeNodeLabel } = await loaded;
  const graph = 'flowchart TD\n X["A"] --> A\n B[Primeiro] --> C\n B[Último] --> A\n';
  const a = changeNodeLabel(graph,'A','Segura');
  assert.ok(a.includes('X["A"] --> A["Segura"]'));
  const b = changeNodeLabel(a,'B','Final');
  assert.ok(b.includes('B[Primeiro] --> C'));
  assert.ok(b.includes('B["Final"] --> A'));
});
test('edits target the diagram after frontmatter, including a one-line graph', async () => {
  const { changeNodeLabel } = await loaded;
  const graph = '---\ntitle: A\n---\nflowchart TD; A --> B\n';
  assert.equal(changeNodeLabel(graph,'A','Origem'), '---\ntitle: A\n---\nflowchart TD; A["Origem"] --> B\n');
});
test('modern shape metadata is left untouched when its structure cannot be edited safely', async () => {
  const { findNodeLabel, changeNodeLabel } = await loaded;
  const graph='flowchart TD\n A@{ shape: cloud, label: "Nuvem" }\n A --> B\n';
  assert.equal(findNodeLabel(graph,'A'),null); assert.equal(changeNodeLabel(graph,'A','Outro'),null);
});
test('creating nodes and connections preserves existing source and uses unused IDs', async () => {
  const { addConnectedNode, connectNodes } = await loaded;
  const graph='flowchart TD\n A[Um] --> B[Dois]\n dk_1[Existente] --> B\n';
  const added=addConnectedNode(graph,'A','Nova "etapa"');
  assert.equal(added,graph+'  A --> dk_2["Nova #quot;etapa#quot;"]\n');
  assert.equal(connectNodes(added,'B','dk_2'),added+'  B --> dk_2\n');
  assert.equal(connectNodes(graph,'A','ausente'),null);
});
test('sequence edits preserve actor identifiers and the message direction', async () => {
  const { sequenceLabels, changeSequenceLabel } = await loaded;
  const graph='---\ntitle: Usuário\n---\nsequenceDiagram\n participant U as Usuário\n participant S\n U->>S: Enviar pedido\n';
  const labels=sequenceLabels(graph);
  assert.deepEqual(labels.map(v=>v.value),['Usuário','S','Enviar pedido']);
  assert.ok(changeSequenceLabel(graph,labels[0],'Cliente').includes('participant U as Cliente'));
  assert.ok(changeSequenceLabel(graph,labels[1],'Servidor').includes('participant S as Servidor'));
  assert.ok(changeSequenceLabel(graph,labels[2],'Novo pedido').includes('U->>S: Novo pedido'));
});
