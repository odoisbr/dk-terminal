const { startProjectTerminal } = require('./helpers/project-session.cjs');
// Testes isolados: ambos os hosts respondem no mesmo servidor de loopback.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

const root = path.resolve(__dirname, '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-browser-test-')));
const first = path.join(temporary, 'primeiro'), second = path.join(temporary, 'segundo');
fs.mkdirSync(first); fs.mkdirSync(second);
const pageHtml = fs.readFileSync(path.join(__dirname, 'fixtures/preview/index.html'));
const requests = [];
let app, server;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounds = { x: 15, y: 85, width: 400, height: 300 };

async function preview(script) {
  return app.evaluate(async ({ BrowserWindow }, source) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child.webContents && child.getVisible());
    if (!view) throw new Error('Prévia não encontrada.');
    return view.webContents.executeJavaScript(source, true);
  }, script);
}

(async () => {
  try {
    server = http.createServer((request, response) => {
      requests.push({ url: request.url, host: request.headers.host });
      response.setHeader('Access-Control-Allow-Origin', '*');
      if (request.url === '/external') return response.end('EXTERNAL_FETCH_OK');
      if (request.url === '/cache-check') {
        response.setHeader('Cache-Control', 'public, max-age=3600');
        return response.end('CACHE_OK');
      }
      if (request.url === '/download') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=dk-browser-test.bin' });
        return response.end('download de teste');
      }
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: `http://outside.test:${server.address().port}/redirect-target` });
        return response.end();
      }
      if (request.url === '/slow') return setTimeout(() => { if (!response.destroyed) response.end(pageHtml); }, 1200);
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(pageHtml);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port, local = `http://127.0.0.1:${port}`;
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    app = await electron.launch({
      executablePath,
      args: [...(executablePath ? [] : [root]), '--host-resolver-rules=MAP outside.test 127.0.0.1', '--no-proxy-server'],
      env: { ...process.env, ...(process.platform === 'win32' ? {} : { SHELL: '/bin/sh' }), DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: first, DK_TERMINAL_DATA_DIR: path.join(temporary, 'profile') },
    });
    const page = await app.firstWindow();
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), require('../package.json').version);
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    if (executablePath) {
      await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, first);
      await page.locator('#launcher-open-local').click();
    } else await page.locator('#launcher-recents .launcher-recent').first().click();
    await startProjectTerminal(page);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, second);
    await page.evaluate(() => window.dk.selectProject());
    const tabs = new Map();
    const getTab = async project => {
      if (!tabs.has(project)) tabs.set(project, await page.evaluate(root => window.dk.createBrowserTab(root), project));
      return tabs.get(project);
    };
    const open = async (project, url) => {
      const id = await getTab(project);
      return page.evaluate(async ({ project, url, bounds, id }) => { await window.dk.selectBrowser(project, id); return window.dk.openBrowser(project, url, bounds, id); }, { project, url, bounds, id });
    };
    const select = async project => page.evaluate(({ root, id }) => window.dk.selectBrowser(root, id), { root: project, id: await getTab(project) });
    const close = async project => { const id = tabs.get(project); if (!id) return; await page.evaluate(({ root, id }) => window.dk.closeBrowser(root, id), { root: project, id }); tabs.delete(project); };
    const currentViewId = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find(view => view.webContents && view.getVisible())?.webContents.id);
    await open(first, local + '/');

    const options = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.getLastWebPreferences());
    assert.equal(options.sandbox, true); assert.equal(options.contextIsolation, true); assert.equal(options.nodeIntegration, false);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.session.getStoragePath()), null, 'A partição da prévia deve ser temporária.');
    assert.equal(await preview("document.body.textContent.includes('DK_PREVIEW_FIXTURE')"), true);
    assert.equal(await preview("typeof window.require + ':' + typeof window.dk"), 'undefined:undefined');
    assert.equal(await preview("window.open('https://outside.test/') === null"), true);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    const permission = await preview("new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve('allowed'), e => resolve('denied:' + e.code), {timeout: 1500}))");
    assert.equal(permission, 'denied:1');
    const crossOrigin = await preview(`fetch('http://outside.test:${port}/external').then(r => r.text()).catch(e => 'ERROR:' + e.message)`);
    assert.equal(crossOrigin, 'EXTERNAL_FETCH_OK');
    assert.ok(requests.some(row => row.url === '/external' && row.host.startsWith('outside.test:')));
    console.log('✓ Isolamento do renderer, permissão negada e acesso de sub-recurso a outra origem observados');

    const originalURL = await preview('location.href');
    await preview(`location.href='http://outside.test:${port}/navigation'; true`);
    await wait(400);
    assert.equal(await preview('location.href'), originalURL);
    assert.equal(requests.some(row => row.url === '/navigation'), false);
    await assert.rejects(open(first, `http://outside.test:${port}/`), /somente/);
    await assert.rejects(open(first, 'file:///etc/passwd'), /somente/);
    await assert.rejects(open(first, local + '/redirect'));
    assert.equal(requests.some(row => row.url === '/redirect-target'), false);
    console.log('✓ Navegação de topo externa, file: e redirecionamento externo bloqueados');

    await open(first, local + '/');
    const downloadPath = path.join(temporary, 'forbidden-download.bin');
    await app.evaluate(async ({ BrowserWindow }, target) => {
      const contents = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents;
      global.__previewDownload = null;
      contents.session.prependOnceListener('will-download', (_event, item) => {
        item.setSavePath(target); item.once('done', (_done, state) => { global.__previewDownload = state; });
      });
      await contents.executeJavaScript("(()=>{const a=document.createElement('a');a.href='/download';a.download='fixture.bin';document.body.append(a);a.click();})()");
    }, downloadPath);
    for (let i = 0; i < 50 && !await app.evaluate(() => global.__previewDownload); i++) await wait(50);
    assert.equal(await app.evaluate(() => global.__previewDownload), 'cancelled');
    assert.equal(fs.existsSync(downloadPath), false);
    console.log('✓ Download cancelado sem gravar arquivo');

    assert.equal(await preview("fetch('/cache-check').then(r => r.text())"), 'CACHE_OK');
    assert.equal(await preview("fetch('/cache-check').then(r => r.text())"), 'CACHE_OK');
    assert.equal(requests.filter(row => row.url === '/cache-check').length, 1);
    await close(first); await open(first, local + '/');
    assert.equal(await preview("fetch('/cache-check').then(r => r.text())"), 'CACHE_OK');
    assert.equal(requests.filter(row => row.url === '/cache-check').length, 2);
    console.log('✓ Cache HTTP temporário é limpo antes da reabertura');

    await preview("localStorage.setItem('dk-test-marker','first'); true");
    const firstId = await currentViewId();
    await open(second, local + '/');
    const secondId = await currentViewId();
    assert.notEqual(firstId, secondId);
    assert.equal(await app.evaluate(({ webContents }, ids) => webContents.fromId(ids[0]).session !== webContents.fromId(ids[1]).session, [firstId, secondId]), true);
    assert.equal(await preview("localStorage.getItem('dk-test-marker')"), null);
    await preview("localStorage.setItem('dk-test-marker','second'); true");
    await select(first);
    assert.equal(await currentViewId(), firstId);
    assert.equal(await preview("localStorage.getItem('dk-test-marker')"), 'first');
    await close(second);
    assert.equal(await currentViewId(), firstId, 'Fechar a prévia inativa não deve remover a ativa.');
    await open(second, local + '/');
    assert.equal(await preview("localStorage.getItem('dk-test-marker')"), null);
    const previewId = await currentViewId();
    await close(second);
    for (let i = 0; i < 50 && await app.evaluate(({ webContents }, id) => !!webContents.fromId(id), previewId); i++) await wait(50);
    assert.equal(await app.evaluate(({ webContents }, id) => !!webContents.fromId(id), previewId), false);
    assert.equal(await app.evaluate(({ webContents }, id) => !!webContents.fromId(id), firstId), true);
    const previousToken = tabs.get(first);
    // Segura a limpeza real da partição, reproduzindo fechamento e reabertura
    // simultâneos sem tocar em storage fora da fixture.
    await app.evaluate(({ webContents }, id) => {
      const partition = webContents.fromId(id).session, original = partition.clearStorageData;
      global.__browserRestoreCleanup = () => { partition.clearStorageData = original; };
      partition.clearStorageData = async function (...args) {
        await new Promise(resolve => { global.__browserResumeCleanup = resolve; });
        return original.apply(this, args);
      };
    }, firstId);
    const pendingClose = page.evaluate(({ root, id }) => window.dk.closeBrowser(root, id), { root: first, id: previousToken });
    for (let i = 0; i < 100 && !await app.evaluate(() => typeof global.__browserResumeCleanup === 'function'); i++) await wait(30);
    assert.equal(await app.evaluate(() => typeof global.__browserResumeCleanup === 'function'), true, 'A limpeza da partição não ficou pendente.');
    const replacementToken = await page.evaluate(root => window.dk.createBrowserTab(root), first);
    assert.notEqual(previousToken, replacementToken);
    let replacementFinished = false;
    const replacementOpen = page.evaluate(async ({ root, id, url, bounds }) => { await window.dk.selectBrowser(root, id); return window.dk.openBrowser(root, url, bounds, id); }, { root: first, id: replacementToken, url: local + '/', bounds }).then(result => { replacementFinished = true; return result; });
    await wait(150);
    assert.equal(replacementFinished, false, 'A nova guia deve esperar a limpeza da anterior.');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length), 0);
    await app.evaluate(() => { global.__browserResumeCleanup(); global.__browserResumeCleanup = null; });
    await pendingClose; await replacementOpen;
    await app.evaluate(() => { global.__browserRestoreCleanup(); global.__browserRestoreCleanup = null; });
    const replacementId = await currentViewId();
    assert.ok(replacementId); assert.notEqual(replacementId, firstId);
    assert.equal(await preview("localStorage.getItem('dk-test-marker')"), null, 'A nova guia não deve herdar storage da anterior.');
    await preview("localStorage.setItem('dk-test-marker','replacement');true");
    assert.equal(await page.evaluate(({ root, id }) => window.dk.closeBrowser(root, id), { root: first, id: previousToken }), false);
    assert.equal(await page.evaluate(({ root, id }) => window.dk.selectBrowser(root, id), { root: first, id: previousToken }), false);
    const stale = await page.evaluate(({ root, id, url, bounds }) => window.dk.openBrowser(root, url, bounds, id), { root: first, id: previousToken, url: local + '/', bounds });
    assert.equal(stale.cancelled, true, 'Uma identidade encerrada não pode abrir outra view.');
    assert.equal(await currentViewId(), replacementId);
    assert.equal(await preview("localStorage.getItem('dk-test-marker')"), 'replacement', 'Um fechamento tardio não pode apagar a guia nova.');
    await page.evaluate(({ root, id }) => window.dk.closeBrowser(root, id), { root: first, id: replacementToken });
    tabs.delete(first);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length), 0);
    console.log('✓ Limpeza sequencial e identidades encerradas preservam a guia substituta');

    const oldIds = [];
    for (let i = 0; i < 3; i++) {
      await open(first, local + '/');
      oldIds.push(await currentViewId());
      await close(first);
    }
    for (let i = 0; i < 50 && await app.evaluate(({ webContents }, ids) => ids.some(id => !!webContents.fromId(id)), oldIds); i++) await wait(50);
    assert.equal(await app.evaluate(({ webContents }, ids) => ids.some(id => !!webContents.fromId(id)), oldIds), false);
    console.log('✓ Aberturas repetidas não deixam WebContents ativos');

    const slow = open(first, local + '/slow');
    for (let i = 0; i < 50 && !requests.some(row => row.url === '/slow'); i++) await wait(30);
    assert.ok(requests.some(row => row.url === '/slow'));
    const slowView = await currentViewId();
    await open(second, local + '/');
    const activeSecond = await currentViewId();
    assert.notEqual(activeSecond, slowView);
    assert.notEqual((await slow).cancelled, true);
    assert.equal(await preview('location.href'), local + '/');
    assert.equal(await currentViewId(), activeSecond, 'A conclusão de A não pode cobrir B.');
    assert.equal(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].contentView.children.find(view => view.webContents?.id === id)?.getVisible(), slowView), false);
    await close(second); await close(first);
    console.log('✓ Carregamento de projeto oculto não cobre a prévia selecionada');

    await open(first, local + '/');
    const slowAgain = open(first, local + '/slow');
    for (let i = 0; i < 50 && requests.filter(row => row.url === '/slow').length < 2; i++) await wait(30);
    assert.equal(requests.filter(row => row.url === '/slow').length, 2);
    await open(first, local + '/?newer=1');
    assert.equal((await slowAgain).cancelled, true);
    assert.equal(await preview('location.search'), '?newer=1');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length), 1);
    await close(first);
    console.log('✓ Navegações concorrentes mantêm o endereço mais recente');
  } finally {
    if (app) {
      try { await app.evaluate(() => { if (typeof global.__browserResumeCleanup === 'function') global.__browserResumeCleanup(); if (typeof global.__browserRestoreCleanup === 'function') global.__browserRestoreCleanup(); }); } catch {}
      await app.close();
    }
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
