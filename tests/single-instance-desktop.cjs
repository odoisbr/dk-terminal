const { _electron: electron } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executable = require('electron');
const temp = fs.realpathSync(fs.mkdtempSync('/private/tmp/dk-single-instance-'));
const profile = path.join(temp, 'profile'), otherProfile = path.join(temp, 'other-profile');
const first = path.join(temp, 'Primeiro'), second = path.join(temp, 'Segundo'), third = path.join(temp, 'Terceiro');
for (const dir of [profile, otherProfile, first, second, third]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(second, 'arquivo.txt'), 'Teste de encaminhamento.');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ projects: [], remoteProjects: [
  { id: 1, name: 'Aceito', path: 'design/projeto' },
  { id: 2, name: 'Subgrupo', path: 'design/equipe/projeto' },
  { id: 3, name: 'Outro', path: 'outro/projeto' },
  { id: 4, name: 'Prefixo parecido', path: 'designer/projeto' },
] }));
const environment = dir => ({ ...process.env, ELECTRON_RUN_AS_NODE: undefined, DK_TERMINAL_TEST: '1', DK_TERMINAL_DATA_DIR: dir, DK_TERMINAL_TEST_DATA: dir, DK_TERMINAL_TEST_PROJECT: '' });
function secondary(dir, files = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [root, ...files], { cwd: temp, env: environment(dir), stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('A segunda instância não encerrou: ' + errors)); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Segunda instância encerrou com ${code}: ${errors}`)); });
  });
}
let primary, independent;
(async () => {
  try {
    primary = await electron.launch({ args: [root, first], env: environment(profile), timeout: 60000 });
    let page = await primary.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('#project-title')?.textContent === 'Primeiro');
    const bootstrap = await page.evaluate(() => window.dk.bootstrap());
    assert.deepEqual(bootstrap.remoteProjects.map(item => item.id), [1, 2]);
    const chat = await page.evaluate(dir => window.dk.createChat(dir), first);
    const primaryPid = await primary.evaluate(() => process.pid);
    // Forward a relative file path and a directory without starting another writer.
    await secondary(profile, [path.relative(temp, path.join(second, 'arquivo.txt')), third]);
    await page.waitForFunction(() => document.querySelector('#project-title')?.textContent === 'Terceiro');
    assert.equal(await primary.evaluate(() => process.pid), primaryPid);
    assert.equal((await page.evaluate(dir => window.dk.listChats(dir), first)).length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    assert.deepEqual(new Set(saved.projects), new Set([first, second, third]));
    // Canonical profile aliases must share the same lock.
    const alias = path.join(temp, 'profile-alias'); fs.symlinkSync(profile, alias, 'dir');
    if (process.platform === 'darwin') {
      await primary.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await secondary(alias);
      assert.equal(await primary.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), false);
    } else await secondary(alias);
    // Finder's open-file route still activates the enclosing folder.
    await primary.evaluate(({ app }, file) => app.emit('open-file', { preventDefault() {} }, file), path.join(second, 'arquivo.txt'));
    await page.waitForFunction(() => document.querySelector('#project-title')?.textContent === 'Segundo');
    const slowShell = path.join(temp, 'slow-login.sh');
    fs.writeFileSync(slowShell, '#!/bin/sh\n/bin/sleep 2\nprintf "\\0%s\\0" "$PATH"\n', { mode: 0o700 });
    independent = await electron.launch({ args: [root, first], env: { ...environment(otherProfile), SHELL: slowShell }, timeout: 60000 });
    const independentPage = await independent.firstWindow();
    // Requests received before login-environment discovery finishes join bootstrap.
    assert.equal(await independentPage.locator('#startup-loading').isVisible(), true);
    await secondary(otherProfile, [second]);
    await independentPage.locator('#startup-loading').waitFor({ state: 'detached' });
    await independentPage.waitForFunction(() => document.querySelector('#project-title')?.textContent === 'Segundo');
    assert.notEqual(await independent.evaluate(() => process.pid), primaryPid);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(otherProfile, 'settings.json'), 'utf8')).projects, [first, second]);
    await independent.close(); independent = null;
    if (process.platform === 'darwin') {
      await primary.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await secondary(profile, [third]);
      page = await primary.firstWindow();
      await page.locator('#startup-loading').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('#project-title')?.textContent === 'Terceiro');
      assert.equal((await page.evaluate(dir => window.dk.listChats(dir), first))[0].id, chat.id);
    }
    await primary.close(); primary = null;
    const history = JSON.parse(fs.readFileSync(path.join(profile, 'codex-conversations.json'), 'utf8'));
    assert.equal(history.sessions.length, 1); assert.equal(history.sessions[0].id, chat.id);
    console.log('✓ Perfil tem uma única instância; arquivos, Finder, foco, reabertura e perfis independentes preservam configurações e histórico');
  } finally {
    if (independent) await independent.close();
    if (primary) await primary.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
