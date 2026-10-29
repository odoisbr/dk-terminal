const { openFolderDialog } = require('./helpers/open-folder.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openProjectPanel } = require('./helpers/project-inspector.cjs');

const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-project-sessions-')));
const parent = path.join(temp, 'projetos'), second = path.join(temp, 'Segundo projeto'), bin = path.join(temp, 'bin');
for (const dir of [parent, second, bin]) fs.mkdirSync(dir);
const first = path.join(parent, 'Projeto novo'), marker = path.join(temp, 'shell-starts');
const fixtureShell = path.join(temp, process.platform === 'win32' ? 'shell.exe' : 'shell');
if (process.platform === 'win32') fs.copyFileSync(process.execPath, fixtureShell);
else fs.writeFileSync(fixtureShell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else printf "start\\n" >> "$SEA_FIXTURE_SHELL_STARTS"; exec /bin/sh; fi\n', { mode: 0o755 });
// Fake Claude responds to plugin discovery locally and never reaches an account or network.
const fakeClaude = path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude');
if (process.platform === 'win32') fs.copyFileSync(process.execPath, fakeClaude);
else fs.writeFileSync(fakeClaude, '#!/bin/sh\nif [ "$1" = "plugin" ]; then printf "[]\\n"; exit 0; fi\nprintf "SEA_FAKE_CLAUDE_READY\\n"; exec /bin/sh\n', { mode: 0o755 });
const env = { ...process.env, PATH: bin, DK_TERMINAL_TEST: '1', DK_TERMINAL_DATA_DIR: path.join(temp, 'profile'), SEA_FIXTURE_SHELL_STARTS: marker, ...(process.platform === 'win32' ? { ComSpec: fixtureShell } : { SHELL: fixtureShell }) };
delete env.DK_TERMINAL_TEST_PROJECT;
delete env.DK_TERMINAL_TEST_DATA;
let app, page;

async function counts() { return app.evaluate(() => ({ ...global.__sessionStartCounts })); }
async function expectStarts(count) {
  assert.deepEqual(await counts(), { create: count, start: count });
  if (process.platform !== 'win32') {
    const readStarts = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : [];
    let starts = readStarts();
    for (let attempt = 0; count > 0 && starts.length < count && attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100)); starts = readStarts();
    }
    assert.equal(starts.length, count, 'Nenhum shell da fixture pode iniciar sem uma ação do usuário.');
  }
}
async function selectProject(directory) {
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, directory);
  await openFolderDialog(app);
  await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, directory);
}

(async () => {
  try {
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env, timeout: 60000 });
    page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    // Observe the real handlers without replacing their behaviour. Restore them
    // before shutdown; all projects and processes belong to this fixture.
    await app.evaluate(({ ipcMain }) => {
      global.__sessionStartCounts = { create: 0, start: 0 };
      global.__sessionStartOriginals = {};
      for (const [channel, field] of [['terminal:create', 'create'], ['terminal:start', 'start']]) {
        const original = ipcMain._invokeHandlers?.get(channel);
        if (!original) throw new Error(`Handler ${channel} indisponível.`);
        global.__sessionStartOriginals[channel] = original;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => {
          global.__sessionStartCounts[field]++;
          if (channel === 'terminal:create' && args[2] === 'extension:claude' && global.__holdClaudeCreate) {
            await new Promise(resolve => { global.__releaseClaudeCreate = resolve; });
          }
          return original(...args);
        });
      }
    });
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, parent);
    await page.locator('#launcher-create-project').click();
    await page.locator('#new-project-name').fill('Projeto novo');
    await page.getByRole('button', { name: 'Escolher pasta e criar' }).click();
    await page.locator('#launcher').waitFor({ state: 'hidden' });
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, first);
    await page.locator('#terminal-empty').waitFor({ state: 'visible' });
    await page.locator('#empty-new').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tabs .tab').count(), 0);
    assert.equal(await page.locator('.terminal-pane').count(), 0);
    await expectStarts(0);
    if (process.env.SEA_PROJECT_EMPTY_SCREENSHOT) await page.screenshot({ path: process.env.SEA_PROJECT_EMPTY_SCREENSHOT });

    // Abrir e editar um arquivo não deve iniciar um terminal implicitamente.
    const file = path.join(first, 'nota.txt');
    fs.writeFileSync(file, 'Conteúdo original\n');
    fs.writeFileSync(path.join(first, 'limpo.txt'), 'Arquivo que pode ser fechado\n');
    await openProjectPanel(page, 'files');
    await page.locator('.tree-file[data-relative="nota.txt"]').click();
    // Aciona a mesma ação do menu nativo usada por Cmd/Ctrl+F.
    await page.locator('.cm-content').focus();
    await app.evaluate(({ Menu }) => { const menu = Menu.getApplicationMenu().items.find(item => item.label === 'Editar'); menu.submenu.items.find(item => item.label === 'Buscar no terminal').click(); });
    await page.locator('.cm-search').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#search-bar').isVisible(), false, 'A busca do editor não deve abrir a busca do terminal.');
    assert.equal(await page.locator('.terminal-pane').count(), 0);
    await expectStarts(0);
    await page.locator('.cm-content').click(); await page.keyboard.insertText(' rascunho preservado');
    await page.locator('.dk-editor-dirty[aria-label="Alterações não salvas"]').waitFor();
    assert.equal(await page.locator('#editor-view').isVisible(), true);
    assert.equal(await page.locator('#terminal-empty').isVisible(), false);
    assert.equal(await page.locator('.terminal-pane').count(), 0);
    await expectStarts(0);

    await page.locator('#new-session').click();
    await page.locator('.terminal-pane[data-ready=true]:visible').waitFor();
    const id = (await page.locator('.tab-select[aria-selected=true]').getAttribute('id')).slice(4);
    await expectStarts(1);
    assert.equal(await page.locator('#editor-view').isVisible(), true);
    assert.match(await page.locator('.cm-content').innerText(), /rascunho preservado/);
    await page.evaluate(id => { window.__sessionProof = ''; window.dk.onTerminalData(event => { if (event.id === id) window.__sessionProof += event.data; }); }, id);
    const command = process.platform === 'win32' ? 'process.stdout.write("\\nSEA_SESSION_ALIVE\\n")\r' : 'printf "\\nSEA_SESSION_ALIVE\\n"\r';
    await page.evaluate(({ id, command }) => window.dk.writeTerminal(id, command), { id, command });
    await page.waitForFunction(() => window.__sessionProof.includes('SEA_SESSION_ALIVE\r\n'));

    await selectProject(second);
    await page.locator('#terminal-empty').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tabs .tab').count(), 0);
    assert.equal(await page.locator(`#pane-${id}`).isVisible(), false);
    await expectStarts(1);
    await page.locator('.project-select[title="Projeto novo"]').click();
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, first);
    await page.locator(`#pane-${id}[data-ready=true]`).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tabs .tab').count(), 1);
    assert.equal(await page.locator('#editor-view').isVisible(), true);
    assert.match(await page.locator('.cm-content').innerText(), /rascunho preservado/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'Conteúdo original\n');
    await expectStarts(1);
    // Fechar a aba limpa por Cmd/Ctrl+W deve preservar o terminal e o outro
    // arquivo ainda não salvo. O menu nativo entrega o mesmo comando.
    await page.locator('.tree-file[data-relative="limpo.txt"]').click();
    await page.locator('.cm-content').focus();
    await app.evaluate(({ Menu }) => { const menu = Menu.getApplicationMenu().items.find(item => item.label === 'Arquivo'); menu.submenu.items.find(item => item.label === 'Fechar aba').click(); });
    await page.getByRole('tab', { name: /limpo\.txt/ }).waitFor({ state: 'detached' });
    assert.equal(await page.locator(`#pane-${id}[data-ready=true]`).isVisible(), true);
    assert.equal(await page.locator('#tabs .tab').count(), 1);
    assert.match(await page.locator('.cm-content').innerText(), /rascunho preservado/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'Conteúdo original\n');
    await expectStarts(1);
    console.log('✓ Projeto sem terminal permite editar e buscar; sessão, editor e atalhos respeitam o projeto');

    // O primeiro Claude também deve exibir feedback antes de o PTY estar pronto.
    await page.locator('.project-select[title="Segundo projeto"]').click();
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, second);
    await page.locator('#terminal-empty').waitFor({ state: 'visible' });
    await app.evaluate(() => { global.__holdClaudeCreate = true; });
    await page.locator('#launch-claude').click();
    const startup = page.locator('#session-state[role="status"]');
    await startup.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => /Abrindo Claude Code/.test(document.querySelector('#session-state')?.textContent || ''));
    assert.match(await startup.innerText(), /Abrindo Claude Code/);
    assert.deepEqual(await counts(), { create: 2, start: 1 });
    await app.evaluate(() => { if (typeof global.__releaseClaudeCreate !== 'function') throw new Error('A abertura do Claude não foi suspensa.'); global.__holdClaudeCreate = false; global.__releaseClaudeCreate(); global.__releaseClaudeCreate = null; });
    await page.getByRole('tab', { name: 'Claude Code', exact: true }).waitFor();
    await page.locator('.terminal-pane[data-ready=true]:visible').waitFor();
    await page.waitForFunction(() => !/Abrindo Claude Code/.test(document.querySelector('#session-state')?.textContent || ''), null, { timeout: 15000 });
    assert.deepEqual(await counts(), { create: 2, start: 2 });
    assert.equal(fs.readFileSync(file, 'utf8'), 'Conteúdo original\n');
    console.log('✓ Claude simulado mostra carregamento no primeiro uso e inicia sem rede');
  } finally {
    if (app) {
      try { await app.evaluate(() => { global.__holdClaudeCreate = false; if (typeof global.__releaseClaudeCreate === 'function') global.__releaseClaudeCreate(); global.__releaseClaudeCreate = null; }); } catch {}
      if (page) {
        try { await page.evaluate(() => window.dk.setDirtyFiles([])); } catch {}
        for (const directory of [first, second]) try { await page.evaluate(folder => window.dk.closeProjectSessions(folder), directory); } catch {}
      }
      try { await app.evaluate(({ ipcMain }) => { for (const [channel, original] of Object.entries(global.__sessionStartOriginals || {})) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original); } }); } catch {}
      await app.close();
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
