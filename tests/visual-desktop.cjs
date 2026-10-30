const { openFolderDialog } = require('./helpers/open-folder.cjs');
const { openProjectPanel } = require('./helpers/project-inspector.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

// Editor visual (M3) ponta a ponta no app real: protocolo dk-preview, ponte, sessão, patch por faixa,
// rede bloqueada, corpus parse5 × Chromium e prova do worker dentro de um .asar.
// Projetos e perfil são temporários; nenhum pedido sai da máquina (a sessão padrão cancela e registra
// qualquer URL fora de dk-app/dk-preview, e um servidor loopback conta conexões).
const root = path.resolve(__dirname, '..');
const corpusSource = path.join(__dirname, 'fixtures', 'm3-corpus');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-visual-ui-')));
const projectA = path.join(temp, 'Projeto Visual'), projectB = path.join(temp, 'Projeto B');
for (const folder of [projectA, projectB, path.join(projectA, 'fontes'), path.join(projectA, 'imagens')]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(projectB, 'LEIA.txt'), 'Outro projeto.\n');
const fixtureShell = path.join(temp, 'shell');
fs.writeFileSync(fixtureShell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await delay(50);
  }
}
const git = (...args) => execFileSync('git', ['-C', projectA, ...args], { encoding: 'utf8' });
const step = (label, detail = '') => console.log(`✓ ${label}${detail ? ` (${detail})` : ''}`);

// Servidor loopback: qualquer conexão ou pedido aqui é vazamento do iframe.
const loopback = { connections: 0, requests: [] };
const server = http.createServer((request, response) => { loopback.requests.push(request.url); response.end('vazou'); });
server.on('connection', () => { loopback.connections++; });

function writeProject(port) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(projectA, 'imagens', 'ponto.png'), png);
  // Fonte woff2 local pequena (3,6 KB, KaTeX) copiada para o projeto temporário.
  fs.copyFileSync(path.join(root, 'node_modules', 'katex', 'dist', 'fonts', 'KaTeX_Size3-Regular.woff2'), path.join(projectA, 'fontes', 'local.woff2'));
  fs.writeFileSync(path.join(projectA, 'estilo.css'), "@font-face{font-family:DkLocal;src:url(fontes/local.woff2) format('woff2')}\n.fonte{font-family:DkLocal,serif}\nh1{color:rgb(20, 100, 40)}\n");
  const lines = [
    '<!doctype html>', '<html lang="pt-BR">', '<head>', '<meta charset="utf-8">', '<title>Página M3</title>',
    '<link rel="stylesheet" href="estilo.css">',
    `<link rel="stylesheet" href="http://localhost:${port}/externo.css">`,
    `<link rel="preconnect" href="http://127.0.0.1:${port}">`,
    '</head>', '<body>',
    '<h1 id="titulo" title="Original">Título original</h1>',
    '<p id="folha">Texto da folha</p>',
    '<p class="fonte" id="fonte">Fonte local</p>',
    '<img id="local" src="imagens/ponto.png" alt="Ponto">',
    `<img id="externa" src="http://127.0.0.1:${port}/externa.png" alt="Externa">`,
    '<button id="botao" onclick="window.__autorClique = 1">Botão</button>',
    '<b><p id="cruzada">x</b></p>',
    '<a id="link" href="outra.html">Outra</a>',
    '<script>window.__autorScript = 1; try { parent.__autorScript = 1; } catch {}</script>',
    '</body>', '</html>', '',
  ];
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n'), 'utf8')]);
  fs.writeFileSync(path.join(projectA, 'pagina.html'), bytes);
  fs.writeFileSync(path.join(projectA, 'refresh-externo.html'), `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=http://127.0.0.1:${port}/meta"></head><body><p>Refresh</p></body></html>\n`);
  fs.writeFileSync(path.join(projectA, 'outra.html'), '<!doctype html><html><body><p>Outra página</p></body></html>\n');
  execFileSync('git', ['init', '-q', projectA]);
  git('-c', 'user.name=Teste', '-c', 'user.email=teste@example.invalid', 'add', '-A');
  git('-c', 'user.name=Teste', '-c', 'user.email=teste@example.invalid', 'commit', '-q', '-m', 'inicial');
  return bytes;
}

let app;
const productFailures = [], observations = [];
(async () => {
  if (process.platform === 'win32') { console.log('Ignorado no Windows: o shell de teste é um script sh.'); return; }
  const started = Date.now();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const original = writeProject(port);
  const page_ = 'pagina.html', pageFile = path.join(projectA, page_);
  try {
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    const env = { ...process.env, SHELL: fixtureShell, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: projectA, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile') };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env, timeout: 120000 });
    const page = await app.firstWindow({ timeout: 60000 });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    // Instrumentação de rede na sessão padrão (antes de qualquer documento visual).
    await app.evaluate(({ session, BrowserWindow }) => {
      const net = globalThis.__dkNet = { before: [], completed: [], errors: [], blocked: [], navigations: [] };
      const internal = /^(dk-app|dk-preview|devtools|chrome|chrome-extension|data|blob|file|about):/i;
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        net.before.push({ url: details.url, type: details.resourceType });
        if (!internal.test(details.url)) { net.blocked.push(details.url); callback({ cancel: true }); } else callback({});
      });
      session.defaultSession.webRequest.onCompleted(details => net.completed.push({ url: details.url, status: details.statusCode }));
      session.defaultSession.webRequest.onErrorOccurred(details => net.errors.push({ url: details.url, error: details.error }));
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.on('will-frame-navigate', event => net.navigations.push({ url: event.url, main: event.isMainFrame }));
    });
    const netState = () => app.evaluate(() => JSON.parse(JSON.stringify(globalThis.__dkNet)));
    await page.locator('#startup-loading').waitFor({ state: 'detached', timeout: 30000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
    await page.locator('#launcher-recents .launcher-recent').first().click();
    await page.locator('#launcher').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('project-title')?.textContent === 'Projeto Visual');

    // Acesso a frames pelo processo principal (o iframe é OOPIF e opaco).
    const frameJs = (url, code) => app.evaluate(({ BrowserWindow }, [target, source]) => {
      const frame = BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.find(f => f.url === target);
      if (!frame) return { __missing: true };
      return frame.executeJavaScript(source, false).then(value => ({ value }), error => ({ __error: String(error) }));
    }, [url, code]).then(result => { if (result.__missing) throw new Error(`Frame ausente: ${url}`); if (result.__error) throw new Error(result.__error); return result.value; });
    const frameUrls = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.map(f => f.url));
    const visualFrame = page.locator('iframe.dk-visual-frame');
    const currentUrl = () => visualFrame.getAttribute('src');
    const generation = async () => Number(new URL(await currentUrl()).searchParams.get('g'));
    async function waitFrame(url) {
      await until(async () => (await frameUrls()).includes(url), `Frame não carregou: ${url}`);
      await until(async () => (await frameJs(url, 'document.readyState').catch(() => null)) === 'complete', `Frame não ficou pronto: ${url}`);
      return url;
    }
    async function waitGeneration(gen) {
      await until(async () => await generation() === gen, `Geração ${gen} não chegou ao iframe.`);
      return waitFrame(await currentUrl());
    }
    const inFrame = async code => frameJs(await waitFrame(await currentUrl()), code);
    async function clickInFrame(selector) {
      const url = await waitFrame(await currentUrl());
      const point = await frameJs(url, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 12), y: b.y + b.height / 2 }; })()`);
      await delay(150);
      const box = await visualFrame.boundingBox();
      await page.mouse.click(box.x + point.x, box.y + point.y);
    }
    const head = page.locator('.dk-visual-inspector-head');
    async function select(selector, tag) {
      await clickInFrame(selector);
      await until(async () => new RegExp(`^<${tag}> #\\d+$`).test(await head.textContent()), `Inspetor não mostrou <${tag}> para ${selector}.`);
      await page.locator('.dk-visual-form, .dk-visual-readonly').first().waitFor();
    }
    const applyButton = page.locator('.dk-visual-form button[type="submit"]');
    async function editText(value) {
      await page.getByRole('tab', { name: 'Texto', exact: true }).click();
      await page.locator('.dk-visual-textarea').fill(value);
      await applyButton.click();
    }
    const toolbar = name => page.locator('.dk-visual-toolbar').getByRole('button', { name, exact: true });
    const state = () => page.evaluate(dir => window.dk.visualState(dir), projectA);
    const banners = () => page.locator('.dk-visual-banner').allInnerTexts();
    // Pedido de um URL dk-preview por um iframe do renderer (iniciador dk-app://app). Com guard=false
    // os ouvintes de will-frame-navigate do app saem temporariamente para observar a resposta do protocolo.
    async function probe(url, guard) {
      const before = await netState();
      if (!guard) await app.evaluate(({ BrowserWindow }) => { const c = BrowserWindow.getAllWindows()[0].webContents; globalThis.__dkSavedNav = c.listeners('will-frame-navigate'); c.removeAllListeners('will-frame-navigate'); });
      try {
        await page.evaluate(src => { const f = document.createElement('iframe'); f.id = 'dk-test-probe'; f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'position:fixed;width:10px;height:10px;left:-50px'; f.src = src; document.body.append(f); }, url);
        if (guard) { await delay(1500); }
        else await until(async () => { const n = await netState(); return n.completed.slice(before.completed.length).some(e => e.url === url) || n.errors.slice(before.errors.length).some(e => e.url === url); }, `Sem resposta do protocolo para ${url}`);
      } finally {
        await page.evaluate(() => document.getElementById('dk-test-probe')?.remove());
        if (!guard) await app.evaluate(({ BrowserWindow }) => { const c = BrowserWindow.getAllWindows()[0].webContents; for (const l of globalThis.__dkSavedNav) c.on('will-frame-navigate', l); });
      }
      const after = await netState();
      return { completed: after.completed.slice(before.completed.length).filter(e => e.url === url), requested: after.before.slice(before.before.length).filter(e => e.url === url).length,
        navigations: after.navigations.slice(before.navigations.length).filter(e => e.url === url).length };
    }

    // h. Prévia antiga (srcdoc) do editor de código continua funcionando.
    await openProjectPanel(page, 'files');
    await page.locator(`.tree-file[data-relative="${page_}"]`).click();
    const codePreview = page.frameLocator('iframe[title="Visualização de pagina.html"]');
    await codePreview.locator('#titulo').waitFor();
    const legacy = page.locator('iframe[title="Visualização de pagina.html"]');
    assert.equal(await legacy.getAttribute('sandbox'), '');
    assert.ok((await legacy.getAttribute('srcdoc')).includes('Texto da folha'));
    assert.equal(await codePreview.locator('#folha').textContent(), 'Texto da folha');
    assert.equal(await page.evaluate(() => window.__autorScript), undefined);
    step('h prévia srcdoc do editor de código intacta', 'sandbox="", srcdoc com o documento, script do autor não roda');

    // a. Abrir pelo botão "Editar visualmente".
    await page.evaluate(() => { window.__bridge = []; addEventListener('message', e => { if (e.data && e.data.dk === 1) window.__bridge.push({ origin: e.origin, type: e.data.type, gen: e.data.gen, nodes: e.data.nodes, counts: e.data.counts, hosts: e.data.hosts, node: e.data.node, count: e.data.count }); }); });
    const netStart = await netState();
    const sessionStart = Date.now();
    await page.getByRole('button', { name: 'Editar visualmente', exact: true }).click();
    await page.locator('#visual-view').waitFor({ state: 'visible' });
    await visualFrame.waitFor();
    const url0 = await currentUrl();
    assert.match(url0, /^dk-preview:\/\/[0-9a-f]{32}\/pagina\.html\?g=0$/);
    assert.equal(await visualFrame.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await visualFrame.getAttribute('allow'), '');
    assert.equal(await visualFrame.getAttribute('referrerpolicy'), 'no-referrer');
    await waitFrame(url0);
    await until(async () => (await page.evaluate(() => window.__bridge)).some(m => m.type === 'dk-edit-ready'), 'A ponte não enviou dk-edit-ready.');
    // Banner de recursos bloqueados: falha de produto conhecida (ponte inserida no EOF perde eventos de
    // bloqueio que ocorrem antes dela) é registrada sem interromper os demais itens; o teste falha no fim.
    const blockedBanner = await until(async () => (await banners()).find(t => /recursos externos não carregados/.test(t)), '', 6000).catch(() => null);
    await delay(1200); // agrega relatórios tardios de bloqueio
    const bannerText = (await banners()).join('\n');
    assert.match(bannerText, /Scripts desativados na edição: 1 scripts e 1 manipuladores\./);
    let blockedCount = 0;
    if (!blockedBanner) productFailures.push('a: banner de recursos externos ausente (2 recursos externos bloqueados, nenhum dk-edit-blocked da ponte)');
    else {
      const finalBanner = (await banners()).find(t => /recursos externos não carregados/.test(t));
      assert.ok(finalBanner.includes(`127.0.0.1:${port}`) && finalBanner.includes(`localhost:${port}`), finalBanner);
      assert.ok(!/https?:\/\/|externa\.png|externo\.css|dk-preview/.test(finalBanner), `Banner não pode trazer URL: ${finalBanner}`);
      blockedCount = Number(finalBanner.match(/^(\d+)/)[1]);
      if (blockedCount !== 2) productFailures.push(`a: banner conta ${blockedCount} recursos externos para 2 bloqueados (violação de CSP e erro do elemento contados em dobro)`);
    }
    step('a aberto pelo botão "Editar visualmente"', `iframe sandbox="allow-scripts", ${url0.replace(/\/\/[0-9a-f]{32}/, '//<token>')}; banners: ${JSON.stringify(await banners())}`);

    // b. Scripts do autor não rodam; a ponte roda; seleção, painel e clone.
    const ready = (await page.evaluate(() => window.__bridge)).find(m => m.type === 'dk-edit-ready');
    assert.equal(ready.origin, 'null');
    const author = await inFrame('({ script: typeof window.__autorScript, clique: window.__autorClique, nonce: [...document.scripts].filter(s => s.nonce).length, scripts: document.scripts.length, overlay: document.documentElement.lastElementChild.getAttribute("aria-hidden"), marcados: document.querySelectorAll("[data-dk-node]").length })');
    assert.equal(author.script, 'undefined'); assert.equal(await page.evaluate(() => window.__autorScript), undefined);
    assert.equal(author.overlay, 'true'); assert.equal(author.nonce, 1);
    assert.equal(ready.nodes, author.marcados);
    await clickInFrame('#botao');
    await delay(300);
    assert.equal(await inFrame('typeof window.__autorClique'), 'undefined', 'onclick do autor não pode rodar.');
    await select('#folha', 'p');
    assert.equal(await page.locator('.dk-visual-textarea').inputValue(), 'Texto da folha');
    await select('#cruzada > b', 'b');
    const cloneText = await page.locator('.dk-visual-readonly').textContent();
    assert.match(cloneText, /somente leitura.*duplicado pela estrutura HTML/i);
    const select2 = (await page.evaluate(() => window.__bridge)).filter(m => m.type === 'dk-edit-select').at(-1);
    assert.equal(select2.count, 2);
    step('b scripts do autor e onclick não rodam; ponte ativa', `ready.nodes=${ready.nodes}, ${author.scripts} scripts no DOM (1 com nonce); clone count=${select2.count}: "${cloneText}"`);

    // c. Texto de folha e atributo title, desfazer/refazer, salvar; só o trecho muda no disco.
    const newText = 'Texto editado & <seguro>';
    await select('#folha', 'p');
    await page.locator('.dk-visual-textarea').fill(newText);
    await applyButton.click();
    await waitGeneration(1);
    assert.equal(await inFrame('document.getElementById("folha").textContent'), newText);
    await select('#titulo', 'h1');
    await page.getByRole('tab', { name: 'Atributos' }).click();
    await page.getByLabel('Título (title)').fill('Novo título');
    await applyButton.click();
    await waitGeneration(2);
    assert.equal(await inFrame('document.getElementById("titulo").title'), 'Novo título');
    assert.equal((await state()).dirty, true);
    await toolbar('Desfazer').click();
    await waitGeneration(3);
    assert.equal(await inFrame('document.getElementById("titulo").title'), 'Original');
    assert.equal(await inFrame('document.getElementById("folha").textContent'), newText);
    await toolbar('Refazer').click();
    await waitGeneration(4);
    assert.equal(await inFrame('document.getElementById("titulo").title'), 'Novo título');
    assert.equal(fs.readFileSync(pageFile).equals(original), true, 'Desfazer/refazer não podem gravar.');
    await toolbar('Salvar').click();
    await until(async () => !(await state()).dirty, 'Salvar não limpou o estado.');
    const saved = fs.readFileSync(pageFile);
    const expected = Buffer.from(original.toString('utf8').replace('Texto da folha', 'Texto editado &amp; &lt;seguro&gt;').replace('title="Original"', 'title="Novo título"'), 'utf8');
    assert.ok(saved.equals(expected), 'Bytes gravados diferentes do esperado.');
    const firstChange = original.indexOf('title="Original"'), lastChangeEnd = original.indexOf('Texto da folha') + Buffer.byteLength('Texto da folha');
    assert.ok(saved.subarray(0, firstChange).equals(original.subarray(0, firstChange)), 'Prefixo alterado.');
    const suffix = original.length - lastChangeEnd;
    assert.ok(saved.subarray(saved.length - suffix).equals(original.subarray(lastChangeEnd)), 'Sufixo alterado.');
    assert.ok(saved.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOM perdido.');
    const crlf = b => (b.toString('latin1').match(/\r\n/g) || []).length, bareLf = b => (b.toString('latin1').match(/(^|[^\r])\n/g) || []).length;
    assert.equal(crlf(saved), crlf(original)); assert.equal(bareLf(saved), 0);
    const stat = git('diff', '--stat').trim().split('\n');
    assert.equal(stat.length, 2); assert.match(stat.at(-1), /1 file changed, 2 insertions\(\+\), 2 deletions\(-\)/);
    const numstat = git('diff', '--numstat').trim();
    step('c texto + title aplicados (g=1,2), desfazer g=3, refazer g=4, salvo', `prefixo ${firstChange} B e sufixo ${suffix} B idênticos, BOM e ${crlf(saved)} CRLF preservados; git diff --stat: "${stat.at(-1).trim()}" (${numstat.replace(/\s+/g, ' ')})`);

    // d. Conflito: arquivo alterado por fora; salvar recusa; Recarregar descarta.
    await select('#folha', 'p');
    await editText('Edição em conflito');
    await waitGeneration(5);
    const external = Buffer.concat([saved, Buffer.from('<!-- alterado por fora -->\r\n')]);
    fs.writeFileSync(pageFile, external);
    await toolbar('Salvar').click();
    await page.locator('.dk-visual-banner.is-conflict').waitFor();
    assert.match(await page.locator('.dk-visual-banner.is-conflict').innerText(), /Conflito ao salvar: o arquivo foi alterado no disco\./);
    assert.ok(fs.readFileSync(pageFile).equals(external), 'Conflito não pode gravar.');
    const conflictState = await state();
    assert.equal(conflictState.dirty, true); assert.equal(conflictState.canUndo, true);
    assert.equal(await inFrame('document.getElementById("folha").textContent'), 'Edição em conflito');
    assert.equal(fs.readdirSync(projectA).filter(n => /\.tmp|\.dk-/.test(n)).length, 0, 'Sem temporários após conflito.');
    await page.getByRole('button', { name: 'Recarregar (descarta alterações)' }).click();
    await page.locator('dialog.dk-visual-confirm').getByRole('button', { name: 'Recarregar', exact: true }).click();
    await until(async () => { const u = await currentUrl(); return u !== null && u.endsWith('?g=0'); }, 'Recarregar não abriu nova sessão.');
    await waitFrame(await currentUrl());
    assert.equal(await inFrame('document.getElementById("folha").textContent'), newText);
    assert.equal((await state()).dirty, false);
    assert.ok(fs.readFileSync(pageFile).equals(external));
    // Recarregar cria nova sessão: as violações de CSP anteriores à ponte precisam continuar contadas.
    const reloadedBanner = await until(async () => (await banners()).find(t => /recursos externos não carregados/.test(t)), 'Aviso de recursos externos ausente após Recarregar.', 6000);
    assert.match(reloadedBanner, /^2 recursos externos não carregados/);
    step('d conflito: banner, disco intocado, cópia e histórico mantidos (canUndo); Recarregar descarta');

    // e. Rede, fonte local, geração antiga 410 e navegação barrada.
    const urlNow = await currentUrl();
    const token = new URL(urlNow).host;
    const font = await inFrame('document.fonts.load("16px DkLocal").then(() => ({ status: [...document.fonts].find(f => f.family.replace(/"/g, "") === "DkLocal")?.status, family: getComputedStyle(document.getElementById("fonte")).fontFamily, color: getComputedStyle(document.getElementById("titulo")).color, img: document.getElementById("local").naturalWidth, ext: document.getElementById("externa").naturalWidth }))');
    assert.equal(font.status, 'loaded'); assert.equal(font.color, 'rgb(20, 100, 40)'); assert.equal(font.img, 1); assert.equal(font.ext, 0);
    const fontResponses = (await netState()).completed.filter(e => e.url === `dk-preview://${token}/fontes/local.woff2`);
    assert.ok(fontResponses.some(e => e.status === 200), `Fonte sem 200: ${JSON.stringify(fontResponses)}`);
    // Aplica para criar a geração 1 desta sessão; a 0 fica antiga.
    await select('#folha', 'p');
    await editText('Geração nova');
    await waitGeneration(1);
    const stale = await probe(urlNow, false);
    assert.deepEqual(stale.completed.map(e => e.status), [410], `Geração antiga: ${JSON.stringify(stale)}`);
    const staleGuarded = await probe(urlNow, true);
    assert.equal(staleGuarded.requested, 0, 'Com o guarda, o iframe não deve pedir URL que não é a atual.');
    // Navegação do próprio iframe para outro documento do protocolo e para fora.
    const live = await currentUrl();
    await frameJs(live, `location.href = ${JSON.stringify(`dk-preview://${token}/outra.html`)}; 1`);
    await delay(800);
    assert.ok((await frameUrls()).includes(live), 'O iframe saiu do documento atual (dk-preview).');
    assert.equal(await inFrame('document.getElementById("folha").textContent'), 'Geração nova');
    const outraBlocked = (await netState()).navigations.some(n => !n.main && n.url === `dk-preview://${token}/outra.html`);
    assert.ok(outraBlocked, 'will-frame-navigate não registrou a tentativa para outra.html.');
    assert.equal((await netState()).completed.filter(e => e.url.endsWith('/outra.html')).length, 0);
    // Para fora: a CSP do pai (frame-src dk-preview:) barra antes de will-frame-navigate; o iframe fica
    // numa página de erro opaca, sem pedido de rede. A próxima geração restaura o documento.
    const blockedBefore = (await netState()).blocked.length;
    await frameJs(live, `location.href = ${JSON.stringify(`http://127.0.0.1:${port}/fuga`)}; 1`);
    await delay(800);
    const escaped = await app.evaluate(({ BrowserWindow }, target) => { const f = BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.find(x => x.url === target); return f ? f.executeJavaScript('({ url: document.URL, text: document.body ? document.body.innerText.length : 0 })') : null; }, `http://127.0.0.1:${port}/fuga`);
    assert.equal((await netState()).blocked.length, blockedBefore); assert.equal(loopback.connections, 0);
    assert.ok(!escaped || (escaped.url === 'chrome-error://chromewebdata/' && escaped.text === 0), `Navegação externa carregou conteúdo: ${JSON.stringify(escaped)}`);
    // Descarta a geração para continuar limpo.
    await toolbar('Desfazer').click();
    await waitGeneration(2);
    assert.equal((await state()).dirty, false);
    const netEnd = await netState();
    const external_ = netEnd.before.slice(netStart.before.length).filter(e => !/^(dk-app|dk-preview):/.test(e.url) && !e.url.startsWith(`file://${root}/dist/`));
    assert.deepEqual(external_, [], `Pedidos fora de dk-*: ${JSON.stringify(external_)}`);
    assert.equal(loopback.connections, 0); assert.deepEqual(loopback.requests, []);
    const previewRequests = netEnd.before.slice(netStart.before.length).filter(e => e.url.startsWith('dk-preview:')).length;
    step('e rede zerada', `${previewRequests} pedidos dk-preview, 0 fora de dk-* (exceto file:// do próprio dist servido pelo dk-app), 0 conexões no loopback, ${blockedCount} bloqueios reportados; fonte woff2 "loaded" (200); g antiga = 410; com guarda 0 pedidos; navegação para outra.html e loopback barradas`);

    // g (parte 1). Fechar com alterações pede confirmação; ⌘S salva no visual.
    await select('#folha', 'p');
    await editText('Salvo por comando');
    await waitGeneration(3);
    await toolbar('Fechar').click();
    const confirmDialog = page.locator('dialog.dk-visual-confirm');
    await confirmDialog.waitFor();
    assert.match(await confirmDialog.innerText(), /Salvar alterações em pagina\.html\?/);
    await confirmDialog.getByRole('button', { name: 'Cancelar' }).click();
    assert.equal(await page.locator('#visual-view').isVisible(), true);
    await app.evaluate(({ dialog }) => { globalThis.__dkDialogs = []; dialog.showMessageBox = async (...args) => { const options = args.find(a => a && a.message); globalThis.__dkDialogs.push(options.message); return { response: 0 }; }; });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await until(async () => (await app.evaluate(() => globalThis.__dkDialogs.length)) > 0, 'Fechar a janela não pediu confirmação.');
    const closeMessage = (await app.evaluate(() => globalThis.__dkDialogs))[0];
    assert.equal(closeMessage, 'Há alterações não salvas no editor visual.');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal((await state()).dirty, true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu', 'save'));
    await until(async () => !(await state()).dirty, '⌘S (menu Salvar) não salvou o visual.');
    assert.ok(fs.readFileSync(pageFile).toString('utf8').includes('<p id="folha">Salvo por comando</p>'));
    step('g fechar com alterações pede confirmação', `diálogo do app e da janela: "${closeMessage}"; ⌘S (menu Salvar) gravou`);

    // h (retorno). Depois de salvar no visual, a prévia srcdoc reflete o disco.
    await page.locator('[data-testid="visual-back"]').click();
    await page.locator('#visual-view').waitFor({ state: 'hidden' });
    await until(async () => (await codePreview.locator('#folha').textContent().catch(() => '')) === 'Salvo por comando', 'A prévia do código não refletiu o arquivo salvo.');
    step('h prévia srcdoc atualizada após salvar no visual');

    // f. Prova 10: parse5 × Chromium no corpus (servido pela sessão real do app).
    const corpus = path.join(projectA, 'corpus');
    execFileSync(process.execPath, [path.join(corpusSource, 'gerar.cjs'), corpus]);
    const manifest = JSON.parse(fs.readFileSync(path.join(corpusSource, 'manifesto.json'), 'utf8'));
    const rows = [], divergences = [], refusalsMismatch = [];
    for (const entry of manifest) {
      const relative = `corpus/${entry.arquivo}`;
      if (!fs.existsSync(path.join(projectA, relative))) { refusalsMismatch.push(`${entry.arquivo}: ausente`); continue; }
      const result = await page.evaluate(([dir, rel, dirty]) => window.dk.openVisual(dir, rel, { codeEditorDirty: dirty }), [projectA, relative, entry.caso === 'editor-codigo-sujo']);
      if (entry.esperado !== 'editavel') { if (result.ok) refusalsMismatch.push(`${entry.arquivo}: abriu`); continue; }
      if (!result.ok) { refusalsMismatch.push(`${entry.arquivo}: recusado ${result.reason}`); continue; }
      const url = result.doc.url;
      await page.evaluate(src => { const f = document.createElement('iframe'); f.id = 'dk-test-corpus'; f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'position:fixed;width:400px;height:300px;left:-500px'; f.src = src; document.body.append(f); }, url);
      await waitFrame(url);
      const dom = await frameJs(url, `(() => { const ids = new Set(), all = new Set(); let elements = 0;
        for (const e of document.querySelectorAll('[data-dk-node]')) { elements++; ids.add(e.getAttribute('data-dk-node')); all.add(e.getAttribute('data-dk-node')); }
        const walk = r => { for (const t of r.querySelectorAll('template')) { for (const e of t.content.querySelectorAll('[data-dk-node]')) all.add(e.getAttribute('data-dk-node')); walk(t.content); } };
        walk(document); return { ids: ids.size, all: all.size, elements }; })()`);
      await page.evaluate(() => document.getElementById('dk-test-corpus')?.remove());
      rows.push({ arquivo: entry.arquivo, prepare: result.doc.nodes, dom: dom.ids, comTemplate: dom.all, elementos: dom.elements });
      if (dom.ids !== result.doc.nodes) divergences.push(`${entry.arquivo}: prepare ${result.doc.nodes}, DOM ${dom.ids} (com template ${dom.all}, elementos ${dom.elements})`);
    }
    // Meta refresh para fora (o único gatilho de navegação sem scripts do autor).
    const refresh = await page.evaluate(dir => window.dk.openVisual(dir, 'refresh-externo.html', { codeEditorDirty: false }), projectA);
    assert.equal(refresh.ok, true);
    await page.evaluate(src => { const f = document.createElement('iframe'); f.id = 'dk-test-corpus'; f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'position:fixed;width:400px;height:300px;left:-500px'; f.src = src; document.body.append(f); }, refresh.doc.url);
    await delay(2000);
    const refreshStayed = (await frameUrls()).includes(refresh.doc.url);
    await page.evaluate(() => document.getElementById('dk-test-corpus')?.remove());
    assert.equal(loopback.connections, 0);
    if (!refreshStayed) observations.push('meta refresh para URL externa troca o documento do iframe por página de erro (sem tráfego): a área de edição fica vazia até nova geração');
    await page.evaluate(dir => window.dk.closeVisual(dir), projectA);
    const editable = manifest.filter(e => e.esperado === 'editavel').length;
    assert.deepEqual(refusalsMismatch, [], `Corpus fora do esperado: ${refusalsMismatch.join('; ')}`);
    const unexplained = divergences.filter(line => { const row = rows.find(r => line.startsWith(r.arquivo + ':')); return row.comTemplate !== row.prepare; });
    assert.deepEqual(unexplained, [], `Divergências parse5 × Chromium: ${unexplained.join('; ')}`);
    const clones = rows.filter(r => r.elementos > r.dom).map(r => `${r.arquivo} (${r.elementos} elementos, ${r.dom} ids)`);
    step('f prova 10 parse5 × Chromium', `${rows.length}/${editable} editáveis abertos, ${rows.filter(r => r.dom === r.prepare).length} iguais por id; divergências só por template: ${divergences.join('; ') || 'nenhuma'}; clones: ${clones.join(', ') || 'nenhum'}; ${manifest.length - editable} recusas conferidas`);
    fs.rmSync(corpus, { recursive: true, force: true });

    // g (parte 2). Trocar de projeto revoga a sessão.
    await page.getByRole('button', { name: 'Editar visualmente', exact: true }).click();
    await waitFrame(await currentUrl());
    const revokedUrl = await currentUrl();
    const revokedGen = await generation();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, projectB);
    await openFolderDialog(app);
    await page.waitForFunction(() => document.getElementById('project-title')?.textContent === 'Projeto B');
    const afterSwitch = await page.evaluate(([dir, gen]) => window.dk.inspectVisual(dir, gen, 1), [projectA, revokedGen]);
    assert.equal(afterSwitch.ok, false);
    const revokedProbe = await probe(revokedUrl, false);
    assert.deepEqual(revokedProbe.completed.map(e => e.status), [404], `Token revogado: ${JSON.stringify(revokedProbe)}`);
    assert.equal(await page.locator('#visual-view').isVisible(), false);
    step('g trocar de projeto revoga a sessão', `inspect → ${afterSwitch.reason}; token antigo → 404`);

    assert.deepEqual(pageErrors, []);

    // 2. Prova do asar: worker e ponte dentro de um .asar, no processo main do Electron.
    const staging = path.join(temp, 'asar-src'), asarFile = path.join(temp, 'prova.asar');
    fs.mkdirSync(path.join(staging, 'electron'), { recursive: true });
    for (const file of ['visual-patch-worker.cjs', 'html-patch.cjs', 'visual-bridge.js', 'files.cjs']) fs.copyFileSync(path.join(root, 'electron', file), path.join(staging, 'electron', file));
    for (const dep of ['parse5', 'entities']) fs.cpSync(fs.realpathSync(path.join(root, 'node_modules', dep)), path.join(staging, 'node_modules', dep), { recursive: true, dereference: true });
    await require('@electron/asar').createPackage(staging, asarFile);
    fs.rmSync(staging, { recursive: true, force: true });
    const asarProof = await app.evaluate(async ({ app: electronApp }, [archive, work]) => {
      const load = process.getBuiltinModule('module').createRequire(electronApp.getAppPath() + '/electron/main.cjs');
      const fsAsar = load('node:fs'), pathMod = load('node:path'), { Worker } = load('node:worker_threads');
      const bridge = fsAsar.readFileSync(pathMod.join(archive, 'electron', 'visual-bridge.js'), 'utf8');
      const stat = fsAsar.lstatSync(work);
      const html = Buffer.from('<!doctype html><html><head><title>A</title></head><body><p>asar</p></body></html>');
      const worker = new Worker(pathMod.join(archive, 'electron', 'visual-patch-worker.cjs'), { workerData: { root: work, dev: stat.dev, ino: stat.ino } });
      const call = message => new Promise((resolve, reject) => {
        worker.once('message', resolve); worker.once('error', reject);
        worker.postMessage(message);
      });
      try {
        const prepared = await call({ id: 1, command: 'prepare', bytes: html, relative: 'a.html', serving: { nonce: 'abc123', chan: 'c'.repeat(32), gen: 0, bridgeSource: bridge } });
        const encoded = await call({ id: 2, command: 'encode' });
        const patch = load(pathMod.join(archive, 'electron', 'html-patch.cjs'));
        return { bridgeBytes: bridge.length, prepareOk: prepared.result.ok, nodes: prepared.result.info?.nodes, servedHasBridge: Buffer.from(prepared.result.served || []).toString('utf8').includes('<script nonce="abc123">'),
          roundTrip: Buffer.from(encoded.result.bytes).equals(html), mainPrepare: patch.prepare(html, { relative: 'a.html' }).ok, reason: prepared.result.reason };
      } finally { await worker.terminate(); }
    }, [asarFile, temp]);
    assert.equal(asarProof.prepareOk, true, `Worker no asar falhou: ${JSON.stringify(asarProof)}`);
    assert.ok(asarProof.bridgeBytes > 1000); assert.equal(asarProof.servedHasBridge, true); assert.equal(asarProof.roundTrip, true); assert.equal(asarProof.mainPrepare, true);
    step('2 asar: new Worker(<asar>/electron/visual-patch-worker.cjs) executou prepare e encode', `${asarProof.nodes} nós, ponte ${asarProof.bridgeBytes} B lida com fs.readFileSync do asar, parse5 resolvido no asar (worker e main); arquivo ${Math.round(fs.statSync(asarFile).size / 1024)} KiB`);

    if (observations.length) console.log('! Observações:\n  - ' + observations.join('\n  - '));
    if (productFailures.length) { console.log('✗ Falhas de produto:\n  - ' + productFailures.join('\n  - ')); process.exitCode = 1; }
    console.log(`Tempo total: ${((Date.now() - started) / 1000).toFixed(1)} s (sessão visual ${((Date.now() - sessionStart) / 1000).toFixed(1)} s).`);
  } finally {
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
      await app.close().catch(() => {});
    }
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
