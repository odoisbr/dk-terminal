const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..'), coord = 'COORD-PLUGINS-M2';
const registrar = path.join(root, 'scripts/evidencia-marco.mjs'), gate = path.join(root, 'scripts/gate-marco.mjs');
const agentKey = key => ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'ANTIGRAVITY_AGENT'].includes(key) || key.startsWith('CLAUDE_CODE_');
const humanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !agentKey(key)));
const manifestFile = 'docs/coordenacoes/pacotes-M2.json';
function manifest(dir, pacotes = [{ id: 'g', arquivos: ['alvo.txt'] }]) {
  fs.mkdirSync(path.join(dir, 'docs/coordenacoes'), { recursive: true });
  fs.writeFileSync(path.join(dir, manifestFile), JSON.stringify({ schema_version: 1, coordenacao: coord, pacotes }));
}
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea gate com espaços ')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(dir, 'alvo.txt'), 'revisão inicial\n');
  manifest(dir);
  git('add', 'alvo.txt', manifestFile); git('commit', '-m', 'fixture');
  fs.writeFileSync(path.join(dir, 'unitarios.log'), 'unitários: 2 passaram\n');
  fs.writeFileSync(path.join(dir, 'desktop.log'), 'desktop: 1 passou\n');
  const teste = (saida, passou) => ({ comando: `node ${saida}.cjs`, status: 'passou', passou, falhou: 0, saida: `${saida}.log` });
  fs.writeFileSync(path.join(dir, 'registro.json'), JSON.stringify({ alvos: ['alvo.txt'],
    pacotes: [{ id: 'g', arquivos: ['alvo.txt'], implementado_por: { host: 'codex', modelo: 'gpt-6', esforco: 'high' } }],
    ambiente: { electron: '45.1.0', claude_versao: '2.1.312', codex_versao: null, segredo: 'não copiar' },
    testes: { unitarios: teste('unitarios', 2), desktop: teste('desktop', 1) } }));
  fs.writeFileSync(path.join(dir, 'registro-testes.json'), JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'registro.json'))).testes));
  const evidenceFile = path.join(dir, '.dk/coordenacoes/evidencias', coord + '.verificacao.json');
  return { dir, git, evidenceFile,
    read: () => JSON.parse(fs.readFileSync(evidenceFile)),
    change: fn => { const e = JSON.parse(fs.readFileSync(evidenceFile)); fn(e); fs.writeFileSync(evidenceFile, JSON.stringify(e)); } };
}
// Aprovações positivas usam um terminal real; o subprocesso só recebe a resposta após o prompt.
function interactive(f, command, args, confirmation = coord, env = humanEnv) {
  const python = `import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
p = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
sent = False
end = time.monotonic() + 5
while time.monotonic() < end:
    if select.select([master], [], [], 0.05)[0]:
        try: chunk = os.read(master, 65536)
        except OSError: break
        if not chunk: break
        output += chunk
        if b'Confirme' in output and not sent:
            os.write(master, (sys.argv[1] + '\\n').encode())
            sent = True
    if p.poll() is not None: break
if p.poll() is None: p.kill()
p.wait()
os.close(master)
sys.stdout.buffer.write(output)
sys.exit(p.returncode if p.returncode >= 0 else 1)
`;
  return spawnSync('python3', ['-c', python, confirmation, process.execPath, registrar, command, coord, '--projeto', f.dir, ...args], { encoding: 'utf8', timeout: 7000, env });
}
function record(f, command = 'registrar', ...args) {
  const result = command === 'registrar'
    ? spawnSync(process.execPath, [registrar, command, coord, '--projeto', f.dir, ...args], { encoding: 'utf8' })
    : interactive(f, command, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return f.read();
}
const register = f => {
  const e = record(f, 'registrar', '--entrada', 'registro.json', '--perfil', 'testador', '--host', 'codex');
  for (const p of e.pacotes) if (p.revisao === null) record(f, 'revisar', '--pacote', p.id, '--veredito', 'aprovado', '--revisor', 'independente');
  return f.read();
};
const scope = f => record(f, 'decisao-escopo', '--autor', 'Pessoa autorizada', '--motivo', 'Revisão explícita do escopo para esta fixture.');
const manual = (f, p3 = 'ok') => record(f, 'cli-oficial', '--autorizado-por', 'pessoa@example.test', '--versao', '2.1.312',
  '--passo', 'P1=ok', '--passo', 'P2=ok', '--passo', `P3=${p3}`, '--passo', 'P4=ok', '--passo', 'P5=ok');
function check(f, allowed, reason) {
  const result = spawnSync(process.execPath, [gate, coord, '--projeto', f.dir, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, allowed ? 0 : 1, result.stderr || result.stdout);
  const json = JSON.parse(result.stdout);
  assert.equal(json.concluida, allowed);
  if (allowed) assert.deepEqual(json.motivos, []);
  else { assert.ok(json.motivos.length); if (reason) assert.match(json.motivos.join('\n'), reason); }
  return json;
}

test('positivo: registro vincula identidade, revisão, saídas e rodada oficial; gate não escreve', t => {
  const f = fixture(t), e = register(f), stat = fs.statSync(f.dir);
  assert.deepEqual(e.projeto, { realpath: f.dir, dev: stat.dev, ino: stat.ino });
  assert.equal(e.revisao.commit, f.git('rev-parse', 'HEAD'));
  assert.equal(e.alvos[0].sha256, sha(fs.readFileSync(path.join(f.dir, 'alvo.txt'))));
  assert.deepEqual(e.pacotes[0].revisao.alvos, e.alvos);
  assert.ok(e.revisao.dirty.some(d => d.arquivo === 'registro.json' && /^[a-f0-9]{64}$/.test(d.sha256)));
  assert.equal(e.testes.unitarios.saida_sha256, sha(fs.readFileSync(path.join(f.dir, 'unitarios.log'))));
  assert.equal(e.ambiente.platform, process.platform); assert.equal(e.ambiente.segredo, undefined);
  assert.deepEqual(Object.keys(e.gravado_por), ['perfil', 'host', 'data']);
  manual(f);
  const before = fs.readFileSync(f.evidenceFile);
  check(f, true); assert.deepEqual(fs.readFileSync(f.evidenceFile), before);
});
test('positivo: decisão explícita de escopo substitui a rodada', t => {
  const f = fixture(t); register(f); scope(f); check(f, true);
});
test('bloqueia evidência ausente, mesmo com M1 concluído e concluida:true forjado', t => {
  const f = fixture(t), folder = path.join(f.dir, '.dk/coordenacoes'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'COORD-PLUGINS-M1.json'), JSON.stringify({ concluida: true }));
  fs.writeFileSync(path.join(folder, coord + '.json'), JSON.stringify({ concluida: true, anterior: { concluida: true } }));
  check(f, false, /ausente/);
});
test('invocar scripts por link simbólico também executa registro e gate', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), gateLink = path.join(f.dir, 'gate.mjs'), recordLink = path.join(f.dir, 'registro.mjs');
  fs.symlinkSync(gate, gateLink); fs.symlinkSync(registrar, recordLink);
  const blocked = spawnSync(process.execPath, [gateLink, coord, '--projeto', f.dir, '--json'], { encoding: 'utf8' });
  assert.equal(blocked.status, 1); assert.equal(JSON.parse(blocked.stdout).concluida, false);
  const result = spawnSync(process.execPath, [recordLink, 'cli-oficial', coord, '--projeto', f.dir, '--autorizado-por', 'pessoa@example.test', '--limitacao', 'Não executada'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Evidência ausente/);
});
test('bloqueia falha de teste unitário ou desktop, contagens inválidas e hash ausente', t => {
  const f = fixture(t); register(f); scope(f); const original = f.read();
  for (const kind of ['unitarios', 'desktop']) for (const alteration of [
    test => { test.status = 'falhou'; }, test => { test.falhou = 1; },
    test => { test.passou = 0; }, test => { test.saida_sha256 = ''; },
  ]) {
    fs.writeFileSync(f.evidenceFile, JSON.stringify(original));
    f.change(e => alteration(e.testes[kind])); check(f, false, new RegExp(kind));
  }
});
test('bloqueia sem rodada manual e sem decisão, inclusive aprovação declarada', t => {
  const f = fixture(t); register(f); check(f, false, /Rodada manual/);
  f.change(e => { e.concluida = true; e.aprovacao_host_provada = true; }); check(f, false, /P2–P5/);
  f.change(e => { e.decisao_escopo = { autor: ' ', data: 'hoje', motivo: '' }; }); check(f, false);
});
test('CLI não executada registra limitação e mantém gate bloqueado', t => {
  const f = fixture(t); register(f);
  const e = record(f, 'cli-oficial', '--autorizado-por', 'pessoa@example.test', '--limitacao', 'CLI indisponível.');
  assert.equal(e.cli_oficial.executada, false); assert.equal(e.aprovacao_host_provada, false);
  check(f, false, /Rodada manual/);
});
test('bloqueia outro projeto, inclusive mesmo caminho com dev/ino divergente', t => {
  const f = fixture(t), other = fixture(t); register(f); scope(f);
  fs.mkdirSync(path.dirname(other.evidenceFile), { recursive: true }); fs.copyFileSync(f.evidenceFile, other.evidenceFile);
  check(other, false, /outro projeto/);
  f.change(e => { e.projeto.ino += 1; }); check(f, false, /dev\/ino/);
});
test('bloqueia alvo divergente e arquivo novo mesmo declarando revisão limpa', t => {
  const f = fixture(t); register(f); scope(f); f.change(e => { e.revisao.dirty = []; });
  fs.writeFileSync(path.join(f.dir, 'alvo.txt'), 'alteração posterior\n');
  check(f, false, /divergente/);
});
test('sempre compara hashes mesmo com commit igual a HEAD e árvore limpa', t => {
  const f = fixture(t); f.git('add', '.'); f.git('commit', '-m', 'entradas'); register(f); scope(f);
  assert.deepEqual(f.read().revisao.dirty, []);
  f.change(e => { e.alvos[0].sha256 = '0'.repeat(64); }); check(f, false, /SHA-256 divergente/);
  fs.writeFileSync(path.join(f.dir, 'novo.txt'), 'nova revisão'); check(f, false, /divergente/);
});
test('JSON acima de 4 MiB é recusado pelo gate e registro, sem substituir evidência', t => {
  const f = fixture(t); register(f); scope(f);
  const original = fs.readFileSync(f.evidenceFile);
  fs.writeFileSync(path.join(f.dir, 'grande.json'), ' '.repeat(4 * 1024 * 1024 + 1));
  const result = spawnSync(process.execPath, [registrar, 'registrar', coord, '--projeto', f.dir, '--entrada', 'grande.json'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /4 MiB/); assert.deepEqual(fs.readFileSync(f.evidenceFile), original);
  fs.writeFileSync(f.evidenceFile, ' '.repeat(4 * 1024 * 1024 + 1)); check(f, false, /4 MiB/);
});
test('bloqueia P3 falhou mesmo com aprovacao_host_provada:true forjado', t => {
  const f = fixture(t); register(f); const e = manual(f, 'falhou'); assert.equal(e.aprovacao_host_provada, false);
  f.change(e => { e.aprovacao_host_provada = true; }); check(f, false, /P2–P5/);
});
test('atualizar registro preserva decisão só na mesma revisão e calcula novos hashes', t => {
  const f = fixture(t); register(f); scope(f); register(f); check(f, true);
  fs.writeFileSync(path.join(f.dir, 'alvo.txt'), 'nova revisão'); register(f);
  assert.equal(f.read().decisao_escopo, null); check(f, false, /Rodada manual/);
  assert.equal(fs.readdirSync(path.dirname(f.evidenceFile)).length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.evidenceFile).mode & 0o777, 0o600);
});
test('alterar arquivo aprovado bloqueia e registrar anula o veredito; gate recusa reaproveitar hashes antigos', t => {
  const f = fixture(t); register(f); scope(f); check(f, true);
  const revisao = f.read().pacotes[0].revisao;
  fs.writeFileSync(path.join(f.dir, 'alvo.txt'), 'conteúdo após aprovação');
  check(f, false, /SHA-256 divergente/);
  const e = record(f, 'registrar', '--entrada', 'registro.json');
  assert.equal(e.pacotes[0].revisao, null);
  scope(f); check(f, false, /revisão.*pendente/);
  // Mesmo com Git e alvos atualizados, o veredito anterior não cobre o conteúdo novo.
  f.change(e => { e.pacotes[0].revisao = revisao; });
  check(f, false, /Pacote g: hashes da revisão divergentes/);
  record(f, 'revisar', '--pacote', 'g', '--veredito', 'aprovado', '--revisor', 'Revisor B');
  check(f, true);
});
test('arquivo novo no pacote anula revisão tanto por entrada quanto por --pacote', t => {
  for (const viaCli of [false, true]) {
    const f = fixture(t); register(f);
    fs.writeFileSync(path.join(f.dir, 'novo.txt'), 'arquivo acrescentado');
    const input = JSON.parse(fs.readFileSync(path.join(f.dir, 'registro.json')));
    input.alvos.push('novo.txt');
    if (!viaCli) input.pacotes[0].arquivos.push('novo.txt');
    fs.writeFileSync(path.join(f.dir, 'registro.json'), JSON.stringify(input));
    const args = viaCli ? ['--pacote', 'g=alvo.txt,novo.txt'] : [];
    const e = record(f, 'registrar', '--entrada', 'registro.json', ...args);
    assert.deepEqual(e.pacotes[0].arquivos, ['alvo.txt', 'novo.txt']);
    assert.equal(e.pacotes[0].revisao, null);
    scope(f); check(f, false, /revisão.*pendente/);
    const reviewed = record(f, 'revisar', '--pacote', 'g', '--veredito', 'aprovado', '--revisor', 'Revisor B');
    assert.deepEqual(reviewed.pacotes[0].revisao.alvos, reviewed.alvos);
    check(f, true);
    const reduced = record(f, 'registrar', '--entrada', 'registro.json', '--pacote', 'g=alvo.txt');
    assert.equal(reduced.pacotes[0].revisao, null);
  }
});
test('revisar fotografa o conteúdo no momento do veredito e gate exige snapshot completo', t => {
  const f = fixture(t); register(f);
  fs.writeFileSync(path.join(f.dir, 'alvo.txt'), 'conteúdo antes da revisão');
  const e = record(f, 'revisar', '--pacote', 'g', '--veredito', 'aprovado', '--revisor', 'Revisor B');
  assert.deepEqual(e.pacotes[0].revisao.alvos, [{ arquivo: 'alvo.txt', sha256: sha('conteúdo antes da revisão') }]);
  assert.notDeepEqual(e.pacotes[0].revisao.alvos, e.alvos);
  record(f, 'registrar', '--entrada', 'registro.json'); scope(f); check(f, true);
  const original = f.read();
  for (const alter of [
    p => { delete p.revisao.alvos; },
    p => { p.revisao.alvos = []; },
    p => { p.revisao.alvos[0].sha256 = '0'.repeat(64); },
    p => { p.revisao.alvos.push(p.revisao.alvos[0]); },
  ]) {
    fs.writeFileSync(f.evidenceFile, JSON.stringify(original));
    f.change(e => alter(e.pacotes[0])); check(f, false, /hashes da revisão divergentes/);
  }
});
test('recusa traversal, coordenação errada, JSON inválido e link para fora do projeto', t => {
  const f = fixture(t), other = fixture(t); register(f); scope(f); const original = fs.readFileSync(f.evidenceFile);
  for (const arquivo of ['../externo', '.git/config']) {
    f.change(e => { e.alvos[0].arquivo = arquivo; }); check(f, false, /Caminho inválido/);
    fs.writeFileSync(f.evidenceFile, original);
  }
  f.change(e => { e.coordenacao = 'COORD-PLUGINS-M1'; }); check(f, false, /coordenação/);
  fs.writeFileSync(f.evidenceFile, '{'); check(f, false);
  fs.writeFileSync(f.evidenceFile, original);
  if (process.platform !== 'win32') {
    fs.symlinkSync(other.dir, path.join(f.dir, 'externo'));
    f.change(e => { e.alvos[0].arquivo = 'externo/alvo.txt'; }); check(f, false, /fora do projeto/);
    fs.rmSync(path.dirname(f.evidenceFile), { recursive: true });
    fs.symlinkSync(other.dir, path.join(f.dir, '.dk/coordenacoes/evidencias'));
    const result = spawnSync(process.execPath, [registrar, 'registrar', coord, '--projeto', f.dir, '--entrada', 'registro.json'], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /fora do projeto/);
    assert.ok(!fs.existsSync(path.join(other.dir, coord + '.verificacao.json')));
  }
});
test('não lê credenciais para calcular hashes e não aceita saída só declarada', t => {
  const f = fixture(t); register(f); const original = fs.readFileSync(f.evidenceFile);
  fs.writeFileSync(path.join(f.dir, '.env'), 'SEGREDO=nao_ler');
  const input = JSON.parse(fs.readFileSync(path.join(f.dir, 'registro.json'))); input.alvos = ['.env'];
  fs.writeFileSync(path.join(f.dir, 'registro.json'), JSON.stringify(input));
  let result = spawnSync(process.execPath, [registrar, 'registrar', coord, '--projeto', f.dir, '--entrada', 'registro.json'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /credenciais/); assert.doesNotMatch(result.stderr, /SEGREDO/);
  fs.rmSync(path.join(f.dir, '.env'));
  input.alvos = ['alvo.txt']; delete input.testes.desktop.saida; input.testes.desktop.saida_sha256 = '0'.repeat(64);
  fs.writeFileSync(path.join(f.dir, 'registro.json'), JSON.stringify(input));
  result = spawnSync(process.execPath, [registrar, 'registrar', coord, '--projeto', f.dir, '--entrada', 'registro.json'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /arquivo de saída/); assert.deepEqual(fs.readFileSync(f.evidenceFile), original);
});
test('m3-anterior executa o gate e usa código e JSON mantendo dependências', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'docs/coordenacoes/M3-preview-bridge.json')));
  const anterior = contract.tarefas.find(t => t.id === 'm3-anterior');
  assert.match(anterior.objetivo, /node scripts\/gate-marco\.mjs COORD-PLUGINS-M2 --projeto \. --json/);
  assert.match(anterior.objetivo, /saída 0 e concluida=true/); assert.deepEqual(anterior.tools, ['Bash(node scripts/gate-marco.mjs COORD-PLUGINS-M2 --projeto . --json)']);
  assert.match(anterior.objetivo, /Não gravar evidência/);
  const inventario = contract.tarefas.find(t => t.id === 'm3-inventario');
  assert.deepEqual(inventario.condicao, { dependencia: 'm3-anterior', ponteiro: '/anterior/concluida', igual: true });
});


test('pacotes são obrigatórios, todos revisados, identificados e cobertos por alvos canônicos', t => {
  const f = fixture(t); register(f); scope(f); const original = f.read();
  for (const [alter, reason] of [
    [e => { delete e.pacotes; }, /pacote/i],
    [e => { e.pacotes = []; }, /pacote/i],
    [e => { e.pacotes[0].revisao.veredito = 'reprovado'; }, /pacote.*g|g.*reprovado/i],
    [e => { e.pacotes.push({ ...e.pacotes[0], id: 'h', revisao: null }); }, /pacote/i],
    [e => { e.pacotes[0].arquivos.push('sem-alvo.txt'); }, /sem-alvo.txt/],
    [e => { delete e.pacotes[0].implementado_por.modelo; }, /pacote/i],
    [e => { e.pacotes.push(e.pacotes[0]); }, /duplicado/i],
    [e => { e.pacotes[0].arquivos = ['./alvo.txt']; }, /normalizado/i],
    [e => { e.alvos.push({ ...e.alvos[0], arquivo: './alvo.txt' }); }, /normalizado|duplicado/i],
    [e => { e.pacotes[0].arquivos.push('alvo.txt'); }, /duplicado/i],
  ]) {
    fs.writeFileSync(f.evidenceFile, JSON.stringify(original)); f.change(alter); check(f, false, reason);
  }
});
test('registrar recusa --revisao e preserva veredito existente vindo de entrada', t => {
  const f = fixture(t); register(f);
  const before = fs.readFileSync(f.evidenceFile);
  const r = spawnSync(process.execPath, [registrar, 'registrar', coord, '--projeto', f.dir, '--entrada', 'registro.json', '--revisao', 'g=reprovado:Outro'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Opção inválida/);
  assert.deepEqual(fs.readFileSync(f.evidenceFile), before);
  const input = JSON.parse(fs.readFileSync(path.join(f.dir, 'registro.json')));
  input.pacotes[0].revisao = { revisor: 'Outro', veredito: 'reprovado', data: '2026-10-30' };
  fs.writeFileSync(path.join(f.dir, 'registro.json'), JSON.stringify(input));
  const e = register(f);
  assert.deepEqual(e.pacotes[0].revisao, JSON.parse(before).pacotes[0].revisao);
  const rejected = record(f, 'revisar', '--pacote', 'g', '--veredito', 'reprovado', '--revisor', 'Revisor B');
  input.pacotes[0].revisao = { revisor: 'Outro', veredito: 'aprovado', data: '2026-10-30' };
  fs.writeFileSync(path.join(f.dir, 'registro.json'), JSON.stringify(input));
  assert.deepEqual(register(f).pacotes[0].revisao, rejected.pacotes[0].revisao);
});
test('novos pacotes ficam pendentes e registrar recusa importar aprovação por JSON', t => {
  const f = fixture(t);
  const e = record(f, 'registrar', '--entrada', 'registro.json');
  assert.equal(e.pacotes[0].revisao, null); check(f, false, /revisão.*pendente/);
  const original = fs.readFileSync(f.evidenceFile);
  const input = JSON.parse(fs.readFileSync(path.join(f.dir, 'registro.json')));
  input.pacotes.push({ ...input.pacotes[0], id: 'h', revisao: { revisor: 'Executor', veredito: 'aprovado', data: '2026-10-29' } });
  fs.writeFileSync(path.join(f.dir, 'registro.json'), JSON.stringify(input));
  const r = spawnSync(process.execPath, [registrar, 'registrar', coord, '--projeto', f.dir, '--entrada', 'registro.json'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /use revisar/); assert.deepEqual(fs.readFileSync(f.evidenceFile), original);
});
test('revisar confirma a coordenação e altera somente a revisão do pacote escolhido', t => {
  const f = fixture(t); register(f); const before = f.read();
  const e = record(f, 'revisar', '--pacote', 'g', '--veredito', 'reprovado', '--revisor', 'Revisor B');
  assert.equal(e.pacotes[0].revisao.veredito, 'reprovado');
  assert.equal(e.pacotes[0].revisao.revisor, 'Revisor B');
  assert.ok(Number.isFinite(Date.parse(e.pacotes[0].revisao.data)));
  assert.deepEqual({ ...e, gravado_por: null, pacotes: [] }, { ...before, gravado_por: null, pacotes: [] });
  assert.deepEqual({ ...e.pacotes[0], revisao: null }, { ...before.pacotes[0], revisao: null });
  check(f, false, /g.*reprovado/);
  const approved = record(f, 'revisar', '--pacote', 'g', '--veredito', 'aprovado', '--revisor', 'Revisor A');
  assert.equal(approved.pacotes[0].revisao.veredito, 'aprovado');
  for (const args of [[], ['--pacote', 'h', '--veredito', 'aprovado', '--revisor', 'A'], ['--pacote', 'g', '--veredito', 'talvez', '--revisor', 'A'], ['--pacote', 'g', '--pacote', 'g', '--veredito', 'aprovado', '--revisor', 'A'], ['--pacote', 'g', '--veredito', 'aprovado']]) {
    const original = fs.readFileSync(f.evidenceFile), r = interactive(f, 'revisar', args);
    assert.equal(r.status, 1); assert.deepEqual(fs.readFileSync(f.evidenceFile), original);
  }
});
test('--pacote mescla por id, normaliza e não remove pacote existente', t => {
  const f = fixture(t); register(f);
  let e = record(f, 'registrar', '--entrada', 'registro.json', '--alvo', './alvo.txt', '--pacote', 'h=./alvo.txt', '--host', 'codex', '--modelo', 'gpt-6', '--esforco', 'high');
  assert.deepEqual(e.pacotes.map(p => p.id), ['g', 'h']);
  assert.deepEqual(e.pacotes[1].arquivos, ['alvo.txt']);
  assert.equal(e.pacotes[1].revisao, null);
  const original = fs.readFileSync(f.evidenceFile);
  // A entrada antiga omite h: também não pode apagar um pacote já registrado.
  const r = spawnSync(process.execPath, [registrar, 'registrar', coord, '--projeto', f.dir, '--entrada', 'registro.json'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /remover.*h/i); assert.deepEqual(fs.readFileSync(f.evidenceFile), original);
  e = record(f, 'registrar', '--alvo', 'alvo.txt', '--testes', 'registro-testes.json', '--pacote', 'g=alvo.txt');
  assert.deepEqual(e.pacotes.map(p => p.id), ['g', 'h']);
});
test('estado runtime é opcional, mas quando existe deve estar inteiramente concluído', t => {
  const f = fixture(t); register(f); scope(f); check(f, true);
  const state = path.join(f.dir, '.dk/coordenacoes', coord + '.json');
  const completed = { status: 'concluido', parado: false, contrato: { tarefas: [{ id: 'g' }] }, tarefas: { g: { estado: 'concluido' } } };
  for (const value of [
    { concluida: true }, { ...completed, status: 'em_execucao', concluida: true },
    { ...completed, parado: true }, { ...completed, tarefas: { g: { estado: 'falhou' } } },
    { ...completed, tarefas: {} },
  ]) { fs.writeFileSync(state, JSON.stringify(value)); check(f, false, /coordenação|runtime/i); }
  fs.writeFileSync(state, JSON.stringify({ ...completed, concluida: false })); check(f, true);
});
test('revisão precisa do HEAD exato, ainda que todos os alvos sejam iguais', t => {
  const f = fixture(t); register(f); scope(f);
  f.git('commit', '--allow-empty', '-m', 'outro HEAD'); check(f, false, /HEAD/);
});
test('compara conjunto sujo inteiro e lista adições, remoções e hashes divergentes', t => {
  const f = fixture(t); register(f); scope(f);
  fs.writeFileSync(path.join(f.dir, 'arquivo novo com espaço.txt'), 'novo');
  fs.writeFileSync(path.join(f.dir, 'unitarios.log'), 'conteúdo posterior');
  fs.rmSync(path.join(f.dir, 'desktop.log'));
  const result = check(f, false, /dirty/);
  for (const name of ['arquivo novo com espaço.txt', 'unitarios.log', 'desktop.log']) assert.ok(result.motivos.some(m => m.includes(name)), name);
});
test('status porcelain inclui staged, renomeados, excluídos e nomes com whitespace final; exclui .dk inteiro', t => {
  const f = fixture(t); f.git('add', '.'); f.git('commit', '-m', 'entradas');
  manifest(f.dir, [{ id: 'g', arquivos: ['renomeado.txt'] }]); f.git('add', manifestFile); f.git('commit', '-m', 'manifesto renomeado');
  f.git('mv', 'alvo.txt', 'renomeado.txt'); fs.rmSync(path.join(f.dir, 'desktop.log'));
  fs.mkdirSync(path.join(f.dir, 'pasta')); fs.writeFileSync(path.join(f.dir, 'pasta', 'novo \n'), 'novo');
  fs.mkdirSync(path.join(f.dir, '.dk/plugins'), { recursive: true }); fs.writeFileSync(path.join(f.dir, '.dk/plugins/plugin.json'), '{}');
  const input = JSON.parse(fs.readFileSync(path.join(f.dir, 'registro.json')));
  input.alvos = ['renomeado.txt']; input.pacotes[0].arquivos = ['renomeado.txt']; input.testes.desktop.saida = 'unitarios.log';
  fs.writeFileSync(path.join(f.dir, 'registro.json'), JSON.stringify(input));
  const e = register(f);
  assert.ok(e.revisao.dirty.some(d => d.arquivo === 'pasta/novo \n'));
  assert.ok(e.revisao.dirty.some(d => d.arquivo === 'renomeado.txt'));
  assert.ok(e.revisao.dirty.some(d => d.arquivo === 'desktop.log' && d.sha256 === null));
  assert.ok(e.revisao.dirty.every(d => !d.arquivo.startsWith('.dk/')));
  scope(f); check(f, true);
  fs.writeFileSync(path.join(f.dir, '.dk/plugins/plugin.json'), '{"alterado":true}'); check(f, true);
});
test('alvo skip-worktree continua sujeito a SHA-256 com árvore limpa', t => {
  const f = fixture(t); f.git('add', '.'); f.git('commit', '-m', 'entradas'); register(f); scope(f);
  f.git('update-index', '--skip-worktree', 'alvo.txt'); fs.writeFileSync(path.join(f.dir, 'alvo.txt'), 'invisível ao status');
  assert.equal(f.git('status', '--porcelain', '--', ':!.dk'), ''); check(f, false, /SHA-256 divergente/);
});
test('aprovações recusam pipe sem TTY, mesmo recebendo o identificador correto', t => {
  const f = fixture(t); register(f); const original = fs.readFileSync(f.evidenceFile);
  for (const [command, args] of [
    ['revisar', ['--pacote', 'g', '--veredito', 'aprovado', '--revisor', 'Pessoa']],
    ['decisao-escopo', ['--autor', 'Pessoa', '--motivo', 'Escopo']],
    ['cli-oficial', ['--autorizado-por', 'pessoa@example.test', '--passo', 'P2=ok', '--passo', 'P3=ok', '--passo', 'P4=ok', '--passo', 'P5=ok']],
  ]) {
    const r = spawnSync(process.execPath, [registrar, command, coord, '--projeto', f.dir, ...args], { encoding: 'utf8', input: coord + '\n', env: humanEnv });
    assert.equal(r.status, 1); assert.match(r.stderr, /TTY interativo/); assert.deepEqual(fs.readFileSync(f.evidenceFile), original);
    const wrong = interactive(f, command, args, 'COORD-ERRADA');
    assert.equal(wrong.status, 1, wrong.stdout); assert.match(wrong.stdout, /Confirmação/); assert.deepEqual(fs.readFileSync(f.evidenceFile), original);
  }
});
test('FIFO em evidência, alvo ou runtime bloqueia em menos de 2 segundos', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); register(f); scope(f); const original = fs.readFileSync(f.evidenceFile);
  for (const file of [f.evidenceFile, path.join(f.dir, 'alvo.txt'), path.join(f.dir, '.dk/coordenacoes', coord + '.json')]) {
    fs.rmSync(file, { force: true }); execFileSync('mkfifo', [file]);
    const start = performance.now();
    const r = spawnSync(process.execPath, [gate, coord, '--projeto', f.dir, '--json'], { encoding: 'utf8', timeout: 1800 });
    assert.equal(r.error, undefined, r.error?.message); assert.equal(r.status, 1); assert.ok(performance.now() - start < 2000);
    assert.match(JSON.parse(r.stdout).motivos.join(' '), /arquivo regular/);
    fs.rmSync(file); if (file === f.evidenceFile) fs.writeFileSync(file, original); else if (file.endsWith('alvo.txt')) fs.writeFileSync(file, 'revisão inicial\n');
  }
});
test('M3 preserva inventário e snapshots de HEAD; aviso de regeneração fica em restricoes', () => {
  const current = JSON.parse(fs.readFileSync(path.join(root, 'docs/coordenacoes/M3-preview-bridge.json')));
  const head = JSON.parse(execFileSync('git', ['show', 'HEAD:docs/coordenacoes/M3-preview-bridge.json'], { cwd: root, encoding: 'utf8' }));
  const warning = 'regenerar o contrato M3 antes do despacho, depois que M2 entrar';
  assert.ok(current.restricoes.includes(warning));
  assert.match(fs.readFileSync(path.join(root, 'docs/coordenacoes/gerar.mjs'), 'utf8'), new RegExp(warning));
  for (const task of current.tarefas) {
    if (task.id === 'm3-anterior') continue;
    assert.deepEqual(task, head.tarefas.find(t => t.id === task.id));
  }
  assert.deepEqual({ ...current, tarefas: [], restricoes: current.restricoes.filter(r => r !== warning) }, { ...head, tarefas: [] });
});

test('gate exige ids exatos e arquivos canônicos do manifesto de HEAD, mesmo se disco e evidência forem reduzidos', t => {
  const f = fixture(t);
  manifest(f.dir, [{ id: 'a', arquivos: ['alvo.txt', 'unitarios.log'] }, { id: 'g', arquivos: ['alvo.txt'] }]);
  f.git('add', manifestFile); f.git('commit', '-m', 'pacotes completos');
  manifest(f.dir); // Uma lista reduzida no disco não é autoridade.
  register(f); scope(f); check(f, false, /a/);
  f.change(e => { e.pacotes.push({ ...e.pacotes[0], id: 'a' }); });
  check(f, false, /unitarios.log/);
  f.change(e => { e.pacotes.find(p => p.id === 'a').arquivos.push('unitarios.log'); });
  check(f, false, /unitarios.log/);
  f.change(e => { e.alvos.push({ arquivo: 'unitarios.log', sha256: sha(fs.readFileSync(path.join(f.dir, 'unitarios.log'))) }); });
  record(f, 'revisar', '--pacote', 'a', '--veredito', 'aprovado', '--revisor', 'independente');
  check(f, true);
  f.change(e => { e.pacotes.push({ ...e.pacotes[0], id: 'extra' }); });
  check(f, false, /extra/);
});
test('gate recusa manifesto ausente de HEAD mesmo existindo no disco', t => {
  const f = fixture(t); f.git('rm', '--cached', manifestFile); f.git('commit', '-m', 'sem manifesto');
  register(f); scope(f); check(f, false, /pacotes-M2.json/);
});
test('aprovações recusam todos os marcadores de agente mesmo com TTY e resposta correta', t => {
  const f = fixture(t); register(f); const original = fs.readFileSync(f.evidenceFile);
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'ANTIGRAVITY_AGENT', 'CLAUDE_CODE_FUTURO']) {
    for (const [command, args] of [
      ['decisao-escopo', ['--autor', 'Pessoa', '--motivo', 'Escopo']],
      ['cli-oficial', ['--autorizado-por', 'pessoa@example.test', '--limitacao', 'Não executada']],
      ['revisar', ['--pacote', 'g', '--veredito', 'aprovado', '--revisor', 'Pessoa']],
    ]) {
      const r = interactive(f, command, args, coord, { ...humanEnv, [key]: '' });
      assert.equal(r.status, 1, `${key}: ${r.stdout}`); assert.match(r.stdout, /agente/i);
      assert.doesNotMatch(r.stdout, /Confirme/); assert.deepEqual(fs.readFileSync(f.evidenceFile), original);
    }
  }
});
test('scripts declaram limites da evidência autodeclarada no topo', () => {
  for (const file of [registrar, gate]) {
    const header = fs.readFileSync(file, 'utf8').split('import fs')[0];
    assert.match(header, /evidência é autodeclarada/); assert.match(header, /orquestrador rodar o gate/);
    assert.match(header, /agentes não gravarem aprovações/); assert.match(header, /forjado à mão.*acesso ao disco/);
  }
});
test('flags skip-worktree, assume-unchanged e combinadas bloqueiam arquivos fora dos alvos', t => {
  const f = fixture(t); f.git('add', '.'); f.git('commit', '-m', 'entradas'); register(f); scope(f);
  const original = fs.readFileSync(f.evidenceFile);
  for (const flags of [['--skip-worktree'], ['--assume-unchanged'], ['--skip-worktree', '--assume-unchanged']]) {
    for (const flag of flags) f.git('update-index', flag, 'desktop.log', 'unitarios.log');
    const result = check(f, false, /skip-worktree|assume-unchanged/);
    for (const file of ['desktop.log', 'unitarios.log']) assert.ok(result.motivos.some(m => m.includes(file)));
    const r = spawnSync(process.execPath, [registrar, 'registrar', coord, '--projeto', f.dir, '--entrada', 'registro.json'], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /skip-worktree|assume-unchanged/);
    assert.deepEqual(fs.readFileSync(f.evidenceFile), original);
    f.git('update-index', '--no-skip-worktree', 'desktop.log', 'unitarios.log');
    f.git('update-index', '--no-assume-unchanged', 'desktop.log', 'unitarios.log');
  }
});

test('manifesto M2 versionado contém exatamente os pacotes a–g e seus arquivos autorizados', () => {
  const saved = JSON.parse(fs.readFileSync(path.join(root, manifestFile)));
  assert.equal(saved.schema_version, 1); assert.equal(saved.coordenacao, coord);
  assert.deepEqual(Object.fromEntries(saved.pacotes.map(p => [p.id, p.arquivos])), {
    a: ['electron/agent-run.cjs', 'tests/agent-run.test.cjs', 'tests/fixtures/agent-run/fake-claude.cjs', 'tests/fixtures/agent-run/claude-help.txt'],
    b: ['electron/prompt-compose.cjs', 'tests/prompt-compose.test.cjs'],
    c: ['electron/main.cjs', 'electron/preload.cjs', 'src/api.d.ts', 'electron/codex-chat.cjs', 'tests/m2-canais.test.cjs'],
    d: ['src/agent-run.ts', 'src/agent-run.css', 'src/main.ts', 'src/stages.ts'],
    e: ['tests/agent-run-desktop.cjs', 'package.json'],
    f: ['README.md', 'docs/planejamento/m2-rodada-manual.md'],
    g: ['scripts/gate-marco.mjs', 'scripts/evidencia-marco.mjs', 'tests/gate-marco.test.cjs', 'docs/coordenacoes/pacotes-M2.json', 'docs/coordenacoes/gerar.mjs', 'docs/coordenacoes/M3-preview-bridge.json'],
  });
  assert.equal(saved.pacotes.length, 7);
});
