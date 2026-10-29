const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DebugLog, redact, captureConsole } = require('../electron/debug-log.cjs');

const home = '/Users/fulano';
const temporary = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-debug-log-')));

test('redige tokens conhecidos, variáveis sensíveis e a pasta home', () => {
  const samples = [
    ['Authorization: Bearer abc.def-123', 'abc.def-123'],
    ['token sea_pat_AbC123_xyz usado', 'sea_pat_AbC123_xyz'],
    ['remoto glpat-AAAAbbbbCCCC1234', 'glpat-AAAAbbbbCCCC1234'],
    ['gh: ghp_0123456789abcdefABCDEF', 'ghp_0123456789abcdefABCDEF'],
    ['chave sk-ant-api03-secretvalue', 'sk-ant-api03-secretvalue'],
    ['DK_TERMINAL_PREVIEW_TOKEN=9f8e7d6c5b4a', '9f8e7d6c5b4a'],
    ['GITLAB_TOKEN: valor-secreto', 'valor-secreto'],
    ['{"clientSecret":"um segredo com espaços"}', 'um segredo com espaços'],
    ['DB_PASSWORD=hunter2 outra=1', 'hunter2'],
    ['OPENAI_API_KEY="k-123456"', 'k-123456'],
    ['https://usuario:senha123@gitlab.example.com/repo.git', 'senha123'],
    ['http://localhost:3000/cb?access_token=xyz987&ok=1', 'xyz987'],
  ];
  for (const [input, secret] of samples) {
    const output = redact(input, { homes: [home] });
    assert.ok(!output.includes(secret), `vazou ${secret} em ${output}`);
    assert.match(output, /REDACTED/);
  }
  assert.equal(redact('sea_pat_abc', {}), 'sea_pat_[REDACTED]');
  assert.equal(redact(`abrindo ${home}/Projetos/app e ${home}`, { homes: [home] }), 'abrindo ~/Projetos/app e ~');
  assert.equal(redact('/Users/fulanox/arquivo', { homes: [home] }), '/Users/fulanox/arquivo');
  assert.equal(redact('valor literal 0123456789abcdef aqui', { secrets: ['0123456789abcdef'] }), 'valor literal [REDACTED] aqui');
  assert.equal(redact('Serviço dev iniciado na porta 5173', { homes: [home] }), 'Serviço dev iniciado na porta 5173');
});

test('grava somente quando ligado, com cabeçalho e redação, e persiste a preferência', () => {
  const dir = temporary();
  try {
    const settingsFile = path.join(dir, 'debug.json');
    const log = new DebugLog({ directory: path.join(dir, 'logs'), settingsFile, homes: [home], secrets: () => ['segredo-literal-123'], header: () => ({ app: '1.0.0', macOS: '15.0', arch: 'arm64', electron: '45', node: '22' }), now: () => new Date(2026, 9, 29, 10, 0, 0) });
    assert.equal(log.enabled, false);
    assert.equal(log.event('teste', 'não grava'), false);
    assert.equal(fs.existsSync(path.join(dir, 'logs')), false);
    log.setEnabled(true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { enabled: true });
    log.error('main', `falha em ${home}/projeto com Bearer abcdef123 e segredo-literal-123`);
    const file = path.join(dir, 'logs', 'sea-dock-2026-10-29.log');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^=== SEA Dock .*app=1\.0\.0 · macOS=15\.0 · arch=arm64 · electron=45 · node=22 ===/);
    assert.match(text, /\[ERROR\] \[main\] falha em ~\/projeto com Bearer \[REDACTED\] e \[REDACTED\]/);
    assert.ok(!text.includes(home) && !text.includes('abcdef123') && !text.includes('segredo-literal-123'));
    assert.equal(new DebugLog({ directory: path.join(dir, 'logs'), settingsFile }).enabled, true);
    log.setEnabled(false);
    assert.equal(log.event('teste', 'depois de desligar'), false);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('depois de desligar'));
    const forced = new DebugLog({ directory: path.join(dir, 'logs'), settingsFile, forced: true });
    assert.equal(forced.enabled, true); assert.equal(forced.state().forced, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('roda arquivos ao atingir o limite e mantém no máximo cinco', () => {
  const dir = temporary();
  try {
    let tick = 0;
    const log = new DebugLog({ directory: dir, settingsFile: path.join(dir, 'debug.json'), forced: true, maxBytes: 2048, maxFiles: 5, now: () => new Date(2026, 9, 29, 10, 0, tick++ % 60) });
    const payload = 'x'.repeat(600);
    for (let index = 0; index < 60; index++) { log.event('carga', `${index} ${payload}`); }
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.log')).sort();
    assert.equal(files.length, 5, files.join(', '));
    for (const name of files) {
      assert.match(name, /^sea-dock-2026-10-29(?:-\d+)?\.log$/);
      assert.ok(fs.statSync(path.join(dir, name)).size <= 2048 + 1024, `${name} excedeu o limite`);
      assert.match(fs.readFileSync(path.join(dir, name), 'utf8'), /^=== SEA Dock/);
    }
    assert.match(fs.readFileSync(log.file, 'utf8'), /59 x+/);
    assert.ok(!files.includes('sea-dock-2026-10-29-2.log'), 'o arquivo mais antigo deveria ter sido removido');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('troca de arquivo quando muda o dia', () => {
  const dir = temporary();
  try {
    let day = 29;
    const log = new DebugLog({ directory: dir, settingsFile: path.join(dir, 'debug.json'), forced: true, now: () => new Date(2026, 9, day, 23, 0, 0) });
    log.event('a', 'primeiro dia'); day = 30; log.event('a', 'segundo dia');
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.log')).sort(), ['sea-dock-2026-10-29.log', 'sea-dock-2026-10-30.log']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('exporta os logs em zip no macOS ou txt nas demais plataformas', async () => {
  const dir = temporary();
  try {
    const log = new DebugLog({ directory: path.join(dir, 'logs'), settingsFile: path.join(dir, 'debug.json'), forced: true });
    await assert.rejects(() => log.exportTo(path.join(dir, 'saida')), /Ainda não há logs/);
    log.event('teste', 'conteúdo exportado');
    const text = await log.exportTo(path.join(dir, 'saida'), 'linux');
    assert.match(path.basename(text), /^sea-dock-logs-.*\.txt$/);
    assert.match(fs.readFileSync(text, 'utf8'), /conteúdo exportado/);
    if (process.platform === 'darwin') {
      const zip = await log.exportTo(path.join(dir, 'saida'), 'darwin');
      assert.match(path.basename(zip), /^sea-dock-logs-.*\.zip$/);
      assert.equal(fs.readFileSync(zip).subarray(0, 2).toString('latin1'), 'PK');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('console do processo principal continua escrevendo e também vai para o log', () => {
  const dir = temporary();
  try {
    const log = new DebugLog({ directory: dir, settingsFile: path.join(dir, 'debug.json'), forced: true });
    const seen = [];
    const fake = { log: (...a) => seen.push(['log', ...a]), info: () => {}, warn: () => {}, error: (...a) => seen.push(['error', ...a]), debug: () => {} };
    captureConsole(log, fake);
    fake.error('falhou', new Error('quebra'), { token: 'abc' });
    assert.equal(seen.length, 1);
    const text = fs.readFileSync(log.file, 'utf8');
    assert.match(text, /\[ERROR\] \[main\] falhou Error: quebra/);
    assert.ok(!text.includes("'abc'"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
