// Corpus da POC M3: Testes / Corpus de bytes e D7 de registros/M3/m3-desenho.md.
// Sem parser/editor: esperado e avisos são oráculos para a implementação futura.
// Uso: node tests/fixtures/m3-corpus/gerar.cjs [diretorio-de-saida]
// Sem argumento, regenera nesta pasta. Nunca apaga arquivos preexistentes.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const DOCTYPE = '<!doctype html>';
const LEGADO = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const MIB2 = 2 * 1024 * 1024;
const pagina = corpo => `${DOCTYPE}<html><head><meta charset="utf-8"><title>M3</title></head><body>${corpo}</body></html>`;

function limite(tamanho) {
  // Preenchimento dentro do body; não acrescentar newline no EOF.
  const abertura = Buffer.from(`${DOCTYPE}<html><head><title>M3</title></head><body><p>`);
  const fechamento = Buffer.from('</p></body></html>');
  return Buffer.concat([abertura, Buffer.alloc(tamanho - abertura.length - fechamento.length, 0x78), fechamento]);
}

function gerar(destino = __dirname) {
  const manifesto = [];
  fs.mkdirSync(destino, { recursive: true });
  function caso(nome, conteudo, opcoes = {}) {
    const bytes = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, opcoes.encoding || 'utf8');
    const arquivo = nome + (opcoes.extensao || '.html');
    const entrada = {
      arquivo, caso: nome, esperado: opcoes.motivo ? 'recusa' : 'editavel',
      ...(opcoes.motivo ? { motivo_recusa: opcoes.motivo } : {}),
      avisos: opcoes.avisos || [],
      caracteristicas: {
        bom: false, eol: 'lf', loneCR: false, doctype: DOCTYPE, quirks_esperado: false,
        nul: false, utf8: true, tamanho: bytes.length,
        ...opcoes.caracteristicas,
      },
      ...(opcoes.contexto ? { contexto: opcoes.contexto } : {}),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    fs.writeFileSync(path.join(destino, arquivo), bytes);
    manifesto.push(entrada);
  }

  caso('bom-crlf', Buffer.concat([BOM, Buffer.from(`${DOCTYPE}\r\n<html>\r\n<head><title>M3</title></head>\r\n<body>Olá</body>\r\n</html>\r\n`)]), { caracteristicas: { bom: true, eol: 'crlf' } });
  caso('lf', `${DOCTYPE}\n<html>\n<head><title>M3</title></head>\n<body>Olá</body>\n</html>\n`);
  caso('eol-mistos', `${DOCTYPE}\r\n<html>\n<head><title>M3</title></head>\r\n<body>Olá</body>\n</html>\r\n`, { caracteristicas: { eol: 'mixed' } });
  caso('cr-solitario', `${DOCTYPE}\r<html>\r<head><title>M3</title></head>\r<body>Olá</body>\r</html>\r`, { caracteristicas: { loneCR: true } });
  caso('sem-doctype', '<html><head><title>M3</title></head><body>Quirks</body></html>', { caracteristicas: { doctype: null, quirks_esperado: true } });
  caso('doctype-legado', `${LEGADO}<html><head><title>M3</title></head><body>Legado</body></html>`, { caracteristicas: { doctype: LEGADO, quirks_esperado: true } });
  caso('comentarios-doctype-html', `<!-- antes -->\n${pagina('<p>Comentários</p>')}\n<!-- depois -->`);
  caso('entidades-nomeadas', pagina('<p>&copy; &eacute; &lt; &gt; &amp;</p>'));
  caso('entidades-numericas', pagina('<p>&#65; &#x41; &#128512; &#x1F600;</p>'));
  caso('entidade-sem-ponto-virgula', pagina('<p>A &amp B</p>'));
  caso('entidade-nbsp', pagina('<p>A&nbsp;B</p>'));
  caso('template', pagina('<template><p>Somente leitura</p></template><p>Editável</p>'));
  caso('svg-style-title', pagina('<svg xmlns="http://www.w3.org/2000/svg"><style>circle { fill: red }</style><title>Vetor</title><circle r="4"></circle></svg>'));
  caso('textarea', pagina('<textarea>A &amp; B\n&lt;p&gt;</textarea>'));
  caso('title', `${DOCTYPE}<html><head><title>A &amp; B &lt;p&gt;</title></head><body><p>M3</p></body></html>`);
  caso('script', pagina('<script>window.autor = "<p>";</script><button onclick="window.autor++">Ação</button>'), { avisos: ['scripts'] });
  caso('style', pagina('<style>p::before { content: "<texto>"; }</style><p>M3</p>'));
  caso('noscript', pagina('<noscript><p>Sem scripts</p></noscript>'));
  caso('xmp', pagina('<xmp><b>literal &amp;</b></xmp>'));
  caso('tabela-sem-tbody', pagina('<table><tr><td>Implícito</td></tr></table>'));
  caso('formatacao-cruzada', pagina('<b><p>x</b></p>'));
  caso('atributos-sem-aspas', pagina('<p id=alvo class=teste title=valor>Texto</p>'));
  caso('atributos-aspas-simples', pagina("<p id='alvo' title='A &amp; B'>Texto</p>"));
  caso('atributos-duplicados', pagina('<p id="primeiro" id="segundo" class="a" CLASS="b">Texto</p>'));
  caso('atributos-maiusculos', pagina('<P ID="ALVO" CLASS="TESTE" TITLE="Título">Texto</P>'));
  caso('void', pagina('<p>A<br>B<hr><img src="local.png" alt="Imagem"><input disabled></p>'));
  caso('svg-auto-fechamento', pagina('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/><circle r="2" /></svg>'));
  caso('css-comentario', pagina('<p style="color: red; /* preservar */ margin: 0">CSS</p>'));
  caso('css-url', pagina('<p style="background-image: url(imagem.png); color: red">CSS</p>'));
  caso('css-important', pagina('<p style="color: red !important; margin: 0">CSS</p>'));
  caso('base', `${DOCTYPE}<html><head><base href="https://example.invalid/"><title>M3</title></head><body>Base</body></html>`, { avisos: ['base'] });
  caso('meta-refresh', `${DOCTYPE}<html><head><meta http-equiv="refresh" content="0;url=outra.html"><title>M3</title></head><body>Refresh</body></html>`);
  caso('charset-latin1', `${DOCTYPE}<html><head><meta charset="latin1"><title>M3</title></head><body>Bytes UTF-8: ação</body></html>`, { motivo: 'meta-charset-nao-utf8' });
  caso('charset-http-equiv-latin1', `${DOCTYPE}<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>M3</title></head><body>Bytes UTF-8: ação</body></html>`, { motivo: 'meta-charset-nao-utf8' });
  caso('php-fora-comentario', pagina('<?php echo "M3"; ?>'), { motivo: 'instrucao-servidor' });
  caso('asp-fora-comentario', pagina('<% Response.Write("M3") %>'), { motivo: 'instrucao-servidor' });
  caso('marcadores-em-comentario', pagina('<!-- <?php echo "M3"; ?> <% Response.Write("M3") %> --> <p>Editável</p>'));
  caso('comentario-aberto', `${DOCTYPE}<html><head><title>M3</title></head><body><!-- sem fechamento`, { motivo: 'comentario-aberto' });
  // Contextos RAWTEXT e RCDATA: EOF imediatamente após o texto, sem tag final.
  for (const tag of ['textarea', 'title', 'script', 'style', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes']) {
    caso(`${tag}-aberto`, `${DOCTYPE}<html><head></head><body><${tag}>aberto`, {
      motivo: ['textarea', 'title'].includes(tag) ? 'rcdata-aberto' : 'rawtext-aberto',
      avisos: tag === 'script' ? ['scripts'] : [],
    });
  }
  caso('utf8-emoji', pagina('<p>Olá, ação, 日本語, 😀 🧑🏽‍💻</p>'));
  caso('nul', pagina('<p>A\0B</p>'), { motivo: 'nul', caracteristicas: { nul: true } });
  caso('latin1', pagina('<p>ação café</p>'), { encoding: 'latin1', motivo: 'nao-utf8', caracteristicas: { utf8: false } });
  caso('limite-2-mib', limite(MIB2));
  caso('limite-2-mib-mais-um', limite(MIB2 + 1), { motivo: 'documento-maior-2-mib' });
  caso('data-dk-node-autor', pagina('<p data-dk-node="autor-7">Preservar</p>'));
  caso('noop-prepare-encode', Buffer.concat([BOM, Buffer.from(`<!-- antes -->\r\n${DOCTYPE}\n<html><head><title>😀 &amp;</title></head>\r\n<body><p ID='autor' data-dk-node="7">A&nbsp;B</p>\r</body></html><!-- depois -->`)]), { caracteristicas: { bom: true, eol: 'mixed', loneCR: true } });
  caso('extensao-txt', pagina('<p>HTML em txt</p>'), { extensao: '.txt', motivo: 'extensao-nao-html' });
  caso('extensao-xhtml', pagina('<p>HTML em xhtml</p>'), { extensao: '.xhtml', motivo: 'extensao-nao-html' });
  caso('frameset', `${DOCTYPE}<html><head><title>M3</title></head><frameset cols="50%,50%"><frame src="a.html"><frame src="b.html"></frameset></html>`, { motivo: 'frameset' });
  caso('plaintext', `${DOCTYPE}<html><head><title>M3</title></head><body><plaintext>literal </plaintext></body></html>`, { motivo: 'plaintext' });
  caso('editor-codigo-sujo', pagina('<p>Alteração ainda não salva no editor de código</p>'), { motivo: 'editor-codigo-sujo', contexto: { editor_codigo_sujo: true } });
  caso('interpolacao', pagina('<p>{{ usuario.nome }}</p>'), { avisos: ['interpolacao'] });

  fs.writeFileSync(path.join(destino, 'manifesto.json'), `${JSON.stringify(manifesto, null, 2)}\n`);
  return manifesto;
}

if (require.main === module) gerar(process.argv[2] || __dirname);
module.exports = { gerar };
