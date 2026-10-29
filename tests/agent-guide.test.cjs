const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const guide = require('../electron/agent-guide.cjs');
const { Extensions } = require('../electron/extensions.cjs');
const { CodexChat } = require('../electron/codex-chat.cjs');

const root = path.resolve(__dirname, '..');
const GUIDE = path.join(root, 'dock-tools', 'agents', 'AGENTS.md');
const temp = t => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-agent-guide-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('o guia existe, é curto e cobre dock-preview, sea, serviços e o limite de tokens', () => {
  const text = fs.readFileSync(GUIDE, 'utf8');
  assert.ok(text.split('\n').length <= 80, 'o guia entra no contexto de toda sessão: mantenha-o curto');
  for (const needle of ['dock-preview <alvo> [--titulo "Texto"]', 'sea help', 'Detectados nas sessões', 'dock-agents', 'SEA_DOCK_AGENTS_MD', 'DK_TERMINAL_PREVIEW_TOKEN', 'abre o protótipo']) assert.ok(text.includes(needle), needle);
  assert.equal(guide.agentGuidePath({ isPackaged: false, appPath: root }), GUIDE);
  assert.equal(guide.agentGuidePath({ isPackaged: true, resourcesPath: '/nao/existe' }), null);
  assert.deepEqual(guide.agentGuideEnvironment(GUIDE), { SEA_DOCK_AGENTS_MD: GUIDE });
  assert.deepEqual(guide.agentGuideEnvironment(null), {});
});

test('Claude Code recebe --append-system-prompt-file e preserva os argumentos existentes', () => {
  const options = { guideFile: '/app/agents/AGENTS.md' };
  assert.deepEqual(guide.agentLaunchArgs('claude', [], options), ['--append-system-prompt-file', '/app/agents/AGENTS.md']);
  assert.deepEqual(guide.agentLaunchArgs('/usr/local/bin/claude', ['--model', 'opus', '--resume'], options), ['--append-system-prompt-file', '/app/agents/AGENTS.md', '--model', 'opus', '--resume']);
  for (const own of [['--append-system-prompt', 'x'], ['--append-system-prompt-file', '/meu.md'], ['--system-prompt=x'], ['--system-prompt-file', '/a']]) assert.deepEqual(guide.agentLaunchArgs('claude', own, options), own);
  assert.deepEqual(guide.agentLaunchArgs('claude', ['--x'], {}), ['--x'], 'sem guia, nada muda');
});

test('Codex recebe developer_instructions por -c, como string TOML, sem sobrepor a configuração da pessoa', () => {
  const text = 'Linha "1"\n\tcom \\ barra\u007f';
  const args = guide.agentLaunchArgs('codex', ['--model', 'o3'], { guideFile: '/g/AGENTS.md', guideText: text });
  assert.equal(args[0], '-c'); assert.deepEqual(args.slice(2), ['--model', 'o3']);
  assert.ok(args[1].startsWith('developer_instructions="'));
  assert.equal(JSON.parse(args[1].slice('developer_instructions='.length)), text);
  assert.ok(!/[\u0000-\u0008\u000a-\u001f\u007f]/.test(args[1]), 'string TOML de linha única, sem caracteres de controle');
  for (const own of [['-c', 'developer_instructions="meu"'], ['--config=developer_instructions="x"'], ['-cdeveloper_instructions="x"']]) assert.deepEqual(guide.agentLaunchArgs('codex', own, { guideFile: '/g', guideText: text }), own);
  assert.deepEqual(guide.agentLaunchArgs('codex', ['-c', 'model="o3"'], { guideFile: '/g', guideText: text }).slice(2), ['-c', 'model="o3"']);
  assert.deepEqual(guide.agentLaunchArgs('codex', [], { guideFile: '/g', guideText: text, codexHasInstructions: true }), []);
  assert.deepEqual(guide.agentLaunchArgs('codex', [], { guideFile: '/g', guideText: '  ' }), []);
});

test('config.toml do Codex com developer_instructions na raiz é respeitado (só leitura)', t => {
  const dir = temp(t);
  assert.equal(guide.codexConfigHasInstructions({ CODEX_HOME: dir }), false);
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "o3"\n[profiles.x]\ndeveloper_instructions = "perfil"\n');
  assert.equal(guide.codexConfigHasInstructions({ CODEX_HOME: dir }), false, 'dentro de uma tabela não conta');
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "o3"\n  developer_instructions = """\nminhas\n"""\n');
  assert.equal(guide.codexConfigHasInstructions({ CODEX_HOME: dir }), true);
  fs.mkdirSync(path.join(dir, 'home', '.codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'home', '.codex', 'config.toml'), 'developer_instructions = "x"\n');
  assert.equal(guide.codexConfigHasInstructions({ HOME: path.join(dir, 'home') }), true);
});

test('Antigravity recebe --add-dir com a pasta do guia; outras CLIs ficam como estão', () => {
  const options = { guideFile: '/app/agents/AGENTS.md' };
  assert.deepEqual(guide.agentLaunchArgs('agy', ['--model', 'x'], options), ['--add-dir', '/app/agents', '--model', 'x']);
  assert.deepEqual(guide.agentLaunchArgs('agy', ['--add-dir', '/outra'], options), ['--add-dir', '/app/agents', '--add-dir', '/outra']);
  assert.deepEqual(guide.agentLaunchArgs('agy', ['--add-dir', '/app/agents'], options), ['--add-dir', '/app/agents']);
  for (const command of ['gemini', 'dk', 'node']) assert.deepEqual(guide.agentLaunchArgs(command, ['--a'], options), ['--a']);
});

test('extensões claude, codex e agy lançam com o guia; gemini e dk sem mudança', t => {
  const dir = temp(t), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const name of ['claude', 'codex', 'agy', 'gemini', 'dk']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  const host = new Extensions([path.join(root, 'extensions')], { PATH: bin, HOME: dir });
  host.agentGuide = GUIDE;
  assert.deepEqual(host.spec('claude').args, ['--append-system-prompt-file', GUIDE]);
  const codex = host.spec('codex').args;
  assert.equal(codex[0], '-c'); assert.equal(JSON.parse(codex[1].slice('developer_instructions='.length)), fs.readFileSync(GUIDE, 'utf8'));
  assert.deepEqual(host.spec('antigravity').args, ['--add-dir', path.dirname(GUIDE)]);
  assert.deepEqual(host.spec('gemini').args, []); assert.deepEqual(host.spec('dk').args, []);
  fs.mkdirSync(path.join(dir, '.codex')); fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'developer_instructions = "meu"\n');
  assert.deepEqual(host.spec('codex').args, [], 'instruções do usuário no config.toml não são sobrepostas');
});

test('bloco com marcadores: cria, acrescenta, atualiza, é idempotente e preserva o resto', () => {
  const created = guide.upsertGuideBlock(null, 'Guia v1\n');
  assert.equal(created.action, 'create');
  assert.equal(created.content, `${guide.GUIDE_START}\nGuia v1\n${guide.GUIDE_END}\n`);
  assert.equal(guide.upsertGuideBlock(created.content, 'Guia v1').changed, false);

  const own = '# Meu projeto\n\nRegras da equipe.';
  const appended = guide.upsertGuideBlock(own, 'Guia v1');
  assert.equal(appended.action, 'append');
  assert.equal(appended.content, `${own}\n\n${guide.GUIDE_START}\nGuia v1\n${guide.GUIDE_END}\n`);
  assert.equal(guide.upsertGuideBlock(appended.content, 'Guia v1').changed, false);

  const surrounded = `# Antes\n\n${guide.GUIDE_START}\nGuia antigo\n${guide.GUIDE_END}\n\n## Depois\nfim\n`;
  const updated = guide.upsertGuideBlock(surrounded, 'Guia v2');
  assert.equal(updated.action, 'update'); assert.equal(updated.changed, true);
  assert.equal(updated.content, `# Antes\n\n${guide.GUIDE_START}\nGuia v2\n${guide.GUIDE_END}\n\n## Depois\nfim\n`);
  assert.equal(guide.upsertGuideBlock(updated.content, 'Guia v2').changed, false);

  assert.throws(() => guide.upsertGuideBlock(`x\n${guide.GUIDE_START}\nsem fim`, 'g'), /incompletos/);
  assert.throws(() => guide.upsertGuideBlock(`${guide.GUIDE_END}\n${guide.GUIDE_START}\n`, 'g'), /incompletos/);
  assert.throws(() => guide.upsertGuideBlock(`${guide.GUIDE_START}${guide.GUIDE_END}${guide.GUIDE_START}${guide.GUIDE_END}`, 'g'), /repetidos/);
});

test('leitura e gravação do AGENTS.md do projeto: sem link simbólico, atômica e com as permissões existentes', t => {
  const dir = temp(t);
  assert.deepEqual(guide.readProjectAgents(dir), { file: path.join(dir, 'AGENTS.md'), text: null });
  guide.writeProjectAgents(dir, 'um\n');
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'um\n');
  fs.chmodSync(path.join(dir, 'AGENTS.md'), 0o600);
  const current = guide.readProjectAgents(dir);
  assert.equal(current.text, 'um\n'); assert.equal(current.mode, 0o600);
  guide.writeProjectAgents(dir, 'dois\n', current.mode);
  assert.equal(fs.statSync(path.join(dir, 'AGENTS.md')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['AGENTS.md'], 'nenhum temporário fica para trás');
  const linked = path.join(dir, 'linked'); fs.mkdirSync(linked); fs.symlinkSync(path.join(dir, 'AGENTS.md'), path.join(linked, 'AGENTS.md'));
  assert.throws(() => guide.readProjectAgents(linked), /não é um arquivo comum/);
});

test('dock-agents imprime o guia sem runtime e sem NODE_OPTIONS', { skip: process.platform === 'win32' }, async () => {
  const output = await new Promise((resolve, reject) => execFile(path.join(root, 'dock-tools', 'bin', 'dock-agents'), [], { env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require /tmp/x.js' } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.equal(output, fs.readFileSync(GUIDE, 'utf8'));
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'dock-tools', 'bin', 'dock-agents'), 'utf8'), /NODE_OPTIONS=/);
});

test('painel Codex envia o guia como developerInstructions em thread/start e thread/resume', { skip: process.platform === 'win32' }, async t => {
  const dir = temp(t), bin = path.join(dir, 'bin'), project = path.join(dir, 'project'), log = path.join(dir, 'log.jsonl');
  fs.mkdirSync(bin); fs.mkdirSync(project);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs'); const rl = require('node:readline');
const out = v => process.stdout.write(JSON.stringify(v) + '\\n');
rl.createInterface({ input: process.stdin }).on('line', line => { const r = JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
  if (r.method === 'initialize') out({ id: r.id, result: {} });
  else if (r.method === 'thread/start' || r.method === 'thread/resume') out({ id: r.id, result: { thread: { id: 't1' } } });
  else if (r.method === 'turn/start') { out({ id: r.id, result: { turn: { id: 'u1' } } }); out({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u1', status: 'completed' } } }); } });
`, { mode: 0o755 });
  const chat = new CodexChat({ env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, storeFile: path.join(dir, 'private', 'chat.json'), developerInstructions: () => 'GUIA DO SEA DOCK' });
  t.after(() => chat.closeAll());
  const session = chat.create(project);
  const done = async () => { const end = Date.now() + 4000; while (chat.read(project, session.id).session.running) { if (Date.now() > end) assert.fail('timeout'); await new Promise(r => setTimeout(r, 15)); } };
  await chat.send(project, session.id, 'oi'); await done();
  await chat.send(project, session.id, 'de novo'); await done();
  const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.find(r => r.method === 'thread/start').params.developerInstructions, 'GUIA DO SEA DOCK');
  assert.equal(requests.find(r => r.method === 'thread/resume').params.developerInstructions, 'GUIA DO SEA DOCK');
});
