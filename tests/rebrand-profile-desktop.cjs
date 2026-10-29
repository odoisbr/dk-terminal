const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The test uses the real application entry point inside a disposable Electron
// wrapper. It never changes HOME or selects an actual user profile.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-rebrand-profile-')));
const appData = path.join(temp, 'appData');
const oldProfile = path.join(appData, 'DK Terminal');
const overrideProfile = path.join(temp, 'explicit-profile');
const project = path.join(temp, 'Projeto preservado');
const wrapper = path.join(temp, 'fixture-app');
const bin = path.join(temp, 'bin');
const diagnostic = path.join(temp, 'wrapper-error.json');
for (const dir of [appData, oldProfile, overrideProfile, project, wrapper, bin]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(wrapper, 'package.json'), JSON.stringify({ name: 'sea-dock-profile-fixture', productName: 'SEA Dock', version: require('../package.json').version, main: 'main.cjs' }));
fs.writeFileSync(path.join(wrapper, 'main.cjs'), `
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const fixtureRoot = ${JSON.stringify(temp)};
const isolatedAppData = ${JSON.stringify(appData)};
const errorFile = ${JSON.stringify(diagnostic)};
const originalGetPath = app.getPath.bind(app);
const withinFixture = value => { const relative = path.relative(fixtureRoot, value); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
try {
  app.setPath('appData', isolatedAppData);
  app.getAppPath = () => ${JSON.stringify(root)};
  const productNameBeforeEntry = app.getName();
  if (productNameBeforeEntry !== 'SEA Dock') throw new Error('A fixture não representa o produto SEA Dock: ' + productNameBeforeEntry);
  // Fail closed if the application asks Electron for a personal data path. Do
  // not set userData or sessionData here: the real entry point decides them.
  app.getPath = name => {
    const value = originalGetPath(name);
    if ((name === 'userData' || name === 'sessionData') && !withinFixture(value)) throw new Error('Electron não redirecionou ' + name + ' para a fixture: ' + value);
    return value;
  };
  require(${JSON.stringify(path.join(root, 'electron', 'main.cjs'))});
  // Check sessionData only after the real entry has run, but before ready and
  // before Chromium opens a session; reading it earlier can cache a default.
  global.__rebrandFixture = { productNameBeforeEntry, appData: app.getPath('appData'), userData: app.getPath('userData'), sessionData: app.getPath('sessionData') };
} catch (error) {
  fs.writeFileSync(errorFile, JSON.stringify({ message: error.message }, null, 2));
  console.error('Fixture de perfil bloqueada:', error.message);
  app.exit(91);
}
`);

const shell = path.join(temp, process.platform === 'win32' ? 'shell-fixture.exe' : 'shell-fixture');
if (process.platform === 'win32') fs.copyFileSync(process.execPath, shell);
else fs.writeFileSync(shell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });
const environment = { ...process.env, PATH: bin, DK_TERMINAL_TEST: '1', DK_ROOT: path.join(temp, 'no-kit'), ...(process.platform === 'win32' ? { ComSpec: shell } : { SHELL: shell }) };
delete environment.DK_TERMINAL_DATA_DIR;
delete environment.DK_TERMINAL_TEST_DATA;
delete environment.DK_TERMINAL_TEST_PROJECT;
delete environment.ELECTRON_RUN_AS_NODE;
let app, page, openedProject = false;

async function launch(overriddenDirectory) {
  if (fs.existsSync(diagnostic)) fs.unlinkSync(diagnostic);
  const env = { ...environment };
  if (overriddenDirectory) env.DK_TERMINAL_DATA_DIR = overriddenDirectory;
  try {
    // Intentionally run the source entry in the wrapper even if a packaged
    // executable is provided; an installed package requires separate testing.
    app = await electron.launch({ args: [wrapper], env, timeout: 30000 });
    page = await app.firstWindow({ timeout: 30000 });
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
  } catch (error) {
    if (fs.existsSync(diagnostic)) console.error(`A fixture não acessou perfil pessoal: ${fs.readFileSync(diagnostic, 'utf8')}`);
    throw error;
  }
  return page;
}
async function launchPrevious() {
  const executable = process.env.DK_REBRAND_PREVIOUS_EXECUTABLE;
  if (!executable) {
    await launch(oldProfile);
    await expectPaths(oldProfile);
    return;
  }
  // Chromium também recebe o caminho temporário antes do boot da versão antiga.
  // A versão anterior executa com seu próprio main, sem o wrapper de produto novo.
  const env = { ...environment, DK_TERMINAL_DATA_DIR: oldProfile };
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${oldProfile}`], env, timeout: 30000 });
  page = await app.firstWindow({ timeout: 30000 });
  await page.locator('#startup-loading').waitFor({ state: 'detached' });
  const previous = await app.evaluate(({ app }) => ({ name: app.getName(), userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }));
  assert.equal(previous.name, 'DK Terminal', 'A cópia fornecida deve ser a versão anterior do aplicativo.');
  assert.equal(previous.userData, oldProfile);
  assert.equal(previous.sessionData, oldProfile);
  console.log('Perfil semeado pela versão anterior empacotada.');
}
async function paths() {
  return app.evaluate(({ app }) => ({ name: app.getName(), appData: app.getPath('appData'), userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), fixture: global.__rebrandFixture }));
}
async function expectPaths(expected) {
  const current = await paths();
  assert.equal(current.name, 'SEA Dock');
  assert.equal(current.fixture.productNameBeforeEntry, 'SEA Dock');
  assert.equal(current.appData, appData);
  assert.equal(current.userData, expected, 'userData deve apontar para o perfil escolhido.');
  assert.equal(current.sessionData, expected, 'sessionData precisa acompanhar o perfil para preservar localStorage.');
}
async function close() {
  if (!app) return;
  if (openedProject && page) {
    try { await page.evaluate(directory => window.dk.closeProjectSessions(directory), project); } catch {}
  }
  await app.close(); app = null; page = null; openedProject = false;
}

(async () => {
  try {
    // Cria dados reais no caminho da versão anterior usando a opção existente
    // de perfil explícito; a segunda execução não usa essa opção.
    await launchPrevious();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    await page.locator('#launcher-open-local').click();
    openedProject = true;
    if (process.env.DK_REBRAND_PREVIOUS_EXECUTABLE) await page.locator('.terminal-pane[data-ready=true]').waitFor();
    else await startProjectTerminal(page);
    const theme = page.getByRole('button', { name: 'Tema SEA', exact: true });
    if (await theme.getAttribute('aria-pressed') !== 'true') await theme.click();
    assert.equal(await theme.getAttribute('aria-pressed'), 'true');
    await page.locator('#profile-show').click();
    await page.getByLabel('Tamanho da fonte').selectOption('16');
    await page.getByLabel('Linhas de histórico').selectOption('20000');
    const seeded = await page.evaluate(() => {
      localStorage.setItem('sea-rebrand-fixture', 'valor preservado');
      return { origin: location.origin, protocol: location.protocol, theme: localStorage.getItem('seaTheme'), preferences: JSON.parse(localStorage.getItem('terminalPreferences')) };
    });
    assert.equal(seeded.protocol, 'dk-app:');
    assert.equal(seeded.theme, 'true');
    assert.equal(seeded.preferences.fontSize, 16);
    assert.equal(seeded.preferences.scrollback, 20000);
    const settingsFile = path.join(oldProfile, 'settings.json');
    assert.ok(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).projects.includes(project));
    await close();

    // Sem override: exercita a escolha real de perfil no main do SEA Dock.
    await launch();
    await expectPaths(oldProfile);
    const restored = await page.evaluate(() => ({ origin: location.origin, protocol: location.protocol, theme: localStorage.getItem('seaTheme'), preferences: JSON.parse(localStorage.getItem('terminalPreferences')), sentinel: localStorage.getItem('sea-rebrand-fixture') }));
    assert.equal(restored.origin, seeded.origin, 'A origem do armazenamento deve permanecer igual.');
    assert.equal(restored.protocol, 'dk-app:');
    assert.equal(restored.theme, seeded.theme);
    assert.equal(restored.preferences.fontSize, 16);
    assert.equal(restored.preferences.scrollback, 20000);
    assert.equal(restored.sentinel, 'valor preservado');
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('theme-sea')), true);
    await page.locator('#launcher-recents .launcher-recent').filter({ hasText: 'Projeto preservado' }).waitFor();
    assert.ok(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).projects.includes(project));
    assert.equal(fs.existsSync(path.join(appData, 'SEA Dock', 'settings.json')), false, 'A nova marca não deve iniciar um perfil paralelo.');

    // A escolha alternativa também deve sobreviver a um reinício completo.
    await page.locator('#launcher [data-route="settings"]').click();
    await page.getByRole('checkbox', { name: 'Tema SEA', exact: true }).uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem('seaTheme')), 'false');
    await close();

    await launch();
    await expectPaths(oldProfile);
    assert.equal(await page.evaluate(() => localStorage.getItem('seaTheme')), 'false');
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('theme-sea')), false);
    assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => localStorage.getItem('sea-rebrand-fixture')), 'valor preservado');
    await page.locator('#launcher [data-route="settings"]').click();
    assert.equal(await page.getByRole('checkbox', { name: 'Tema SEA', exact: true }).isChecked(), false);
    await close();

    // A preferência explícita ainda isola dados e não altera o perfil legado.
    const oldSettings = fs.readFileSync(settingsFile, 'utf8');
    await launch(overrideProfile);
    await expectPaths(overrideProfile);
    assert.equal(await page.evaluate(() => localStorage.getItem('sea-rebrand-fixture')), null);
    assert.equal(await page.locator('#launcher-recents .launcher-recent').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('seaTheme')), 'true', 'Um perfil novo deve iniciar com o tema SEA.');
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('theme-sea')), true);
    await close();
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), oldSettings);
    console.log('✓ SEA Dock preserva o perfil e a origem legados e respeita perfil explícito isolado');
  } finally {
    await close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
