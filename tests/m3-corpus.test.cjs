const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

// Os dois casos de 2 MiB não são versionados: o gerador os recria quando faltam.
for (const nome of ['limite-2-mib.html', 'limite-2-mib-mais-um.html']) {
  if (!fs.existsSync(path.join(__dirname, 'fixtures', 'm3-corpus', nome))) {
    require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'm3-corpus', 'gerar.cjs')]);
    break;
  }
}

const pasta = path.join(__dirname, 'fixtures/m3-corpus');
const manifesto = JSON.parse(fs.readFileSync(path.join(pasta, 'manifesto.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ler = entrada => fs.readFileSync(path.join(pasta, entrada.arquivo));

// Checklist independente do gerador, transcrito de Testes / Corpus de bytes
// e D7 em registros/M3/m3-desenho.md (30/10/2026). Não depende do registro
// externo estar presente em outra máquina. Cada item exige bytes testemunhais.
// Não é um parser HTML nem prova de prepare/encode/Chromium, ainda inexistentes
// nesta POC: editabilidade, avisos e quirks são expectativas para esses testes.
const cobertura = {
  'bom-crlf': /^\uFEFF<!doctype html>\r\n<html>\r\n[\s\S]*<\/html>\r\n$/,
  'lf': /^<!doctype html>\n<html>\n[\s\S]*<\/html>\n$/,
  'eol-mistos': /^<!doctype html>\r\n<html>\n[\s\S]*<\/html>\r\n$/,
  'cr-solitario': /^<!doctype html>\r<html>\r[\s\S]*<\/html>\r$/,
  'sem-doctype': /^<html><head><title>M3<\/title><\/head><body>Quirks<\/body><\/html>$/,
  'doctype-legado': /^<!DOCTYPE HTML PUBLIC "-\/\/W3C\/\/DTD HTML 3\.2 Final\/\/EN">/,
  'comentarios-doctype-html': /^<!-- antes -->\n<!doctype html>[\s\S]*<\/html>\n<!-- depois -->$/,
  'entidades-nomeadas': /<p>&copy; &eacute; &lt; &gt; &amp;<\/p>/,
  'entidades-numericas': /<p>&#65; &#x41; &#128512; &#x1F600;<\/p>/,
  'entidade-sem-ponto-virgula': /<p>A &amp B<\/p>/,
  'entidade-nbsp': /<p>A&nbsp;B<\/p>/,
  'template': /<template><p>Somente leitura<\/p><\/template><p>Editável<\/p>/,
  'svg-style-title': /<svg[^>]*><style>circle \{ fill: red \}<\/style><title>Vetor<\/title><circle r="4"><\/circle><\/svg>/,
  'textarea': /<textarea>A &amp; B\n&lt;p&gt;<\/textarea>/,
  'title': /<head><title>A &amp; B &lt;p&gt;<\/title><\/head>/,
  'script': /<script>window\.autor = "<p>";<\/script><button onclick="window\.autor\+\+">/,
  'style': /<style>p::before \{ content: "<texto>"; \}<\/style>/,
  'noscript': /<noscript><p>Sem scripts<\/p><\/noscript>/,
  'xmp': /<xmp><b>literal &amp;<\/b><\/xmp>/,
  'tabela-sem-tbody': /<table><tr><td>Implícito<\/td><\/tr><\/table>/,
  'formatacao-cruzada': /<b><p>x<\/b><\/p>/,
  'atributos-sem-aspas': /<p id=alvo class=teste title=valor>/,
  'atributos-aspas-simples': /<p id='alvo' title='A &amp; B'>/,
  'atributos-duplicados': /<p id="primeiro" id="segundo" class="a" CLASS="b">/,
  'atributos-maiusculos': /<P ID="ALVO" CLASS="TESTE" TITLE="Título">Texto<\/P>/,
  'void': /<br>B<hr><img src="local\.png" alt="Imagem"><input disabled>/,
  'svg-auto-fechamento': /<svg[^>]*><path d="M0 0L1 1"\/><circle r="2" \/><\/svg>/,
  'css-comentario': /style="color: red; \/\* preservar \*\/ margin: 0"/,
  'css-url': /style="background-image: url\(imagem\.png\); color: red"/,
  'css-important': /style="color: red !important; margin: 0"/,
  'base': /<head><base href="https:\/\/example\.invalid\/">/,
  'meta-refresh': /<meta http-equiv="refresh" content="0;url=outra\.html">/,
  'charset-latin1': /<meta charset="latin1">[\s\S]*Bytes UTF-8: ação/,
  'charset-http-equiv-latin1': /<meta http-equiv="Content-Type" content="text\/html; charset=iso-8859-1">[\s\S]*Bytes UTF-8: ação/,
  'php-fora-comentario': /<body><\?php echo "M3"; \?><\/body>/,
  'asp-fora-comentario': /<body><% Response\.Write\("M3"\) %><\/body>/,
  'marcadores-em-comentario': /<!-- <\?php echo "M3"; \?> <% Response\.Write\("M3"\) %> -->/,
  'comentario-aberto': /<body><!-- sem fechamento$/,
  'textarea-aberto': /<body><textarea>aberto$/,
  'title-aberto': /<body><title>aberto$/,
  'script-aberto': /<body><script>aberto$/,
  'style-aberto': /<body><style>aberto$/,
  'noscript-aberto': /<body><noscript>aberto$/,
  'xmp-aberto': /<body><xmp>aberto$/,
  'iframe-aberto': /<body><iframe>aberto$/,
  'noembed-aberto': /<body><noembed>aberto$/,
  'noframes-aberto': /<body><noframes>aberto$/,
  'utf8-emoji': /<p>Olá, ação, 日本語, 😀 🧑🏽‍💻<\/p>/,
  'nul': /<p>A\0B<\/p>/,
  'latin1': /<p>a\xe7\xe3o caf\xe9<\/p>/,
  'limite-2-mib': /^<!doctype html><html><head><title>M3<\/title><\/head><body><p>x+<\/p><\/body><\/html>$/,
  'limite-2-mib-mais-um': /^<!doctype html><html><head><title>M3<\/title><\/head><body><p>x+<\/p><\/body><\/html>$/,
  'data-dk-node-autor': /<p data-dk-node="autor-7">Preservar<\/p>/,
  'noop-prepare-encode': /^\uFEFF<!-- antes -->\r\n<!doctype html>\n<html><head><title>😀 &amp;<\/title><\/head>\r\n<body><p ID='autor' data-dk-node="7">A&nbsp;B<\/p>\r<\/body><\/html><!-- depois -->$/,
  'extensao-txt': /<p>HTML em txt<\/p>/,
  'extensao-xhtml': /<p>HTML em xhtml<\/p>/,
  'frameset': /<frameset cols="50%,50%"><frame src="a\.html"><frame src="b\.html"><\/frameset>/,
  'plaintext': /<body><plaintext>literal <\/plaintext><\/body><\/html>$/,
  'editor-codigo-sujo': /<p>Alteração ainda não salva no editor de código<\/p>/,
  'interpolacao': /<p>\{\{ usuario\.nome \}\}<\/p>/,
};

const recusas = {
  'charset-latin1': 'meta-charset-nao-utf8',
  'charset-http-equiv-latin1': 'meta-charset-nao-utf8',
  'php-fora-comentario': 'instrucao-servidor',
  'asp-fora-comentario': 'instrucao-servidor',
  'comentario-aberto': 'comentario-aberto',
  'textarea-aberto': 'rcdata-aberto',
  'title-aberto': 'rcdata-aberto',
  'script-aberto': 'rawtext-aberto',
  'style-aberto': 'rawtext-aberto',
  'noscript-aberto': 'rawtext-aberto',
  'xmp-aberto': 'rawtext-aberto',
  'iframe-aberto': 'rawtext-aberto',
  'noembed-aberto': 'rawtext-aberto',
  'noframes-aberto': 'rawtext-aberto',
  'nul': 'nul',
  'latin1': 'nao-utf8',
  'limite-2-mib-mais-um': 'documento-maior-2-mib',
  'extensao-txt': 'extensao-nao-html',
  'extensao-xhtml': 'extensao-nao-html',
  'frameset': 'frameset',
  'plaintext': 'plaintext',
  'editor-codigo-sujo': 'editor-codigo-sujo',
};
const avisos = {
  'script': ['scripts'], 'script-aberto': ['scripts'],
  'base': ['base'], 'interpolacao': ['interpolacao'],
};

test('manifesto cobre cada caso de Corpus de bytes e as recusas/avisos de D7', () => {
  assert.ok(Array.isArray(manifesto));
  assert.equal(new Set(manifesto.map(e => e.caso)).size, manifesto.length, 'casos únicos');
  assert.equal(new Set(manifesto.map(e => e.arquivo)).size, manifesto.length, 'arquivos únicos');
  assert.deepEqual(manifesto.map(e => e.caso).sort(), Object.keys(cobertura).sort());
  assert.deepEqual(fs.readdirSync(pasta).sort(), ['gerar.cjs', 'manifesto.json', ...manifesto.map(e => e.arquivo)].sort());
  for (const entrada of manifesto) {
    const { arquivo, caso } = entrada;
    assert.match(arquivo, /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:html|txt|xhtml)$/);
    assert.equal(path.parse(arquivo).name, caso);
    assert.equal(path.extname(arquivo), caso === 'extensao-txt' ? '.txt' : caso === 'extensao-xhtml' ? '.xhtml' : '.html');
    assert.match(entrada.sha256, /^[a-f0-9]{64}$/);
    assert.equal(entrada.esperado, Object.hasOwn(recusas, caso) ? 'recusa' : 'editavel', caso);
    assert.equal(entrada.motivo_recusa, recusas[caso], caso);
    assert.equal(Object.hasOwn(entrada, 'motivo_recusa'), entrada.esperado === 'recusa', caso);
    assert.deepEqual(entrada.avisos, avisos[caso] || [], caso);
    assert.deepEqual(entrada.contexto, caso === 'editor-codigo-sujo' ? { editor_codigo_sujo: true } : undefined, caso);
    // Latin-1 deve ser inspecionado como Latin-1, sem decodificação com perdas.
    assert.match(ler(entrada).toString(caso === 'latin1' ? 'latin1' : 'utf8'), cobertura[caso], caso);
  }
});

test('gerar.cjs reproduz manifesto e bytes em diretório temporário, com sha256 por arquivo', t => {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-m3-corpus-'));
  t.after(() => fs.rmSync(destino, { recursive: true, force: true }));
  const resultado = spawnSync(process.execPath, [path.join(pasta, 'gerar.cjs'), destino], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(resultado.error);
  assert.equal(resultado.status, 0, resultado.stderr);
  assert.deepEqual(fs.readFileSync(path.join(destino, 'manifesto.json')), fs.readFileSync(path.join(pasta, 'manifesto.json')));
  assert.deepEqual(fs.readdirSync(destino).sort(), ['manifesto.json', ...manifesto.map(e => e.arquivo)].sort());
  for (const entrada of manifesto) {
    const original = ler(entrada);
    const regenerado = fs.readFileSync(path.join(destino, entrada.arquivo));
    assert.equal(sha256(original), entrada.sha256, entrada.arquivo);
    assert.equal(sha256(regenerado), entrada.sha256, entrada.arquivo);
    assert.deepEqual(regenerado, original, entrada.arquivo);
  }
});

// Medição independente, byte a byte: CR isolado é uma flag separada de EOL
// (D8). Sem LF/CRLF, eol assume 'lf'; CR isolado nunca é normalizado.
function medir(bytes) {
  let lf = 0, crlf = 0, loneCR = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      if (i > 0 && bytes[i - 1] === 0x0d) crlf++;
      else lf++;
    }
    if (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a) loneCR = true;
  }
  let utf8 = true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { utf8 = false; }
  const doctype = bytes.toString('latin1').match(/<!doctype\s[^>]*>/i)?.[0] || null;
  return {
    bom: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    eol: lf && crlf ? 'mixed' : crlf ? 'crlf' : 'lf', loneCR,
    doctype,
    // Apenas os doctypes deste corpus: HTML5, HTML 3.2 e ausente.
    quirks_esperado: doctype === null || doctype === '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">',
    nul: bytes.includes(0), utf8, tamanho: bytes.length,
  };
}

for (const entrada of manifesto) {
  test(`características declaradas conferem com os bytes: ${entrada.arquivo}`, () => {
    assert.deepEqual(entrada.caracteristicas, medir(ler(entrada)));
    assert.equal(entrada.caracteristicas.utf8, entrada.caso !== 'latin1');
    assert.equal(entrada.caracteristicas.nul, entrada.caso === 'nul');
    assert.equal(entrada.caracteristicas.bom, ['bom-crlf', 'noop-prepare-encode'].includes(entrada.caso));
  });
}

test('fronteira de D5/D7 é exatamente 2 MiB, medida em bytes', () => {
  for (const [caso, tamanho, esperado] of [
    ['limite-2-mib', 2097152, 'editavel'],
    ['limite-2-mib-mais-um', 2097153, 'recusa'],
  ]) {
    const entrada = manifesto.find(e => e.caso === caso);
    assert.equal(ler(entrada).length, tamanho);
    assert.equal(entrada.caracteristicas.tamanho, tamanho);
    assert.equal(entrada.esperado, esperado);
  }
});

test('oráculo noop: decodificar e recodificar UTF-8 sem normalizar preserva todos os bytes', () => {
  // Prepara a referência para futuro prepare+encode; não simula o editor.
  // Inclui BOM, emoji, CRLF, LF, CR isolado, entidades e ids do autor.
  for (const entrada of manifesto.filter(e => e.caracteristicas.utf8)) {
    const bytes = ler(entrada);
    const prefixo = entrada.caracteristicas.bom ? bytes.subarray(0, 3) : Buffer.alloc(0);
    const texto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(prefixo.length));
    assert.deepEqual(Buffer.concat([prefixo, Buffer.from(texto, 'utf8')]), bytes, entrada.arquivo);
  }
});
