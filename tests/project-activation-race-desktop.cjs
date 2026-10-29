const { openFolderDialog } = require('./helpers/open-folder.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { openProjectPanel } = require('./helpers/project-inspector.cjs');

// Cenário local: conversas persistidas não executam inferência, e o único
// terminal pertence à fixture. A lista de B é atrasada sem alterar seu resultado.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-activation-race-')));
const first = path.join(temp, 'Projeto A'), second = path.join(temp, 'Projeto B'), third = path.join(temp, 'Projeto C'), fourth = path.join(temp, 'Projeto D'), bin = path.join(temp, 'bin');
for (const dir of [first, second, third, fourth, bin]) fs.mkdirSync(dir);
for (const [directory, letter] of [[first, 'A'], [second, 'B'], [third, 'C'], [fourth, 'D']]) fs.writeFileSync(path.join(directory, `somente-${letter}.txt`), `Arquivo ${letter}\n`);
const shell = path.join(temp, process.platform === 'win32' ? 'shell.exe' : 'shell');
const codex = path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex');
if (process.platform === 'win32') { fs.copyFileSync(process.execPath, shell); fs.copyFileSync(process.execPath, codex); }
else {
  fs.writeFileSync(shell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });
  fs.writeFileSync(codex, '#!/bin/sh\nprintf "codex-fixture\\n"\n', { mode: 0o755 });
}
const env = { ...process.env, PATH: bin, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: first, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile'), ...(process.platform === 'win32' ? { ComSpec: shell } : { SHELL: shell }) };
let app, page;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) { for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(50); } throw new Error(message); }
async function selectViaDialog(directory) {
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
    await app.evaluate(({ ipcMain }, delayedRoot) => {
      global.__raceOriginals = {}; global.__raceCounts = { create: 0, start: 0 }; global.__raceCalls = []; global.__raceHold = false; global.__raceBReturned = false; global.__raceDelayed = delayedRoot; global.__raceFailRoot = null;
      for (const [channel, key] of [['terminal:create', 'create'], ['terminal:start', 'start'], ['chat:list', 'chat']]) {
        const original = ipcMain._invokeHandlers?.get(channel); if (!original) throw new Error(`Handler ${channel} indisponível.`);
        global.__raceOriginals[channel] = original; ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => {
          if (key !== 'chat') global.__raceCounts[key]++;
          if (key === 'chat') global.__raceCalls.push({ channel, root: args[1], phase: 'request', hold: global.__raceHold, delayedRoot: global.__raceDelayed });
          if (key === 'chat' && args[1] === global.__raceDelayed && global.__raceHold) {
            global.__raceCalls.push({ channel, root: args[1], phase: 'held' });
            await new Promise(resolve => { global.__raceReleaseB = resolve; });
            const result = await original(...args); global.__raceCalls.push({ channel, root: args[1], phase: 'returned' }); global.__raceBReturned = true; return result;
          }
          return original(...args);
        });
      }
      const activate = ipcMain._invokeHandlers?.get('project:activate'); if (!activate) throw new Error('Handler de ativação indisponível.');
      global.__raceOriginals['project:activate'] = activate; ipcMain.removeHandler('project:activate');
      ipcMain.handle('project:activate', async (...args) => {
        global.__raceCalls.push({ channel: 'project:activate', root: args[1], phase: 'request', failed: args[1] === global.__raceFailRoot });
        const result = args[1] === global.__raceFailRoot ? { ok: false, error: 'Falha simulada ao selecionar projeto C' } : await activate(...args);
        global.__raceCalls.push({ channel: 'project:activate', root: args[1], phase: 'returned', ok: result?.ok }); return result;
      });
    }, second);
    if (executablePath) {
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, first);
      await page.locator('#launcher-open-local').click();
    } else await page.locator('#launcher-recents .launcher-recent').first().click();
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, first);
    await selectViaDialog(third);
    assert.deepEqual(await app.evaluate(() => global.__raceCounts), { create: 0, start: 0 });
    await startProjectTerminal(page);
    const id = (await page.locator('.tab-select[aria-selected=true]').getAttribute('id')).slice(4);
    assert.deepEqual(await app.evaluate(() => global.__raceCounts), { create: 1, start: 1 });
    const cChat = await page.evaluate(folder => window.dk.createChat(folder), third);
    await page.locator('.project-select[title="Projeto A"]').click();
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, first);
    await page.locator('#launch-codex').click();
    await page.getByRole('textbox', { name: 'Mensagem para o Codex' }).waitFor();
    await page.waitForFunction(() => (document.querySelector('select[aria-label="Conversas do projeto"]')?.options.length || 0) > 0);
    await openProjectPanel(page, 'files');
    await page.locator('.tree-file[data-relative="somente-A.txt"]').waitFor();
    assert.equal(await page.locator('.project-select[title="Projeto B"]').count(), 0);
    await app.evaluate(({ dialog }, folder) => { global.__raceHold = true; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, second);
    await openFolderDialog(app);
    await until(() => app.evaluate(() => typeof global.__raceReleaseB === 'function'), 'A resposta de B não ficou pendente.');
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, second);
    assert.equal(await page.locator('.tree-file[data-relative="somente-A.txt"]').count(), 0, 'A árvore anterior não pode aparecer sob o cabeçalho de B.');
    await page.locator('.tree-file[data-relative="somente-B.txt"]').waitFor();
    await page.locator('.project-select[title="Projeto C"]').click();
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, third);
    await page.locator('.tree-file[data-relative="somente-C.txt"]').waitFor();
    assert.equal(await page.locator('.tree-file[data-relative="somente-B.txt"]').count(), 0);
    await page.waitForFunction(chat => document.querySelector('select[aria-label="Conversas do projeto"]')?.value === chat, cChat.id);
    await app.evaluate(() => { global.__raceHold = false; global.__raceReleaseB(); global.__raceReleaseB = null; });
    await until(() => app.evaluate(() => global.__raceBReturned), 'A resposta atrasada de B não retornou.');
    await page.waitForTimeout(300); // permite entregar a resposta tardia ao renderer
    assert.equal(await page.locator('#project-title').innerText(), 'Projeto C');
    assert.equal(await page.locator('.project-select[aria-current=page]').getAttribute('title'), 'Projeto C');
    assert.equal(await page.getByRole('combobox', { name: 'Conversas do projeto' }).inputValue(), cChat.id);
    assert.deepEqual(await app.evaluate(() => global.__raceCounts), { create: 1, start: 1 });
    await page.locator('.project-select[title="Projeto B"]').waitFor();
    await page.locator('#launcher-show').click();
    await page.locator('#launcher-recents .launcher-recent').filter({ hasText: 'Projeto B' }).waitFor();
    await page.locator('#launcher-close').click();
    assert.equal(await page.locator('#project-title').innerText(), 'Projeto C');
    await page.getByRole('button', { name: 'Voltar ao terminal', exact: true }).click();
    await page.locator(`#pane-${id}[data-ready=true]:visible`).waitFor();
    assert.equal(await page.locator(`#tab-${id}`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#tabs .tab').count(), 1);
    await page.evaluate(id => { window.__raceOutput = ''; window.dk.onTerminalData(event => { if (event.id === id) window.__raceOutput += event.data; }); }, id);
    const command = process.platform === 'win32' ? 'process.stdout.write("\\nSEA_RACE_ALIVE\\n")\r' : 'printf "\\nSEA_RACE_ALIVE\\n"\r';
    await page.evaluate(({ id, command }) => window.dk.writeTerminal(id, command), { id, command });
    await page.waitForFunction(() => window.__raceOutput.includes('SEA_RACE_ALIVE\r\n'));
    console.log('✓ B novo permanece listado e resposta atrasada não altera conversa ou terminal ativo de C');

    // Repete a corrida com outro projeto novo enquanto a ativação de C falha.
    // O aplicativo pode preservar A ou concluir D, mas não pode misturá-los.
    await page.locator('.project-select[title="Projeto A"]').click();
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, first);
    await page.locator('#launch-codex').click();
    await page.getByRole('textbox', { name: 'Mensagem para o Codex' }).waitFor();
    await app.evaluate(({ dialog }, { delayed, failure }) => {
      global.__raceDelayed = delayed; global.__raceFailRoot = failure; global.__raceHold = true; global.__raceBReturned = false;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [delayed] });
    }, { delayed: fourth, failure: third });
    await openFolderDialog(app);
    await until(() => app.evaluate(() => typeof global.__raceReleaseB === 'function'), 'A resposta do projeto D não ficou pendente.');
    await page.locator('.project-select[title="Projeto C"]').click();
    await page.getByText('Falha simulada ao selecionar projeto C', { exact: false }).waitFor();
    await app.evaluate(() => { global.__raceHold = false; global.__raceReleaseB(); global.__raceReleaseB = null; });
    await until(() => app.evaluate(() => global.__raceBReturned), 'A resposta atrasada de D não retornou.');
    await page.waitForTimeout(300);
    const finalPath = await page.locator('#breadcrumb-project').getAttribute('data-project-path');
    assert.ok([first, fourth].includes(finalPath), `Seleção incoerente após falha: ${finalPath}`);
    const finalTitle = finalPath === first ? 'Projeto A' : 'Projeto D';
    assert.equal(await page.locator('#project-title').innerText(), finalTitle);
    assert.equal(await page.locator('.project-select[aria-current=page]').getAttribute('title'), finalTitle);
    const activeChat = await page.getByRole('combobox', { name: 'Conversas do projeto' }).inputValue();
    if (activeChat) assert.equal((await page.evaluate(({ folder, chat }) => window.dk.readChat(folder, chat), { folder: finalPath, chat: activeChat })).session.root, finalPath);
    assert.deepEqual(await app.evaluate(() => global.__raceCounts), { create: 1, start: 1 });
    await page.getByRole('button', { name: 'Voltar ao terminal', exact: true }).click();
    await page.locator('#terminal-empty').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tabs .tab').count(), 0);
    assert.equal(await page.locator(`#pane-${id}`).isVisible(), false);
    await page.locator('.project-select[title="Projeto D"]').waitFor();
    await page.locator('#launcher-show').click();
    await page.locator('#launcher-recents .launcher-recent').filter({ hasText: 'Projeto D' }).waitFor();
    console.log('✓ Falha da ativação concorrente mantém seleção e sessões coerentes');

    // Abrir Perfil enquanto uma troca pela sidebar aguarda o chat não deve
    // fechar a rota escolhida quando a troca completar.
    await page.locator('#launcher-close').click();
    await page.locator('.project-select[title="Projeto A"]').click();
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, first);
    await page.locator('#launch-codex').click();
    await page.getByRole('textbox', { name: 'Mensagem para o Codex' }).waitFor();
    const aChats = await page.evaluate(folder => window.dk.listChats(folder), first);
    assert.ok(aChats.length, 'O chat de A precisa existir antes da troca pela sidebar.');
    await page.waitForFunction(chat => document.querySelector('select[aria-label="Conversas do projeto"]')?.value === chat, aChats[0].id);
    await app.evaluate((_electron, folder) => { global.__raceDelayed = folder; global.__raceFailRoot = null; global.__raceHold = true; global.__raceBReturned = false; }, second);
    await page.locator('.project-select[title="Projeto B"]').click();
    try {
      await until(() => app.evaluate(() => typeof global.__raceReleaseB === 'function'), 'A troca pela sidebar não ficou pendente.');
    } catch (error) {
      const dom = await page.evaluate(() => ({ breadcrumb: document.querySelector('#breadcrumb-project')?.dataset.projectPath, chatHidden: document.querySelector('#chat-view')?.hidden, chatVisible: !!document.querySelector('#chat-view')?.getClientRects().length, toast: document.querySelector('#toast')?.textContent, selected: document.querySelector('.project-select[aria-current=page]')?.title }));
      const trace = await app.evaluate(() => {
        const primitive = value => value == null || ['string', 'number', 'boolean'].includes(typeof value) ? value : `<${typeof value}>`;
        return { calls: (global.__raceCalls || []).map(call => Object.fromEntries(Object.entries(call).map(([key, value]) => [key, primitive(value)]))), hold: primitive(global.__raceHold), delayed: primitive(global.__raceDelayed), failure: primitive(global.__raceFailRoot), hasRelease: typeof global.__raceReleaseB === 'function' };
      });
      throw new Error(`${error.message} Estado: ${JSON.stringify({ dom, trace })}`, { cause: error });
    }
    await page.locator('#profile-show').click();
    await page.locator('#launcher [data-route="settings"][aria-current="page"]').waitFor();
    await app.evaluate(() => { global.__raceHold = false; global.__raceReleaseB(); global.__raceReleaseB = null; });
    await until(() => app.evaluate(() => global.__raceBReturned), 'A troca pela sidebar não retornou.');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#launcher').isVisible(), true);
    assert.equal(await page.locator('#launcher [data-route="settings"]').getAttribute('aria-current'), 'page');
    assert.deepEqual(await app.evaluate(() => global.__raceCounts), { create: 1, start: 1 });
    console.log('✓ Perfil permanece aberto após troca de projeto concluída em segundo plano');
  } finally {
    if (app) {
      try { await app.evaluate(() => { global.__raceHold = false; if (typeof global.__raceReleaseB === 'function') global.__raceReleaseB(); global.__raceReleaseB = null; }); } catch {}
      if (page) for (const directory of [first, second, third, fourth]) try { await page.evaluate(folder => window.dk.closeProjectSessions(folder), directory); } catch {}
      try { await app.evaluate(({ ipcMain }) => { for (const [channel, original] of Object.entries(global.__raceOriginals || {})) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original); } }); } catch {}
      await app.close();
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
