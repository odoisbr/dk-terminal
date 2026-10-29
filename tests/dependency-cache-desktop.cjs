const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openProjectPanel } = require('./helpers/project-inspector.cjs');

// Project, package manager and user profile are disposable fixtures. This test
// never calls a real installer or touches the user's project and package cache.
if (process.platform === 'win32') {
  console.log('⏭ Fixture do gerenciador em Windows não verificada.');
  process.exit(0);
}
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-dependencies-')));
const project = path.join(temp, 'Projeto com espaços'), bin = path.join(temp, 'bin');
fs.mkdirSync(project); fs.mkdirSync(bin);
const marker = path.join(temp, 'pnpm-args.txt');
const manifest = '{\n  "name": "fixture",\n  "packageManager": "pnpm@10.0.0",\n  "scripts": { "dev": "echo fixture" }\n}\n';
const lock = "lockfileVersion: '9.0'\n";
fs.writeFileSync(path.join(project, 'package.json'), manifest);
fs.writeFileSync(path.join(project, 'pnpm-lock.yaml'), lock);
fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "10.0.0\\n"; exit 0; fi\nprintf "%s\\n" "$@" > "$SEA_DOCK_TEST_MARKER"\nprintf "Fixture concluída\\n"\n', { mode: 0o755 });
const shell = path.join(temp, 'shell');
fs.writeFileSync(shell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });
const env = { ...process.env, SHELL: shell, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, SEA_DOCK_TEST_MARKER: marker,
  DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile') };
let app;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(message); await delay(50); }
}

(async () => {
  try {
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env, timeout: 60000 });
    const page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    if (executablePath) {
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
      await page.locator('#launcher-open-local').click();
    } else await page.locator('#launcher-recents .launcher-recent').first().click();
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, project);
    await openProjectPanel(page, 'services');
    const prepare = page.locator('#prepare-dependencies');
    await prepare.waitFor({ state: 'visible' });
    await app.evaluate(({ dialog, ipcMain }) => {
      global.__dependenciesTest = { dialogs: [], accept: false, finished: 0 };
      dialog.showMessageBox = async (...args) => {
        const options = args.length > 1 ? args[1] : args[0];
        global.__dependenciesTest.dialogs.push(options);
        const confirmIndex = options.buttons.findIndex(text => /instalar|preparar|continuar/i.test(text));
        if (confirmIndex < 0) throw new Error('Confirmação não oferece ação de preparação.');
        return { response: global.__dependenciesTest.accept ? confirmIndex : options.cancelId ?? 0, checkboxChecked: false };
      };
      const handler = ipcMain._invokeHandlers.get('dependency:prepare');
      if (!handler) throw new Error('Ação de preparação não registrada.');
      ipcMain.removeHandler('dependency:prepare');
      ipcMain.handle('dependency:prepare', async (...args) => {
        try { return await handler(...args); } finally { global.__dependenciesTest.finished++; }
      });
    });
    await prepare.click();
    await until(() => app.evaluate(() => global.__dependenciesTest.dialogs.length === 1), 'Confirmação não apareceu.');
    await until(() => app.evaluate(() => global.__dependenciesTest.finished === 1), 'A ação cancelada não terminou.');
    assert.equal(fs.existsSync(marker), false, 'Cancelar não deve executar o gerenciador.');
    assert.equal(await page.locator('.terminal-pane').count(), 0, 'Cancelar não deve abrir uma sessão.');
    await app.evaluate(() => { global.__dependenciesTest.accept = true; });
    await prepare.click();
    await until(() => fs.existsSync(marker), 'O gerenciador simulado não foi executado.');
    assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), ['install', '--prefer-offline', '--frozen-lockfile']);
    assert.equal(await app.evaluate(() => global.__dependenciesTest.dialogs.length), 2);
    assert.equal(await page.locator('.terminal-pane').count(), 1, 'Preparação deve ter sessão visível.');
    assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), manifest);
    assert.equal(fs.readFileSync(path.join(project, 'pnpm-lock.yaml'), 'utf8'), lock);
    assert.equal(fs.existsSync(path.join(project, 'node_modules')), false);
    console.log('✓ Cancelar não instala; confirmação executa pnpm com cache em sessão e preserva arquivos da fixture');
  } finally { if (app) await app.close(); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
