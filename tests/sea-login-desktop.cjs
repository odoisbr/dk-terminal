const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-sea-login-')));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const marker = path.join(tmp, 'logged-in');
const sea = path.join(bin, 'sea');
const shell = path.join(bin, 'shell');
fs.writeFileSync(sea, `#!/bin/sh\nif [ "$1" = version ]; then echo 1.2.3; exit 0; fi\nif [ "$1" = auth ] && [ "$2" = me ]; then if [ -f "$FAKE_SEA_MARKER" ]; then printf '{"data":{"name":"Pessoa de teste"}}'; exit 0; else exit 1; fi; fi\nif [ "$1" = auth ] && [ "$2" = login ]; then printf 'Token: '; stty -echo; read -r token; stty echo; printf '\\nLogin concluído\\n'; touch "$FAKE_SEA_MARKER"; exit 0; fi\nexit 1\n`, { mode: 0o755 });
fs.writeFileSync(shell, `#!/bin/sh\nprintf '\\000%s\\000' '${bin}:/usr/bin:/bin:/usr/sbin:/sbin'\n`, { mode: 0o755 });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

let app;
(async () => {
  try {
    app = await electron.launch({
      executablePath: process.env.DK_TERMINAL_EXECUTABLE || undefined,
      args: process.env.DK_TERMINAL_EXECUTABLE ? [] : [root],
      env: { ...process.env, SHELL: shell, FAKE_SEA_MARKER: marker, DK_TERMINAL_DATA_DIR: path.join(tmp, 'profile') },
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Perfil e configurações', exact: true }).last().click();
    const row = page.locator('.account-row').filter({ hasText: 'Conta SEA' });
    const home = page.locator('#launcher [data-route="home"]');
    const settings = page.locator('#launcher [data-route="settings"]');
    const terminal = page.locator('#account-terminal');
    const dialog = page.locator('#account-dialog');
    const startLogin = async () => {
      await row.getByRole('button', { name: 'Entrar' }).click();
      await page.getByText('Siga as instruções da ferramenta.').waitFor();
      await page.waitForFunction(() => document.querySelector('#account-terminal')?.textContent.includes('Token:'), null, { timeout: 10000 });
    };
    const submitLogin = async () => {
      await terminal.locator('.xterm-helper-textarea').fill('dummy-pass');
      await terminal.locator('.xterm-helper-textarea').press('Enter');
      await page.getByText('Autenticação concluída. Feche esta janela para atualizar o perfil.').waitFor({ timeout: 10000 });
      assert.equal((await terminal.innerText()).includes('dummy-pass'), false);
    };

    await startLogin();
    await submitLogin();
    await page.getByRole('button', { name: 'Fechar autenticação' }).click();
    await page.getByText('Pessoa de teste').waitFor({ timeout: 10000 });
    console.log('✓ Login usa a CLI em terminal protegido e atualiza o perfil, sem exibir a credencial');

    // Atrasa apenas uma chamada de fechamento por vez nesta instância do teste.
    // Os canais reais continuam responsáveis por iniciar e encerrar o processo.
    await app.evaluate(({ ipcMain }) => {
      const close = ipcMain._invokeHandlers?.get('terminal:close');
      const start = ipcMain._invokeHandlers?.get('account:start');
      if (typeof close !== 'function' || typeof start !== 'function') throw new Error('Não foi possível instrumentar os canais de login da fixture.');
      const state = global.__seaLoginFixture = { close, start, hold: false, resume: null, finished: 0, started: 0 };
      ipcMain.removeHandler('terminal:close');
      ipcMain.handle('terminal:close', async (...args) => {
        const held = state.hold;
        if (held) {
          state.hold = false;
          await new Promise(resolve => { state.resume = resolve; });
        }
        try { return await close(...args); }
        finally { if (held) state.finished++; }
      });
      ipcMain.removeHandler('account:start');
      ipcMain.handle('account:start', (...args) => { state.started++; return start(...args); });
    });
    const holdClose = () => app.evaluate(() => { global.__seaLoginFixture.hold = true; });
    const waitForHeldClose = () => until(() => app.evaluate(() => typeof global.__seaLoginFixture.resume === 'function'), 'O encerramento da fixture não ficou pendente.');
    const releaseClose = () => app.evaluate(() => {
      const state = global.__seaLoginFixture;
      if (typeof state.resume !== 'function') throw new Error('Não há encerramento pendente.');
      const resume = state.resume;
      state.resume = null;
      resume();
    });
    const waitForClose = count => until(() => app.evaluate((_, expected) => global.__seaLoginFixture.finished >= expected, count), 'O encerramento da fixture não terminou.');

    // Fechar o login e mudar de rota não pode reconstruir as configurações.
    await startLogin();
    await holdClose();
    await page.getByRole('button', { name: 'Fechar autenticação' }).click();
    await waitForHeldClose();
    await home.click();
    await releaseClose();
    await waitForClose(1);
    await terminal.locator('.xterm').waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await home.getAttribute('aria-current'), 'page');
    assert.equal(await page.getByTestId('settings-plugins').count(), 0);
    console.log('✓ Conclusão tardia do login preserva a rota escolhida');

    // Um novo pedido de login pode aguardar o encerramento anterior. Se a
    // pessoa navegar durante essa espera, a continuação não deve abrir diálogo.
    await settings.click();
    await startLogin();
    await holdClose();
    const startsBeforeStaleRequest = await app.evaluate(() => global.__seaLoginFixture.started);
    await row.getByRole('button', { name: 'Entrar' }).evaluate(button => button.click());
    await waitForHeldClose();
    await home.click();
    await releaseClose();
    await waitForClose(2);
    await terminal.locator('.xterm').waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await home.getAttribute('aria-current'), 'page');
    assert.equal(await app.evaluate(() => global.__seaLoginFixture.started), startsBeforeStaleRequest);
    console.log('✓ Pedido de login atrasado não reabre o diálogo depois da navegação');

    // Um fechamento anterior não pode remover o terminal do login mais novo.
    await settings.click();
    await startLogin();
    await holdClose();
    await page.getByRole('button', { name: 'Fechar autenticação' }).click();
    await waitForHeldClose();
    await startLogin();
    await releaseClose();
    await waitForClose(3);
    await page.waitForTimeout(200);
    assert.equal(await terminal.locator('.xterm').count(), 1);
    await submitLogin();
    await page.getByRole('button', { name: 'Fechar autenticação' }).click();
    await page.getByText('Pessoa de teste').waitFor({ timeout: 10000 });
    console.log('✓ A limpeza atrasada preserva o novo terminal de autenticação');
  } finally {
    if (app) {
      await app.evaluate(({ ipcMain }) => {
        const state = global.__seaLoginFixture;
        if (!state) return;
        state.hold = false;
        if (typeof state.resume === 'function') state.resume();
        state.resume = null;
        ipcMain.removeHandler('terminal:close');
        ipcMain.handle('terminal:close', state.close);
        ipcMain.removeHandler('account:start');
        ipcMain.handle('account:start', state.start);
        delete global.__seaLoginFixture;
      }).catch(() => {});
      await app.close();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
