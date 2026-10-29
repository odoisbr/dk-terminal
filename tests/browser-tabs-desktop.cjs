const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { openProjectPanel } = require('./helpers/project-inspector.cjs');

// Apenas projetos, comandos e servidores de loopback descartáveis.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-browser-tabs-')));
const first = path.join(temp, 'Projeto A'), second = path.join(temp, 'Projeto B'), bin = path.join(temp, 'bin');
for (const directory of [first, second, bin]) fs.mkdirSync(directory);
fs.writeFileSync(path.join(first, 'nota.txt'), 'Conteúdo original\n');
const server = path.join(temp, 'server.cjs');
fs.writeFileSync(server, String.raw`
const http = require('node:http');
const html = '<!doctype html><html lang="pt-BR"><body><h1>Fixture local</h1><label>Valor<input id="value"></label><script>window.__loadNonce=Math.random()</script></body></html>';
http.createServer((req,res) => {
  const send = () => { if (!res.destroyed) { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end(html); } };
  if (req.url === '/slow') { console.log('BROWSER_SLOW_REQUEST'); setTimeout(send, 1500); } else send();
}).listen(0, '127.0.0.1', function(){ console.log('http://127.0.0.1:' + this.address().port); });
`);
for (const project of [first, second]) fs.writeFileSync(path.join(project, 'dk-terminal.services.json'), JSON.stringify({ services: [{ name: 'web', role: 'frontend', command: process.execPath, args: [server] }] }));
const shell = path.join(temp, process.platform === 'win32' ? 'shell.exe' : 'shell');
if (process.platform === 'win32') fs.copyFileSync(process.execPath, shell);
else fs.writeFileSync(shell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });
const env = { ...process.env, PATH: bin, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: first, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile'), ...(process.platform === 'win32' ? { ComSpec: shell } : { SHELL: shell }) };
let app, page;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await delay(60); }
}
async function views() {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(item => item.webContents).map(item => ({ id: item.webContents.id, visible: item.getVisible(), url: item.webContents.getURL(), loading: item.webContents.isLoadingMainFrame(), bounds: item.getBounds() })));
}
async function view(id) { return (await views()).find(item => item.id === id); }
async function contents(id, source) {
  return app.evaluate(async ({ webContents }, { id, source }) => {
    const target = webContents.fromId(id); if (!target || target.isDestroyed()) throw new Error('Prévia destruída.');
    return target.executeJavaScript(source, true);
  }, { id, source });
}
async function visiblePreview(url) {
  let found;
  await until(async () => { const candidates = (await views()).filter(item => item.visible); found = candidates[0]; return candidates.length === 1 && found && !found.loading && (found.url === url || found.url === url + '/'); }, `Prévia ${url} não ficou visível.`);
  return found;
}
async function service(project) { return (await page.evaluate(folder => window.dk.listServices(folder), project)).find(item => item.id === 'custom:web'); }
async function startService(project) {
  await openProjectPanel(page, 'services');
  await page.getByRole('button', { name: 'Iniciar serviço web', exact: true }).click();
  let item; await until(async () => { item = await service(project); return item?.status === 'running' && item.pid && item.url; }, 'Serviço temporário não iniciou.');
  return item;
}
async function alive(item) { const response = await fetch(item.url); assert.equal(response.status, 200); assert.match(await response.text(), /Fixture local/); }
async function projectPath(directory) { await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, directory); }
async function tabSelected(selected) { await page.waitForFunction(value => document.querySelector('#browser-tab')?.getAttribute('aria-selected') === String(value), selected); }
async function assertCanvas(id) {
  let sample;
  await until(async () => {
    const bounds = (await view(id))?.bounds, canvas = await page.locator('#browser-canvas').boundingBox();
    if (!bounds || !canvas) return false;
    sample = { bounds, canvas };
    return Math.abs(bounds.x - canvas.x) <= 2 && Math.abs(bounds.y - canvas.y) <= 2 && Math.abs(bounds.width - canvas.width) <= 2 && Math.abs(bounds.height - canvas.height) <= 2;
  }, `Limites da prévia não acompanham o canvas: ${JSON.stringify(sample)}`);
}

(async () => {
  try {
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env, timeout: 60000 });
    page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await app.evaluate(({ ipcMain }) => {
      global.__browserTabHandlers = {}; global.__browserTabCounts = { create: 0, start: 0 };
      for (const [channel, key] of [['terminal:create', 'create'], ['terminal:start', 'start']]) {
        const original = ipcMain._invokeHandlers?.get(channel); if (!original) throw new Error(`Handler ${channel} indisponível.`);
        global.__browserTabHandlers[channel] = original; ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => { global.__browserTabCounts[key]++; return original(...args); });
      }
    });
    if (executablePath) {
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, first);
      await page.locator('#launcher-open-local').click();
    } else await page.locator('#launcher-recents .launcher-recent').first().click();
    await projectPath(first); await startProjectTerminal(page);
    const terminalId = (await page.locator('.tab-select[aria-selected=true]').getAttribute('id')).slice(4);
    await openProjectPanel(page, 'files');
    await page.locator('.tree-file[data-relative="nota.txt"]').click();
    await page.locator('.cm-content').click(); await page.keyboard.insertText(' rascunho preservado');
    await page.locator('.dk-editor-dirty[aria-label="Alterações não salvas"]').waitFor();
    let serviceA = await startService(first);
    await page.locator('#browser-view').waitFor({ state: 'visible' });
    const a = await visiblePreview(serviceA.url);
    const browserTab = page.locator('#browser-tab');
    assert.equal(await browserTab.getAttribute('role'), 'tab');
    assert.equal(await browserTab.getAttribute('aria-controls'), 'browser-view');
    assert.match(await page.locator('#browser-tab-close').getAttribute('aria-label'), /Fechar.*browser/i);
    await tabSelected(true);
    assert.equal(await page.locator(`#tab-${terminalId}`).isVisible(), true, 'As guias do terminal devem permanecer acessíveis.');
    assert.equal(await page.locator(`#tab-${terminalId}`).getAttribute('aria-selected'), 'false');
    assert.equal(await page.locator('#file-tabs .dk-editor-tab-name').filter({ hasText: 'nota.txt' }).isVisible(), true);
    await assertCanvas(a.id);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 620));
    await page.waitForFunction(() => innerWidth <= 940);
    await assertCanvas(a.id);
    for (const control of [browserTab, page.locator('#browser-tab-close'), page.locator(`#tab-${terminalId}`), page.locator('#tab-files')]) {
      await control.scrollIntoViewIfNeeded();
      const rect = await control.boundingBox(), bounds = (await view(a.id)).bounds;
      assert.ok(rect && !(rect.x < bounds.x + bounds.width && rect.x + rect.width > bounds.x && rect.y < bounds.y + bounds.height && rect.y + rect.height > bounds.y), `A prévia encobre um controle na janela mínima: ${JSON.stringify({ rect, bounds })}`);
      if (await control.isEnabled()) await control.click({ trial: true });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await page.waitForFunction(() => innerWidth > 940);
    await assertCanvas(a.id);
    await contents(a.id, "document.querySelector('#value').value='dados A';localStorage.setItem('tab-fixture','A');window.__savedNonce=window.__loadNonce;true");
    await page.locator('#open-browser').click();
    assert.equal(await page.locator('#browser-tab').count(), 1, 'Abrir novamente não deve duplicar a guia.');
    assert.equal((await visiblePreview(serviceA.url)).id, a.id);

    await page.locator(`#tab-${terminalId}`).click(); await tabSelected(false);
    await until(async () => (await view(a.id))?.visible === false, 'A prévia não foi ocultada ao selecionar terminal.');
    assert.equal(await contents(a.id, "document.querySelector('#value').value"), 'dados A');
    assert.equal(await page.locator(`#pane-${terminalId}`).isVisible(), true);
    await page.evaluate(id => { window.__browserTabTerminalOutput = ''; window.dk.onTerminalData(event => { if (event.id === id) window.__browserTabTerminalOutput += event.data; }); }, terminalId);
    const terminalCommand = process.platform === 'win32' ? 'process.stdout.write("\\nBROWSER_TAB_TERMINAL_ALIVE\\n")\r' : 'printf "\\nBROWSER_TAB_TERMINAL_ALIVE\\n"\r';
    await page.evaluate(({ id, command }) => window.dk.writeTerminal(id, command), { id: terminalId, command: terminalCommand });
    await page.waitForFunction(() => window.__browserTabTerminalOutput.includes('BROWSER_TAB_TERMINAL_ALIVE\r\n'));
    await page.locator('#file-tabs .dk-editor-tab-name').filter({ hasText: 'nota.txt' }).click();
    assert.match(await page.locator('.cm-content').innerText(), /rascunho preservado/);
    await browserTab.click(); await tabSelected(true);
    assert.equal((await visiblePreview(serviceA.url)).id, a.id);
    assert.equal(await contents(a.id, "window.__savedNonce===window.__loadNonce && localStorage.getItem('tab-fixture')==='A' && document.querySelector('#value').value==='dados A'"), true);
    await alive(serviceA);

    // Uma navegação concluída em segundo plano não pode cobrir o terminal.
    await page.locator('#browser-address').fill(serviceA.url + '/slow');
    await page.locator('#browser-address').press('Enter');
    await until(async () => (await service(first))?.log.includes('BROWSER_SLOW_REQUEST'), 'A navegação lenta não começou.');
    await page.locator(`#tab-${terminalId}`).click();
    await until(async () => { const item = await view(a.id); return item && !item.loading && item.url === serviceA.url + '/slow'; }, 'A navegação lenta não concluiu.');
    assert.equal((await view(a.id)).visible, false);
    assert.equal(await page.locator(`#pane-${terminalId}`).isVisible(), true);
    await browserTab.click(); await tabSelected(true);
    assert.equal((await view(a.id)).visible, true);

    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, second);
    await page.locator('#open-project').click(); await projectPath(second);
    assert.equal((await view(a.id)).visible, false);
    assert.equal(await page.locator('#browser-tab').count(), 0);
    assert.equal(await page.locator('.terminal-pane:visible').count(), 0);
    assert.deepEqual(await app.evaluate(() => global.__browserTabCounts), { create: 1, start: 1 });
    const serviceB = await startService(second);
    await page.locator('#browser-view').waitFor({ state: 'visible' });
    const b = await visiblePreview(serviceB.url);
    assert.notEqual(b.id, a.id);
    assert.equal((await view(a.id)).visible, false);
    await contents(b.id, "document.querySelector('#value').value='dados B';localStorage.setItem('tab-fixture','B');true");
    await assertCanvas(b.id);

    // Perfil cobre o HTML; a view nativa precisa ficar realmente oculta.
    await page.locator('#profile-show').click();
    await until(async () => (await view(b.id))?.visible === false, 'A prévia cobriu o Perfil.');
    await page.getByRole('checkbox', { name: 'Cursor piscando' }).waitFor();
    await page.locator('#launcher-close').click();
    await until(async () => (await view(b.id))?.visible === true, 'A prévia não reapareceu após o Perfil.');
    assert.equal(await contents(b.id, "document.querySelector('#value').value"), 'dados B');

    await page.locator('.project-select[title="Projeto A"]').click(); await projectPath(first);
    await until(async () => (await view(b.id))?.visible === false, 'A prévia de B permaneceu sobre A.');
    await page.locator('#browser-tab').click(); await tabSelected(true);
    await until(async () => (await view(a.id))?.visible === true, 'A prévia de A não retornou.');
    assert.equal(await contents(a.id, "localStorage.getItem('tab-fixture')"), 'A');
    assert.equal((await view(a.id)).url, serviceA.url + '/slow');
    assert.equal(await page.locator('#browser-tab').count(), 1);
    await alive(serviceA); await alive(serviceB);
    // Encerrar o serviço não fecha a guia nem apaga a página já carregada.
    await page.locator('#browser-stop').click();
    await until(async () => { const item = await service(first); return item && !['running', 'starting', 'stopping'].includes(item.status); }, 'O serviço de A não foi encerrado.');
    await page.waitForFunction(() => /Serviço encerrado/i.test(document.querySelector('#browser-status')?.textContent || ''));
    assert.equal(await page.locator('#browser-tab').count(), 1);
    assert.equal((await view(a.id)).visible, true);
    assert.equal(await contents(a.id, "document.querySelector('h1').textContent"), 'Fixture local');
    serviceA = await startService(first);
    assert.equal((await visiblePreview(serviceA.url)).id, a.id);
    await alive(serviceA); await alive(serviceB);
    await page.locator('#browser-tab-close').click();
    await page.locator('#browser-tab').waitFor({ state: 'detached' });
    await until(() => app.evaluate(({ webContents }, id) => !webContents.fromId(id), a.id), 'Fechar a guia de A não descartou sua view.');
    assert.ok(await view(b.id), 'Fechar A não deve destruir a prévia de B.');
    await alive(serviceA); await alive(serviceB);
    assert.equal(await page.locator(`#pane-${terminalId}`).count(), 1);
    assert.equal(fs.readFileSync(path.join(first, 'nota.txt'), 'utf8'), 'Conteúdo original\n');

    await page.locator('.project-select[title="Projeto B"]').click(); await projectPath(second);
    await page.locator('#browser-tab').click();
    await until(async () => (await view(b.id))?.visible === true, 'A prévia de B não voltou.');
    assert.equal(await contents(b.id, "document.querySelector('#value').value"), 'dados B');
    const projectB = page.locator('.project-row').filter({ has: page.locator('.project-select[title="Projeto B"]') });
    await projectB.hover(); await projectB.locator('.forget-project').click();
    await projectB.waitFor({ state: 'detached' });
    await until(() => app.evaluate(({ webContents }, id) => !webContents.fromId(id), b.id), 'Fechar o projeto não descartou sua prévia.');
    await alive(serviceA); await alive(serviceB);
    assert.equal(await page.locator(`#pane-${terminalId}`).count(), 1);
    assert.deepEqual(await app.evaluate(() => global.__browserTabCounts), { create: 1, start: 1 });
    console.log('✓ Guias preservam estado por projeto; fechar guia/projeto libera apenas sua prévia e mantém serviços');

    // Abrir e fechar uma guia enquanto browser:open está pendente não pode
    // permitir que o retorno tardio recrie uma view sem guia visível.
    await page.locator('.project-select[title="Projeto A"]').click(); await projectPath(first);
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers?.get('browser:open'); if (!original) throw new Error('Handler browser:open indisponível.');
      global.__browserTabOpenOriginal = original; global.__browserTabOpenDone = false;
      ipcMain.removeHandler('browser:open');
      ipcMain.handle('browser:open', async (...args) => { await new Promise(resolve => { global.__browserTabResumeOpen = resolve; }); const result = await original(...args); global.__browserTabOpenDone = true; return result; });
    });
    await page.locator('#open-browser').click();
    await until(() => app.evaluate(() => typeof global.__browserTabResumeOpen === 'function'), 'A abertura não ficou pendente.');
    await page.locator('#browser-tab-close').click();
    await page.locator('#browser-tab').waitFor({ state: 'detached' });
    await app.evaluate(() => { global.__browserTabResumeOpen(); global.__browserTabResumeOpen = null; });
    await until(() => app.evaluate(() => global.__browserTabOpenDone), 'A abertura pendente não retornou.');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#browser-tab').count(), 0);
    assert.equal((await views()).length, 0, 'O retorno tardio não pode recriar uma prévia sem guia.');
    await alive(serviceA); await alive(serviceB);
    assert.deepEqual(await app.evaluate(() => global.__browserTabCounts), { create: 1, start: 1 });
    console.log('✓ Fechamento durante carregamento não ressuscita view nem cria terminal');

    // A identidade da primeira guia pode retornar após ela ser fechada e uma
    // substituta já estar aberta. O retorno antigo deve limpar apenas seu ID.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('browser:open'); ipcMain.handle('browser:open', global.__browserTabOpenOriginal); global.__browserTabOpenOriginal = null;
      const create = ipcMain._invokeHandlers?.get('browser:create'), close = ipcMain._invokeHandlers?.get('browser:close');
      if (!create || !close) throw new Error('Handlers de criação/fechamento indisponíveis.');
      global.__browserTabCreateOriginal = create; global.__browserTabCloseOriginal = close;
      global.__browserTabCreateIds = []; global.__browserTabCloseResults = [];
      let holdFirst = true;
      ipcMain.removeHandler('browser:create');
      ipcMain.handle('browser:create', async (...args) => {
        const response = await create(...args);
        if (response?.ok && typeof response.value === 'string') global.__browserTabCreateIds.push(response.value);
        if (holdFirst) { holdFirst = false; await new Promise(resolve => { global.__browserTabResumeCreate = resolve; }); }
        return response;
      });
      ipcMain.removeHandler('browser:close');
      ipcMain.handle('browser:close', async (...args) => {
        const response = await close(...args);
        global.__browserTabCloseResults.push({ id: args[2], ok: !!response?.ok, value: response?.value });
        return response;
      });
    });
    await page.locator('#open-browser').click();
    await until(() => app.evaluate(() => typeof global.__browserTabResumeCreate === 'function'), 'A criação antiga não ficou pendente.');
    const oldIdentity = await app.evaluate(() => global.__browserTabCreateIds[0]);
    assert.ok(oldIdentity);
    await page.locator('#browser-tab-close').click();
    await page.locator('#browser-tab').waitFor({ state: 'detached' });
    await page.locator('#open-browser').click();
    await page.locator('#browser-tab').waitFor({ state: 'visible' });
    const replacement = await visiblePreview(serviceA.url);
    const newIdentity = await app.evaluate(() => global.__browserTabCreateIds[1]);
    assert.ok(newIdentity); assert.notEqual(newIdentity, oldIdentity);
    await contents(replacement.id, "document.querySelector('#value').value='nova guia';localStorage.setItem('late-create','preservado');true");
    await app.evaluate(() => { global.__browserTabResumeCreate(); global.__browserTabResumeCreate = null; });
    await until(() => app.evaluate((_electron, id) => (global.__browserTabCloseResults || []).some(entry => entry.id === id && entry.ok), oldIdentity), 'A identidade da guia antiga não foi liberada.');
    assert.equal(await page.locator('#browser-tab').count(), 1);
    await tabSelected(true);
    assert.equal((await visiblePreview(serviceA.url)).id, replacement.id);
    assert.equal(await contents(replacement.id, "document.querySelector('#value').value"), 'nova guia');
    assert.equal(await contents(replacement.id, "localStorage.getItem('late-create')"), 'preservado');
    assert.equal((await views()).length, 1, 'O retorno antigo não pode ressuscitar outra prévia.');
    assert.equal(await page.evaluate(({ root, id }) => window.dk.selectBrowser(root, id), { root: first, id: oldIdentity }), false);
    assert.equal(await page.evaluate(({ root, id }) => window.dk.closeBrowser(root, id), { root: first, id: oldIdentity }), false);
    const bounds = await page.locator('#browser-canvas').boundingBox();
    const staleOpen = await page.evaluate(({ root, url, bounds, id }) => window.dk.openBrowser(root, url, bounds, id), { root: first, url: serviceA.url, bounds, id: oldIdentity });
    assert.equal(staleOpen.cancelled, true);
    assert.equal((await visiblePreview(serviceA.url)).id, replacement.id);
    assert.equal(await contents(replacement.id, "localStorage.getItem('late-create')"), 'preservado');
    await alive(serviceA); await alive(serviceB);
    assert.deepEqual(await app.evaluate(() => global.__browserTabCounts), { create: 1, start: 1 });
    console.log('✓ Criação antiga atrasada limpa sua identidade sem afetar a guia substituta');
  } finally {
    if (app) {
      try { await app.evaluate(({ ipcMain }) => {
        if (typeof global.__browserTabResumeOpen === 'function') global.__browserTabResumeOpen(); global.__browserTabResumeOpen = null;
        if (typeof global.__browserTabResumeCreate === 'function') global.__browserTabResumeCreate(); global.__browserTabResumeCreate = null;
        if (global.__browserTabOpenOriginal) { ipcMain.removeHandler('browser:open'); ipcMain.handle('browser:open', global.__browserTabOpenOriginal); }
        if (global.__browserTabCreateOriginal) { ipcMain.removeHandler('browser:create'); ipcMain.handle('browser:create', global.__browserTabCreateOriginal); }
        if (global.__browserTabCloseOriginal) { ipcMain.removeHandler('browser:close'); ipcMain.handle('browser:close', global.__browserTabCloseOriginal); }
      }); } catch {}
      if (page) {
        try { await page.evaluate(() => window.dk.setDirtyFiles([])); } catch {}
        for (const directory of [first, second]) {
          try { await page.evaluate(async folder => { const item = (await window.dk.listServices(folder)).find(service => service.id === 'custom:web'); if (item && ['running', 'starting'].includes(item.status)) await window.dk.stopService(folder, item.id); }, directory); } catch {}
          try { await page.evaluate(folder => window.dk.closeProjectSessions(folder), directory); } catch {}
        }
      }
      try { await app.evaluate(({ ipcMain }) => { for (const [channel, original] of Object.entries(global.__browserTabHandlers || {})) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original); } }); } catch {}
      await app.close();
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
