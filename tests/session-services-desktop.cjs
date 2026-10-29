const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-detected-')));
const project = path.join(temporary, 'projeto'); fs.mkdirSync(project);
const server = path.join(temporary, 'servidor.cjs');
fs.writeFileSync(server, "require('http').createServer((q,s)=>s.end('<!doctype html><title>detectado</title><h1 id=\"ok\">servidor-detectado</h1>')).listen(0,'127.0.0.1',function(){console.log('PORTA='+this.address().port)});\n");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 15000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw new Error(description); await delay(100); } }
let app;
(async () => {
  try {
    app = await electron.launch({ args: [root], env: { ...process.env, SHELL: '/bin/sh', DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_DATA_DIR: path.join(temporary, 'perfil') }, timeout: 60000 });
    const page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await page.locator('#launcher-recents .launcher-recent').first().click();
    await startProjectTerminal(page);
    const terminalId = (await page.locator('.tab-select[aria-selected=true]').getAttribute('id')).slice(4);

    // Guia aberta antes do servidor existir: lista vazia e botão Atualizar disponível.
    await page.locator('#tab-services').click();
    const refresh = page.getByRole('button', { name: 'Atualizar', exact: true });
    await refresh.waitFor();
    assert.ok((await refresh.boundingBox()).height >= 44, 'Atualizar precisa de alvo de 44 px.');
    await until(async () => /Nenhum servidor escutando/.test(await page.locator('#detected-status').innerText()), 'A guia não informou ausência de servidores.');

    await page.evaluate(id => { window.__detectedOutput = ''; window.dk.onTerminalData(event => { if (event.id === id) window.__detectedOutput += event.data; }); }, terminalId);
    await page.evaluate(({ id, command }) => window.dk.writeTerminal(id, command), { id: terminalId, command: `'${process.execPath}' '${server}'\r` });
    await page.waitForFunction(() => /PORTA=\d+/.test(window.__detectedOutput));
    const port = Number((await page.evaluate(() => window.__detectedOutput)).match(/PORTA=(\d+)/)[1]);
    const url = `http://127.0.0.1:${port}`;

    await refresh.click();
    const row = page.locator('.detected-row').filter({ hasText: `porta ${port}` });
    await row.waitFor({ timeout: 4000 });
    if (process.env.DK_DETECTED_SCREENSHOT) await page.screenshot({ path: process.env.DK_DETECTED_SCREENSHOT });
    assert.match(await row.innerText(), new RegExp(`PID \\d+ · porta ${port}`));
    assert.match(await row.locator('strong').innerText(), /servidor\.cjs/);
    assert.equal(await row.locator('.service-address').innerText(), url);
    assert.equal(await page.locator('#detected-count').innerText(), '1');
    const pid = Number(await row.getAttribute('data-detected-pid'));
    assert.ok(pid > 1);

    // Abrir na prévia reaproveita a guia de navegador do projeto.
    await row.getByRole('button', { name: /Abrir na prévia/ }).click();
    await page.locator('#browser-view').waitFor({ state: 'visible' });
    await until(async () => await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(item => item.webContents && item.getVisible());
      return !!view && await view.webContents.executeJavaScript('document.querySelector("#ok")?.textContent === "servidor-detectado"');
    }), 'A prévia não abriu o servidor detectado.');
    assert.equal(await page.locator('#browser-address').inputValue(), `${url}/`);

    // Encerrar pede confirmação; cancelar mantém o processo.
    await app.evaluate(({ dialog }) => { global.__detectedDialogs = []; dialog.showMessageBox = async (...args) => { global.__detectedDialogs.push(args.at(-1)); return { response: 0 }; }; });
    await row.getByRole('button', { name: /Encerrar processo/ }).click();
    await until(async () => (await app.evaluate(() => global.__detectedDialogs.length)) === 1, 'A confirmação não apareceu.');
    const prompt = await app.evaluate(() => global.__detectedDialogs[0]);
    assert.match(prompt.message, /Encerrar processo/); assert.match(prompt.detail, new RegExp(`PID: ${pid}`)); assert.match(prompt.detail, new RegExp(`Porta: ${port}`));
    await delay(300);
    assert.equal((await fetch(url)).status, 200);

    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.locator(`.detected-row[data-detected-pid="${pid}"]`).getByRole('button', { name: /Encerrar processo/ }).click();
    await until(async () => { try { await fetch(url); return false; } catch { return true; } }, 'O servidor detectado não foi encerrado.');
    await until(async () => await page.locator(`.detected-row[data-detected-pid="${pid}"]`).count() === 0, 'O servidor encerrado continuou na lista.');

    // O shell da sessão continua vivo: só o grupo do servidor recebeu o sinal.
    await page.evaluate(({ id }) => window.dk.writeTerminal(id, 'printf "\\nSESSAO_VIVA\\n"\r'), { id: terminalId });
    await page.waitForFunction(() => window.__detectedOutput.includes('SESSAO_VIVA\r\n'));
    assert.equal((await page.evaluate(dir => window.dk.detectSessionServices(dir), project)).items.length, 0);
    console.log('✓ Servidor iniciado no terminal aparece após Atualizar, abre na prévia e encerra só o grupo dele com confirmação');
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
