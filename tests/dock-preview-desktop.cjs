const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { PREVIEW_INSTRUCTIONS } = require('../electron/preview-instructions.cjs');

// A partir de um terminal real do app, `dock-preview` abre um HTML do projeto e um
// endereço local na guia de navegador, e recusa arquivo fora do projeto.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-dock-preview-')));
const project = path.join(temp, 'Projeto com espaços');
fs.mkdirSync(path.join(project, 'prototipo'), { recursive: true }); fs.mkdirSync(path.join(temp, 'config'));
fs.writeFileSync(path.join(project, 'prototipo', 'index.html'), '<!doctype html><title>Protótipo</title><link rel="stylesheet" href="estilo.css"><body>PROTOTIPO_ARQUIVO_OK</body>');
fs.writeFileSync(path.join(project, 'prototipo', 'estilo.css'), 'body{color:rgb(1, 2, 3)}');
fs.writeFileSync(path.join(temp, 'fora.html'), 'FORA');
const server = http.createServer((_req, res) => res.end('<html><title>Servidor local</title><body>SERVIDOR_LOCAL_OK</body></html>'));
let app;
const views = () => app.evaluate(async ({ BrowserWindow }) => Promise.all(BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v.webContents).map(async v => ({ url: v.webContents.getURL(), visible: v.getVisible(), body: await v.webContents.executeJavaScript('document.body ? document.body.textContent + "|" + getComputedStyle(document.body).color : ""').catch(() => '') }))));
async function until(fn, description, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!await fn()) { if (Date.now() > end) throw new Error(description); await new Promise(r => setTimeout(r, 100)); }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  app = await electron.launch({ args: [root], env: { ...process.env, DK_TERMINAL_TEST: '1', DK_TERMINAL_DATA_DIR: path.join(temp, 'config'), DK_TERMINAL_TEST_PROJECT: project }, timeout: 60000 });
  const page = await app.firstWindow(); await page.locator('#startup-loading').waitFor({ state: 'detached' });
  await page.locator('#launcher-recents .launcher-recent').first().click();
  await page.waitForFunction(dir => document.querySelector('#breadcrumb-project')?.dataset.projectPath === dir, project);

  // Botão da guia Serviços copia a instrução canônica.
  await page.locator('#tab-services').click();
  await page.locator('#preview-ai-copy').click();
  await until(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) === PREVIEW_INSTRUCTIONS, 'A instrução para IA não foi copiada.');
  assert.ok((await page.locator('#preview-ai-copy').boundingBox()).height >= 44);
  await page.locator('#tab-services').click();

  await page.locator('#new-session').click();
  await page.locator('.terminal-pane[data-ready="true"]').waitFor();
  await page.evaluate(() => { window.__output = ''; window.dk.onTerminalData(e => { window.__output += e.data; }); });
  const id = (await page.locator('.tab-select[aria-selected="true"]').getAttribute('id')).slice(4);
  const type = command => page.evaluate(({ id, command }) => window.dk.writeTerminal(id, command + '\r'), { id, command });

  await type('dock-preview ../fora.html; echo "saida=$?"');
  await page.waitForFunction(() => /ERRO: .*fica fora do projeto desta sessão/.test(window.__output) && /saida=1/.test(window.__output), null, { timeout: 20000 });
  await type('dock-preview https://example.com/; echo "saida=$?"');
  await page.waitForFunction(() => /ERRO: o navegador do SEA Dock só abre endereços locais/.test(window.__output) && /saida=2/.test(window.__output), null, { timeout: 20000 });

  await type('dock-preview prototipo/index.html --titulo "Tela inicial"');
  await page.waitForFunction(() => /OK: prévia aberta no navegador do SEA Dock \(Tela inicial\): prototipo\/index\.html/.test(window.__output), null, { timeout: 20000 });
  await page.locator('#browser-view').waitFor({ state: 'visible' });
  assert.match(await page.locator('#browser-address').inputValue(), /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/prototipo\/index\.html$/);
  await until(async () => (await views()).some(v => v.visible && v.body.includes('PROTOTIPO_ARQUIVO_OK|rgb(1, 2, 3)')), 'O HTML do projeto não abriu com seu CSS no navegador do app.');
  await until(async () => (await page.locator('#browser-status').textContent()).startsWith('Tela inicial · '), 'O título não apareceu na barra do navegador.');
  await page.locator('#browser-copy-ai').waitFor({ state: 'visible' });

  await page.locator('#browser-back').click();
  await type(`dock-preview http://127.0.0.1:${port}/`);
  await page.waitForFunction(port => window.__output.includes(`OK: prévia aberta no navegador do SEA Dock: http://127.0.0.1:${port}/`), port, { timeout: 20000 });
  await page.locator('#browser-view').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#browser-address').inputValue(), `http://127.0.0.1:${port}/`);
  await until(async () => (await views()).some(v => v.visible && v.url === `http://127.0.0.1:${port}/` && v.body.includes('SERVIDOR_LOCAL_OK')), 'O endereço local não abriu no navegador do app.');
  console.log('OK: dock-preview abriu arquivo do projeto e endereço local a partir do terminal do app, recusou alvo externo e copiou a instrução para IA');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (app) await app.close().catch(() => {}); server.close(); fs.rmSync(temp, { recursive: true, force: true }); });
