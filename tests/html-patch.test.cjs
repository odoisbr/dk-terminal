'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { parse } = require('parse5');
const patch = require('../electron/html-patch.cjs');
const { prepare, encode, serve, inspect, apply, applyEdit, invert, LIMITS, REASONS } = patch;
const folder = path.join(__dirname, 'fixtures/m3-corpus');
const manifesto = JSON.parse(fs.readFileSync(path.join(folder, 'manifesto.json'), 'utf8'));

// Same fixture bootstrap as the independent corpus suite (large files are not
// versioned). Never substitute synthetic bytes for a manifest entry.
for (const name of ['limite-2-mib.html', 'limite-2-mib-mais-um.html']) {
  if (!fs.existsSync(path.join(folder, name))) {
    require('node:child_process').execFileSync(process.execPath, [path.join(folder, 'gerar.cjs')]);
    break;
  }
}

const read = entry => fs.readFileSync(path.join(folder, entry.arquivo));
function docOf(text, relative = 'index.html') {
  const result = prepare(Buffer.from(text), { relative });
  assert.equal(result.ok, true, result.reason);
  return result.doc;
}
const byTag = (doc, tag) => doc.nodes.find(n => n.tag === tag)?.id;
function elements(text) {
  const tree = parse(text, { sourceCodeLocationInfo: true, scriptingEnabled: true });
  const result = [], stack = [tree];
  while (stack.length) {
    const e = stack.pop();
    if (e.tagName) result.push(e);
    const children = e.content?.childNodes || e.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return { tree, elements: result };
}
const valueOf = (e, name) => e.attrs.find(a => a.name === name)?.value;
function assertPatch(before, result) {
  assert.equal(result.ok, true, result.reason);
  const { edit, doc: after } = result;
  assert.ok(Object.isFrozen(edit), 'apply edits are immutable');
  const inverse = invert(edit);
  assert.ok(Object.isFrozen(inverse), 'inverse edits are immutable');
  assert.throws(() => { edit.newText = 'tampered'; }, TypeError);
  assert.throws(() => { inverse.newText = 'tampered'; }, TypeError);
  assert.equal(before.text.slice(edit.start, edit.end), edit.oldText);
  assert.equal(after.text, before.text.slice(0, edit.start) + edit.newText + before.text.slice(edit.end));
  const a = encode(before), b = encode(after);
  const prefix = Buffer.byteLength(before.text.slice(0, edit.start)) + (before.bom ? 3 : 0);
  const suffix = Buffer.byteLength(before.text.slice(edit.end));
  assert.deepEqual(b.subarray(0, prefix), a.subarray(0, prefix));
  assert.deepEqual(b.subarray(b.length - suffix), a.subarray(a.length - suffix));
  assert.deepEqual(encode(applyEdit(after, inverse)), a, 'undo restores exact bytes');
  assert.deepEqual(encode(applyEdit(before, edit)), b, 'redo / replay produces identical bytes');
  const previous = elements(before.text), next = elements(after.text);
  assert.equal(next.tree.mode, previous.tree.mode);
  assert.deepEqual(next.elements.map(e => [e.tagName, e.namespaceURI]), previous.elements.map(e => [e.tagName, e.namespaceURI]));
  return after;
}
function refused(doc, op, reason, options) {
  const bytes = encode(doc);
  assert.deepEqual(apply(doc, op, options), { ok: false, reason });
  assert.deepEqual(encode(doc), bytes);
}

test('API congelada, limites e motivos públicos', () => {
  assert.deepEqual(Object.keys(patch).sort(), ['prepare', 'serve', 'inspect', 'apply', 'applyEdit', 'invert', 'encode', 'LIMITS', 'REASONS'].sort());
  assert.equal(LIMITS.document, 2097152);
  assert.equal(LIMITS.text, 65536);
  assert.equal(LIMITS.attr, 1024);
  assert.equal(LIMITS.css, 128);
  assert.equal(LIMITS.image, 4194304);
  assert.deepEqual(Object.values(REASONS).sort(), ['no-target', 'not-leaf', 'raw-context', 'foreign', 'template', 'clone', 'implicit', 'attr-not-allowed', 'attr-duplicated-in-source', 'value-invalid', 'css-unparseable', 'css-duplicate', 'path-outside', 'image-missing', 'too-large', 'verify-bytes', 'verify-tree', 'stale-gen', 'too-deep', 'too-many-attributes', 'too-many-nodes', 'too-complex', 'author-node-on-implicit'].sort());
  assert.ok(Object.isFrozen(LIMITS) && Object.isFrozen(REASONS));
});

const noTextLeaf = new Set(['formatacao-cruzada', 'void', 'svg-auto-fechamento', 'svg-style-title', 'textarea', 'noscript', 'xmp']);
for (const entry of manifesto) {
  test(`corpus real: ${entry.arquivo}`, () => {
    const bytes = read(entry);
    const prepared = prepare(bytes, { relative: entry.arquivo });
    if (entry.contexto?.editor_codigo_sujo) {
      // Dirty is external session state: this API receives bytes + relative,
      // so the fixture's bytes alone must not pretend to carry that state.
      assert.equal(entry.esperado, 'recusa');
      assert.equal(entry.motivo_recusa, 'editor-codigo-sujo');
      assert.equal(prepared.ok, true);
      assert.deepEqual(encode(prepared.doc), bytes);
      return;
    }
    assert.equal(prepared.ok, entry.esperado === 'editavel', prepared.reason);
    if (!prepared.ok) {
      assert.equal(prepared.reason, entry.motivo_recusa);
      assert.equal(typeof prepared.message, 'string');
      return;
    }
    const doc = prepared.doc;
    assert.deepEqual(doc.warnings, entry.avisos);
    assert.equal(doc.bom, entry.caracteristicas.bom);
    assert.equal(doc.loneCR, entry.caracteristicas.loneCR);
    // The manifest uses 'lf' as its fallback; the API uses 'none'. Compare
    // every entry, including lone-CR files, without skipping the manifest.
    assert.equal(doc.eol === 'none', !doc.text.includes('\n'));
    assert.equal(doc.eol === 'none' ? 'lf' : doc.eol, entry.caracteristicas.eol);
    assert.deepEqual(encode(doc), bytes);
    assert.deepEqual(doc.nodes.map(n => n.id), Array.from({ length: doc.nodes.length }, (_, i) => i + 1));
    const originalElements = elements(doc.text).elements;
    const located = originalElements.filter(e => e.sourceCodeLocation?.startTag);
    assert.deepEqual(doc.nodes.map(n => [n.tag, n.ns, n.start, n.end]), located.map(e => [e.tagName, e.namespaceURI, e.sourceCodeLocation.startTag.startOffset, e.sourceCodeLocation.startTag.endOffset]));
    for (const n of doc.nodes) assert.match(doc.text.slice(n.start, n.end), /^<[a-z]/i);

    const options = { nonce: 'nonce-m3', chan: 'chan-m3', gen: 7, bridgeSource: 'globalThis.bridge = {chan: CHAN, gen: GEN};' };
    const served = serve(doc, options);
    assert.equal(served.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), doc.bom);
    const output = elements(new TextDecoder().decode(served)).elements;
    const marked = output.filter(e => valueOf(e, 'data-dk-node') !== undefined);
    const first = new Map();
    for (const e of marked) {
      const id = Number(valueOf(e, 'data-dk-node')), n = doc.nodes[id - 1];
      assert.ok(n);
      assert.equal(valueOf(e, 'data-dk-node'), String(n.id));
      assert.equal(e.tagName, n.tag);
      assert.equal(e.namespaceURI, n.ns);
      if (first.has(id)) assert.equal(n.readonly, 'clone');
      else first.set(id, e);
    }
    assert.deepEqual([...first.keys()], doc.nodes.map(n => n.id));
    if (entry.caso === 'formatacao-cruzada') {
      const b = doc.nodes.find(n => n.tag === 'b');
      assert.equal(b.readonly, 'clone');
      assert.equal(marked.filter(e => valueOf(e, 'data-dk-node') === String(b.id)).length, 2);
      refused(doc, { type: 'text', node: b.id, value: 'safe' }, 'clone');
      refused(doc, { type: 'attr', node: b.id, name: 'title', value: 'safe' }, 'clone');
      refused(doc, { type: 'css', node: b.id, prop: 'color', value: 'red' }, 'clone');
    } else assert.equal(marked.length, doc.nodes.length);
    const bridge = output.filter(e => e.tagName === 'script').at(-1);
    assert.equal(valueOf(bridge, 'nonce'), options.nonce);
    assert.equal(bridge.childNodes[0].value, 'globalThis.bridge = {chan: "chan-m3", gen: 7};');
    assert.deepEqual(encode(doc), bytes, 'serve never changes working bytes');
    const leaf = doc.nodes.find(n => inspect(doc, n.id).can.text);
    assert.equal(Boolean(leaf), !noTextLeaf.has(entry.caso), 'explicit list of corpus cases without an eligible text leaf');
    let next = doc;
    if (leaf) next = assertPatch(doc, apply(doc, { type: 'text', node: leaf.id, value: 'A & <b>😀</b>\nB' }));
    else {
      for (const n of doc.nodes) assert.equal(apply(doc, { type: 'text', node: n.id, value: 'safe' }).ok, false);
    }
    // The exact-2-MiB fixture first shrinks through the legitimate text patch;
    // otherwise adding an attribute would correctly exceed the document cap.
    const target = next.nodes.find(n => inspect(next, n.id).can.attrs.includes('title'));
    assert.ok(target);
    assertPatch(next, apply(next, { type: 'attr', node: target.id, name: 'title', value: 'A "quote" & <literal> 😀' }));
    assert.deepEqual(encode(doc), bytes);
  });
}

test('D7: charset, UTF-8, extensão e marcadores usam contexto real de parser', () => {
  for (const html of ['<meta charset="ISO-8859-1">', '<META HTTP-EQUIV="content-type" CONTENT="text/html; charset=\'latin1\'">', '<meta charset="">']) {
    assert.equal(prepare(Buffer.from(html), { relative: 'a.html' }).reason, 'meta-charset-nao-utf8');
  }
  assert.equal(docOf('<meta charset="UTF-8"><p>x</p>', 'A.HTM').nodes.at(-1).tag, 'p');
  for (const html of ['<p title="<!-- <? -->">x</p>', '<script>"<!-- <% -->"</script>', '<?php x?>', '<% x %>']) {
    assert.equal(prepare(Buffer.from(html), { relative: 'a.html' }).reason, 'instrucao-servidor');
  }
  assert.ok(docOf('<!-- <? <% --> <p>x</p>'));
  assert.equal(prepare(Buffer.from([0xc0, 0xaf]), { relative: 'a.html' }).reason, 'nao-utf8');
  assert.equal(prepare(Buffer.from('<p>\0</p>'), { relative: 'a.html' }).reason, 'nul');
  assert.equal(prepare(Buffer.from('<p>x</p>'), { relative: 'a.svg' }).reason, 'extensao-nao-html');
  assert.equal(prepare(Buffer.from('<body><p>x</p><frameset></frameset>'), { relative: 'a.html' }).reason, 'frameset');
  assert.equal(prepare(Buffer.from('<select><meta charset="latin1"></select>'), { relative: 'a.html' }).reason, 'meta-charset-nao-utf8');
  assert.ok(docOf('<script>"<meta charset=latin1><frameset>"</script>'));
});

test('inspetor só expõe atributos permitidos e nunca o ID do autor', () => {
  const doc = docOf('<p id="a" class="b" title="A &amp; B" data-dk-node="secret" nonce="secret" onclick="x()" style="color: red; margin: 0">Texto &amp; 😀</p>');
  const p = byTag(doc, 'p'), info = inspect(doc, p);
  assert.deepEqual(info.attrs, { id: 'a', class: 'b', title: 'A & B' });
  assert.deepEqual(info.style, { color: 'red', margin: '0' });
  assert.equal(info.text, 'Texto & 😀');
  assert.equal(info.can.text, true);
  assert.equal(info.can.css, true);
  assert.equal(info.can.attrs.includes('data-dk-node'), false);
  assert.equal(doc.scripts, 0);
  assert.equal(doc.handlers, 1);
  assert.deepEqual(doc.warnings, ['scripts']);
  const served = serve(doc, { nonce: 'n', chan: 'GEN</script>', gen: 4, bridgeSource: 'globalThis.x = [CHAN, GEN];' });
  assert.equal(valueOf(elements(served.toString()).elements.find(e => e.tagName === 'p'), 'data-dk-node'), String(p));
  assert.ok(served.toString().includes('data-dk-node="secret"'));
  assert.ok(served.toString().includes('"GEN\\u003c/script>"'));
});

test('adversariais: HTML é texto, aspas são escapadas; nomes/eventos não são operações', () => {
  const doc = docOf('<p title=old>old</p>'), node = byTag(doc, 'p');
  const text = '<img src=x onerror="alert(1)"> & \'quoted\'';
  const changed = assertPatch(doc, apply(doc, { type: 'text', node, value: text }));
  assert.equal(inspect(changed, node).text, text);
  assert.ok(changed.text.includes('&lt;img'));
  const changedAttr = assertPatch(doc, apply(doc, { type: 'attr', node, name: 'title', value: '"><script>x</script>&' }));
  assert.ok(changedAttr.text.includes('title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;&amp;"'));
  for (const name of ['onclick', 'ONLOAD', 'style', 'srcdoc', 'formaction', 'action', 'target', 'xlink:href', 'nonce', 'data-dk-node', 'is', 'srcset', '__proto__']) {
    refused(doc, { type: 'attr', node, name, value: 'x' }, 'attr-not-allowed');
    refused(doc, { type: 'attr', node, name, value: null }, 'attr-not-allowed');
  }
  for (const value of ['\0', '\r', 'a\r\nb', '\ud800', 42, {}, null]) refused(doc, { type: 'text', node, value }, 'value-invalid');
  for (const value of ['\0', '\r', '\ud800', 42, {}]) refused(doc, { type: 'attr', node, name: 'title', value }, 'value-invalid');
  for (const node of [-1, 0, 9999, '1', 1.5, null, undefined]) refused(doc, { type: 'text', node, value: 'x' }, 'no-target');
  assert.deepEqual(inspect(doc, 999).reasons, ['no-target']);
});

test('limites inclusivos, medidos em bytes para texto e em caracteres para atributo/CSS', () => {
  const doc = docOf('<p>x</p>'), node = byTag(doc, 'p');
  for (const value of ['x'.repeat(LIMITS.text), '😀'.repeat(LIMITS.text / 4)]) assertPatch(doc, apply(doc, { type: 'text', node, value }));
  for (const value of ['x'.repeat(LIMITS.text + 1), '😀'.repeat(LIMITS.text / 4 + 1)]) refused(doc, { type: 'text', node, value }, 'too-large');
  assertPatch(doc, apply(doc, { type: 'attr', node, name: 'title', value: 'x'.repeat(LIMITS.attr) }));
  refused(doc, { type: 'attr', node, name: 'title', value: 'x'.repeat(LIMITS.attr + 1) }, 'too-large');
  refused(doc, { type: 'css', node, prop: 'color', value: 'x'.repeat(LIMITS.css + 1) }, 'too-large');
  const full = prepare(read(manifesto.find(e => e.caso === 'limite-2-mib')), { relative: 'full.html' }).doc;
  refused(full, { type: 'attr', node: byTag(full, 'p'), name: 'title', value: 'x' }, 'too-large');
});

test('somente leitura: template, foreign (inclusive integração HTML), clones e implícitos', () => {
  const doc = docOf('<template><p>x</p></template><svg><foreignObject><p>x</p></foreignObject></svg><math><mi>x</mi></math><b><p>x</b></p><table><tr><td>x</td></tr></table>');
  for (const n of doc.nodes.filter(n => n.readonly)) {
    assert.equal(n.editable, false);
    assert.equal(inspect(doc, n.id).can.text, false);
    for (const op of [{ type: 'text', value: 'x' }, { type: 'attr', name: 'title', value: 'x' }, { type: 'css', prop: 'color', value: 'red' }]) refused(doc, { ...op, node: n.id }, n.readonly);
  }
  assert.ok(doc.nodes.some(n => n.readonly === 'clone'));
  assert.ok(doc.nodes.some(n => n.readonly === 'template'));
  assert.ok(doc.nodes.some(n => n.readonly === 'foreign' && n.tag === 'p'));
  const implicit = elements(doc.text).elements.filter(e => !e.sourceCodeLocation?.startTag);
  assert.ok(implicit.some(e => e.tagName === 'tbody'));
  assert.equal(doc.nodes.some(n => n.tag === 'tbody'), false, 'implicit nodes cannot have source IDs');
  refused(doc, { type: 'attr', node: implicit.find(e => e.tagName === 'tbody'), name: 'title', value: 'x' }, 'no-target');
});

test('texto só em folha com duas tags explícitas e um único nó texto', () => {
  for (const html of ['<p>x<b>y</b></p>', '<p>x<!--c--></p>', '<p></p>', '<p>x', '<img alt="x">', '<p>x<p>y</p>']) {
    const doc = docOf(html), node = doc.nodes[0].id;
    refused(doc, { type: 'text', node, value: 'x' }, 'not-leaf');
  }
  for (const tag of ['script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes']) {
    const doc = docOf(`<${tag}>x</${tag}>`), node = byTag(doc, tag);
    refused(doc, { type: 'text', node, value: 'x' }, 'raw-context');
  }
});

test('atributos duplicados na fonte, caixa e remoção de srcset', () => {
  const doc = docOf('<P ID="a" id="b" title=old>text</P><img SRCSET="a.png 1x" src="a.png">'), node = byTag(doc, 'p');
  refused(doc, { type: 'attr', node, name: 'id', value: 'new' }, 'attr-duplicated-in-source');
  refused(doc, { type: 'attr', node, name: 'id', value: null }, 'attr-duplicated-in-source');
  assert.equal(inspect(doc, node).can.attrs.includes('id'), false);
  const next = assertPatch(doc, apply(doc, { type: 'attr', node, name: 'title', value: 'new' }));
  assert.ok(next.text.includes('ID="a" id="b"'));
  const image = byTag(doc, 'img');
  refused(doc, { type: 'attr', node: image, name: 'srcset', value: 'b.png' }, 'attr-not-allowed');
  assertPatch(doc, apply(doc, { type: 'attr', node: image, name: 'srcset', value: null }));
});

test('formatos dos atributos globais e por tag', () => {
  const doc = docOf('<a>x</a><img src="old.png">'), a = byTag(doc, 'a'), img = byTag(doc, 'img');
  for (const [name, value] of [['id', 'with space'], ['dir', 'sideways'], ['hidden', 'false'], ['lang', 'pt_BR'], ['role', 'button;script']]) refused(doc, { type: 'attr', node: a, name, value }, 'value-invalid');
  for (const [name, value] of [['id', 'a-b'], ['class', 'a b'], ['dir', 'rtl'], ['hidden', ''], ['lang', 'pt-BR'], ['role', 'button'], ['aria-label', 'A "B"']]) assertPatch(doc, apply(doc, { type: 'attr', node: a, name, value }));
  for (const value of ['-1', '1px', '1.5', '0', '9999999']) refused(doc, { type: 'attr', node: img, name: 'width', value }, 'value-invalid');
  assertPatch(doc, apply(doc, { type: 'attr', node: img, name: 'width', value: '120' }));
  refused(doc, { type: 'attr', node: a, name: 'alt', value: 'x' }, 'attr-not-allowed');
});

test('links e imagens contidos na raiz; callback recebe o relativo resolvido', () => {
  const doc = docOf('<a href="old.html">link</a><img src="old.png">', 'pages/index.html'), a = byTag(doc, 'a'), img = byTag(doc, 'img');
  for (const value of ['javascript:alert(1)', 'JaVaScRiPt:x', 'https://a.test/x', '//a.test/x', '/root', '../../x', '..\\x', '%2froot', '%5croot', '%252e%252e/x', '%00x', '../.secret', '../node_modules/a', '\tjavascript:x']) refused(doc, { type: 'attr', node: a, name: 'href', value }, 'path-outside');
  for (const value of ['../other.html', 'next.html?q=a&b=c#x', '#section', './next.html']) assertPatch(doc, apply(doc, { type: 'attr', node: a, name: 'href', value }));
  for (const segment of ['NODE_MODULES', 'Node_Modules', '.GIT', '．ＧＩＴ', 'ＮＯＤＥ＿ＭＯＤＵＬＥＳ', 'node_moduleſ']) {
    for (const encoded of [segment, encodeURIComponent(segment)]) {
      const value = `../${encoded}/a.png`;
      refused(doc, { type: 'attr', node: a, name: 'href', value }, 'path-outside');
      refused(doc, { type: 'attr', node: img, name: 'src', value }, 'path-outside', {
        assetExists() { assert.fail('forbidden paths must not reach the asset callback'); },
      });
    }
  }
  refused(doc, { type: 'attr', node: img, name: 'src', value: '../img/a.png' }, 'image-missing');
  for (const value of ['a.png?q=1', 'a.svg#x', 'a.html', 'a.css']) refused(doc, { type: 'attr', node: img, name: 'src', value }, 'value-invalid', { assetExists: () => ({ ok: true, size: 1 }) });
  refused(doc, { type: 'attr', node: img, name: 'src', value: 'data:image/png,x' }, 'path-outside');
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) {
    assertPatch(doc, apply(doc, { type: 'attr', node: img, name: 'src', value: `../img/a.${ext}` }, { assetExists(relative) { assert.equal(relative, `img/a.${ext}`); return { ok: true, size: LIMITS.image }; } }));
  }
  refused(doc, { type: 'attr', node: img, name: 'src', value: 'a.png' }, 'too-large', { assetExists: () => ({ ok: true, size: LIMITS.image + 1 }) });
  for (const assetExists of [() => ({ ok: false }), () => ({ ok: true }), () => ({ ok: true, size: -1 }), () => { throw new Error('not found'); }]) refused(doc, { type: 'attr', node: img, name: 'src', value: 'a.png' }, 'image-missing', { assetExists });
  assertPatch(doc, apply(doc, { type: 'attr', node: img, name: 'src', value: null }));
});

test('CSS: 30 propriedades com gramáticas fechadas', () => {
  const values = {
    color: '#1234', 'background-color': 'rgba(1, 2, 3, .5)', 'font-family': 'Arial, sans-serif', 'font-size': '1.25rem', 'font-weight': '700', 'font-style': 'italic', 'line-height': '1.5', 'text-align': 'center', 'text-decoration': 'underline',
    margin: '0 auto', 'margin-top': '-2px', 'margin-right': 'auto', 'margin-bottom': '1em', 'margin-left': '0', padding: '0 2px 1rem 3%', 'padding-top': '2px', 'padding-right': '0', 'padding-bottom': '1rem', 'padding-left': '1em',
    width: '50%', height: 'auto', 'min-width': '1px', 'max-width': 'none', 'min-height': '0', 'max-height': '10vh', gap: '1rem 2px', border: '1px solid #123', 'border-radius': '1px 2px', opacity: '.5', display: 'flex',
  };
  assert.equal(Object.keys(values).length, 30);
  const doc = docOf('<p>x</p>'), node = byTag(doc, 'p');
  for (const [prop, value] of Object.entries(values)) {
    const next = assertPatch(doc, apply(doc, { type: 'css', node, prop, value }));
    assert.equal(inspect(next, node).style[prop], value);
    assertPatch(next, apply(next, { type: 'css', node, prop, value: null }));
  }
  for (const prop of ['position', 'background-image', '--custom', 'behavior', '__proto__']) refused(doc, { type: 'css', node, prop, value: 'red' }, 'attr-not-allowed');
  for (const value of ['url(x)', 'URL (x)', 'expression(x)', '\\72 ed', 'red /*x*/', 'red;display:none', '{red}', '<red>', '"red"', "'red'", 'red!important', 'red ! IMPORTANT', '\0', '\r', '\n', 'var(--x)', 'inherit', 'rgb(999,0,0)', '#12345']) refused(doc, { type: 'css', node, prop: 'color', value }, 'value-invalid');
  for (const [prop, value] of [['opacity', '1.1'], ['padding', '-1px'], ['width', 'calc(1px + 2px)'], ['display', 'arbitrary'], ['font-weight', '950'], ['border', 'url(x)']]) refused(doc, { type: 'css', node, prop, value }, 'value-invalid');
});

test('CSS preserva declarações alheias, comentários, URLs e important existentes', () => {
  const doc = docOf('<p style="background-image: url(a;b.png); /* keep */ COLOR : red !important ; margin: 0">x</p>'), node = byTag(doc, 'p');
  const result = apply(doc, { type: 'css', node, prop: 'color', value: 'blue' });
  const next = assertPatch(doc, result);
  assert.equal(result.edit.oldText, 'red');
  assert.equal(next.text, doc.text.replace('red !important', 'blue !important'));
  assert.equal(inspect(next, node).style.color, 'blue !important');
  for (const suffix of ['!important', ' ! IMPORTANT', '\t!ImPoRtAnT', '\r\n !\timportant']) {
    const d = docOf(`<p style="color: red${suffix} ; margin: 0">x</p>`), n = byTag(d, 'p');
    const changed = assertPatch(d, apply(d, { type: 'css', node: n, prop: 'color', value: ' blue ' }));
    assert.equal(changed.text, d.text.replace('red', 'blue'));
  }
  const added = assertPatch(doc, apply(doc, { type: 'css', node, prop: 'opacity', value: '.5' }));
  assert.ok(added.text.includes('COLOR : red !important ; margin: 0; opacity: .5;'));
  const removed = assertPatch(doc, apply(doc, { type: 'css', node, prop: 'color', value: null }));
  assert.ok(removed.text.includes('/* keep */  margin: 0'));
  for (const style of ['color:red; COLOR:blue', 'margin:0; color:red; color:blue']) {
    const d = docOf(`<p style="${style}">x</p>`), n = byTag(d, 'p');
    refused(d, { type: 'css', node: n, prop: 'color', value: 'blue' }, 'css-duplicate');
    assert.ok(inspect(d, n).reasons.includes('css-duplicate'));
  }
  for (const style of ['color red', 'color:', 'color:red; /*open', 'color:red; x:fn(', 'color:red; x:{x}', 'color:r&#101;d']) {
    const d = docOf(`<p style="${style}">x</p>`), n = byTag(d, 'p');
    refused(d, { type: 'css', node: n, prop: 'color', value: 'blue' }, 'css-unparseable');
  }
  const duplicate = docOf('<p style="color:red" STYLE="color:blue">x</p>');
  refused(duplicate, { type: 'css', node: byTag(duplicate, 'p'), prop: 'color', value: 'blue' }, 'attr-duplicated-in-source');
});

test('EOL da faixa: CRLF, LF, CR isolado e sequência mista; BOM e entidades externas intactos', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const doc = docOf(`\uFEFF<!--outside-->${eol}<!doctype html><p>A${eol}B</p><!--&amp;-->`), node = byTag(doc, 'p');
    const next = assertPatch(doc, apply(doc, { type: 'text', node, value: 'C\nD\nE' }));
    assert.ok(next.text.includes(`<p>C${eol}D${eol}E</p>`));
    assert.equal(inspect(next, node).text, 'C\nD\nE');
  }
  const mixed = docOf('<p>A\r\nB\nC\rD</p>');
  const next = assertPatch(mixed, apply(mixed, { type: 'text', node: byTag(mixed, 'p'), value: '1\n2\n3\n4\n5' }));
  assert.equal(next.text, '<p>1\r\n2\n3\r4\r5</p>');
  assert.equal(docOf('\uFEFF\uFEFF<p>x</p>').text[0], '\uFEFF', 'only the encoding BOM is removed');
});

test('histórico rejeita faixa velha, corte de surrogate e alterações de árvore/doctype/quirks', () => {
  const doc = docOf('<!doctype html><p>😀 old</p><div>x</div>'), node = byTag(doc, 'p');
  const applied = apply(doc, { type: 'text', node, value: 'new' });
  assertPatch(doc, applied);
  assert.throws(() => applyEdit(applied.doc, applied.edit), { reason: 'verify-bytes' });
  const emoji = doc.text.indexOf('😀');
  assert.throws(() => applyEdit(doc, { start: emoji + 1, end: emoji + 1, oldText: '', newText: 'x' }), { reason: 'verify-bytes' });
  for (const [oldText, newText] of [['<!doctype html>', ''], ['<!doctype html>', '<!doctype other>'], ['<div>x</div>', '<span>x</span>'], ['😀 old', '<i>new</i>']]) {
    const start = doc.text.indexOf(oldText);
    assert.throws(() => applyEdit(doc, { start, end: start + oldText.length, oldText, newText }), { reason: 'verify-tree' });
  }
  assert.throws(() => applyEdit(doc, { start: 0, end: 10000, oldText: '', newText: '' }), { reason: 'verify-bytes' });
  assert.deepEqual(apply({ ...doc }, { type: 'text', node, value: 'x' }), { ok: false, reason: 'stale-gen' });
});

test('serve recusa ponte engolida, fechamento de script e parâmetros inválidos', () => {
  const options = { nonce: 'n', chan: 'c', gen: 1, bridgeSource: 'globalThis.x = [CHAN, GEN];' };
  for (const html of ['<p title="unterminated', '<template><p>x</p>', '<svg><g>']) {
    const doc = docOf(html);
    assert.throws(() => serve(doc, options), { reason: 'verify-tree' });
  }
  const doc = docOf('<p>x</p>');
  assert.throws(() => serve(doc, { ...options, bridgeSource: '</script><p>bad</p><script>' }), { reason: 'verify-tree' });
  for (const change of [{ nonce: '"><script>' }, { gen: -1 }, { gen: 0.5 }, { bridgeSource: '\0' }]) assert.throws(() => serve(doc, { ...options, ...change }), { reason: 'value-invalid' });
});

test('CSS multilinha conserva EOL e trivia fora da declaração tocada', () => {
  const doc = docOf('<p style="\r\n color: red;\n /* untouched */\r padding: 0;\r\n">x</p>'), node = byTag(doc, 'p');
  const next = assertPatch(doc, apply(doc, { type: 'css', node, prop: 'color', value: '#fff' }));
  assert.equal(next.text, doc.text.replace('red', '#fff'));
  assert.equal(next.eol, 'mixed');
  assert.equal(next.loneCR, true);
});

test('histórico não é uma operação genérica de HTML, scripts ou IDs de instrumentação', () => {
  for (const [html, oldText, newText] of [
    ['<p data-dk-node="autor">x</p>', 'autor', 'outro'],
    ['<p data-dk-node="autor">x</p>', 'autor', '&#97;utor'],
    ['<p onclick="original()">x</p>', 'original()', 'outro()'],
    ['<script>original()</script>', 'original()', 'outro()'],
    ['<template><p>original</p></template>', 'original', 'outro'],
  ]) {
    const doc = docOf(html), start = doc.text.indexOf(oldText);
    assert.throws(() => applyEdit(doc, { start, end: start + oldText.length, oldText, newText }), { reason: 'verify-tree' });
  }
  const doc = docOf('<a href="javascript:original()">x</a>'), node = byTag(doc, 'a');
  assertPatch(doc, apply(doc, { type: 'attr', node, name: 'href', value: 'safe.html' }));
  const emptyScript = docOf('<script></script>');
  assert.throws(() => applyEdit(emptyScript, { start: 8, end: 8, oldText: '', newText: 'bad()' }), { reason: 'verify-tree' });
});

test('texto vazio pode ser desfeito; pre/listing não silenciam a remoção de uma quebra inicial', () => {
  const doc = docOf('<p>x</p>'), node = byTag(doc, 'p');
  assertPatch(doc, apply(doc, { type: 'text', node, value: '' }));
  for (const tag of ['pre', 'listing']) {
    const d = docOf(`<${tag}>old</${tag}>`), n = byTag(d, tag);
    refused(d, { type: 'text', node: n, value: '\nnew' }, 'verify-tree');
    assertPatch(d, apply(d, { type: 'text', node: n, value: 'new\nline' }));
  }
});

test('prepare recusa ID tardio do autor em html/body implícito com motivo explícito', () => {
  const options = { nonce: 'n', chan: 'c', gen: 1, bridgeSource: 'void [CHAN, GEN];' };
  for (const html of [
    '<html><p>x</p><body data-dk-node="1">',
    '<p>x</p><body data-dk-node="999">',
    '<p>x</p><body data-dk-node="01">',
    '<p>x</p><html data-dk-node="1">',
    '<p>x</p><html DATA-DK-NODE>',
  ]) assert.deepEqual(prepare(Buffer.from(html)), { ok: false, reason: 'author-node-on-implicit', message: 'author-node-on-implicit' });
  // Explicit roots have a source tag: our injected first attribute wins even
  // when the author's ID only arrives via a later html/body token.
  for (const tag of ['html', 'body']) {
    const doc = docOf(`<html><body><p>x</p><${tag} data-dk-node="999">`);
    const output = elements(serve(doc, options).toString()).elements;
    assert.equal(valueOf(output.find(e => e.tagName === tag), 'data-dk-node'), String(byTag(doc, tag)));
    assert.equal(Object.hasOwn(inspect(doc, byTag(doc, tag)).attrs, 'data-dk-node'), false);
    refused(doc, { type: 'attr', node: byTag(doc, tag), name: 'data-dk-node', value: 'new' }, 'attr-not-allowed');
    assertPatch(doc, apply(doc, { type: 'attr', node: byTag(doc, tag), name: 'title', value: 'safe' }));
  }
});

for (const [html, tags, counts] of [
  ['<p><i>a<p>b', ['p', 'i', 'p'], [1, 2, 1]],
  ['<p><b>1<p>2</b>3', ['p', 'b', 'p'], [1, 2, 1]],
  ['<ul><li><b>x<li>y</b></ul>', ['ul', 'li', 'b', 'li'], [1, 1, 2, 1]],
  ['<b>1<p>2<b>3<p>4</b>5', ['b', 'p', 'b', 'p'], [1, 1, 2, 1]],
]) test(`reconstrução tem um ID por tag de origem: ${html}`, () => {
  const doc = docOf(html);
  assert.deepEqual(doc.nodes.map(n => n.tag), tags);
  assert.deepEqual(doc.nodes.map(n => n.id), tags.map((_, i) => i + 1));
  assert.equal(new Set(doc.nodes.map(n => n.start)).size, tags.length);
  assert.deepEqual(encode(doc), Buffer.from(html));
  const served = serve(doc, { nonce: 'n', chan: 'c', gen: 1, bridgeSource: 'void [CHAN, GEN];' }).toString();
  // One insertion in the bytes, multiple occurrences in the parsed tree.
  assert.equal([...served.matchAll(/ data-dk-node=/g)].length, tags.length);
  const marked = elements(served).elements.filter(e => valueOf(e, 'data-dk-node') !== undefined);
  assert.equal(marked.length, counts.reduce((a, b) => a + b));
  for (const [index, node] of doc.nodes.entries()) {
    const occurrences = marked.filter(e => valueOf(e, 'data-dk-node') === String(node.id));
    assert.equal(occurrences.length, counts[index]);
    assert.ok(occurrences.every(e => e.tagName === node.tag && e.namespaceURI === node.ns));
    assert.equal(node.readonly, counts[index] > 1 ? 'clone' : null);
    assert.equal(node.editable, counts[index] === 1);
    if (counts[index] > 1) {
      assert.deepEqual(inspect(doc, node.id).can, { text: false, attrs: [], css: false });
      for (const op of [{ type: 'text', value: 'safe' }, { type: 'attr', name: 'title', value: 'safe' },
        { type: 'css', prop: 'color', value: 'red' }]) refused(doc, { ...op, node: node.id }, 'clone');
    } else {
      const edited = assertPatch(doc, apply(doc, { type: 'attr', node: node.id, name: 'title', value: 'safe' }));
      assert.doesNotThrow(() => serve(edited, { nonce: 'n', chan: 'c', gen: 1, bridgeSource: '' }));
    }
  }
});

test('D7 interrompe a pilha ao chegar a 512, incluindo elementos implícitos', t => {
  // html + body occupy two slots; head has already been popped.
  const accepted = docOf('<div>'.repeat(509) + 'x' + '</div>'.repeat(509));
  assert.equal(accepted.nodes.length, 509);
  assert.doesNotThrow(() => serve(accepted, { nonce: 'n', chan: 'c', gen: 1, bridgeSource: '' }));
  for (const depth of [510, 600, 100000]) {
    const bytes = Buffer.from('<div>'.repeat(depth) + 'x' + '</div>'.repeat(depth));
    const start = performance.now();
    const result = prepare(bytes);
    const ms = performance.now() - start;
    assert.deepEqual(result, { ok: false, reason: 'too-deep', message: 'too-deep' });
    t.diagnostic(`${depth} div aninhados: ${ms.toFixed(1)} ms`);
    assert.ok(ms < 1000, `early depth refusal took ${ms.toFixed(1)} ms`);
  }
  for (const tag of ['template', 'svg', 'math']) {
    assert.equal(prepare(Buffer.from(`<${tag}>`.repeat(600))).reason, 'too-deep');
  }
  const literal = '<div>'.repeat(600);
  assert.ok(docOf(`<!--${literal}--><script>${literal}</script><p title="${literal}">x</p>`));
});

test('D7 interrompe atributos acima de 256, inclusive repetidos e tags incompletas', t => {
  const attrs = count => Array.from({ length: count }, (_, i) => ` a${i}="x"`).join('');
  const doc = docOf(`<p${attrs(256)}>x</p>`), node = byTag(doc, 'p');
  assert.doesNotThrow(() => serve(doc, { nonce: 'n', chan: 'c', gen: 1, bridgeSource: '' }));
  assertPatch(doc, apply(doc, { type: 'text', node, value: 'y' }));
  refused(doc, { type: 'attr', node, name: 'title', value: 'extra' }, 'too-many-attributes');
  for (const html of [`<p${attrs(257)}>x</p>`, `<p${attrs(300)}>x</p>`, `<p${attrs(100000)}`,
    `<p${' a=x'.repeat(300)}>x</p>`, `<p>x</p${attrs(300)}>`]) {
    const start = performance.now();
    const result = prepare(Buffer.from(html));
    const ms = performance.now() - start;
    assert.equal(result.reason, 'too-many-attributes');
    assert.ok(ms < 1000, `early attribute refusal took ${ms.toFixed(1)} ms`);
    if (html === `<p${attrs(300)}>x</p>`) t.diagnostic(`300 atributos: ${ms.toFixed(1)} ms`);
  }
  const literal = `<p${attrs(300)}>`;
  assert.ok(docOf(`<!--${literal}--><style>${literal}</style>`));
});

test('D7 conta elementos durante o parse: 200000 aceitos, o próximo interrompe', t => {
  // Contagens, não tempo: o teto de tempo do parse fica congelado para não depender da carga da máquina.
  t.mock.method(performance, 'now', () => 0);
  // Include the three implicit html/head/body elements in the ceiling.
  const html = '<!doctype html>' + '<br>'.repeat(199997);
  const doc = docOf(html);
  assert.equal(doc.nodes.length, 199997);
  assert.doesNotThrow(() => serve(doc, { nonce: 'n', chan: 'c', gen: 1, bridgeSource: '' }));
  assert.equal(prepare(Buffer.from(html + '<br>')).reason, 'too-many-nodes');
  assert.equal(prepare(Buffer.from(html + '<br>' + '<div>'.repeat(600))).reason, 'too-many-nodes');
});

test('html/body repetidos limitam atributos acumulados a 256 antes da adoção', t => {
  for (const tag of ['html', 'body']) {
    const repeated = count => Array.from({ length: count }, (_, i) => `<${tag} a${i}>`).join('');
    const prefix = '<!doctype html><html><body><p>x</p>';
    const doc = docOf(prefix + repeated(256));
    const root = byTag(doc, tag);
    assert.doesNotThrow(() => serve(doc, { nonce: 'n', chan: 'c', gen: 1, bridgeSource: '' }));
    refused(doc, { type: 'attr', node: root, name: 'title', value: 'extra' }, 'too-many-attributes');
    for (const count of [257, 20000]) {
      const bytes = Buffer.from(prefix + repeated(count));
      const start = performance.now(), result = prepare(bytes), ms = performance.now() - start;
      assert.equal(result.reason, 'too-many-attributes');
      assert.ok(ms < 1000, `${tag} attribute refusal took ${ms.toFixed(1)} ms`);
      t.diagnostic(`${count} ${tag} repetidos: ${ms.toFixed(1)} ms`);
    }
    // Repeated names do not consume another slot, and no Set is rebuilt for
    // each adoption after the recipient reaches its full attribute allowance.
    const duplicate = docOf(prefix + repeated(256) + `<${tag} a0>`.repeat(5000));
    assert.doesNotThrow(() => serve(duplicate, { nonce: 'n', chan: 'c', gen: 1, bridgeSource: '' }));
  }
});

for (const [name, siblings, fostered] of [
  ['texto', '<i></i>'.repeat(20000), 'a '.repeat(40000)],
  ['comentários', '<!---->'.repeat(30000), 'a <!--x-->'.repeat(10000)],
  ['i em table', '<i></i>'.repeat(20000), '<i></i>'.repeat(20000)],
]) test(`foster parenting com muitos irmãos: ${name}`, t => {
  const bytes = Buffer.from('<!doctype html><body><p id=t>x</p>' + siblings + '<table>' + fostered + '</table>');
  function timed(operation, run) {
    const start = performance.now(), result = run(), ms = performance.now() - start;
    assert.ok(ms < 1000, `${name} ${operation} took ${ms.toFixed(1)} ms`);
    t.diagnostic(`${name} ${operation}: ${ms.toFixed(1)} ms`);
    return result;
  }
  const prepared = timed('prepare', () => prepare(bytes));
  assert.equal(prepared.ok, true, prepared.reason);
  const { doc } = prepared;
  const served = timed('serve', () => serve(doc, { nonce: 'n', chan: 'c', gen: 1, bridgeSource: '1' }));
  assert.ok(served.length > bytes.length);
  const edited = timed('apply', () => apply(doc, { type: 'text', node: byTag(doc, 'p'), value: 'y' }));
  assert.equal(edited.ok, true, edited.reason);
  assert.equal(edited.doc.text, doc.text.replace('<p id=t>x</p>', '<p id=t>y</p>'));
  assert.deepEqual(encode(doc), bytes);
});

test('sondas de fechamento ignorado e i aninhado em table interrompem ou ficam abaixo de 1 s', t => {
  const options = { nonce: 'n', chan: 'c', gen: 1, bridgeSource: '1' };
  function timed(name, run) {
    const start = performance.now(), result = run(), ms = performance.now() - start;
    assert.ok(ms < 1000, `${name} took ${ms.toFixed(1)} ms`);
    t.diagnostic(`${name}: ${ms.toFixed(1)} ms`);
    return result;
  }
  for (const close of ['</div>', '</q>']) {
    const bytes = Buffer.from('<!doctype html><body><p>x</p>' + '<span>'.repeat(500) + close.repeat(4096));
    const result = timed(`${close} prepare`, () => prepare(bytes));
    assert.equal(result.ok, true, result.reason);
    const doc = result.doc;
    timed(`${close} serve`, () => serve(doc, options));
    assert.equal(timed(`${close} apply`, () => apply(doc, { type: 'text', node: byTag(doc, 'p'), value: 'y' })).ok, true);
  }
  const nested = Buffer.from('<!doctype html><body>' + '<i></i>'.repeat(20000) + '<table>' + '<i>'.repeat(600) + '</table>');
  assert.equal(timed('i aninhado em table', () => prepare(nested)).reason, 'too-deep');
  // probe.cjs endScope slices its tail mid-token (2093152 % 6 === 4).
  // Keep distinguishing an incomplete end tag swallowing the bridge from a
  // timeout or a regression in the ignored-end-tag path above.
  const truncated = docOf('<!doctype html><body><p>x</p>' + '<span>'.repeat(500) + '</div>'.repeat(4096) + '</di');
  timed('endScope com tag truncada', () => assert.throws(() => serve(truncated, options), { reason: 'verify-tree' }));
});

test('orçamento total conta elementos, textos e comentários, sem contar tokens de texto mesclados', t => {
  // Contagens, não tempo: o teto de tempo do parse fica congelado para não depender da carga da máquina.
  t.mock.method(performance, 'now', () => 0);
  // Three implicit elements + 299998 comments + 299999 texts = 600000.
  // Both default text insertion and foster insertion must use our counter.
  const base = '<!doctype html>' + 'x<!>'.repeat(299998);
  const doc = docOf(base + 'x');
  assert.equal(doc.nodes.length, 0);
  assert.doesNotThrow(() => serve(doc, { nonce: 'n', chan: 'c', gen: 1, bridgeSource: '1' }));
  for (const ending of ['x<!>', '<!>x', 'x<br>']) {
    assert.equal(prepare(Buffer.from(base + ending)).reason, 'too-many-nodes');
  }
  // Enough comments to leave room for table + one fostered text only.
  const foster = '<!doctype html><body>' + '<!>'.repeat(599995) + '<table>a </table>';
  assert.ok(docOf(foster));
  assert.equal(prepare(Buffer.from(foster + '<!>')).reason, 'too-many-nodes');
  const merged = docOf('<p>' + 'a '.repeat(220000) + '</p>');
  assert.equal(merged.nodes.length, 1, '440000 character tokens create one text node');
});

test('too-complex usa relógio injetado e interrompe a cada 1024 eventos, inclusive tags ignoradas', t => {
  const options = { nonce: 'n', chan: 'c', gen: 1, bridgeSource: '1' };
  for (const tail of ['</q>'.repeat(4096), '<!---->'.repeat(4096), '<table>' + 'a '.repeat(4096) + '</table>']) {
    const bytes = Buffer.from('<!doctype html><p>x</p>' + tail);
    const doc = prepare(bytes).doc;
    assert.ok(doc);
    let reads;
    const clock = t.mock.method(performance, 'now', () => reads++ === 0 ? 10000 : 11501);
    try {
      reads = 0;
      assert.deepEqual(prepare(bytes), { ok: false, reason: 'too-complex', message: 'too-complex' });
      assert.equal(reads, 2, 'first periodic check interrupts the parse');
      reads = 0;
      assert.throws(() => serve(doc, options), { reason: 'too-complex' });
      assert.equal(reads, 2, 'serve verification uses the same budget');
      reads = 0;
      assert.deepEqual(apply(doc, { type: 'attr', node: byTag(doc, 'p'), name: 'title', value: 'safe' }), { ok: false, reason: 'too-complex' });
      assert.equal(reads, 2, 'apply verification uses the same budget');
      assert.deepEqual(encode(doc), bytes, 'a timeout never changes the original');
      // A poisonous tail proves this is an in-parse check, not an EOF check.
      reads = 0;
      const poison = Buffer.concat([bytes, Buffer.from('<p' + ' a=x'.repeat(300) + '>')]);
      assert.equal(prepare(poison).reason, 'too-complex');
    } finally { clock.mock.restore(); }
  }
  let reads = 0;
  const clock = t.mock.method(performance, 'now', () => reads++ === 0 ? 10000 : 11500);
  assert.equal(prepare(Buffer.from('<p>x</p>' + '</q>'.repeat(4096))).ok, true, '1500 ms inclusive');
  assert.ok(reads > 2, 'clock sampled periodically through EOF');
  clock.mock.restore();
  // Even a parse with fewer than 1024 events checks the elapsed time at EOF.
  reads = 0;
  t.mock.method(performance, 'now', () => reads++ === 0 ? 10000 : 11501);
  assert.equal(prepare(Buffer.from('<p>x</p>')).reason, 'too-complex');
});

test('desempenho: prepare, serve e apply abaixo de 5 s cada em quase 2 MiB de irmãos', t => {
  const prefix = '<!doctype html><html><head></head><body>';
  const suffix = '</body></html>';
  const siblings = '<div>x</div>'.repeat(150000);
  const size = LIMITS.document - 1024;
  const html = prefix + siblings + '<!--' + ' '.repeat(size - prefix.length - siblings.length - suffix.length - 7) + '-->' + suffix;
  const bytes = Buffer.from(html);
  assert.equal(bytes.length, size);
  // O teto de tempo do parse fica congelado; a medição usa hrtime e continua exigindo menos de 5 s.
  t.mock.method(performance, 'now', () => 0);
  function timed(name, run) {
    const start = process.hrtime.bigint(), result = run(), ms = Number(process.hrtime.bigint() - start) / 1e6;
    t.diagnostic(`${name}: ${ms.toFixed(1)} ms (${bytes.length} bytes, 150000 div irmãos)`);
    assert.ok(ms < 5000, `${name} took ${ms.toFixed(1)} ms`);
    return result;
  }
  const prepared = timed('prepare', () => prepare(bytes));
  assert.equal(prepared.ok, true, prepared.reason);
  const doc = prepared.doc;
  assert.equal(doc.nodes.length, 150003);
  const served = timed('serve', () => serve(doc, { nonce: 'n', chan: 'c', gen: 1, bridgeSource: 'void [CHAN, GEN];' }));
  assert.ok(served.length > bytes.length);
  const node = doc.nodes.at(-1).id;
  const result = timed('apply', () => apply(doc, { type: 'text', node, value: 'y' }));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.doc.text, html.slice(0, result.edit.start) + 'y' + html.slice(result.edit.end));
  assert.deepEqual(encode(doc), bytes);
});

test('estilo do autor com espaços longos não torna o apply de CSS quadrático', () => {
  const bytes = Buffer.from(`<!doctype html><html><head></head><body><p style="color: a${' '.repeat(1024 * 1024)}b">x</p></body></html>`);
  const prepared = prepare(bytes, { relative: 'a.html' });
  assert.equal(prepared.ok, true);
  const node = prepared.doc.nodes.find(item => item.tag === 'p').id;
  const started = performance.now();
  apply(prepared.doc, { type: 'css', node, prop: 'color', value: 'red' });
  assert.ok(performance.now() - started < 1000);
});

test('!important do autor continua preservado com espaços e caixa variados', () => {
  const bytes = Buffer.from('<!doctype html><html><head></head><body><p style="color: blue  !\tIMPORTANT">x</p></body></html>');
  const prepared = prepare(bytes, { relative: 'a.html' });
  const node = prepared.doc.nodes.find(item => item.tag === 'p').id;
  const result = apply(prepared.doc, { type: 'css', node, prop: 'color', value: 'red' });
  assert.equal(result.ok, true);
  assert.match(encode(result.doc).toString(), /color: red {2}!\tIMPORTANT/);
});

test('HTML formatado legítimo perto de 2 MiB cabe no orçamento de nós', () => {
  const bytes = Buffer.from(`<!doctype html><html><head></head><body>\n${'<div>x</div>\n'.repeat(140000)}</body></html>`);
  assert.equal(prepare(bytes, { relative: 'a.html' }).ok, true);
});
