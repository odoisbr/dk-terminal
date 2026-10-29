const { startProjectTerminal } = require('./helpers/project-session.cjs');
// Testes isolados: ambos os hosts respondem no mesmo servidor de loopback.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), { createHash } = require('node:crypto');

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
    const view = BrowserWindow.getAllWindows()[0].contentView.children[0];
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
    const open = (project, url) => page.evaluate(({ project, url, bounds }) => window.dk.openBrowser(project, url, bounds), { project, url, bounds });
    const close = () => page.evaluate(() => window.dk.closeBrowser());
    await open(first, local + '/');

    const options = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.getLastWebPreferences());
    assert.equal(options.sandbox, true); assert.equal(options.contextIsolation, true); assert.equal(options.nodeIntegration, false);
    const partitionKey = 'dk-preview-' + createHash('sha256').update(first).digest('hex').slice(0, 20);
    assert.equal(await app.evaluate(({ BrowserWindow, session }, key) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.session === session.fromPartition(key), partitionKey), true);
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
    await close(); await open(first, local + '/');
    assert.equal(await preview("fetch('/cache-check').then(r => r.text())"), 'CACHE_OK');
    assert.equal(requests.filter(row => row.url === '/cache-check').length, 2);
    console.log('✓ Cache HTTP temporário é limpo antes da reabertura');

    await preview("localStorage.setItem('dk-test-marker','first'); true");
    await open(second, local + '/');
    assert.equal(await preview("localStorage.getItem('dk-test-marker')"), null);
    await preview("localStorage.setItem('dk-test-marker','second'); true");
    await close();
    await open(second, local + '/');
    assert.equal(await preview("localStorage.getItem('dk-test-marker')"), null);
    const previewId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.id);
    await close();
    for (let i = 0; i < 50 && await app.evaluate(({ webContents }, id) => !!webContents.fromId(id), previewId); i++) await wait(50);
    assert.equal(await app.evaluate(({ webContents }, id) => !!webContents.fromId(id), previewId), false);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length), 0);
    console.log('✓ Partições separadas, storage limpo e WebContents removido ao fechar');

    const oldIds = [];
    for (let i = 0; i < 3; i++) {
      await open(first, local + '/');
      oldIds.push(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.id));
      await close();
    }
    for (let i = 0; i < 50 && await app.evaluate(({ webContents }, ids) => ids.some(id => !!webContents.fromId(id)), oldIds); i++) await wait(50);
    assert.equal(await app.evaluate(({ webContents }, ids) => ids.some(id => !!webContents.fromId(id)), oldIds), false);
    console.log('✓ Aberturas repetidas não deixam WebContents ativos');

    const slow = open(first, local + '/slow');
    for (let i = 0; i < 50 && !requests.some(row => row.url === '/slow'); i++) await wait(30);
    assert.ok(requests.some(row => row.url === '/slow'));
    await open(second, local + '/');
    assert.equal((await slow).cancelled, true);
    assert.equal(await preview('location.href'), local + '/');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length), 1);
    await close();
    console.log('✓ Troca de projeto durante carregamento não conserva a prévia anterior');

    await open(first, local + '/');
    const slowAgain = open(first, local + '/slow');
    for (let i = 0; i < 50 && requests.filter(row => row.url === '/slow').length < 2; i++) await wait(30);
    assert.equal(requests.filter(row => row.url === '/slow').length, 2);
    await open(first, local + '/?newer=1');
    assert.equal((await slowAgain).cancelled, true);
    assert.equal(await preview('location.search'), '?newer=1');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length), 1);
    await close();
    console.log('✓ Navegações concorrentes mantêm o endereço mais recente');
  } finally {
    if (app) await app.close();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
