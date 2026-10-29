const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Um `claude` falso no PATH responde ao que o SEA Dock consulta e registra o que ele executa.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-plugin-status-')));
const bin = path.join(temp, 'bin'), state = path.join(temp, 'state'), market = path.join(temp, 'market'), project = path.join(temp, 'Projeto');
for (const folder of [bin, state, path.join(market, '.claude-plugin'), project]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(project, 'projeto.yml'), 'projeto: Projeto Plugin\n');
const kitAt = version => { const kit = path.join(temp, 'cache', 'dk', 'dk', version); fs.mkdirSync(path.join(kit, 'cli'), { recursive: true }); fs.writeFileSync(path.join(kit, 'cli', 'dk'), ''); return kit; };
const entry = version => [{ id: 'dk@dk', version, scope: 'user', enabled: true, installPath: kitAt(version) }];
fs.writeFileSync(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'dk', plugins: [{ name: 'dk', version: '1.7.0' }] }));
fs.writeFileSync(path.join(state, 'markets.json'), JSON.stringify([{ name: 'dk', source: 'git', installLocation: market }]));
fs.writeFileSync(path.join(state, 'list.json'), '[]');
fs.writeFileSync(path.join(state, 'after-install.json'), JSON.stringify(entry('1.6.0')));
fs.writeFileSync(path.join(state, 'after-update.json'), JSON.stringify(entry('1.7.0')));
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
S=${JSON.stringify(state)}
echo "$@" >> "$S/calls.log"
case "$1 $2" in
  "plugin list") /bin/cat "$S/list.json" ;;
  "plugin marketplace") /bin/cat "$S/markets.json" ;;
  "plugin install") /bin/cp "$S/after-install.json" "$S/list.json" ;;
  "plugin update") /bin/sleep 1; /bin/cp "$S/after-update.json" "$S/list.json" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
const fixtureShell = path.join(temp, 'shell');
fs.writeFileSync(fixtureShell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });

const text = (page, id) => page.locator(`#${id}`).innerText();
async function expectText(page, id, pattern) {
  await page.waitForFunction(({ id, source }) => new RegExp(source).test(document.getElementById(id)?.textContent || ''), { id, source: pattern.source }, { timeout: 15000 });
}

let app;
(async () => {
  if (process.platform === 'win32') { console.log('Ignorado no Windows: o claude falso é um script sh.'); return; }
  try {
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    const env = { ...process.env, PATH: bin, SHELL: fixtureShell, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile') };
    delete env.DK_ROOT;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env });
    const page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    const control = page.locator('#install-dk-plugin');

    // Não instalado.
    await expectText(page, 'kit-label', /Plugin DK não instalado/);
    assert.equal(await control.isVisible(), true);
    assert.equal(await control.innerText(), 'Instalar plugin DK no Claude');
    console.log('✓ Plugin ausente orienta a instalar');

    // Instalado, mas desatualizado em relação ao catálogo do marketplace.
    await control.click();
    await expectText(page, 'kit-description', /Atualização disponível · v1\.6\.0 → v1\.7\.0/);
    assert.equal(await text(page, 'kit-label'), 'Plugin DK conectado');
    assert.equal(await control.innerText(), 'Atualizar plugin DK');
    assert.ok(!(await text(page, 'kit-description')).includes(temp), 'A descrição não deve mostrar caminhos.');
    console.log('✓ Plugin desatualizado mostra versões e oferece atualização');

    // Atualizar: carregamento, comando do Claude e resultado.
    await control.click();
    await page.waitForFunction(() => { const el = document.getElementById('install-dk-plugin'); return el?.disabled && el.getAttribute('aria-busy') === 'true' && /Atualizando/.test(el.textContent || ''); }, null, { timeout: 2000 });
    await expectText(page, 'kit-description', /^v1\.7\.0 · versão mais recente$/);
    assert.equal(await control.isVisible(), false);
    await expectText(page, 'toast', /Plugin DK atualizado para v1\.7\.0/);
    const description = page.locator('#kit-description');
    assert.ok(!(await description.innerText()).includes(temp), 'A descrição não deve mostrar caminhos.');
    assert.match(await description.getAttribute('title'), /cache\/dk\/dk\/1\.7\.0/);
    const calls = fs.readFileSync(path.join(state, 'calls.log'), 'utf8').split('\n');
    assert.ok(calls.includes('plugin update dk@dk --scope user'), `Comando de atualização inesperado: ${calls.join(' | ')}`);
    assert.ok(!calls.some(line => / (-y|--yes)\b/.test(line)), 'O SEA Dock não deve aceitar comandos do marketplace sozinho.');
    console.log('✓ Atualização roda pelo Claude, mostra carregamento e confirma a versão conectada');

    // Abrir projeto leva ao Início, onde a pessoa escolhe pasta, recentes ou GitLab.
    if (await page.locator('#launcher').isVisible()) await page.locator('#launcher-recents .launcher-recent').first().click();
    await page.locator('#launcher').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#open-project kbd').count(), 0);
    await page.locator('#open-project').click();
    await page.locator('#launcher').waitFor();
    await page.locator('#launcher-open-local').waitFor();
    assert.equal(await page.locator('#launcher-title').innerText(), 'Seu espaço de trabalho');
    console.log('✓ Abrir projeto leva ao Início');
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
