'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocol = require('../electron/visual-protocol.cjs');
const { PRIVILEGES, documentCsp, documentUrl, createHandler, frameNavigationAllowed, isPreviewUrl } = protocol;

const TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER_TOKEN = 'fedcba9876543210fedcba9876543210';
const NONCE = 'MDEyMzQ1Njc4OWFiY2RlZg==';
const MIB = 1024 * 1024;
const COMMON = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};
const EXPECTED_CSP = `default-src 'none'; script-src 'nonce-${NONCE}'; style-src dk-preview://${TOKEN} 'unsafe-inline'; img-src dk-preview://${TOKEN} data:; font-src dk-preview://${TOKEN} data:; media-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors dk-app://app; sandbox allow-scripts`;

function write(root, relative, bytes) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function fakeSession(root, token = TOKEN, relative = 'pages/index.html') {
  root = fs.realpathSync(root);
  const { dev, ino } = fs.lstatSync(root);
  let generation = 1, requests = 0, bytes = 0;
  return {
    token, root, dev, ino, relative, gen: 1, nonce: NONCE,
    served: Buffer.from(`\ufeff<!doctype html>\r\n<p>cópia 🌊</p><script nonce="${NONCE}">bridge()</script>\r\n`),
    counted: [],
    document() { return Buffer.from(this.served); },
    countRequest(size) {
      if (generation !== this.gen) { generation = this.gen; requests = 0; bytes = 0; }
      this.counted.push(size);
      requests++;
      bytes += size;
      return requests <= 2000 && bytes <= 64 * MIB;
    },
  };
}

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-visual-protocol-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'projeto'), outside = path.join(temp, 'fora');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  write(root, 'pages/index.html', '<p>VERSÃO DO DISCO</p>');
  write(root, 'assets/site.css', 'body{color:red}');
  const session = fakeSession(root);
  const sessions = new Map([[TOKEN, session]]);
  return {
    temp, root, outside, session, sessions,
    handler: createHandler({ byToken: token => sessions.get(token) || null }),
    url: (relative = 'pages/index.html', query = '?g=1', token = TOKEN) => `dk-preview://${token}/${relative}${query}`,
  };
}

function request(url, initiatorOrigin = 'null', { raw = false, ...options } = {}) {
  const result = new Request(raw ? `dk-preview://${TOKEN}/raw` : url, options);
  // Request/URL already collapse dot segments. Keep a real Request while testing
  // the exact URL string supplied at the handler boundary, before that collapse.
  if (raw) Object.defineProperty(result, 'url', { value: url });
  result.initiatorOrigin = initiatorOrigin;
  return result;
}

async function checked(handler, req) {
  const result = await handler(req);
  assert.ok(result instanceof Response);
  assert.equal(result.headers.has('location'), false);
  assert.ok(result.status < 300 || result.status >= 400, `redirect: ${result.status}`);
  for (const [name, value] of Object.entries(COMMON)) assert.equal(result.headers.get(name), value);
  if (result.status >= 400) {
    assert.equal(await result.text(), '');
    assert.equal(result.headers.has('access-control-allow-origin'), false);
    assert.equal(result.headers.has('content-type'), false);
  }
  return result;
}

function get(f, url = documentUrl(f.session), initiator = 'dk-app://app', options) {
  return checked(f.handler, request(url, initiator, options));
}

test('API CommonJS e privilégios contêm somente o contrato M3-b', () => {
  assert.deepEqual(Object.keys(protocol).sort(), ['PRIVILEGES', 'createHandler', 'documentCsp', 'documentUrl', 'frameNavigationAllowed', 'isPreviewUrl'].sort());
  assert.deepEqual(PRIVILEGES, { scheme: 'dk-preview', privileges: { standard: true, secure: true, corsEnabled: true } });
});

test('CSP exata permite só a ponte com nonce e recursos locais, sem rede', () => {
  assert.equal(documentCsp(TOKEN, NONCE), EXPECTED_CSP);
  assert.equal(documentCsp(OTHER_TOKEN, 'novoNonce'), EXPECTED_CSP.replaceAll(TOKEN, OTHER_TOKEN).replace(NONCE, 'novoNonce'));
  const directives = new Map(EXPECTED_CSP.split('; ').map(d => { const [name, ...values] = d.split(' '); return [name, values]; }));
  for (const name of ['default-src', 'media-src', 'connect-src', 'frame-src', 'child-src', 'worker-src', 'object-src', 'manifest-src', 'form-action', 'base-uri']) {
    assert.deepEqual(directives.get(name), ["'none'"]);
  }
  assert.deepEqual(directives.get('script-src'), [`'nonce-${NONCE}'`]);
  assert.deepEqual(directives.get('sandbox'), ['allow-scripts']);
  assert.deepEqual(directives.get('frame-ancestors'), ['dk-app://app']);
  assert.doesNotMatch(EXPECTED_CSP, /https?:|wss?:|\*|'unsafe-eval'|allow-same-origin/);
});

test('documento vem da cópia em memória com bytes e headers exatos', async t => {
  const f = fixture(t);
  const response = await get(f);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.session.served);
  assert.deepEqual(Object.fromEntries(response.headers), {
    ...COMMON, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': EXPECTED_CSP,
  });
  assert.deepEqual(f.session.counted, [f.session.served.length]);
  fs.unlinkSync(path.join(f.root, f.session.relative));
  assert.equal((await get(f)).status, 200, 'document() não relê o HTML do disco');
});

test('somente o relativo da sessão é documento, inclusive .htm e nomes codificados', async t => {
  const f = fixture(t);
  f.session.relative = 'páginas com espaço/tela #1.htm';
  const url = documentUrl(f.session);
  assert.equal(url, f.url('p%C3%A1ginas%20com%20espa%C3%A7o/tela%20%231.htm'));
  assert.equal((await get(f, url)).status, 200);
  assert.equal(frameNavigationAllowed(url, f.session), true);
  for (const relative of ['pages/index.html', 'outro.html', 'outro.htm', 'outro.HTML']) {
    write(f.root, relative, '<p>outro documento</p>');
    for (const initiator of ['dk-app://app', 'null']) assert.equal((await get(f, f.url(relative), initiator)).status, 404);
  }
});

test('geração antiga, ausente, futura ou ambígua recebe 410; nova geração usa nova cópia e nonce', async t => {
  const f = fixture(t);
  assert.equal((await get(f)).status, 200);
  f.session.gen = 2;
  f.session.nonce = 'nonceDaGeracao2';
  f.session.served = Buffer.from('<p>geração 2</p>');
  for (const query of ['?g=1', '', '?g=', '?g=3', '?g=02', '?g=2.0', '?g=NaN', '?g=2&g=2', '?g=1&g=2']) {
    assert.equal((await get(f, f.url(undefined, query))).status, 410, query);
  }
  const current = await get(f, documentUrl(f.session));
  assert.equal(current.status, 200);
  assert.equal(await current.text(), '<p>geração 2</p>');
  assert.equal(current.headers.get('content-security-policy'), EXPECTED_CSP.replace(NONCE, f.session.nonce));
  assert.equal(f.session.counted.length, 2);
});

test('GET é o único método, incluindo recusa de POST, HEAD e OPTIONS', async t => {
  const f = fixture(t);
  assert.equal((await get(f)).status, 200);
  for (const method of ['POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
    for (const [url, origin] of [[f.url(), 'dk-app://app'], [f.url('assets/site.css', ''), 'null']]) {
      assert.equal((await get(f, url, origin, { method })).status, 405, method);
    }
  }
  assert.equal(f.session.counted.length, 1);
});

test('initiatorOrigin exige dk-app://app no documento e string null nos recursos', async t => {
  const f = fixture(t), asset = f.url('assets/site.css', '');
  assert.equal((await get(f)).status, 200);
  assert.equal((await get(f, asset, 'null')).status, 200);
  const wrong = [null, '', 'undefined', 'NULL', 'https://example.test', `dk-preview://${TOKEN}`, 'dk-app://outro', 'dk-app://app/'];
  for (const origin of [...wrong, 'null']) assert.equal((await get(f, f.url(), origin)).status, 404, String(origin));
  for (const origin of [...wrong, 'dk-app://app']) assert.equal((await get(f, asset, origin)).status, 404, String(origin));
  for (const url of [f.url(), asset]) {
    const missing = new Request(url);
    assert.equal((await checked(f.handler, missing)).status, 404);
    const forgedHeaders = new Request(url, { headers: { Origin: 'null', 'Sec-Fetch-Dest': 'style', 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal((await checked(f.handler, forgedHeaders)).status, 404, 'headers não substituem initiatorOrigin');
  }
});

test('token ausente, desconhecido ou revogado e aliases de autoridade são recusados', async t => {
  const f = fixture(t);
  assert.equal((await get(f)).status, 200);
  for (const url of [
    f.url(undefined, '?g=1', OTHER_TOKEN), f.url(undefined, '?g=1', 'curto'),
    `dk-preview://user@${TOKEN}/pages/index.html?g=1`,
    `dk-preview://user:pass@${TOKEN}/pages/index.html?g=1`,
    `dk-preview://${TOKEN}:80/pages/index.html?g=1`,
    `dk-preview://${TOKEN}./pages/index.html?g=1`,
    `dk-preview://${TOKEN.toUpperCase()}/pages/index.html?g=1`,
    `dk-preview://%30${TOKEN.slice(1)}/pages/index.html?g=1`,
    'dk-preview:///pages/index.html?g=1', 'dk-app://app/pages/index.html?g=1',
  ]) assert.equal((await get(f, url, 'dk-app://app', { raw: true })).status, 404, url);
  f.sessions.delete(TOKEN);
  assert.equal((await get(f)).status, 404);
  assert.equal((await get(f, f.url('assets/site.css', ''), 'null')).status, 404);
  f.sessions.set(TOKEN, { ...f.session, token: OTHER_TOKEN });
  assert.equal((await get(f)).status, 404, 'resultado do lookup precisa corresponder ao host');
});

test('tokens de sessões diferentes só resolvem seus próprios documentos, raízes e gerações', async t => {
  const f = fixture(t);
  const other = fakeSession(f.outside, OTHER_TOKEN, 'other.html');
  other.gen = 8;
  other.served = Buffer.from('<p>outra sessão</p>');
  f.sessions.set(OTHER_TOKEN, other);
  write(f.outside, 'other.css', 'outro');
  write(f.root, 'only-here.css', 'local');
  const own = await get(f, documentUrl(other));
  assert.equal(own.status, 200);
  assert.equal(await own.text(), '<p>outra sessão</p>');
  assert.equal((await get(f, f.url('other.css', '', OTHER_TOKEN), 'null')).status, 200);
  assert.equal((await get(f, f.url('only-here.css', '', OTHER_TOKEN), 'null')).status, 404);
  assert.equal((await get(f, f.url('other.css', ''), 'null')).status, 404);
  assert.equal((await get(f, f.url('pages/index.html', '?g=1', OTHER_TOKEN))).status, 404);
  assert.equal((await get(f, f.url('other.html', '?g=1', OTHER_TOKEN))).status, 410);
  assert.equal(frameNavigationAllowed(f.url('other.html', '?g=8', OTHER_TOKEN), f.session), false);
});

const ASSETS = [
  ['css', 'text/css'], ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'], ['webp', 'image/webp'], ['svg', 'image/svg+xml'],
  ['woff', 'font/woff'], ['woff2', 'font/woff2'], ['ttf', 'font/ttf'], ['otf', 'font/otf'],
];
for (const [extension, mime] of ASSETS) {
  test(`MIME e bytes de .${extension}; CSP só no SVG e CORS só em fonte`, async t => {
    const f = fixture(t), relative = `assets/recurso.${extension}`;
    const bytes = Buffer.from([0, 1, 2, 0xff, 0x80]);
    write(f.root, relative, bytes);
    const response = await get(f, f.url(relative, '?cache=1'), 'null');
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.deepEqual(Object.fromEntries(response.headers), {
      ...COMMON, 'content-type': mime,
      ...(extension === 'svg' ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
      ...(mime.startsWith('font/') ? { 'access-control-allow-origin': '*' } : {}),
    });
    assert.deepEqual(f.session.counted, [bytes.length]);
    assert.equal((await get(f, f.url(relative, ''), 'dk-app://app')).status, 404);
  });
}

test('recursos aceitam espaços, Unicode e extensão maiúscula, decodificando uma vez', async t => {
  const f = fixture(t);
  write(f.root, 'estilos/ação #+?.CSS', 'p{color:blue}');
  const response = await get(f, f.url('estilos/a%C3%A7%C3%A3o%20%23%2B%3F.CSS', ''), 'null');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/css');
  assert.equal(await response.text(), 'p{color:blue}');
  // Esses padrões na query não são parte do caminho do arquivo.
  assert.equal((await get(f, f.url('assets/site.css', '?q=%2e%2f%5c%00//'), 'null')).status, 200);
});

test('extensões fora da lista, HTML adicional, arquivo ausente e pasta recebem 404 sem redirecionar', async t => {
  const f = fixture(t);
  for (const relative of ['script.js', 'module.mjs', 'dados.json', 'text.txt', 'video.mp4', 'audio.mp3', 'icon.ico', 'image.avif', 'font.eot', 'other.html', 'other.htm', 'other.xhtml', 'sem-extensao']) {
    write(f.root, relative, 'não servir');
    assert.equal((await get(f, f.url(relative, ''), 'null')).status, 404, relative);
  }
  fs.mkdirSync(path.join(f.root, 'directory.css'));
  for (const relative of ['missing.css', 'directory.css', 'pages']) assert.equal((await get(f, f.url(relative, ''), 'null')).status, 404);
});

test('URL bruta recusa codificações maliciosas, separadores e traversal antes de normalizar', async t => {
  const f = fixture(t);
  assert.equal((await get(f, f.url('assets/site.css', ''), 'null')).status, 200);
  for (const relative of [
    '%2e%2e/assets/site.css', '%2E%2E/assets/site.css', 'assets/%2e/site.css', 'assets/site%2ecss',
    'assets%2fsite.css', 'assets%2Fsite.css', 'assets%5csite.css', 'assets%5Csite.css',
    'assets/site.css%00', 'assets//site.css', '/assets/site.css', 'assets\\site.css',
    'assets/./site.css', 'assets/../assets/site.css', '../assets/site.css',
    'assets/%252e%252e/site.css', 'assets/%252E/site.css', 'assets%252fsite.css',
    'assets%255csite.css', 'assets/site.css%2500', 'assets/%25site.css',
    'assets/\0site.css', 'C:/assets/site.css', 'C:%2fassets/site.css',
    'assets/.hidden.css', '.private/site.css', 'node_modules/pkg/site.css',
    'assets/node_modules/site.css', 'NODE_MODULES/site.css', 'assets/%6eode_modules/site.css',
  ]) {
    const response = await get(f, f.url(relative, ''), 'null', { raw: true });
    assert.ok([400, 404].includes(response.status), `${relative}: ${response.status}`);
  }
  assert.equal(f.session.counted.length, 1);
});

test('escape percentual inválido ou UTF-8 inválido dá 400 e URL inválida nunca lança', async t => {
  const f = fixture(t);
  for (const relative of ['bad%.css', 'bad%2.css', 'bad%GG.css', '%C3%28.css', '%FF.css', '%ED%A0%80.css']) {
    assert.equal((await get(f, f.url(relative, ''), 'null', { raw: true })).status, 400, relative);
  }
  for (const url of ['', 'not a URL', 'dk-preview:', 'dk-preview://[bad]/site.css', `dk-preview://${TOKEN}/a\nb.css`]) {
    const response = await get(f, url, 'null', { raw: true });
    assert.ok([400, 404].includes(response.status));
  }
});

test('arquivos ocultos e node_modules existem mas não podem ser lidos, nem por symlink', async t => {
  const f = fixture(t);
  for (const relative of ['.hidden.css', '.private/site.css', 'node_modules/pkg/site.css', 'assets/.hidden.css']) {
    const target = write(f.root, relative, 'segredo');
    const alias = `alias-${f.session.counted.length}-${relative.replaceAll('/', '-')}.css`;
    fs.symlinkSync(target, path.join(f.root, alias));
    assert.ok([400, 404].includes((await get(f, f.url(relative, ''), 'null')).status));
    assert.equal((await get(f, f.url(alias, ''), 'null')).status, 404);
  }
  assert.deepEqual(f.session.counted, [0, 0, 0, 0]);
});

test('NFKC e caixa bloqueiam node_moduleſ e ocultos na URL e no alvo real', async t => {
  const f = fixture(t);
  const paths = [
    'node_module\u017f/pkg/site.css', 'NoDe_MoDuLeS/pkg/site.css',
    '\uff4eode_modules/pkg/site.css', '\uff0ehidden/site.css', '\u2024private/site.css',
    '.\u212a/site.css', '.cafe\u0301/site.css', '.MiXeD/site.css',
  ];
  const aliases = paths.map((relative, i) => {
    const target = write(f.root, relative, 'segredo');
    const alias = `unicode-${i}.css`;
    fs.symlinkSync(target, path.join(f.root, alias));
    return alias;
  });
  const open = t.mock.method(fs, 'openSync'), read = t.mock.method(fs, 'readSync');
  const native = t.mock.method(fs.realpathSync, 'native');
  for (const [i, relative] of paths.entries()) {
    const encoded = relative.split('/').map(encodeURIComponent).join('/');
    assert.equal((await get(f, f.url(encoded, ''), 'null')).status, 400, relative);
    assert.equal((await get(f, f.url(aliases[i], ''), 'null')).status, 404, relative);
  }
  assert.ok(native.mock.callCount() >= paths.length, 'alvos são conferidos pelo realpath nativo');
  assert.equal(open.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
  assert.deepEqual(f.session.counted, paths.map(() => 0));
});

test('nome nativo é filtrado mesmo quando resolveFile mantém um alias do filesystem', async t => {
  const f = fixture(t), lexical = path.join(f.root, 'assets/site.css');
  const hidden = write(f.root, '.private/site.css', 'segredo');
  const nativeRealpath = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, 'native', (file, ...args) => file === lexical ? hidden : nativeRealpath(file, ...args));
  const open = t.mock.method(fs, 'openSync'), read = t.mock.method(fs, 'readSync');
  assert.equal((await get(f, f.url('assets/site.css', ''), 'null')).status, 404);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
  assert.deepEqual(f.session.counted, [0]);
});

test('acentos, NFD, Kelvin U+212A e caixa mista continuam válidos fora dos nomes bloqueados', async t => {
  const f = fixture(t);
  for (const relative of ['estilos/ação.css', 'cafe\u0301/ac\u0327a\u0303o.CSS', '\u212a/site.css', 'AsSeTs/Cor.CSS', 'pa\u017fta/site.css']) {
    write(f.root, relative, 'p{color:blue}');
    const encoded = relative.split('/').map(encodeURIComponent).join('/');
    const response = await get(f, f.url(encoded, ''), 'null');
    assert.equal(response.status, 200, relative);
    assert.equal(response.headers.get('content-type'), 'text/css');
    assert.equal(await response.text(), 'p{color:blue}');
  }
});

test('symlinks exigem MIME equivalente no alvo real e respeitam o limite antes de abrir', async t => {
  const f = fixture(t);
  const refused = [
    ['html.css', 'target.html'], ['text.png', 'target.txt'],
    ['css.png', 'target.css'], ['image.css', 'target.png'],
    ['svg.png', 'target.svg'], ['image.svg', 'target.png'],
    ['font.woff2', 'target.png'], ['font.woff', 'target.ttf'],
  ];
  for (const [alias, relative] of refused) {
    const target = write(f.root, relative, 'conteúdo');
    fs.symlinkSync(target, path.join(f.root, alias));
  }
  const large = write(f.root, 'large-real.css', Buffer.alloc(MIB + 1));
  for (const alias of ['large-alias.css', 'large-alias.png']) fs.symlinkSync(large, path.join(f.root, alias));
  const open = t.mock.method(fs, 'openSync'), read = t.mock.method(fs, 'readSync');
  for (const relative of [...refused.map(([alias]) => alias), 'large-alias.css', 'large-alias.png']) {
    assert.equal((await get(f, f.url(relative, ''), 'null')).status, 404, relative);
  }
  assert.equal(open.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
  assert.deepEqual(f.session.counted, Array(refused.length + 2).fill(0));
  t.mock.restoreAll();
  const jpeg = write(f.root, 'real.JPEG', 'jpeg');
  fs.symlinkSync(jpeg, path.join(f.root, 'alias.jpg'));
  const response = await get(f, f.url('alias.jpg', ''), 'null');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(await response.text(), 'jpeg');
});

test('symlink interno permanece contido; arquivo e diretório externos são recusados', async t => {
  const f = fixture(t);
  fs.symlinkSync('assets/site.css', path.join(f.root, 'internal.css'));
  const internal = await get(f, f.url('internal.css', ''), 'null');
  assert.equal(internal.status, 200);
  assert.equal(await internal.text(), 'body{color:red}');
  write(f.outside, 'secret.css', 'FORA DA RAIZ');
  fs.symlinkSync(path.join(f.outside, 'secret.css'), path.join(f.root, 'external.css'));
  fs.symlinkSync(f.outside, path.join(f.root, 'external'));
  for (const relative of ['external.css', 'external/secret.css']) {
    assert.equal((await get(f, f.url(relative, ''), 'null')).status, 404);
  }
});

test('troca da raiz por outra pasta, symlink ou arquivo invalida documento e recursos', async t => {
  const f = fixture(t), asset = f.url('assets/site.css', '');
  assert.equal((await get(f, asset, 'null')).status, 200);
  const old = path.join(f.temp, 'original');
  fs.renameSync(f.root, old);
  fs.mkdirSync(f.root);
  write(f.root, 'assets/site.css', 'raiz substituída');
  assert.notEqual(fs.lstatSync(f.root).ino, f.session.ino);
  assert.equal((await get(f, asset, 'null')).status, 404);
  assert.equal((await get(f)).status, 404);
  fs.rmSync(f.root, { recursive: true });
  fs.symlinkSync(old, f.root);
  assert.equal((await get(f, asset, 'null')).status, 404);
  fs.unlinkSync(f.root);
  fs.writeFileSync(f.root, 'não é pasta');
  assert.equal((await get(f, asset, 'null')).status, 404);
});

test('dev e ino são conferidos separadamente, incluindo raiz ausente', async t => {
  const f = fixture(t), asset = f.url('assets/site.css', '');
  const { dev, ino } = f.session;
  f.session.dev = dev + 1;
  assert.equal((await get(f, asset, 'null')).status, 404);
  f.session.dev = dev;
  f.session.ino = ino + 1;
  assert.equal((await get(f, asset, 'null')).status, 404);
  f.session.ino = ino;
  assert.equal((await get(f, asset, 'null')).status, 200);
  fs.rmSync(f.root, { recursive: true });
  assert.equal((await get(f, asset, 'null')).status, 404);
});

test('readBounded usa O_NOFOLLOW e recusa symlink inserido depois de resolveFile', async t => {
  const f = fixture(t), target = path.join(f.root, 'assets/site.css');
  const secret = write(f.outside, 'secret.css', 'SEGREDO');
  const open = fs.openSync;
  let opens = 0;
  t.mock.method(fs, 'openSync', (file, flags, mode) => {
    if (file === target) {
      opens++;
      assert.equal(flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
      fs.unlinkSync(target);
      fs.symlinkSync(secret, target);
    }
    return open(file, flags, mode);
  });
  assert.equal((await get(f, f.url('assets/site.css', ''), 'null')).status, 404);
  assert.equal(opens, 1);
  assert.deepEqual(f.session.counted, [Buffer.byteLength('body{color:red}')]);
});

test('raiz é revalidada depois da leitura', async t => {
  const f = fixture(t), read = fs.readSync;
  let swapped = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const result = read(...args);
    if (!swapped) {
      swapped = true;
      fs.renameSync(f.root, path.join(f.temp, 'original'));
      fs.mkdirSync(f.root);
    }
    return result;
  });
  assert.equal((await get(f, f.url('assets/site.css', ''), 'null')).status, 404);
  assert.equal(swapped, true);
  assert.deepEqual(f.session.counted, [Buffer.byteLength('body{color:red}')]);
});

test('crescimento após resolveFile não pode ler bytes além da reserva', async t => {
  const f = fixture(t), target = write(f.root, 'growing.png', 'a');
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    const result = stat(file, ...args);
    if (file === target) fs.appendFileSync(target, 'b');
    return result;
  });
  const read = t.mock.method(fs, 'readSync');
  assert.equal((await get(f, f.url('growing.png', ''), 'null')).status, 404);
  assert.deepEqual(f.session.counted, [1]);
  assert.equal(read.mock.callCount(), 0);
});

for (const [extension] of ASSETS) {
  test(`limite .${extension}: aceita exatamente ${extension === 'css' ? 1 : 4} MiB e recusa um byte a mais`, async t => {
    const f = fixture(t), limit = (extension === 'css' ? 1 : 4) * MIB;
    const relative = `large.${extension}`, bytes = Buffer.alloc(limit, 65);
    const target = write(f.root, relative, bytes);
    const response = await get(f, f.url(relative, ''), 'null');
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    fs.appendFileSync(target, 'x');
    assert.equal((await get(f, f.url(relative, ''), 'null')).status, 404);
    assert.deepEqual(f.session.counted, [limit, 0]);
  });
}

test('recursos vazios são válidos e contam um pedido de zero bytes', async t => {
  const f = fixture(t);
  write(f.root, 'empty.css', '');
  const response = await get(f, f.url('empty.css', ''), 'null');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.deepEqual(f.session.counted, [0]);
});

test('orçamento inclui documento e recursos: 2000 pedidos passam, 2001 dá 429 até nova geração', async t => {
  const f = fixture(t);
  write(f.root, 'empty.css', '');
  assert.equal((await get(f)).status, 200);
  for (let i = 1; i < 2000; i++) assert.equal((await get(f, f.url('empty.css', ''), 'null')).status, 200, String(i));
  const open = t.mock.method(fs, 'openSync'), read = t.mock.method(fs, 'readSync');
  assert.equal((await get(f, f.url('empty.css', ''), 'null')).status, 429);
  assert.equal((await get(f)).status, 429);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
  f.session.gen++;
  assert.equal((await get(f, f.url(undefined, '?g=2'))).status, 200);
  assert.equal((await get(f, f.url('empty.css', ''), 'null')).status, 200);
});

test('orçamento de bytes aceita 64 MiB e devolve 429 ao exceder', async t => {
  const f = fixture(t);
  write(f.root, 'large.png', Buffer.alloc(4 * MIB, 65));
  write(f.root, 'one.woff2', 'x');
  // Inclui bytes do documento na mesma soma sem ultrapassar seu limite de origem.
  f.session.served = Buffer.alloc(MIB, 65);
  for (let i = 0; i < 4; i++) {
    const response = await get(f);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  for (let i = 0; i < 15; i++) {
    const response = await get(f, f.url('large.png', ''), 'null');
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  assert.equal(f.session.counted.reduce((sum, size) => sum + size, 0), 64 * MIB);
  const open = t.mock.method(fs, 'openSync'), read = t.mock.method(fs, 'readSync');
  // The very request that exceeds the byte budget must not open or read anything.
  assert.equal((await get(f, f.url('one.woff2', ''), 'null')).status, 429);
  for (let i = 0; i < 20; i++) assert.equal((await get(f, f.url('large.png', `?${i}`), 'null')).status, 429);
  assert.equal((await get(f)).status, 429);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
  f.session.gen++;
  assert.equal((await get(f, f.url('one.woff2', ''), 'null')).status, 200);
  assert.equal(open.mock.callCount(), 1);
  assert.ok(read.mock.callCount() > 0);
});

test('404 conta zero bytes e esgotamento interrompe stat/realpath até a próxima geração', async t => {
  const f = fixture(t);
  // The interface may return fresh objects sharing the same session budget.
  f.handler = createHandler({ byToken: token => token === TOKEN ? {
    ...f.session, countRequest: size => f.session.countRequest(size),
  } : null });
  for (let i = 0; i < 2000; i++) {
    assert.equal((await get(f, f.url(`missing-${i}.css`, ''), 'null')).status, 404);
  }
  assert.deepEqual(f.session.counted, Array(2000).fill(0));
  assert.equal((await get(f, f.url('missing.css', ''), 'null')).status, 429);
  assert.deepEqual(f.session.counted, Array(2001).fill(0));
  const spies = [
    t.mock.method(fs.realpathSync, 'native'), t.mock.method(fs, 'realpathSync'),
    ...['statSync', 'lstatSync', 'openSync', 'readSync'].map(name => t.mock.method(fs, name)),
    t.mock.method(f.session, 'document'),
  ];
  for (const relative of ['missing.css', 'assets/site.css', 'other.html']) {
    assert.equal((await get(f, f.url(relative, ''), 'null')).status, 429);
  }
  assert.equal((await get(f)).status, 429);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
  t.mock.restoreAll();
  f.session.gen++;
  assert.equal((await get(f, f.url('missing.css', ''), 'null')).status, 404);
  assert.equal((await get(f, f.url('assets/site.css', ''), 'null')).status, 200);
  assert.equal((await get(f)).status, 200);
});

test('exceções internas não vazam detalhes nem rejeitam a Promise', async t => {
  const f = fixture(t), fail = () => { throw new Error(`SEGREDO ${f.root}`); };
  assert.equal((await checked(createHandler({ byToken: fail }), request(f.url(), 'dk-app://app'))).status, 404);
  const document = f.session.document;
  f.session.document = fail;
  assert.equal((await get(f)).status, 404);
  f.session.document = () => 'não é Buffer';
  assert.equal((await get(f)).status, 404);
  f.session.document = document;
  f.session.countRequest = fail;
  assert.equal((await get(f)).status, 404);
  assert.equal((await get(f, f.url('assets/site.css', ''), 'null')).status, 404);
  assert.equal((await get(f, f.url('missing.css', ''), 'null')).status, 404);
});

test('falha de leitura do arquivo recebe 404 sem detalhes', async t => {
  const f = fixture(t);
  t.mock.method(fs, 'readSync', () => { throw new Error(`EACCES: ${f.root}`); });
  assert.equal((await get(f, f.url('assets/site.css', ''), 'null')).status, 404);
  assert.deepEqual(f.session.counted, [Buffer.byteLength('body{color:red}')], 'falha não cobra um segundo pedido');
});

test('documentUrl codifica POSIX uma vez e gera exatamente a URL aceita pela navegação', async t => {
  const f = fixture(t);
  for (const relative of ['pages/index.html', 'páginas/tela #1+?.htm', 'cafe\u0301/\u212a.HTML']) {
    for (const gen of [0, 1, Number.MAX_SAFE_INTEGER]) {
      Object.assign(f.session, { relative, gen });
      const url = documentUrl(f.session);
      assert.equal(new URL(url).search, `?g=${gen}`);
      assert.equal(decodeURIComponent(new URL(url).pathname.slice(1)), relative);
      assert.equal(frameNavigationAllowed(url, f.session), true);
      assert.equal((await get(f, url)).status, 200);
    }
  }
  for (const invalid of [
    null, undefined, {}, { ...f.session, token: 'invalid' },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', 1n].map(gen => ({ ...f.session, gen })),
    ...['../index.html', '/index.html', '.hidden.html', 'node_module\u017f/a.html', 'a%20b.html'].map(relative => ({ ...f.session, relative })),
  ]) {
    assert.throws(() => documentUrl(invalid), TypeError);
    assert.equal(frameNavigationAllowed(f.url(), invalid), false);
  }
});

test('frameNavigationAllowed aceita só a URL exata do documento da geração atual', t => {
  const f = fixture(t), current = documentUrl(f.session);
  assert.equal(frameNavigationAllowed(current, f.session), true);
  for (const url of [
    f.url(undefined, '?g=0'), f.url(undefined, '?g=2'), f.url(undefined, ''),
    f.url(undefined, '?g=01'), current + '#anchor', current + '&other=1', current + '&g=1',
    f.url('assets/site.css'), f.url('other.html'), f.url(undefined, '?g=1', OTHER_TOKEN),
    current.replace('index.html', '%69ndex.html'), current.replace('/pages/', '/pages/./'),
    current.replace('/pages/', '/pages//'), current.replace('dk-preview:', 'DK-PREVIEW:'),
    current.replace('dk-preview:', 'https:'), 'about:blank', 'data:text/html,hi', '', null, {},
  ]) assert.equal(frameNavigationAllowed(url, f.session), false, String(url));
  assert.equal(frameNavigationAllowed(current, null), false);
  assert.equal(frameNavigationAllowed(current, {}), false);
  for (const relative of ['../index.html', '/index.html', '.hidden.html', 'node_modules/index.html', 'a\\index.html', 'a%20b.html']) {
    assert.equal(frameNavigationAllowed(f.url(relative), { ...f.session, relative }), false);
  }
  f.session.gen++;
  assert.equal(frameNavigationAllowed(current, f.session), false);
  assert.equal(frameNavigationAllowed(documentUrl(f.session), f.session), true);
});

test('isPreviewUrl reconhece o esquema para download sem autorizar o conteúdo', () => {
  for (const url of [`dk-preview://${TOKEN}/pages/index.html?g=1`, 'DK-PREVIEW://unknown/file.bin', 'dk-preview:opaque', 'dk-preview://revoked/other.html']) {
    assert.equal(isPreviewUrl(url), true, url);
  }
  for (const url of ['https://example.test/dk-preview:', 'dk-app://app/index.html', 'not a URL', '/dk-preview:', 'file:///tmp/a', '', null, undefined, 123, {}]) {
    assert.equal(isPreviewUrl(url), false, String(url));
  }
});

test('index.html acrescenta frame-src dk-preview: mantendo as demais diretivas', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const meta = index.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(meta);
  assert.equal(meta[1], "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src dk-preview:");
});

test('raiz aberta com outra grafia de caixa continua servindo sub-recursos', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-preview-caixa-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, 'Projéto');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'a.css'), 'b{}');
  const alias = path.join(base, 'PROJÉTO');
  if (!fs.existsSync(alias)) return t.skip('sistema de arquivos diferencia caixa');
  const root = fs.realpathSync(alias);
  const stat = fs.lstatSync(root);
  const session = { token: TOKEN, root, dev: stat.dev, ino: stat.ino, relative: 'index.html', gen: 0, nonce: NONCE, document: () => Buffer.from('x'), countRequest: () => true };
  const handler = createHandler({ byToken: token => (token === TOKEN ? session : null) });
  const request = new Request(`dk-preview://${TOKEN}/a.css`);
  request.initiatorOrigin = 'null';
  assert.equal((await handler(request)).status, 200);
});
