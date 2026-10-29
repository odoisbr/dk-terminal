const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// This test requires a packaged macOS app. Everything it can write or launch
// belongs to a disposable copy with its own bundle identifier and profile.
const executable = process.env.DK_TERMINAL_EXECUTABLE;
if (process.platform !== 'darwin' || !executable) {
  console.log('⏭ Comando dock no macOS não verificado: informe DK_TERMINAL_EXECUTABLE com o aplicativo empacotado.');
  process.exit(0);
}

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-dock-command-')));
const home = path.join(temp, 'home fixture'), profile = path.join(temp, 'profile fixture');
const project = path.join(temp, "Projeto O'Connor $ teste"), extraction = path.join(temp, 'asar-contents');
const bin = path.join(home, '.local', 'bin'), installed = path.join(bin, 'dock');
const copy = path.join(temp, "SEA Dock 'fixture $ teste.app");
const bundleId = 'br.com.sea.dock.test' + randomUUID().replaceAll('-', '');
for (const directory of [home, profile, project]) fs.mkdirSync(directory);
fs.writeFileSync(path.join(project, 'nota.txt'), 'Projeto isolado da fixture.\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(60);
  }
}

async function prepareCopy() {
  const sourceExecutable = fs.realpathSync(executable);
  const macOS = path.dirname(sourceExecutable), contents = path.dirname(macOS), source = path.dirname(contents);
  assert.equal(path.basename(macOS), 'MacOS', 'Informe o executável dentro de Contents/MacOS.');
  assert.equal(path.basename(contents), 'Contents');
  assert.ok(source.toLowerCase().endsWith('.app'), 'O teste exige um .app empacotado.');
  execFileSync('/usr/bin/ditto', [source, copy], { timeout: 120000, stdio: 'pipe' });

  const info = path.join(copy, 'Contents', 'Info.plist');
  const archive = path.join(copy, 'Contents', 'Resources', 'app.asar');
  assert.ok(fs.existsSync(archive), 'O app de teste precisa conter Resources/app.asar.');
  const asar = await import('@electron/asar');
  asar.extractAll(archive, extraction);
  const main = path.join(extraction, 'electron', 'main.cjs');
  assert.ok(fs.existsSync(path.join(extraction, 'electron', 'dock-cli.cjs')), 'Empacote novamente o app com o módulo do comando dock.');
  // Launch Services may launch a new process without the environment passed to
  // Playwright. Force even that process to use this fixture's profile *before*
  // the real application entry runs. Never alter the original bundle.
  fs.writeFileSync(main, `process.env.DK_TERMINAL_DATA_DIR = ${JSON.stringify(profile)};\n` + fs.readFileSync(main, 'utf8'));

  const rebuilt = path.join(copy, 'Contents', 'Resources', 'fixture.asar');
  await asar.createPackageWithOptions(extraction, rebuilt, { unpackDir: 'node_modules/node-pty' });
  fs.rmSync(archive + '.unpacked', { recursive: true, force: true });
  if (fs.existsSync(rebuilt + '.unpacked')) fs.renameSync(rebuilt + '.unpacked', archive + '.unpacked');
  fs.renameSync(rebuilt, archive);
  const digest = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId, info], { stdio: 'pipe' });
  // Packager sets this header digest when the Electron integrity fuse is used.
  // Update it after adding the fixture-only profile bootstrap.
  const plistBuddy = '/usr/libexec/PlistBuddy';
  try { execFileSync(plistBuddy, ['-c', 'Print :ElectronAsarIntegrity:Resources/app.asar:hash', info], { stdio: 'pipe' }); }
  catch { throw new Error('O pacote não possui o campo de integridade ASAR esperado; não foi possível preparar uma cópia segura.'); }
  execFileSync(plistBuddy, ['-c', `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${digest}`, info], { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', copy], { timeout: 120000, stdio: 'pipe' });
  return path.join(copy, path.relative(source, sourceExecutable));
}

function runDock() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: bin, DK_TERMINAL_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn('dock', ['.'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`O comando dock não terminou: ${stderr}`)); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`dock encerrou com ${code}: ${stderr}`)); });
  });
}

let app;
(async () => {
  try {
    const executablePath = await prepareCopy();
    const env = { ...process.env, DK_TERMINAL_DATA_DIR: profile, DK_ROOT: path.join(temp, 'sem-kit'), PATH: '/usr/bin:/bin' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath, args: [], env, timeout: 60000 });
    const page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await app.evaluate(({ app, dialog, ipcMain }, paths) => {
      const path = process.getBuiltinModule('node:path'), fs = process.getBuiltinModule('node:fs');
      const main = path.join(app.getAppPath(), 'electron', 'main.cjs');
      const module = process.getBuiltinModule('node:module').createRequire(main)('./dock-cli.cjs');
      const originalInstall = module.install, originalUninstall = module.uninstall;
      const relative = path.relative(paths.bundle, fs.realpathSync(process.execPath));
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('A fixture não está executando a cópia temporária.');
      global.__dockFixture = { dialogs: [], errors: [], create: 0, start: 0 };
      module.install = options => originalInstall({ ...options, home: paths.home, envPath: paths.bin, temporaryRoots: [] });
      module.uninstall = options => originalUninstall({ ...options, home: paths.home });
      dialog.showMessageBox = async (...args) => {
        const options = args.length > 1 ? args[1] : args[0];
        global.__dockFixture.dialogs.push({ message: options.message, detail: options.detail });
        return { response: 0, checkboxChecked: false };
      };
      dialog.showErrorBox = (title, message) => global.__dockFixture.errors.push({ title, message });
      for (const [channel, key] of [['terminal:create', 'create'], ['terminal:start', 'start']]) {
        const original = ipcMain._invokeHandlers?.get(channel);
        if (typeof original !== 'function') throw new Error(`Handler ausente: ${channel}`);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => { global.__dockFixture[key]++; return original(...args); });
      }
    }, { bundle: copy, home, bin });
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);

    const menu = async label => app.evaluate(({ Menu, BrowserWindow }, name) => {
      const root = Menu.getApplicationMenu().items.find(item => item.label === 'SEA Dock');
      const item = root?.submenu?.items.find(candidate => candidate.label === name);
      if (!item?.enabled) throw new Error(`Ação do menu indisponível: ${name}`);
      item.click(item, BrowserWindow.getAllWindows()[0], {});
    }, label);
    const expectDialog = async message => until(async () => {
      const state = await app.evaluate(() => global.__dockFixture);
      if (state.errors.length) throw new Error(`Comando dock: ${JSON.stringify(state.errors)}`);
      return state.dialogs.some(item => item.message === message);
    }, `Não apareceu o resultado: ${message}`);

    await menu('Instalar comando dock no terminal');
    await expectDialog('Comando dock instalado.');
    assert.equal(fs.statSync(installed).mode & 0o777, 0o700);
    const script = fs.readFileSync(installed, 'utf8');
    const metadata = JSON.parse(Buffer.from(script.split('\n')[1].slice('# SEA Dock command v1 '.length), 'base64').toString('utf8'));
    assert.equal(metadata.bundle, copy);
    assert.equal(metadata.launcher, '/usr/bin/open', 'A fixture deve executar o launcher real.');
    assert.equal(await page.locator('.terminal-pane').count(), 0);

    await runDock();
    await page.waitForFunction(folder => document.querySelector('#breadcrumb-project')?.dataset.projectPath === folder, project, { timeout: 30000 });
    assert.equal(await page.locator('.terminal-pane').count(), 0, 'Abrir projeto não deve iniciar um terminal.');
    const counts = await app.evaluate(() => global.__dockFixture);
    assert.equal(counts.create, 0); assert.equal(counts.start, 0);
    assert.equal(counts.errors.length, 0);

    await menu('Remover comando dock do terminal');
    await expectDialog('Comando dock removido.');
    assert.equal(fs.existsSync(installed), false);
    console.log('✓ Menu instala dock em fixture, abre a pasta pelo launcher real sem terminal automático e remove o comando.');
  } finally {
    if (app) await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
