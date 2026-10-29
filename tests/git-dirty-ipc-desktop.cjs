const { openProjectPanel } = require('./helpers/project-inspector.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-git-dirty-ipc-')));
const first = path.join(temporary, 'projeto');
// A shared prefix must not make a sibling project appear to own the dirty file.
const second = path.join(temporary, 'projeto-extra');
const testEnv = { ...process.env };
for (const key of Object.keys(testEnv)) if (key.startsWith('GIT_')) delete testEnv[key];
Object.assign(testEnv, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_TERMINAL_PROMPT: '0' });

function git(folder, ...args) {
  return execFileSync('git', ['-C', folder, ...args], {
    encoding: 'utf8', env: testEnv, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function prepareProject(folder, remote) {
  fs.mkdirSync(folder);
  execFileSync('git', ['init', '--bare', remote], { env: testEnv, stdio: 'ignore' });
  git(folder, 'init', '-b', 'main');
  git(folder, 'config', 'user.name', 'Teste');
  git(folder, 'config', 'user.email', 'teste@example.invalid');
  fs.writeFileSync(path.join(folder, 'nota.txt'), 'Texto original\n');
  fs.writeFileSync(path.join(folder, 'outro.txt'), 'Conteúdo original\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '-m', 'inicial');
  git(folder, 'remote', 'add', 'origin', remote);
  git(folder, 'push', '-u', 'origin', 'main');
}

let app, page;
(async () => {
  try {
    // Both remotes are bare repositories on disk. No network service is used.
    prepareProject(first, path.join(temporary, 'primeiro.git'));
    prepareProject(second, path.join(temporary, 'segundo.git'));
    git(first, 'branch', 'integrada');
    fs.writeFileSync(path.join(first, 'outro.txt'), 'Alteração no disco\n');
    const initialFirst = git(first, 'rev-parse', 'HEAD');
    const initialSecond = git(second, 'rev-parse', 'HEAD');

    app = await electron.launch({
      executablePath: process.env.DK_TERMINAL_EXECUTABLE || undefined,
      args: process.env.DK_TERMINAL_EXECUTABLE ? [] : [appRoot],
      env: { ...testEnv, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: first, DK_TERMINAL_DATA_DIR: path.join(temporary, 'perfil') },
    });
    page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    if (process.env.DK_TERMINAL_EXECUTABLE) {
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, first);
      await page.locator('#launcher-open-local').click();
    } else {
      await page.locator('#launcher-recents .launcher-recent').first().click();
    }

    // Open a real editor and change its buffer without saving it to disk.
    await openProjectPanel(page, 'files');
    await page.locator('.tree-file[data-relative="nota.txt"]').click();
    await page.locator('.cm-content').click();
    await page.keyboard.insertText(' edição não salva');
    await page.locator('.dk-editor-dirty[aria-label="Alterações não salvas"]').waitFor();
    // Wait for the same IPC used by the editor so assertions cannot race the
    // asynchronous dirty-state notification from the renderer.
    await page.evaluate(file => window.dk.setDirtyFiles([file]), path.join(first, 'nota.txt'));

    await assert.rejects(
      page.evaluate(root => window.dk.gitCommit(root, ['outro.txt'], 'não deve salvar'), first),
      /Salve os arquivos abertos no editor antes de criar uma versão/,
    );
    assert.equal(git(first, 'rev-parse', 'HEAD'), initialFirst);
    assert.equal(git(first, 'diff', '--cached', '--name-only'), '');

    // Restore the changed on-disk file: Git itself now sees a clean tree, so
    // a refused pull proves that the main-process dirty-editor guard ran.
    fs.writeFileSync(path.join(first, 'outro.txt'), 'Conteúdo original\n');
    assert.equal(git(first, 'status', '--porcelain'), '');
    await assert.rejects(
      page.evaluate(root => window.dk.gitSync(root, 'pull'), first),
      /Salve os arquivos abertos no editor antes de atualizar o projeto/,
    );
    assert.equal(git(first, 'rev-parse', 'HEAD'), initialFirst);

    // Fetch, push and deleting an integrated branch do not overwrite the
    // editor. Changing branches remains protected as it was previously.
    assert.equal(await page.evaluate(root => window.dk.gitSync(root, 'fetch'), first), true);
    assert.equal(await page.evaluate(root => window.dk.gitSync(root, 'push'), first), true);
    await assert.rejects(
      page.evaluate(root => window.dk.gitBranchAction(root, 'switch', 'integrada'), first),
      /Salve os arquivos abertos no editor antes de trocar de branch/,
    );
    assert.equal(await page.evaluate(root => window.dk.gitBranchAction(root, 'delete', 'integrada'), first), true);
    assert.equal(git(first, 'branch', '--show-current'), 'main');

    // Register a second open project without changing the first editor.
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, second);
    const selected = await page.evaluate(() => window.dk.selectProject());
    assert.equal(selected.path, second);
    fs.writeFileSync(path.join(second, 'outro.txt'), 'Alteração no segundo projeto\n');
    assert.equal(await page.evaluate(root => window.dk.gitCommit(root, ['outro.txt'], 'versão do segundo'), second), true);
    assert.notEqual(git(second, 'rev-parse', 'HEAD'), initialSecond);
    assert.equal(await page.evaluate(root => window.dk.gitSync(root, 'pull'), second), true);
    assert.equal(git(first, 'rev-parse', 'HEAD'), initialFirst);

    // Undo the unsaved edit and verify both protected actions work again.
    await page.locator('.cm-content').focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.locator('.dk-editor-dirty[aria-label="Alterações não salvas"]').waitFor({ state: 'detached' });
    await page.locator('.dk-editor-dirty[aria-label="Arquivo salvo"]').waitFor({ state: 'attached' });
    await page.evaluate(() => window.dk.setDirtyFiles([]));
    assert.equal(await page.evaluate(root => window.dk.gitSync(root, 'pull'), first), true);
    fs.writeFileSync(path.join(first, 'outro.txt'), 'Alteração após salvar o editor\n');
    assert.equal(await page.evaluate(root => window.dk.gitCommit(root, ['outro.txt'], 'versão autorizada'), first), true);
    assert.notEqual(git(first, 'rev-parse', 'HEAD'), initialFirst);
    console.log('✓ IPC Git protege edições não salvas por projeto e mantém fetch, push e outros projetos disponíveis');
  } finally {
    if (page) await page.evaluate(() => window.dk.setDirtyFiles([])).catch(() => {});
    if (app) await app.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
