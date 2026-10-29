const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openProjectPanel } = require('./helpers/project-inspector.cjs');

// Projeto, perfil, shell e serviço HTTP pertencem somente à fixture temporária.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-browser-fullscreen-')));
const first = path.join(temp, 'Primeiro projeto'), second = path.join(temp, 'Segundo projeto');
const bin = path.join(temp, 'bin'), profile = path.join(temp, 'profile');
for (const directory of [first, second, bin]) fs.mkdirSync(directory);
const server = path.join(temp, 'fixture-server.cjs');
fs.writeFileSync(server, String.raw`
const http = require('node:http');
const html = '<!doctype html><html lang="pt-BR"><head><title>Prévia de teste</title></head><body><h1>DK_FULLSCREEN_FIXTURE</h1><button id="focus">Área interativa</button></body></html>';
http.createServer((request, response) => {
  const send = () => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); };
  if (request.url === '/slow') { console.log('SLOW_PREVIEW_PENDING'); setTimeout(send, 4000); } else send();
})
  .listen(0, '127.0.0.1', function () { console.log('http://127.0.0.1:' + this.address().port); });
`);
for (const project of [first, second]) fs.writeFileSync(path.join(project, 'dk-terminal.services.json'), JSON.stringify({ services: [
  { name: 'web', role: 'frontend', command: process.execPath, args: [server] },
] }));

const fixtureShell = path.join(temp, process.platform === 'win32' ? 'fixture-shell.exe' : 'fixture-shell');
const quoteShell = value => `'${value.replace(/'/g, "'\\''")}'`;
if (process.platform === 'win32') fs.copyFileSync(process.execPath, fixtureShell);
else fs.writeFileSync(fixtureShell, `#!/bin/sh\nif [ "$1" = "-lc" ]; then printf '\\0%s\\0' "$PATH"; exit; fi\nexec ${quoteShell(process.execPath)} -e 'process.stdin.resume()'\n`, { mode: 0o755 });
const env = {
  ...process.env, PATH: bin, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: first, DK_TERMINAL_DATA_DIR: profile,
  ...(process.platform === 'win32' ? { ComSpec: fixtureShell } : { SHELL: fixtureShell }),
};
const manualEscape = process.env.DK_FULLSCREEN_MANUAL_ESCAPE === '1';
const nativeFullscreen = process.env.DK_FULLSCREEN_NATIVE === '1' || manualEscape;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(typeof message === 'function' ? message() : message); await delay(80); }
}
let app, page;

async function windowState() {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], views = window.contentView.children.filter(child => child.webContents);
    const view = views.find(child => child.getVisible()) || views.at(-1);
    const preferences = view?.webContents.getLastWebPreferences();
    return {
      fullscreen: window.isFullScreen(), fullscreenable: window.isFullScreenable(), focused: window.isFocused(), visible: window.isVisible(), minimized: window.isMinimized(), contentSize: window.getContentSize(),
      view: view ? { id: view.webContents.id, bounds: view.getBounds(), visible: view.getVisible(), loading: view.webContents.isLoadingMainFrame(), url: view.webContents.getURL(), sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, webSecurity: preferences.webSecurity } : null,
    };
  });
}
async function preview(source) {
  return app.evaluate(async ({ BrowserWindow }, script) => {
    const views = BrowserWindow.getAllWindows()[0].contentView.children.filter(child => child.webContents);
    const view = views.find(child => child.getVisible()) || views.at(-1);
    if (!view) throw new Error('Prévia não encontrada.');
    return view.webContents.executeJavaScript(script, true);
  }, source);
}
async function previewVisible(id) {
  return app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].contentView.children.find(child => child.webContents?.id === target)?.getVisible() ?? null, id);
}
async function expectBounds() {
  let observed;
  await until(async () => {
    const canvas = await page.locator('#browser-canvas').boundingBox();
    const state = await windowState();
    if (!canvas || !state.view) return false;
    const [width, height] = state.contentSize;
    const x = Math.max(0, Math.min(width - 1, Math.round(canvas.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(canvas.y)));
    const expected = { x, y, width: Math.max(1, Math.min(width - x, Math.round(canvas.width))), height: Math.max(1, Math.min(height - y, Math.round(canvas.height))) };
    observed = { canvas, expected, actual: state.view.bounds };
    return Object.keys(expected).every(key => Math.abs(expected[key] - state.view.bounds[key]) <= 2);
  }, () => `Os limites do navegador não acompanharam o canvas: ${JSON.stringify(observed)}`);
  return observed;
}
async function expectMode(expanded, fullscreen) {
  const control = page.locator('#browser-fullscreen');
  try {
    await page.waitForFunction(({ expanded }) => {
      const button = document.querySelector('#browser-fullscreen');
      return !!button && button.getAttribute('aria-pressed') === String(expanded) && document.body.classList.contains('browser-fullscreen') === expanded;
    }, { expanded }, { timeout: 20000 });
    await until(async () => (await windowState()).fullscreen === fullscreen, 'O estado de tela cheia nativo não corresponde ao solicitado.', 30000);
  } catch (error) {
    const ui = await page.evaluate(() => {
      const button = document.querySelector('#browser-fullscreen');
      return { bodyClass: document.body.className, pressed: button?.getAttribute('aria-pressed'), disabled: button?.disabled, title: button?.getAttribute('title'), browserHidden: document.querySelector('#browser-view')?.hidden, toast: document.querySelector('#toast')?.textContent, viewport: [innerWidth, innerHeight] };
    });
    const native = await windowState();
    const events = await app.evaluate(() => global.__fullscreenTestEvents || []);
    throw new Error(`Falha ao esperar modo browser=${expanded}, nativo=${fullscreen}: ${JSON.stringify({ ui, native, events })}`, { cause: error });
  }
  assert.equal(await control.isVisible(), true);
  assert.ok((await control.getAttribute('aria-label')) || (await control.getAttribute('title')), 'O controle deve ter nome acessível.');
  const { actual } = await expectBounds();
  const rect = await control.boundingBox();
  assert.ok(rect, 'O controle para sair deve permanecer visível.');
  const overlaps = rect.x < actual.x + actual.width && rect.x + rect.width > actual.x && rect.y < actual.y + actual.height && rect.y + rect.height > actual.y;
  assert.equal(overlaps, false, 'O WebContentsView não pode cobrir o controle de tela cheia.');
}
async function expectService(pid, url) {
  const service = (await page.evaluate(directory => window.dk.listServices(directory), first)).find(item => item.id === 'custom:web');
  assert.equal(service?.status, 'running');
  assert.equal(service?.pid, pid);
  assert.equal(service?.url, url);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /DK_FULLSCREEN_FIXTURE/);
}
async function expectSamePreview(id, url) {
  const view = (await windowState()).view;
  assert.equal(view?.id, id, 'Alternar tela cheia não deve recriar a página.');
  assert.equal(view.url, url);
  assert.equal(view.sandbox, true);
  assert.equal(view.contextIsolation, true);
  assert.equal(view.nodeIntegration, false);
  assert.equal(view.webSecurity, true);
  assert.equal(await preview("typeof window.require + ':' + typeof window.dk"), 'undefined:undefined');
  assert.equal(await preview("localStorage.getItem('fullscreen-fixture')"), 'preservado');
}
async function sendPreviewEscape(expectConsumed = false) {
  if (!nativeFullscreen) {
    if (expectConsumed) {
      // The background automation session cannot deliver native window input.
      // Exercise Electron's handler on the real view; native mode uses real keys.
      const prevented = await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child.webContents).webContents;
        let consumed = false;
        contents.emit('before-input-event', { preventDefault: () => { consumed = true; } }, { type: 'keyDown', key: 'Escape', isAutoRepeat: false });
        return consumed;
      });
      assert.equal(prevented, true, 'O handler deve consumir Escape quando a prévia está em tela cheia.');
      return;
    }
    // CDP delivers actual Chromium input to the isolated WebContentsView even
    // when the automated macOS session cannot make a window foreground.
    await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child.webContents).webContents;
      await contents.executeJavaScript("document.body.tabIndex = 0; document.body.focus(); true");
      const debuggerClient = contents.debugger;
      debuggerClient.attach('1.3');
      try {
        await debuggerClient.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        await debuggerClient.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      } finally { debuggerClient.detach(); }
    });
    return;
  }
  if (manualEscape) {
    console.log(expectConsumed
      ? 'AÇÃO MANUAL: clique na página da prévia em tela cheia e pressione Escape físico para sair.'
      : 'AÇÃO MANUAL: clique na página da prévia fora da tela cheia e pressione Escape físico para verificar a entrega à página.');
    if (expectConsumed) await until(async () => !(await windowState()).fullscreen, 'Escape físico não fechou a tela cheia.', 90000);
    else await until(async () => await preview('window.__escapeCount') >= 1, 'Escape físico fora da tela cheia não chegou à página.', 90000);
    return;
  }
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus();
    window.contentView.children.find(child => child.webContents).webContents.focus();
  });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'A janela de teste não recebeu foco.');
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child.webContents).webContents;
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
}
async function initialTransitionTrace() {
  const samples = [];
  const deadline = Date.now() + 7500;
  let wasPending = false, previous = '';
  while (Date.now() < deadline) {
    const ui = await page.evaluate(() => {
      const button = document.querySelector('#browser-fullscreen');
      return { disabled: button?.disabled, pressed: button?.getAttribute('aria-pressed'), toast: document.querySelector('#toast')?.textContent };
    });
    const native = await windowState();
    const sample = { ui, fullscreen: native.fullscreen, focused: native.focused, contentSize: native.contentSize };
    const fingerprint = JSON.stringify(sample);
    if (fingerprint !== previous) { samples.push({ ...sample, time: Date.now() }); previous = fingerprint; }
    if (ui.disabled) wasPending = true;
    if (!ui.disabled && (wasPending || ui.pressed === 'true')) break;
    await delay(80);
  }
  return samples;
}
async function nativeProbe(focus) {
  await app.evaluate(({ app, BrowserWindow }, shouldFocus) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (shouldFocus) { window.show(); window.focus(); app.focus({ steal: true }); }
    else window.blur();
  }, focus);
  await delay(300);
  const before = await windowState();
  const offset = await app.evaluate(() => (global.__fullscreenTestEvents || []).length);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
  const deadline = Date.now() + 10000;
  let events = [];
  do {
    await delay(100);
    events = (await app.evaluate(() => global.__fullscreenTestEvents || [])).slice(offset);
    if (events.some(event => event.name === 'enter-full-screen')) break;
  } while (Date.now() < deadline);
  const after = await windowState();
  if (after.fullscreen) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
    try { await until(async () => !(await windowState()).fullscreen, 'A saída nativa da fixture não terminou.', 10000); } catch {}
    await delay(300);
  }
  return { requestedFocus: focus, before, after, events };
}

(async () => {
  try {
    console.log(nativeFullscreen ? 'Transições e Escape da prévia: nativos (sessão interativa).' : 'Transições e Escape da prévia em tela cheia: eventos simulados apenas na fixture; isto não valida a integração nativa.');
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env, timeout: 60000 });
    page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    if (!nativeFullscreen) await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const originalSet = window.setFullScreen, originalIs = window.isFullScreen;
      let active = false, savedSize = window.getContentSize();
      window.isFullScreen = () => active;
      window.setFullScreen = enabled => {
        if (!!enabled === active) return;
        if (enabled) {
          savedSize = window.getContentSize();
          window.emit('will-enter-full-screen');
          active = true;
          const area = screen.getDisplayMatching(window.getBounds()).workAreaSize;
          window.setContentSize(Math.max(savedSize[0] + 180, area.width), Math.max(savedSize[1] + 180, area.height));
          window.emit('enter-full-screen');
        } else {
          window.emit('will-leave-full-screen');
          active = false;
          window.setContentSize(savedSize[0], savedSize[1]);
          window.emit('leave-full-screen');
        }
      };
      global.__restoreFullscreenFixture = () => {
        if (active) window.setFullScreen(false);
        window.setFullScreen = originalSet; window.isFullScreen = originalIs;
      };
    });
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; global.__fullscreenTestEvents = [];
      global.__fullscreenTestHandlers = [];
      for (const name of ['will-enter-full-screen', 'enter-full-screen', 'will-leave-full-screen', 'leave-full-screen']) {
        const handler = () => global.__fullscreenTestEvents.push({ name, fullscreen: window.isFullScreen(), time: Date.now() });
        global.__fullscreenTestHandlers.push({ name, handler }); window.on(name, handler);
      }
    });
    // A rota GitLab da fixture nunca consulta conta ou rede reais.
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers?.get('gitlab:projects');
      if (typeof original !== 'function') throw new Error('Não foi possível isolar a rota GitLab de teste.');
      global.__fullscreenGitlabHandler = original;
      ipcMain.removeHandler('gitlab:projects');
      ipcMain.handle('gitlab:projects', async () => ({ ok: true, value: { items: [], hasMore: false } }));
    });
    // A fixture conta somente terminais; serviços HTTP são processos legítimos.
    await app.evaluate(({ ipcMain }) => {
      global.__browserTerminalCounts = { create: 0, start: 0 }; global.__browserTerminalHandlers = {};
      for (const [channel, key] of [['terminal:create', 'create'], ['terminal:start', 'start']]) {
        const original = ipcMain._invokeHandlers?.get(channel);
        if (!original) throw new Error(`Handler ${channel} indisponível.`);
        global.__browserTerminalHandlers[channel] = original;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => { global.__browserTerminalCounts[key]++; return original(...args); });
      }
    });
    if (executablePath) {
      await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, first);
      await page.locator('#launcher-open-local').click();
    } else await page.locator('#launcher-recents .launcher-recent').first().click();
    await startProjectTerminal(page);
    const terminalId = (await page.locator('.tab-select[aria-selected=true]').getAttribute('id')).slice(4);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 720));
    await page.waitForFunction(() => innerWidth === 1120 && innerHeight === 720);

    await page.locator('#tab-services').click();
    await page.getByRole('button', { name: 'Iniciar serviço web', exact: true }).click();
    let service;
    await until(async () => {
      service = (await page.evaluate(directory => window.dk.listServices(directory), first)).find(item => item.id === 'custom:web');
      return service?.status === 'running' && service.pid && service.url;
    }, 'O serviço HTTP temporário não iniciou.');
    const { pid, url } = service;
    await page.locator('#browser-view').waitFor();
    await until(async () => (await windowState()).view?.url === url + '/' || (await windowState()).view?.url === url, 'A prévia não carregou o serviço de teste.');
    assert.equal(await preview("document.body.textContent.includes('DK_FULLSCREEN_FIXTURE')"), true);
    await preview("localStorage.setItem('fullscreen-fixture', 'preservado'); true");
    let originalView = (await windowState()).view;
    let originalURL = originalView.url;
    await expectMode(false, false);

    // A prévia é uma view nativa, acima do HTML: abrir/fechar a árvore deve
    // ajustar seus limites e manter ícones, painel e menu fora dessa view.
    await openProjectPanel(page, 'files');
    const { actual: previewBounds } = await expectBounds();
    const buttons = await page.locator('.inspector-rail button:visible, #project-inspector-panel button:visible').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect();
      return { label: node.getAttribute('aria-label') || node.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
    assert.ok(buttons.length >= 5);
    const overlaps = rect => rect.x < previewBounds.x + previewBounds.width && rect.x + rect.width > previewBounds.x && rect.y < previewBounds.y + previewBounds.height && rect.y + rect.height > previewBounds.y;
    for (const rect of buttons) assert.equal(overlaps(rect), false, `A prévia encobriu um controle do projeto: ${JSON.stringify(rect)}`);
    const file = page.locator('.tree-file[data-relative="dk-terminal.services.json"]');
    await file.waitFor();
    const menu = page.getByRole('menu', { name: 'Ações do item' });
    for (const method of ['mouse', 'keyboard']) {
      if (method === 'mouse') await file.click({ button: 'right' });
      else { await file.focus(); await page.keyboard.press('Shift+F10'); }
      await menu.waitFor();
      const menuRect = await menu.boundingBox();
      const panelRect = await page.locator('#project-inspector-panel').boundingBox();
      assert.ok(menuRect && panelRect);
      assert.equal(overlaps(menuRect), false, `O menu da árvore foi encoberto pela prévia (${method}).`);
      assert.ok(menuRect.x >= panelRect.x && menuRect.y >= panelRect.y && menuRect.x + menuRect.width <= panelRect.x + panelRect.width + 1 && menuRect.y + menuRect.height <= panelRect.y + panelRect.height + 1, `O menu ultrapassou os limites do painel (${method}).`);
      await menu.getByRole('menuitem', { name: 'Copiar nome' }).waitFor();
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
      assert.equal(await file.evaluate(node => document.activeElement === node), true, 'Escape deve devolver o foco ao arquivo.');
    }
    await file.click({ button: 'right' }); await menu.waitFor();
    await page.locator('#reveal-project').focus();
    await menu.waitFor({ state: 'hidden' });
    await page.locator('#tab-files').click();
    await page.locator('#project-inspector-panel').waitFor({ state: 'hidden' });
    await expectBounds();
    await expectSamePreview(originalView.id, originalURL);
    await expectService(pid, url);
    console.log('✓ Árvore e menu permanecem acessíveis ao lado da prévia nativa');

    // O launcher precisa ficar acima da prévia, sem destruí-la ou interromper o serviço.
    await page.locator('#profile-show').click();
    await until(async () => (await windowState()).view?.visible === false, 'A prévia encobriu o perfil.');
    const cursorSetting = page.getByRole('checkbox', { name: 'Cursor piscando' });
    await cursorSetting.waitFor();
    const wasChecked = await cursorSetting.isChecked();
    await cursorSetting.setChecked(!wasChecked);
    assert.equal(await cursorSetting.isChecked(), !wasChecked);
    await cursorSetting.setChecked(wasChecked);
    await page.locator('#launcher [data-route="home"]').click();
    assert.equal((await windowState()).view?.visible, false);
    await page.locator('#launcher [data-route="gitlab"]').click();
    assert.equal((await windowState()).view?.visible, false);
    await page.locator('#launcher-close').click();
    await until(async () => (await windowState()).view?.visible === true, 'A prévia não voltou ao fechar o perfil.');
    await expectSamePreview(originalView.id, originalURL);
    await expectService(pid, url);

    await page.locator('#launcher-show').click();
    await until(async () => (await windowState()).view?.visible === false, 'A prévia encobriu a tela de início.');
    await page.locator('#launcher [data-route="settings"]').click();
    await page.getByRole('checkbox', { name: 'Cursor piscando' }).waitFor();
    await page.locator('#launcher-close').click();
    await until(async () => (await windowState()).view?.visible === true, 'A prévia não voltou ao fechar o início.');
    await expectSamePreview(originalView.id, originalURL);

    // Uma navegação que termina com o perfil aberto não pode trazer a view para a frente.
    await page.locator('#browser-address').fill(url + '/slow');
    await page.locator('#browser-address').press('Enter');
    await until(async () => (await page.evaluate(directory => window.dk.listServices(directory), first)).find(item => item.id === 'custom:web')?.log.includes('SLOW_PREVIEW_PENDING'), 'A navegação lenta da fixture não iniciou.');
    assert.equal((await windowState()).view?.loading, true);
    await page.locator('#profile-show').click();
    await until(async () => (await windowState()).view?.visible === false, 'O perfil não ocultou a prévia em carregamento.');
    await page.getByRole('checkbox', { name: 'Cursor piscando' }).waitFor();
    await until(async () => { const view = (await windowState()).view; return view && !view.loading && view.url === url + '/slow'; }, 'A navegação lenta não terminou.');
    assert.equal((await windowState()).view?.visible, false, 'Terminar o carregamento não deve cobrir o perfil.');
    await page.locator('#launcher-close').click();
    await until(async () => (await windowState()).view?.visible === true, 'A prévia carregada não voltou após fechar o perfil.');
    originalURL = url + '/slow';
    await expectSamePreview(originalView.id, originalURL);
    await expectService(pid, url);
    console.log('✓ Início, perfil e GitLab ocultam a mesma prévia, inclusive durante carregamento');

    // Repete a abertura com a criação da view pendente, sem depender de fullscreen.
    await page.locator('#browser-back').click();
    await until(async () => await previewVisible(originalView.id) === false, 'A prévia não ficou oculta ao voltar ao terminal.');
    await page.locator('#browser-tab-close').click();
    await until(() => app.evaluate(({ webContents }, id) => !webContents.fromId(id), originalView.id), 'Fechar a guia não descartou a prévia inicial.');
    await expectService(pid, url);
    // A abertura ainda não criou WebContentsView quando o perfil aparece.
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers?.get('browser:open');
      if (typeof original !== 'function') throw new Error('Não foi possível instrumentar a abertura de teste.');
      global.__fullscreenBrowserOpenOriginal = original;
      global.__fullscreenResumeBrowserOpen = null;
      ipcMain.removeHandler('browser:open');
      ipcMain.handle('browser:open', async (...args) => {
        await new Promise(resolve => { global.__fullscreenResumeBrowserOpen = resolve; });
        return original(...args);
      });
    });
    try {
      await page.locator('#open-browser').click();
      await page.locator('#browser-view').waitFor();
      await until(() => app.evaluate(() => typeof global.__fullscreenResumeBrowserOpen === 'function'), 'A abertura da prévia não ficou pendente.');
      await page.locator('#profile-show').click();
      await page.getByRole('checkbox', { name: 'Cursor piscando' }).waitFor();
      await app.evaluate(() => { const resume = global.__fullscreenResumeBrowserOpen; global.__fullscreenResumeBrowserOpen = null; resume(); });
      await until(async () => { const view = (await windowState()).view; return view && !view.loading && (view.url === url || view.url === url + '/'); }, 'A prévia pendente não abriu.');
      assert.equal((await windowState()).view.visible, false, 'A view criada durante o perfil deve ficar oculta.');
      const createdId = (await windowState()).view.id;
      await page.locator('#launcher-close').click();
      await until(async () => (await windowState()).view?.visible === true, 'A prévia pendente não voltou ao fechar o perfil.');
      assert.equal((await windowState()).view.id, createdId);
      assert.equal(await preview("document.body.textContent.includes('DK_FULLSCREEN_FIXTURE')"), true);
      await expectService(pid, url);
    } finally {
      await app.evaluate(({ ipcMain }) => {
        if (typeof global.__fullscreenResumeBrowserOpen === 'function') global.__fullscreenResumeBrowserOpen();
        global.__fullscreenResumeBrowserOpen = null;
        if (global.__fullscreenBrowserOpenOriginal) {
          ipcMain.removeHandler('browser:open');
          ipcMain.handle('browser:open', global.__fullscreenBrowserOpenOriginal);
          global.__fullscreenBrowserOpenOriginal = null;
        }
      });
    }
    await expectMode(false, false);
    originalView = (await windowState()).view;
    originalURL = originalView.url;
    await preview("localStorage.setItem('fullscreen-fixture', 'preservado'); true");
    const before = await expectBounds();
    console.log('✓ A prévia criada durante o perfil permanece oculta e reaparece após fechar');

    const control = page.locator('#browser-fullscreen');

    if (nativeFullscreen && process.env.DK_FULLSCREEN_WAIT_FOCUS === '1') {
      console.log('Aguardando foco na janela temporária do SEA Dock.');
      await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'A janela de teste não recebeu foco.', 90000);
    }
    await control.click();
    const transitionTrace = await initialTransitionTrace();
    try { await expectMode(true, true); }
    catch (error) {
      if (!nativeFullscreen) throw new Error(`${error.message}\nTransição simulada: ${JSON.stringify(transitionTrace)}`, { cause: error });
      // Diagnóstico direto: aguarda o evento nativo com e sem foco, sem alterar o app.
      const probes = [await nativeProbe(false), await nativeProbe(true)];
      throw new Error(`${error.message}\nTransição inicial: ${JSON.stringify(transitionTrace)}\nSondagens nativas diretas: ${JSON.stringify(probes)}`, { cause: error });
    }
    const expanded = await expectBounds();
    assert.ok(expanded.actual.width > before.actual.width && expanded.actual.height > before.actual.height, 'A tela cheia deve ampliar a prévia.');
    await expectSamePreview(originalView.id, originalURL);
    await expectService(pid, url);
    await control.click();
    await expectMode(false, false);
    await expectSamePreview(originalView.id, originalURL);

    await control.click();
    await expectMode(true, true);
    await control.focus(); await page.keyboard.press('Escape');
    await expectMode(false, false);
    await expectSamePreview(originalView.id, originalURL);
    await preview("window.__escapeCount = 0; document.addEventListener('keydown', event => { if (event.key === 'Escape') window.__escapeCount++; }); true");
    await sendPreviewEscape();
    await until(async () => await preview('window.__escapeCount') >= 1, 'Escape fora da tela cheia deve chegar à página.');
    await expectMode(false, false);

    await control.click();
    await expectMode(true, true);
    await sendPreviewEscape(true);
    await expectMode(false, false);
    assert.equal(await preview('window.__escapeCount'), 1, 'Escape em tela cheia deve ser consumido antes de chegar à página.');
    await expectSamePreview(originalView.id, originalURL);
    await expectService(pid, url);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 660));
    await page.waitForFunction(() => innerWidth === 1000 && innerHeight === 660);
    await expectBounds();
    console.log(nativeFullscreen
      ? '✓ Botão, Escape na barra e na página, dimensões e isolamento preservados'
      : '✓ Botão, Escape na barra e handler simulado da página; dimensões e isolamento preservados');

    // Voltar ao terminal oculta a mesma página e sai da tela cheia, sem encerrar o serviço.
    await control.click(); await expectMode(true, true);
    const retiredId = (await windowState()).view.id;
    await page.locator('#browser-back').click();
    await until(async () => !(await windowState()).fullscreen && await previewVisible(retiredId) === false, 'Voltar ao terminal não ocultou a prévia em tela cheia.');
    assert.equal(await page.locator('#terminal-host').isVisible(), true);
    await expectService(pid, url);
    assert.equal(await page.locator(`#pane-${terminalId}`).count(), 1);
    assert.equal(await app.evaluate(({ webContents }, id) => !!webContents.fromId(id), retiredId), true);
    await page.locator('#browser-tab').click();
    await until(async () => { const view = (await windowState()).view; return view && view.id === retiredId && view.visible && !view.loading; }, 'A prévia preservada não voltou.');
    await expectSamePreview(retiredId, originalURL);
    await expectMode(false, false);

    // Se o usuário já usava fullscreen nativo, a saída do browser não o desfaz.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await until(async () => (await windowState()).fullscreen, 'Não foi possível entrar no fullscreen nativo da fixture.', 30000);
    await control.click(); await expectMode(true, true);
    await control.click(); await expectMode(false, true);
    await expectService(pid, url);
    const nativeEventsBeforeExit = await app.evaluate(() => (global.__fullscreenTestEvents || []).length);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
    await until(async () => !(await windowState()).fullscreen, 'Não foi possível iniciar a saída do fullscreen nativo da fixture.', 30000);
    if (nativeFullscreen) {
      // macOS can update the flag before emitting leave-full-screen. Reenter
      // immediately to cover that real transition race, then restore normally.
      await control.click(); await expectMode(true, true);
      await control.click(); await expectMode(false, false);
      await expectSamePreview(retiredId, originalURL);
      await expectService(pid, url);
    } else {
      await until(async () => (await app.evaluate(() => global.__fullscreenTestEvents || [])).slice(nativeEventsBeforeExit).some(event => event.name === 'leave-full-screen'), 'Não foi possível confirmar a saída simulada do fullscreen.', 30000);
    }
    await expectBounds();
    console.log(nativeFullscreen
      ? '✓ Voltar preserva o serviço; fullscreen nativo preexistente é respeitado'
      : '✓ Voltar preserva o serviço; estado fullscreen preexistente simulado é respeitado');

    // A ação de menu representa a abertura de outro projeto enquanto a prévia ocupa a janela.
    await control.click(); await expectMode(true, true);
    const oldView = (await windowState()).view.id;
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, second);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu', 'open'));
    await page.waitForFunction(directory => document.querySelector('#breadcrumb-project')?.dataset.projectPath === directory, second, { timeout: 20000 });
    await until(async () => !(await windowState()).fullscreen && await previewVisible(oldView) === false, 'A troca de projeto não ocultou a prévia anterior.', 30000);
    assert.equal(await page.evaluate(() => document.body.classList.contains('browser-fullscreen')), false);
    assert.equal(await app.evaluate(({ webContents }, id) => !!webContents.fromId(id), oldView), true);
    assert.equal(await page.locator(`#pane-${terminalId}`).count(), 1, 'A sessão do primeiro projeto não deve ser encerrada.');
    assert.equal(await page.locator('.project-select[title="Primeiro projeto"]').count(), 1);
    await page.locator('#terminal-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#browser-view').isVisible(), false, 'O projeto sem sessão não deve permanecer no placeholder da prévia anterior.');
    await page.locator('#terminal-empty').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tabs .tab').count(), 0, 'A troca de projeto não deve iniciar um terminal.');
    assert.equal(await page.locator(`#pane-${terminalId}`).isVisible(), false);
    await expectService(pid, url);
    assert.deepEqual(await app.evaluate(() => global.__browserTerminalCounts), { create: 1, start: 1 });
    // O segundo projeto não tem sessão: iniciar e desligar sua própria prévia
    // não pode criar PTY, nem interromper o serviço do primeiro projeto.
    await openProjectPanel(page, 'services');
    await page.getByRole('button', { name: 'Iniciar serviço web', exact: true }).click();
    let secondService;
    await until(async () => {
      secondService = (await page.evaluate(directory => window.dk.listServices(directory), second)).find(item => item.id === 'custom:web');
      return secondService?.status === 'running' && secondService.pid && secondService.url;
    }, 'O serviço do segundo projeto não iniciou.');
    await page.locator('#browser-view').waitFor({ state: 'visible' });
    await until(async () => { const view = (await windowState()).view; return view && !view.loading && (view.url === secondService.url || view.url === secondService.url + '/'); }, 'A prévia do segundo projeto não abriu.');
    assert.equal(await preview("document.body.textContent.includes('DK_FULLSCREEN_FIXTURE')"), true);
    assert.deepEqual(await app.evaluate(() => global.__browserTerminalCounts), { create: 1, start: 1 });
    await page.locator('#browser-stop').click();
    await until(async () => {
      const service = (await page.evaluate(directory => window.dk.listServices(directory), second)).find(item => item.id === 'custom:web');
      return service && service.status !== 'running' && service.status !== 'starting' && service.status !== 'stopping';
    }, 'O serviço do segundo projeto não foi encerrado.');
    assert.deepEqual(await app.evaluate(() => global.__browserTerminalCounts), { create: 1, start: 1 });
    await expectService(pid, url);
    console.log('✓ Trocar projeto e iniciar/desligar prévia não criam terminal nem encerram serviço anterior');
  } finally {
    if (app) {
      if (page) {
        // Encerramento explícito apenas das sessões e do serviço da fixture.
        for (const directory of [first, second]) try { await page.evaluate(async root => { const service = (await window.dk.listServices(root)).find(item => item.id === 'custom:web'); if (service && ['running', 'starting'].includes(service.status)) await window.dk.stopService(root, service.id); }, directory); } catch {}
        for (const directory of [first, second]) try { await page.evaluate(root => window.dk.closeProjectSessions(root), directory); } catch {}
      }
      try { await app.evaluate(({ ipcMain }) => { if (global.__fullscreenGitlabHandler) { ipcMain.removeHandler('gitlab:projects'); ipcMain.handle('gitlab:projects', global.__fullscreenGitlabHandler); } for (const [channel, handler] of Object.entries(global.__browserTerminalHandlers || {})) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); } }); } catch {}
      try { await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; if (window?.isFullScreen()) window.setFullScreen(false); }); } catch {}
      try { await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        for (const entry of global.__fullscreenTestHandlers || []) window?.removeListener(entry.name, entry.handler);
        global.__fullscreenTestHandlers = [];
        if (typeof global.__restoreFullscreenFixture === 'function') global.__restoreFullscreenFixture();
        global.__restoreFullscreenFixture = null;
      }); } catch {}
      await app.close();
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
