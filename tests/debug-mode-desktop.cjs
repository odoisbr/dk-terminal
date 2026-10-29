const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-debug-ui-')));
const project = path.join(temporary, 'projeto'); fs.mkdirSync(project);
const profile = path.join(temporary, 'perfil');
const logs = path.join(profile, 'logs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 15000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw new Error(description); await delay(100); } }
const readLogs = () => fs.existsSync(logs) ? fs.readdirSync(logs).filter(name => name.endsWith('.log')).map(name => fs.readFileSync(path.join(logs, name), 'utf8')).join('\n') : '';
const launch = (extra = [], env = {}) => electron.launch({ args: [root, ...extra], env: { ...process.env, SHELL: '/bin/sh', DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_DATA_DIR: profile, ...env }, timeout: 60000 });
let app;
(async () => {
  try {
    app = await launch();
    let page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await page.locator('#launcher-recents .launcher-recent').first().click();
    await startProjectTerminal(page);
    const terminalId = (await page.locator('.tab-select[aria-selected=true]').getAttribute('id')).slice(4);
    assert.equal(await page.locator('#debug-indicator').count(), 0, 'Indicador não deve aparecer com o modo desligado.');

    await page.locator('#profile-show').click();
    const toggle = page.getByRole('checkbox', { name: 'Modo debug', exact: true });
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), false);
    await toggle.check();
    await page.locator('#debug-indicator').waitFor();
    await until(async () => /Modo debug ligado/.test(await page.locator('#debug-status').innerText()), 'O estado do modo debug não foi informado.');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'debug.json'), 'utf8')), { enabled: true });
    if (process.env.DK_DEBUG_SCREENSHOT) { await page.getByTestId('settings-debug').scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.DK_DEBUG_SCREENSHOT }); }

    // Provoca erros no renderer, no processo principal e numa chamada IPC.
    await page.evaluate(() => {
      setTimeout(() => { throw new Error('falha provocada no renderer Bearer abcdef123456'); });
      Promise.reject(new Error('rejeição provocada no renderer'));
      console.error('console.error do renderer com sea_pat_SEGREDO123');
    });
    await app.evaluate(() => { console.error(`erro provocado no main glpat-TOKENSECRETO em ${process.env.HOME}/pasta-pessoal`); Promise.reject(new Error('rejeição provocada no main')); });
    await page.evaluate(() => window.dk.listServices('/caminho/que/nao/foi/aberto').catch(() => {}));

    // Sessão: o ciclo de vida é registrado, o conteúdo digitado não.
    await page.evaluate(dir => window.dk.activateProject(dir), project);
    const sessionId = await page.evaluate(async dir => { const info = await window.dk.createTerminal(dir); await window.dk.startTerminal(info.id, { cols: 80, rows: 24 }); return info.id; }, project);
    await page.evaluate(id => window.dk.writeTerminal(id, 'echo DIGITADO_NO_TERMINAL_123\r'), sessionId);
    await delay(500);
    await page.evaluate(id => window.dk.closeTerminal(id), sessionId);
    await page.evaluate(id => window.dk.writeTerminal(id, 'echo DIGITADO_NA_PRIMEIRA_SESSAO\r'), terminalId);

    await until(() => {
      const text = readLogs();
      return /rejeição provocada no main/.test(text) && /window\.onerror/.test(text) && /Sessão fechada/.test(text);
    }, 'Os eventos não chegaram ao arquivo de log.');
    const text = readLogs();
    assert.match(text, /^=== SEA Dock · log de diagnóstico .* app=\S+ .*arch=\S+ .*electron=\d+\S* · node=\d+/m);
    assert.match(text, /\[ERROR\] \[renderer\] window\.onerror: .*falha provocada no renderer Bearer \[REDACTED\]/);
    assert.match(text, /\[ERROR\] \[renderer\] unhandledrejection: .*rejeição provocada no renderer/);
    assert.match(text, /\[ERROR\] \[renderer\] console\.error: console\.error do renderer com sea_pat_\[REDACTED\]/);
    assert.match(text, /\[ERROR\] \[main\] erro provocado no main glpat-\[REDACTED\] em ~\/pasta-pessoal/);
    assert.match(text, /unhandledRejection.*rejeição provocada no main/);
    assert.match(text, /\[WARN\] \[ipc\] service:list falhou: Abra esta pasta/);
    assert.match(text, /\[projeto\] Projeto aberto:/);
    assert.match(text, /\[sessão\] Sessão criada: /);
    assert.match(text, /\[sessão\] Sessão iniciada: .* · PID \d+ · /);
    assert.match(text, /\[sessão\] Sessão fechada: /);
    for (const secret of ['abcdef123456', 'SEGREDO123', 'TOKENSECRETO', 'DIGITADO_NO_TERMINAL_123', 'DIGITADO_NA_PRIMEIRA_SESSAO', os.homedir() + '/']) assert.ok(!text.includes(secret), `O log contém ${secret}`);

    // Exportar gera um zip com os logs.
    await page.locator('#profile-show').click();
    assert.equal(await page.getByRole('checkbox', { name: 'Modo debug', exact: true }).isChecked(), true, 'A seção deve refletir o modo ligado ao reabrir.');
    await page.getByRole('button', { name: 'Exportar logs', exact: true }).click();
    await until(async () => /Logs exportados em/.test(await page.locator('#debug-status').innerText()), 'A exportação não terminou.');
    const exports = fs.readdirSync(path.join(profile, 'exports'));
    assert.equal(exports.length, 1);
    assert.match(exports[0], process.platform === 'darwin' ? /^sea-dock-logs-.*\.zip$/ : /^sea-dock-logs-.*\.txt$/);
    if (process.platform === 'darwin') assert.equal(fs.readFileSync(path.join(profile, 'exports', exports[0])).subarray(0, 2).toString('latin1'), 'PK');
    assert.equal(await page.evaluate(() => window.dk.openDebugFolder()), true);

    // Desligar remove o indicador e para a gravação.
    await page.getByRole('checkbox', { name: 'Modo debug', exact: true }).uncheck();
    await page.locator('#debug-indicator').waitFor({ state: 'detached' });
    const size = readLogs().length;
    await page.evaluate(() => console.error('não deve ser gravado'));
    await delay(400);
    assert.equal(readLogs().length, size);
    await app.close(); app = null;

    // --sea-dock-debug liga o modo sem alterar a preferência salva.
    app = await launch(['--sea-dock-debug']);
    page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await page.locator('#debug-indicator').waitFor();
    await page.locator('#profile-show').click();
    const forced = page.getByRole('checkbox', { name: 'Modo debug', exact: true });
    await forced.waitFor();
    assert.equal(await forced.isChecked(), true); assert.equal(await forced.isDisabled(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'debug.json'), 'utf8')), { enabled: false });
    assert.match(readLogs(), /SEA Dock iniciado com modo debug pela linha de comando/);
    console.log('✓ Modo debug liga nas configurações e por --sea-dock-debug, grava erros e ciclo de vida redigidos, exporta zip e desliga');
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
