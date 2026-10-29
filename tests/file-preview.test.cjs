const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { FilePreviews, resolveTarget, renderMarkdown } = require('../electron/file-preview.cjs');

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-file-preview-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const project = path.join(temp, 'Projeto com espaços'), outside = path.join(temp, 'fora');
  fs.mkdirSync(path.join(project, 'prototipo'), { recursive: true });
  fs.mkdirSync(path.join(project, 'telas'));
  fs.mkdirSync(path.join(project, '.dk'));
  fs.mkdirSync(path.join(project, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'prototipo', 'index.html'), '<!doctype html><title>Protótipo</title><link rel="stylesheet" href="estilo.css"><h1>PROTOTIPO_OK</h1>');
  fs.writeFileSync(path.join(project, 'prototipo', 'estilo.css'), 'h1{color:red}');
  fs.writeFileSync(path.join(project, 'telas', 'login.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(project, 'telas', 'fluxo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(project, 'telas', '.rascunho.png'), 'x');
  fs.writeFileSync(path.join(project, 'visao.md'), '# Visão <script>alert(1)</script>\n\nTexto **forte** e [link](javascript:alert(1)) e `código <b>`.\n\n- item\n');
  fs.writeFileSync(path.join(project, '.dk', 'segredo.html'), 'segredo');
  fs.writeFileSync(path.join(project, 'node_modules', 'pkg', 'index.html'), 'dependência');
  fs.writeFileSync(path.join(project, 'dados.bin'), 'x');
  fs.writeFileSync(path.join(outside, 'secreto.html'), 'FORA_DO_PROJETO');
  fs.symlinkSync(path.join(outside, 'secreto.html'), path.join(project, 'atalho.html'));
  fs.symlinkSync(outside, path.join(project, 'pasta-externa'));
  return { project, outside };
}

function get(url, headers = {}, rawPath = null) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    http.get({ hostname: target.hostname, port: target.port, path: rawPath ?? target.pathname + target.search, headers }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on('error', reject);
  });
}

test('alvo de prévia precisa estar dentro do projeto, visível e com tipo apresentável', t => {
  const { project, outside } = fixture(t);
  assert.equal(resolveTarget(project, path.join(project, 'prototipo', 'index.html')).relative, path.join('prototipo', 'index.html'));
  assert.equal(resolveTarget(project, 'telas').directory, true);
  assert.equal(resolveTarget(project, project).relative, '');
  const refuse = (target, status, pattern) => assert.throws(() => resolveTarget(project, target), error => error.status === status && pattern.test(error.message));
  refuse(path.join(outside, 'secreto.html'), 403, /fora do projeto/);
  refuse(path.join(project, '..', 'fora', 'secreto.html'), 403, /fora do projeto/);
  refuse(path.join(project, 'atalho.html'), 403, /fora do projeto/);
  refuse(path.join(project, 'pasta-externa', 'secreto.html'), 403, /fora do projeto/);
  refuse(path.join(project, '.dk', 'segredo.html'), 403, /ocultos/);
  refuse(path.join(project, 'node_modules', 'pkg', 'index.html'), 403, /node_modules/);
  refuse(path.join(project, 'dados.bin'), 415, /Tipo de arquivo/);
  refuse(path.join(project, 'nao-existe.html'), 404, /não encontrado/);
  refuse('a\0b', 400, /inválido/);
});

test('servidor de arquivos serve o projeto atrás do prefixo secreto e revalida cada pedido', async t => {
  const { project } = fixture(t);
  const previews = new FilePreviews(); t.after(() => previews.closeAll());
  const page = await previews.url(project, path.join(project, 'prototipo', 'index.html'));
  const origin = new URL(page).origin, prefix = new URL(page).pathname.split('/')[1];
  assert.match(page, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/prototipo\/index\.html$/);
  const html = await get(page);
  assert.equal(html.status, 200);
  assert.match(html.body, /PROTOTIPO_OK/);
  assert.equal(html.headers['referrer-policy'], 'no-referrer');
  assert.equal((await get(`${origin}/${prefix}/prototipo/estilo.css`)).headers['content-type'], 'text/css; charset=utf-8');
  // Sem o prefixo, com Host diferente, por symlink externo, oculto ou node_modules: recusado.
  assert.equal((await get(`${origin}/prototipo/index.html`)).status, 404);
  assert.equal((await get(page, { host: `localhost:${new URL(page).port}` })).status, 403);
  assert.equal((await get(`${origin}/${prefix}/atalho.html`)).status, 403);
  assert.equal((await get(`${origin}/${prefix}/pasta-externa/secreto.html`)).status, 403);
  assert.equal((await get(`${origin}/${prefix}/.dk/segredo.html`)).status, 403);
  assert.equal((await get(`${origin}/${prefix}/node_modules/pkg/index.html`)).status, 403);
  assert.equal((await get(origin, {}, `/${prefix}/%2e%2e/%2e%2e/fora/secreto.html`)).status, 403);
  assert.equal((await get(origin, {}, `/${prefix}/..%2f..%2ffora%2fsecreto.html`)).status, 403);
  // A mesma porta atende os próximos pedidos do projeto.
  const folder = await previews.url(project, 'telas');
  assert.equal(new URL(folder).origin, origin);
  assert.ok(folder.endsWith('/telas/'));
  const listing = await get(folder);
  assert.equal(listing.status, 200);
  assert.match(listing.headers['content-security-policy'], /default-src 'none'/);
  assert.match(listing.body, /login\.png/);
  assert.match(listing.body, /fluxo\.svg/);
  assert.doesNotMatch(listing.body, /rascunho/);
  assert.equal((await get(`${origin}/${prefix}/telas`)).status, 301);
  assert.equal((await get(`${origin}/${prefix}/prototipo/`)).body.includes('PROTOTIPO_OK'), true);
  previews.close(project);
  await assert.rejects(get(page));
});

test('markdown é apresentado como HTML sem executar conteúdo do autor', async t => {
  const { project } = fixture(t);
  const body = renderMarkdown('# Título <img src=x onerror=alert(1)>\n\n[a](javascript:alert(1)) [b](docs/a.md)\n\n```\n<script>x</script>\n```');
  assert.doesNotMatch(body, /<img src=x/);
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /<a href="#">a<\/a>/);
  assert.match(body, /<a href="docs\/a\.md">b<\/a>/);
  const previews = new FilePreviews(); t.after(() => previews.closeAll());
  const page = await get(await previews.url(project, 'visao.md'));
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.body, /<strong>forte<\/strong>/);
  assert.match(page.body, /<code>código &lt;b&gt;<\/code>/);
  assert.doesNotMatch(page.body, /<script>alert/);
});
