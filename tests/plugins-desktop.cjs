const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { openProjectPanel } = require('./helpers/project-inspector.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tudo usado pela execução dos plugins pertence à fixture descartável.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-plugins-ui-')));
const first = path.join(temp, 'Projeto A'), second = path.join(temp, 'Projeto B'), bin = path.join(temp, 'bin');
for (const folder of [first, second, bin]) fs.mkdirSync(folder);
fs.writeFileSync(path.join(first, 'projeto.yml'), 'projeto: Projeto Exemplo A\n');
fs.writeFileSync(path.join(second, 'projeto.yml'), 'projeto: Projeto Exemplo B\n');
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
const fixtureNode = path.join(bin, nodeName);
const alternateNode = path.join(bin, process.platform === 'win32' ? 'outro-node.exe' : 'outro-node');
if (process.platform === 'win32') fs.copyFileSync(process.execPath, fixtureNode);
else fs.symlinkSync(process.execPath, fixtureNode);
if (process.platform === 'win32') fs.copyFileSync(process.execPath, alternateNode);
else fs.writeFileSync(alternateNode, '#!/bin/sh\nexit 17\n', { mode: 0o755 });
const fixtureShell = path.join(temp, 'shell');
if (process.platform !== 'win32') fs.writeFileSync(fixtureShell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });

const pluginPath = (project, folder) => path.join(project, '.dk', 'plugins', folder, 'plugin.json');
const markerContents = 'ok\u202e';
function writePlugin(project, folder, value) {
  const file = pluginPath(project, folder); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
function manifest(name, marker) {
  return {
    schema: 2, id: 'isolado', name, version: '1.0.0',
    description: 'Fixture <img src=x onerror="window.__pluginInjected=1">',
    permissions: ['process:spawn'],
    contributes: { actions: [{ id: 'gravar', title: 'Gravar marcador', command: 'node', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},${JSON.stringify(markerContents)})`] }] },
  };
}
const markerA = path.join(first, 'executado-a.txt');
const markerB = path.join(second, 'executado-b.txt');
const tampered = path.join(first, 'manifesto-trocado.txt');
writePlugin(first, 'isolado', manifest('Plugin do projeto A', markerA));
writePlugin(second, 'isolado', manifest('Plugin do projeto B', markerB));
writePlugin(first, 'invalido', { schema: 2, id: 'invalido', name: 'Plugin inválido', version: '1.0.0', permissions: ['net:any'], contributes: {} });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(message); await delay(50); }
}
async function showSettings(page) {
  if (await page.locator('#launcher').isVisible()) await page.locator('#launcher [data-route="settings"]').click();
  else await page.locator('#profile-show').click();
  await page.getByTestId('settings-plugins').waitFor();
  await page.getByTestId('settings-plugins').getByTestId('plugins-panel').waitFor();
}

let app;
(async () => {
  try {
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    const env = { ...process.env, PATH: bin, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: first, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile') };
    if (process.platform !== 'win32') env.SHELL = fixtureShell;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env });
    const page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    // O perfil sem projeto orienta o usuário, sem listar ações do projeto recente.
    await page.locator('#welcome-settings').click();
    const settingsPlugins = page.getByTestId('settings-plugins');
    await settingsPlugins.waitFor();
    const panel = settingsPlugins.getByTestId('plugins-panel');
    await panel.waitFor();
    await until(async () => /abra.*projeto/i.test(await panel.getByTestId('plugins-status').innerText()), 'O perfil sem projeto deve orientar como visualizar plugins.');
    assert.equal(await panel.getByTestId('plugin-card').count(), 0);
    await page.locator('#launcher [data-route="home"]').click();
    if (executablePath) {
      await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, first);
      await page.locator('#launcher-open-local').click();
    } else await page.locator('#launcher-recents .launcher-recent').first().click();
    await startProjectTerminal(page);
    await app.evaluate(({ dialog }, dir) => {
      global.__pluginDialogs = []; global.__pluginResponse = 0; global.__holdPluginDialog = false; global.__resumePluginDialog = null;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      dialog.showMessageBox = async (_window, options = _window) => {
        global.__pluginDialogs.push({ message: options.message, detail: options.detail, buttons: options.buttons });
        if (global.__holdPluginDialog) return new Promise(resolve => { global.__resumePluginDialog = resolve; });
        return { response: global.__pluginResponse };
      };
    }, second);

    // A API exige projeto aberto e não pode listar o segundo antes de selecioná-lo.
    await assert.rejects(page.evaluate(dir => window.dk.listPlugins(dir), second));
    await page.evaluate(() => {
      window.__pluginChangeEvents = [];
      window.dk.onPluginsChanged(event => window.__pluginChangeEvents.push(event.path));
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 620));
    await page.waitForFunction(() => window.innerWidth === 940);
    const tabs = await page.locator('.inspector-rail').evaluate(container => {
      return [...container.querySelectorAll('button')].map(button => {
        const rect = button.getBoundingClientRect();
        return { label: button.getAttribute('aria-label'), left: rect.left, top: rect.top, bottom: rect.bottom };
      });
    });
    assert.deepEqual(tabs.map(tab => tab.label), ['Pasta', 'Git', 'Contexto', 'Serviços', 'Consumo']);
    assert.ok(tabs.every((tab, index) => Math.abs(tab.left - tabs[0].left) < 2 && (index === 0 || tab.top >= tabs[index - 1].bottom - 1)), 'Os cinco ícones devem permanecer em uma coluna vertical.');
    await page.locator('#tab-files').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tab-git');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tab-context');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tab-usage');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tab-files');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await showSettings(page);
    const plugin = panel.getByTestId('plugin-card').filter({ hasText: 'Plugin do projeto A' });
    await plugin.waitFor();
    assert.match(await settingsPlugins.getByTestId('plugins-project').innerText(), /Projeto Exemplo A/);
    assert.equal(await panel.getByTestId('plugin-card').first().getAttribute('data-plugin-id'), 'isolado', 'O plugin do projeto deve aparecer antes das extensões do aplicativo.');
    const info = await page.evaluate(dir => window.dk.listPlugins(dir), first);
    const current = info.plugins.find(item => item.id === 'isolado');
    assert.ok(current, 'O plugin do projeto deve ser listado pela API.');
    assert.ok(info.plugins.some(item => item.id === 'claude' && item.origin === 'app' && item.schema === 1), `As extensões incluídas devem permanecer disponíveis também no aplicativo empacotado. Erros: ${info.errors.join(' | ')}`);
    assert.equal(current.schema, 2); assert.equal(current.origin, 'project');
    assert.ok(current.permissions.includes('process:spawn'));
    assert.equal(current.contributes.actions.find(item => item.id === 'gravar').available, true);
    assert.ok(info.errors.some(error => /invalido.*net:any/i.test(error)), 'Manifesto com permissão desconhecida precisa gerar erro.');
    assert.ok(!info.plugins.some(item => item.id === 'invalido'), 'Manifesto inválido não pode ser carregado.');
    assert.match(await plugin.innerText(), /Projeto/i);
    assert.match(await plugin.innerText(), /processo|executar|process:spawn/i);
    assert.equal(await page.evaluate(() => window.__pluginInjected), undefined);
    assert.equal(await plugin.locator('img[src="x"]').count(), 0);
    assert.equal(fs.existsSync(markerA), false, 'Listar e recarregar não podem executar uma ação.');
    console.log('✓ Plugin v2 do projeto exibe origem, permissão e ação; manifesto inválido é recusado');

    // Tanto trocar a rota quanto fechar o perfil devem parar o monitoramento.
    await page.locator('#launcher [data-route="home"]').click();
    await settingsPlugins.waitFor({ state: 'detached' });
    await delay(700);
    let eventCount = await page.evaluate(() => window.__pluginChangeEvents.length);
    writePlugin(first, 'isolado', manifest('Mudança fora do perfil', markerA));
    await delay(1000);
    assert.equal(await page.evaluate(() => window.__pluginChangeEvents.length), eventCount, 'O monitoramento deve parar ao mudar de rota.');
    await showSettings(page);
    await panel.getByTestId('plugin-card').filter({ hasText: 'Mudança fora do perfil' }).waitFor({ timeout: 12000 });
    writePlugin(first, 'isolado', manifest('Plugin do projeto A', markerA));
    await plugin.waitFor({ timeout: 12000 });
    await delay(700);
    await page.locator('#launcher-close').click();
    await page.locator('#launcher').waitFor({ state: 'hidden' });
    await delay(700);
    eventCount = await page.evaluate(() => window.__pluginChangeEvents.length);
    writePlugin(first, 'isolado', manifest('Mudança com perfil fechado', markerA));
    await delay(1000);
    assert.equal(await page.evaluate(() => window.__pluginChangeEvents.length), eventCount, 'O monitoramento deve parar ao fechar o perfil.');
    await showSettings(page);
    await panel.getByTestId('plugin-card').filter({ hasText: 'Mudança com perfil fechado' }).waitFor({ timeout: 12000 });
    writePlugin(first, 'isolado', manifest('Plugin do projeto A', markerA));
    await plugin.waitFor({ timeout: 12000 });
    console.log('✓ Orientação sem projeto e monitoramento restrito ao perfil aberto');

    // O próprio botão carrega as identidades do plugin e da ação.
    const execute = panel.locator('[data-testid="plugin-action"][data-plugin-id="isolado"][data-action-id="gravar"]');
    await execute.waitFor();
    const tabsBefore = await page.locator('#tabs .tab').count();
    await page.locator('#launcher-close').click();
    await page.locator('#show-graph').click();
    await page.locator('#graph-view').waitFor();
    await showSettings(page);
    await execute.waitFor();
    await execute.click();
    await until(() => app.evaluate(() => global.__pluginDialogs.length === 1), 'A confirmação de execução não apareceu.');
    const dialog = await app.evaluate(() => global.__pluginDialogs[0]);
    assert.match(`${dialog.message || ''}\n${dialog.detail || ''}`, /node/i);
    assert.match(`${dialog.message || ''}\n${dialog.detail || ''}`, /writeFileSync|executado-a/i);
    assert.match(dialog.detail, /\\u202e/i, 'Caracteres de direção devem aparecer escapados na confirmação.');
    assert.equal(dialog.detail.includes('\u202e'), false);
    await delay(300);
    assert.equal(fs.existsSync(markerA), false, 'Cancelar não deve executar a ação.');
    assert.equal(await page.locator('#tabs .tab').count(), tabsBefore);
    assert.equal(await page.locator('#launcher').isVisible(), true, 'Cancelar deve manter as configurações abertas.');
    assert.equal(await page.locator('#graph-view').isHidden(), false, 'Cancelar preserva o grafo que estava aberto.');

    // Trocar o manifesto enquanto a confirmação está aberta não deve autorizar a nova ação.
    await app.evaluate(() => { global.__holdPluginDialog = true; });
    await execute.click();
    await until(() => app.evaluate(() => typeof global.__resumePluginDialog === 'function'), 'O diálogo de confirmação não ficou pendente.');
    writePlugin(first, 'isolado', manifest('Plugin substituído', tampered));
    await app.evaluate(() => { const resume = global.__resumePluginDialog; global.__resumePluginDialog = null; global.__holdPluginDialog = false; resume({ response: 1 }); });
    await delay(500);
    assert.equal(fs.existsSync(tampered), false, 'Uma alteração durante a confirmação deve ser recusada.');
    assert.equal(fs.existsSync(markerA), false, 'A ação antiga também não deve iniciar após a troca.');
    assert.equal(await page.locator('#tabs .tab').count(), tabsBefore);
    console.log('✓ Cancelamento e alteração do manifesto durante a confirmação não executam ações');

    writePlugin(first, 'isolado', manifest('Plugin atualizado A', markerA));
    await panel.getByTestId('plugin-card').filter({ hasText: 'Plugin atualizado A' }).waitFor({ timeout: 12000 });
    await app.evaluate(() => { global.__pluginResponse = 1; });
    await execute.click();
    await until(() => fs.existsSync(markerA), 'A ação confirmada não executou a fixture Node.');
    await page.locator('#launcher').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#graph-view').isHidden(), true, 'A ação confirmada retorna à visualização do projeto.');
    assert.equal(fs.readFileSync(markerA, 'utf8'), markerContents, 'O argumento executado deve preservar o caractere original.');
    assert.equal(fs.existsSync(markerB), false);
    assert.ok(await page.locator('#tabs .tab').count() > tabsBefore);
    const pluginSession = (await page.locator('#tabs .tab-select[aria-selected="true"]').getAttribute('id')).slice(4);
    await page.locator(`#pane-${pluginSession}[data-ready="true"]`).waitFor();
    console.log('✓ Ação declarada só inicia após clique e confirmação');

    // Dividir uma sessão de plugin é uma nova execução e exige nova confirmação.
    fs.unlinkSync(markerA);
    const tabsBeforeSplit = await page.locator('#tabs .tab').count();
    const dialogsBeforeSplit = await app.evaluate(() => global.__pluginDialogs.length);
    await app.evaluate(() => { global.__pluginResponse = 0; });
    await page.locator('#split-right').click();
    await until(() => app.evaluate((_, count) => global.__pluginDialogs.length > count, dialogsBeforeSplit), 'Dividir a ação não pediu confirmação.');
    const splitDialog = await app.evaluate(() => global.__pluginDialogs.at(-1));
    assert.match(`${splitDialog.message || ''}\n${splitDialog.detail || ''}`, /writeFileSync|executado-a/i);
    await delay(300);
    assert.equal(fs.existsSync(markerA), false, 'Cancelar o split não pode executar a ação novamente.');
    assert.equal(await page.locator('#tabs .tab').count(), tabsBeforeSplit);
    // O perfil fechado não impede a divisão da sessão de plugin.
    await openProjectPanel(page, 'files');
    await page.locator('#panel-files').waitFor();
    await delay(300);
    await app.evaluate(() => { global.__pluginResponse = 1; });
    await page.locator('#split-right').click();
    await until(() => fs.existsSync(markerA), 'O split confirmado não executou a fixture.');
    await page.waitForFunction(() => document.querySelectorAll('#terminal-host.split .terminal-pane:not([hidden])').length === 2);
    assert.equal(await app.evaluate(() => global.__pluginDialogs.length), dialogsBeforeSplit + 2);
    assert.equal(await page.locator('#tabs .tab').count(), tabsBeforeSplit + 1);
    assert.equal(fs.readFileSync(markerA, 'utf8'), markerContents);
    await showSettings(page);
    await panel.getByTestId('plugin-card').filter({ hasText: 'Plugin atualizado A' }).waitFor({ timeout: 12000 });
    console.log('✓ Dividir exige confirmação, também com o perfil fechado; cancelar não executa a ação');

    // Ao mudar de rota depois da confirmação, concluir a sessão não deve
    // fechar a nova tela. Suspende somente o início do PTY na instância de teste.
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers?.get('terminal:start');
      const gitlab = ipcMain._invokeHandlers?.get('gitlab:projects');
      if (typeof original !== 'function' || typeof gitlab !== 'function') throw new Error('Não foi possível instrumentar os canais da fixture.');
      global.__originalPluginTerminalStart = original;
      global.__originalPluginGitlabProjects = gitlab;
      global.__pausePluginTerminalStart = false;
      global.__resumePluginTerminalStart = null;
      ipcMain.removeHandler('gitlab:projects');
      ipcMain.handle('gitlab:projects', async () => ({ ok: true, value: { items: [], hasMore: false } }));
      ipcMain.removeHandler('terminal:start');
      ipcMain.handle('terminal:start', async (...args) => {
        if (global.__pausePluginTerminalStart) {
          global.__pausePluginTerminalStart = false;
          await new Promise(resolve => { global.__resumePluginTerminalStart = resolve; });
        }
        return original(...args);
      });
    });
    try {
      for (const route of ['home', 'gitlab']) {
        fs.unlinkSync(markerA);
        await app.evaluate(() => { global.__pausePluginTerminalStart = true; });
        await execute.click();
        await until(() => app.evaluate(() => typeof global.__resumePluginTerminalStart === 'function'), 'O início do terminal de teste não ficou pendente.');
        const pendingId = (await page.locator('#tabs .tab-select[aria-selected="true"]').getAttribute('id')).slice(4);
        const routeButton = page.locator(`#launcher [data-route="${route}"]`);
        await routeButton.click();
        assert.equal(await routeButton.getAttribute('aria-current'), 'page');
        await app.evaluate(() => { const resume = global.__resumePluginTerminalStart; global.__resumePluginTerminalStart = null; resume(); });
        await until(() => fs.existsSync(markerA), 'A ação aprovada não iniciou após liberar o terminal de teste.');
        await page.waitForFunction(id => document.querySelector(`#pane-${id}`)?.dataset.ready === 'true', pendingId);
        await delay(200);
        assert.equal(await page.locator('#launcher').isVisible(), true, `A conclusão da ação não deve fechar a rota ${route}.`);
        assert.equal(await routeButton.getAttribute('aria-current'), 'page');
        await showSettings(page);
        await panel.getByTestId('plugin-card').filter({ hasText: 'Plugin atualizado A' }).waitFor({ timeout: 12000 });
      }
    } finally {
      await app.evaluate(({ ipcMain }) => {
        global.__pausePluginTerminalStart = false;
        if (typeof global.__resumePluginTerminalStart === 'function') global.__resumePluginTerminalStart();
        global.__resumePluginTerminalStart = null;
        if (global.__originalPluginTerminalStart) {
          ipcMain.removeHandler('terminal:start');
          ipcMain.handle('terminal:start', global.__originalPluginTerminalStart);
          global.__originalPluginTerminalStart = null;
        }
        if (global.__originalPluginGitlabProjects) {
          ipcMain.removeHandler('gitlab:projects');
          ipcMain.handle('gitlab:projects', global.__originalPluginGitlabProjects);
          global.__originalPluginGitlabProjects = null;
        }
      });
    }
    console.log('✓ Conclusão da ação preserva as rotas Início e GitLab abertas durante o início');

    const invalidPath = pluginPath(first, 'invalido');
    writePlugin(first, 'invalido', { schema: 2, id: 'validado', name: 'Plugin corrigido', version: '1.0.0', permissions: [], contributes: {} });
    await panel.getByTestId('plugin-card').filter({ hasText: 'Plugin corrigido' }).waitFor({ timeout: 12000 });
    fs.rmSync(path.dirname(invalidPath), { recursive: true });
    await until(async () => await panel.getByTestId('plugin-card').filter({ hasText: 'Plugin corrigido' }).count() === 0, 'O plugin removido ainda aparece após a recarga.');
    await panel.getByTestId('plugins-reload').click();
    const reloaded = await page.evaluate(dir => window.dk.reloadPlugins(dir), first);
    assert.ok(reloaded.plugins.some(item => item.id === 'isolado'));
    assert.ok(!reloaded.plugins.some(item => item.id === 'validado'));
    console.log('✓ Alterações, correção e remoção de manifestos atualizam a lista');

    await page.locator('#launcher-close').click();
    await page.locator('#open-project').click();
    await page.locator('.project-select[title="Projeto Exemplo B"]').waitFor();
    await showSettings(page);
    const secondCard = panel.getByTestId('plugin-card').filter({ hasText: 'Plugin do projeto B' });
    await secondCard.waitFor({ timeout: 12000 });
    assert.match(await settingsPlugins.getByTestId('plugins-project').innerText(), /Projeto Exemplo B/);
    assert.equal(await panel.getByTestId('plugin-card').filter({ hasText: 'Plugin atualizado A' }).count(), 0);
    const secondInfo = await page.evaluate(dir => window.dk.listPlugins(dir), second);
    assert.equal(secondInfo.plugins.find(item => item.id === 'isolado')?.name, 'Plugin do projeto B');
    await execute.click();
    await until(() => fs.existsSync(markerB), 'A ação do segundo projeto não executou no projeto correto.');
    await page.locator('#launcher').waitFor({ state: 'hidden' });
    assert.equal(fs.readFileSync(markerB, 'utf8'), markerContents);
    assert.equal(fs.readFileSync(markerA, 'utf8'), markerContents);
    assert.equal(fs.existsSync(tampered), false);
    console.log('✓ Troca de projeto isola manifestos e ações mesmo com o mesmo ID de plugin');

    const secondSession = (await page.locator('#tabs .tab-select[aria-selected="true"]').getAttribute('id')).slice(4);
    await page.locator(`#pane-${secondSession}[data-ready="true"]`).waitFor();
    await openProjectPanel(page, 'files');
    await delay(300);
    fs.unlinkSync(markerB);
    const revision = secondInfo.plugins.find(item => item.id === 'isolado').revision;
    const alternate = path.join(temp, 'Projeto substituto');
    const original = path.join(temp, 'Projeto B original');
    fs.mkdirSync(alternate);
    // Mesmo conteúdo e mesma revisão, mas outro diretório físico.
    writePlugin(alternate, 'isolado', manifest('Plugin do projeto B', markerB));
    function substituteProject() {
      fs.renameSync(second, original);
      fs.symlinkSync(alternate, second, process.platform === 'win32' ? 'junction' : 'dir');
    }
    function restoreProject() {
      fs.unlinkSync(second);
      fs.renameSync(original, second);
    }
    const invoke = ({ root, revision }) => window.dk.executePlugin(root, 'isolado', 'gravar', revision);

    // Substituir a raiz por link não pode fazer o processo mirar outra pasta.
    substituteProject();
    try {
      const count = await app.evaluate(() => global.__pluginDialogs.length);
      await assert.rejects(page.evaluate(dir => window.dk.activateProject(dir), second));
      await assert.rejects(page.evaluate(invoke, { root: second, revision }));
      assert.equal(await app.evaluate(() => global.__pluginDialogs.length), count);
      assert.equal(fs.existsSync(markerB), false);
    } finally { restoreProject(); }

    // A mesma verificação precisa ocorrer depois que o usuário aceita o diálogo.
    async function startHeldConfirmation() {
      await app.evaluate(() => { global.__holdPluginDialog = true; global.__resumePluginDialog = null; });
      await page.evaluate(({ root, revision }) => {
        window.__pluginPending = { done: false };
        window.dk.executePlugin(root, 'isolado', 'gravar', revision).then(
          value => { window.__pluginPending = { done: true, value }; },
          error => { window.__pluginPending = { done: true, error: String(error) }; },
        );
      }, { root: second, revision });
      await until(() => app.evaluate(() => typeof global.__resumePluginDialog === 'function'), 'A confirmação da fixture não ficou pendente.');
    }
    async function approveHeldConfirmation() {
      await app.evaluate(() => { const resume = global.__resumePluginDialog; global.__resumePluginDialog = null; global.__holdPluginDialog = false; resume({ response: 1 }); });
      await until(() => page.evaluate(() => window.__pluginPending.done), 'A confirmação da fixture não foi concluída.');
      const result = await page.evaluate(() => window.__pluginPending);
      assert.match(result.error || '', /projeto|pasta|janela/i, `Confirmação antiga não foi recusada pelo motivo esperado: ${JSON.stringify(result)}`);
    }
    await startHeldConfirmation();
    substituteProject();
    try { await approveHeldConfirmation(); } finally { restoreProject(); }
    assert.equal(fs.existsSync(markerB), false);
    console.log('✓ Substituir a pasta por link é recusado antes e durante a confirmação');

    // Fechar e reabrir o mesmo projeto invalida qualquer confirmação antiga.
    await startHeldConfirmation();
    await page.evaluate(dir => window.dk.closeProjectSessions(dir), second);
    await page.evaluate(dir => window.dk.forgetProject(dir), second);
    await page.evaluate(dir => window.dk.activateProject(dir), second);
    await approveHeldConfirmation();
    assert.equal(fs.existsSync(markerB), false);
    console.log('✓ Fechar e reabrir o projeto invalida confirmações pendentes');

    // Uma sessão aprovada ainda está pendente até que o terminal seja iniciado.
    // Trocar a raiz nesse intervalo não pode redirecionar o PTY para outra pasta.
    const pending = await page.evaluate(invoke, { root: second, revision });
    assert.ok(pending?.id, 'A confirmação deve criar uma sessão pendente.');
    substituteProject();
    try {
      await assert.rejects(page.evaluate(id => window.dk.startTerminal(id, { cols: 80, rows: 24 }), pending.id));
      await delay(200);
      assert.equal(fs.existsSync(markerB), false, 'A ação não pode iniciar na pasta substituída.');
    } finally {
      await page.evaluate(id => window.dk.closeTerminal(id).catch(() => {}), pending.id);
      restoreProject();
    }

    const changed = await page.evaluate(invoke, { root: second, revision });
    const alteredMarker = path.join(second, 'executado-alterado.txt');
    writePlugin(second, 'isolado', manifest('Plugin adulterado B', alteredMarker));
    try {
      await assert.rejects(page.evaluate(id => window.dk.startTerminal(id, { cols: 80, rows: 24 }), changed.id));
      assert.equal(fs.existsSync(markerB), false);
      assert.equal(fs.existsSync(alteredMarker), false);
    } finally {
      await page.evaluate(id => window.dk.closeTerminal(id).catch(() => {}), changed.id);
      writePlugin(second, 'isolado', manifest('Plugin do projeto B', markerB));
    }

    const stale = await page.evaluate(invoke, { root: second, revision });
    await page.evaluate(dir => window.dk.forgetProject(dir), second);
    await page.evaluate(dir => window.dk.activateProject(dir), second);
    try {
      await assert.rejects(page.evaluate(id => window.dk.startTerminal(id, { cols: 80, rows: 24 }), stale.id));
      assert.equal(fs.existsSync(markerB), false);
    } finally { await page.evaluate(id => window.dk.closeTerminal(id).catch(() => {}), stale.id); }

    // O terminal criado por split segue a mesma regra de início.
    fs.unlinkSync(markerA);
    const split = await page.evaluate(({ root, id }) => window.dk.splitTerminal(root, id), { root: first, id: pluginSession });
    assert.ok(split?.id, 'O split confirmado deve criar uma sessão pendente.');
    const shadowFirst = path.join(temp, 'Projeto A substituto');
    const originalFirst = path.join(temp, 'Projeto A original');
    fs.mkdirSync(shadowFirst);
    writePlugin(shadowFirst, 'isolado', manifest('Plugin atualizado A', markerA));
    fs.renameSync(first, originalFirst);
    fs.symlinkSync(shadowFirst, first, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await assert.rejects(page.evaluate(id => window.dk.startTerminal(id, { cols: 80, rows: 24 }), split.id));
      assert.equal(fs.existsSync(markerA), false);
    } finally {
      await page.evaluate(id => window.dk.closeTerminal(id).catch(() => {}), split.id);
      fs.unlinkSync(first);
      fs.renameSync(originalFirst, first);
    }
    console.log('✓ Início e split revalidam pasta, manifesto e geração antes do processo');

    // Mesmo nome no PATH, mas outro executável depois da aprovação.
    const pendingExecutable = await page.evaluate(invoke, { root: second, revision });
    assert.ok(pendingExecutable?.id, 'A confirmação deve criar uma sessão pendente.');
    const savedNode = path.join(bin, 'node-fixture-original');
    fs.renameSync(fixtureNode, savedNode);
    if (process.platform === 'win32') fs.copyFileSync(alternateNode, fixtureNode);
    else fs.symlinkSync(alternateNode, fixtureNode);
    try {
      await assert.rejects(page.evaluate(id => window.dk.startTerminal(id, { cols: 80, rows: 24 }), pendingExecutable.id));
      assert.equal(fs.existsSync(markerB), false);
    } finally {
      await page.evaluate(id => window.dk.closeTerminal(id).catch(() => {}), pendingExecutable.id);
      fs.unlinkSync(fixtureNode);
      fs.renameSync(savedNode, fixtureNode);
    }
    console.log('✓ Alteração do executável após confirmação impede o início');
  } finally {
    if (app) await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
