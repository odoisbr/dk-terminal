const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { run, parseArgs, classify } = require('../dock-tools/dock-preview.cjs');
const { PreviewBridge } = require('../electron/preview-bridge.cjs');
const { FilePreviews } = require('../electron/file-preview.cjs');

const wrapper = path.resolve(__dirname, '..', 'dock-tools', 'bin', 'dock-preview');

function project(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-dock-preview-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'Projeto'), outside = path.join(temp, 'outro');
  fs.mkdirSync(path.join(root, 'prototipo'), { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'prototipo', 'index.html'), '<h1>ok</h1>');
  fs.writeFileSync(path.join(outside, 'fora.html'), '<h1>fora</h1>');
  fs.symlinkSync(path.join(outside, 'fora.html'), path.join(root, 'link.html'));
  return { temp, root, outside };
}
async function failure(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('O comando deveria falhar.');
}

test('argumentos: um alvo, título opcional e ajuda', () => {
  assert.deepEqual(parseArgs(['telas/', '--titulo', 'Fluxo de login']), { target: 'telas/', title: 'Fluxo de login' });
  assert.deepEqual(parseArgs(['--titulo=Home', 'index.html']), { target: 'index.html', title: 'Home' });
  assert.deepEqual(parseArgs(['--', '--estranho.html']), { target: '--estranho.html', title: undefined });
  assert.equal(parseArgs(['--help']).help, true);
  for (const argv of [[], ['a', 'b'], ['--titulo'], ['--x', 'a'], ['a', '--titulo', 'linha\nquebrada']]) assert.throws(() => parseArgs(argv), /^Error: ERRO: /);
});

test('endereços: só localhost; externo é recusado antes de falar com o app', () => {
  assert.deepEqual(classify('http://localhost:5173', '/p'), { url: 'http://localhost:5173/' });
  assert.deepEqual(classify('127.0.0.1:3000/app', '/p'), { url: 'http://127.0.0.1:3000/app' });
  assert.deepEqual(classify('prototipo/index.html', '/p'), { path: '/p/prototipo/index.html' });
  for (const target of ['https://example.com', 'http://192.168.0.10:8080/', 'file:///etc/passwd', 'http://user:senha@localhost:1/']) {
    assert.throws(() => classify(target, '/p'), error => /^ERRO: /.test(error.message) && error.code === 2, target);
  }
});

test('fora de uma sessão do SEA Dock, explica onde o comando funciona', async () => {
  const error = await failure(run(['index.html'], { env: {}, cwd: '/' }));
  assert.equal(error.code, 3);
  assert.match(error.message, /^ERRO: dock-preview só funciona dentro de uma sessão do SEA Dock/);
  assert.equal(error.message.includes('\n'), false);
});

test('arquivo fora do projeto ou por symlink externo é recusado com orientação', async t => {
  const { root, outside } = project(t);
  const env = { DK_TERMINAL_PREVIEW_PORT: '1', DK_TERMINAL_PREVIEW_TOKEN: 'a'.repeat(64), DK_TERMINAL_PROJECT: root };
  const send = async () => { throw new Error('não deveria chamar a ponte'); };
  for (const target of [path.join(outside, 'fora.html'), '../outro/fora.html', 'link.html']) {
    const error = await failure(run([target], { env, cwd: root, send }));
    assert.equal(error.code, 1);
    assert.match(error.message, /^ERRO: .* fica fora do projeto desta sessão/);
  }
  const missing = await failure(run(['nao-existe.html'], { env, cwd: root, send }));
  assert.match(missing.message, /^ERRO: arquivo ou pasta não encontrado/);
  const stopped = await failure(run(['http://127.0.0.1:9/'], { env, cwd: root, send, probe: async () => false }));
  assert.match(stopped.message, /^ERRO: nada responde em http:\/\/127\.0\.0\.1:9\/\. Inicie o servidor local/);
});

test('ponta a ponta com a ponte real: arquivo e endereço local abrem; sessão revogada orienta', async t => {
  const { root } = project(t);
  const opened = [];
  const previews = new FilePreviews(); t.after(() => previews.closeAll());
  const bridge = new PreviewBridge(event => { opened.push(event); bridge.finish(event.id, true); }, { resolvePath: (r, target) => previews.url(r, target) });
  await bridge.start(); t.after(() => bridge.close());
  const server = http.createServer((_q, s) => s.end('ok')); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const env = bridge.environment(root);
  const file = await run(['prototipo/index.html', '--titulo', 'Protótipo'], { env, cwd: root });
  assert.equal(file.code, 0);
  assert.match(file.line, /^OK: prévia aberta no navegador do SEA Dock \(Protótipo\): prototipo\/index\.html -> http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/prototipo\/index\.html$/);
  assert.equal(opened[0].title, 'Protótipo');
  const url = `http://127.0.0.1:${server.address().port}/`;
  const local = await run([url], { env, cwd: path.join(root, 'prototipo') });
  assert.equal(local.line, `OK: prévia aberta no navegador do SEA Dock: ${url} -> ${url}`);
  bridge.revoke(root);
  const revoked = await failure(run([url], { env, cwd: root }));
  assert.match(revoked.message, /^ERRO: esta sessão não é mais reconhecida pelo SEA Dock/);
  bridge.close();
  const closed = await failure(run([url], { env, cwd: root }));
  assert.match(closed.message, /^ERRO: o SEA Dock não está respondendo nesta sessão/);
});

test('o script sh usa o runtime do aplicativo empacotado como Node, sem herdar NODE_OPTIONS', { skip: process.platform === 'win32' }, async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-dock-wrapper-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const contents = path.join(temp, 'SEA Dock.app', 'Contents');
  const bin = path.join(contents, 'Resources', 'dock-tools', 'bin');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.join(contents, 'MacOS'));
  fs.copyFileSync(wrapper, path.join(bin, 'dock-preview')); fs.chmodSync(path.join(bin, 'dock-preview'), 0o755);
  fs.writeFileSync(path.join(contents, 'Resources', 'dock-tools', 'dock-preview.cjs'), '');
  const runtime = path.join(contents, 'MacOS', 'SEA Dock');
  fs.writeFileSync(runtime, '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$ELECTRON_RUN_AS_NODE" "${NODE_OPTIONS-unset}" "$1" "$2"\n'); fs.chmodSync(runtime, 0o755);
  const output = await new Promise((resolve, reject) => execFile(path.join(bin, 'dock-preview'), ['telas/'], { env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require /tmp/x.js' } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.equal(output.trim(), `1|unset|${bin}/../dock-preview.cjs|telas/`);
  fs.rmSync(runtime);
  const missing = await new Promise(resolve => execFile(path.join(bin, 'dock-preview'), ['x'], { env: { PATH: '/usr/bin:/bin' } }, (error, _out, stderr) => resolve({ code: error?.code, stderr })));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^ERRO: instalação do SEA Dock incompleta/);
});

test('no desenvolvimento, o script roda com o Electron do repositório e explica quando está fora do app', { skip: process.platform !== 'darwin' }, async () => {
  const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('DK_TERMINAL_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  const result = await new Promise(resolve => execFile(wrapper, ['index.html'], { env }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.equal(result.code, 3);
  assert.match(result.stderr, /^ERRO: dock-preview só funciona dentro de uma sessão do SEA Dock/);
  assert.equal(result.stderr.trim().split('\n').length, 1);
});
