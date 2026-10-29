const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Todas as pastas, seleções e operações são locais à fixture.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-launcher-race-')));
const first = path.join(temp, 'Projeto inicial'), pending = path.join(temp, 'Projeto selecionado em espera'), parent = path.join(temp, 'destino'), bin = path.join(temp, 'bin');
for (const directory of [first, pending, parent, bin]) fs.mkdirSync(directory);
const created = path.join(parent, 'Projeto criado em espera');
const shell = path.join(temp, process.platform === 'win32' ? 'shell.exe' : 'shell');
if (process.platform === 'win32') fs.copyFileSync(process.execPath, shell);
else fs.writeFileSync(shell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });
const env = { ...process.env, PATH: bin, DK_TERMINAL_TEST: '1', DK_TERMINAL_DATA_DIR: path.join(temp, 'profile'), ...(process.platform === 'win32' ? { ComSpec: shell } : { SHELL: shell }) };
delete env.DK_TERMINAL_TEST_PROJECT; delete env.DK_TERMINAL_TEST_DATA;
let app, page;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) { for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(50); } throw new Error(message); }
async function settings() { await page.locator('#launcher [data-route="settings"]').click(); await page.locator('#launcher [data-route="settings"][aria-current="page"]').waitFor(); }
async function home() { await page.locator('#launcher [data-route="home"]').click(); await page.locator('#launcher [data-route="home"][aria-current="page"]').waitFor(); }
async function hold(channel, folder) {
  await app.evaluate(({ dialog }, args) => {
    global.__launcherGate = args.channel; global.__launcherGateRoot = args.folder; global.__launcherGateReturned = false;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [args.folder] });
  }, { channel, folder });
}
async function release() {
  await until(() => app.evaluate(() => typeof global.__launcherRelease === 'function'), 'A operação da fixture não ficou pendente.');
  await app.evaluate(() => { global.__launcherGate = null; global.__launcherRelease(); global.__launcherRelease = null; });
  await until(() => app.evaluate(() => global.__launcherGateReturned), 'A operação da fixture não retornou.');
  await page.waitForTimeout(200);
}

(async () => {
  try {
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env, timeout: 60000 });
    page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await app.evaluate(({ ipcMain }) => {
      global.__launcherOriginals = {}; global.__launcherCounts = { create: 0, start: 0 };
      for (const [channel, field] of [['service:list', 'service'], ['project:select', 'select'], ['project:create', 'project'], ['terminal:create', 'create'], ['terminal:start', 'start']]) {
        const original = ipcMain._invokeHandlers?.get(channel); if (!original) throw new Error(`Handler ${channel} indisponível.`);
        global.__launcherOriginals[channel] = original; ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => {
          if (field === 'create' || field === 'start') global.__launcherCounts[field]++;
          const result = await original(...args);
          const isTarget = channel !== 'service:list' || args[1] === global.__launcherGateRoot;
          if (global.__launcherGate === channel && isTarget) {
            await new Promise(resolve => { global.__launcherRelease = resolve; });
            global.__launcherGateReturned = true;
          }
          return result;
        });
      }
    });
    await page.locator('#launcher.launcher-workspace').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#launcher-close').isVisible(), false);
    const initialLayout = await page.evaluate(() => ({ sidebar: document.querySelector('.sidebar').getBoundingClientRect().right, launcher: document.querySelector('#launcher').getBoundingClientRect().left }));
    assert.ok(Math.abs(initialLayout.sidebar - initialLayout.launcher) < 2);

    // A seleção já foi aceita e está ativando o primeiro projeto, mas a
    // consulta de serviços demora; navegar não deve fechar o Perfil.
    await hold('service:list', first);
    await page.locator('#launcher-open-local').click();
    await until(() => app.evaluate(() => typeof global.__launcherRelease === 'function'), 'A ativação inicial não ficou pendente.');
    await settings();
    await release();
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, first);
    await page.locator('#launcher [data-route="settings"][aria-current="page"]').waitFor();
    assert.equal(await page.locator('#launcher').isVisible(), true);
    assert.equal(await page.locator('#launcher-close').isVisible(), true);
    assert.equal(await page.locator('#launcher').evaluate(node => node.classList.contains('launcher-workspace')), false);
    const modalLayout = await page.evaluate(() => ({ left: document.querySelector('#launcher').getBoundingClientRect().left, top: document.querySelector('#launcher').getBoundingClientRect().top, headerBottom: document.querySelector('.titlebar').getBoundingClientRect().bottom }));
    assert.ok(Math.abs(modalLayout.left) < 2 && Math.abs(modalLayout.top - modalLayout.headerBottom) < 2, `Posição incorreta após ativar projeto: ${JSON.stringify(modalLayout)}`);
    assert.deepEqual(await app.evaluate(() => global.__launcherCounts), { create: 0, start: 0 });

    // Uma seleção concluída depois de navegar não altera o projeto ativo, mas
    // o caminho aceito pelo processo principal continua nos recentes.
    await home();
    await hold('project:select', pending);
    await page.locator('#launcher-open-local').click();
    await until(() => app.evaluate(() => typeof global.__launcherRelease === 'function'), 'A seleção local não ficou pendente.');
    await settings(); await release();
    assert.equal(await page.locator('#project-title').innerText(), 'Projeto inicial');
    await page.locator('#launcher [data-route="settings"][aria-current="page"]').waitFor();
    await home();
    await page.locator('#launcher-recents .launcher-recent').filter({ hasText: 'Projeto selecionado em espera' }).waitFor();

    // A pasta criada de forma assíncrona também entra nos recentes sem
    // selecionar projeto ou alterar uma rota escolhida depois do pedido.
    await hold('project:create', parent);
    await page.locator('#launcher-create-project').click();
    await page.locator('#new-project-name').fill('Projeto criado em espera');
    await page.getByRole('button', { name: 'Escolher pasta e criar' }).click();
    await until(() => app.evaluate(() => typeof global.__launcherRelease === 'function'), 'A criação não ficou pendente.');
    assert.equal(fs.existsSync(created), true);
    await settings(); await release();
    assert.equal(await page.locator('#project-title').innerText(), 'Projeto inicial');
    await page.locator('#launcher [data-route="settings"][aria-current="page"]').waitFor();
    await home();
    await page.locator('#launcher-recents .launcher-recent').filter({ hasText: 'Projeto criado em espera' }).waitFor();
    assert.deepEqual(await app.evaluate(() => global.__launcherCounts), { create: 0, start: 0 });
    await page.locator('#launcher-recents .launcher-recent').filter({ hasText: 'Projeto criado em espera' }).click();
    await page.locator('#launcher').waitFor({ state: 'hidden' });
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, created);
    await page.locator('#terminal-empty').waitFor({ state: 'visible' });
    assert.deepEqual(await app.evaluate(() => global.__launcherCounts), { create: 0, start: 0 });
    console.log('✓ Operações atrasadas preservam a rota, os recentes e o estado sem terminal');
  } finally {
    if (app) {
      try { await app.evaluate(() => { global.__launcherGate = null; if (typeof global.__launcherRelease === 'function') global.__launcherRelease(); global.__launcherRelease = null; }); } catch {}
      if (page) for (const directory of [first, pending, created]) try { await page.evaluate(folder => window.dk.closeProjectSessions(folder), directory); } catch {}
      try { await app.evaluate(({ ipcMain }) => { for (const [channel, original] of Object.entries(global.__launcherOriginals || {})) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original); } }); } catch {}
      await app.close();
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
