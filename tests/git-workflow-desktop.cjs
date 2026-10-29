const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { openProjectPanel } = require('./helpers/project-inspector.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Tudo ocorre em repositórios temporários; o único remoto é um bare local.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-git-workflow-')));
const first = path.join(temp, 'Projeto A'), second = path.join(temp, 'Projeto B'), remote = path.join(temp, 'remote.git');
for (const directory of [first, second]) fs.mkdirSync(directory);
const globalConfig = path.join(temp, 'gitconfig'); fs.writeFileSync(globalConfig, '');
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete gitEnv[name];
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (directory, name, value) => fs.writeFileSync(path.join(directory, name), value);
function init(directory) {
  git(directory, 'init', '-b', 'main');
  git(directory, 'config', 'user.name', 'Fixture DK');
  git(directory, 'config', 'user.email', 'fixture@example.invalid');
}
init(first); init(second);
write(first, 'alpha.txt', 'alpha inicial\n'); write(first, 'beta.txt', 'beta inicial\n');
git(first, 'add', '.'); git(first, 'commit', '-m', 'base');
git(first, 'switch', '-c', 'feature'); write(first, 'feature.txt', 'feature\n'); git(first, 'add', '.'); git(first, 'commit', '-m', 'feature');
git(first, 'switch', 'main'); write(first, 'main.txt', 'main\n'); git(first, 'add', '.'); git(first, 'commit', '-m', 'main change');
git(first, 'merge', '--no-ff', 'feature', '-m', 'merge feature');
const mergeHash = git(first, 'rev-parse', 'HEAD');
write(first, 'alpha.txt', 'alpha parcialmente preparado\n'); git(first, 'add', '--', 'alpha.txt');
write(first, 'alpha.txt', 'alpha completo salvo no disco\n');
write(first, 'beta.txt', 'beta preparado e preservado\n'); git(first, 'add', '--', 'beta.txt');
write(first, 'novo.txt', 'não selecionado\n');
write(second, 'outro.txt', 'base B\n'); git(second, 'add', '.'); git(second, 'commit', '-m', 'base B');
write(second, 'outro.txt', 'alteração B\n');
execFileSync('git', ['init', '--bare', remote], { env: gitEnv, stdio: 'ignore' });
git(first, 'remote', 'add', 'origin', remote);
const alphaIndexBefore = git(first, 'show', ':alpha.txt');
const betaIndexBefore = git(first, 'show', ':beta.txt');
const betaDiffBefore = git(first, 'diff', '--cached', '--', 'beta.txt');

const shell = path.join(temp, 'shell');
if (process.platform !== 'win32') fs.writeFileSync(shell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });
const env = {
  ...gitEnv, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: first, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile'),
  ...(process.platform === 'win32' ? {} : { SHELL: shell }),
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(message); await delay(50); }
}
async function section(page, testId, name, expanded) {
  const area = page.getByTestId(testId);
  const toggle = area.getByRole('button', { name });
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) !== String(expanded)) await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), String(expanded));
  return { area, toggle };
}
async function waitDraft(page, text, selected) {
  await page.getByTestId('git-commit-message').waitFor();
  await until(async () => (await page.getByTestId('git-commit-message').inputValue()) === text, 'A mensagem da versão não foi preservada.');
  assert.equal(await page.getByLabel(`Selecionar ${selected}`).isChecked(), true);
}

let app, page;
(async () => {
  const dialogs = [];
  try {
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env, timeout: 60000 });
    page = await app.firstWindow();
    page.on('dialog', dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); void (dialog.type() === 'confirm' ? dialog.dismiss() : dialog.accept()); });
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    if (executablePath) {
      await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, first);
      await page.locator('#launcher-open-local').click();
    } else await page.locator('.project-select').click();
    await startProjectTerminal(page);
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, second);
    await openProjectPanel(page, 'git');

    const changes = page.getByTestId('git-changes-section'), graph = page.getByTestId('git-graph-section'), tools = page.getByTestId('git-tools-section');
    const changesToggle = changes.getByRole('button', { name: /Alterações/ });
    const graphToggle = graph.getByRole('button', { name: /Grafo/ });
    const toolsToggle = tools.getByRole('button', { name: /Ferramentas/ });
    await changesToggle.waitFor(); await graphToggle.waitFor(); await toolsToggle.waitFor();
    assert.equal(await changesToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await graphToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await toolsToggle.getAttribute('aria-expanded'), 'false');
    const message = page.getByTestId('git-commit-message'), commit = page.getByTestId('git-commit');
    await message.waitFor();
    assert.ok(await message.getAttribute('aria-label'), 'A mensagem deve ter nome acessível.');
    assert.equal(await commit.getAttribute('type'), 'submit');
    assert.equal(await commit.isDisabled(), true);
    const shortcut = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';
    await message.focus(); await message.press(shortcut); await delay(250);
    assert.equal(git(first, 'rev-parse', 'HEAD'), mergeHash, 'O atalho desabilitado não pode criar versão.');
    if (process.env.DK_GIT_WORKFLOW_SCREENSHOT) await page.screenshot({ path: process.env.DK_GIT_WORKFLOW_SCREENSHOT });

    await page.getByLabel('Selecionar alpha.txt').check();
    await message.fill('Versão do projeto A');
    assert.equal(await commit.isEnabled(), true);
    const merge = graph.locator('summary').filter({ hasText: 'merge feature' });
    await merge.waitFor();
    assert.match(await merge.innerText(), new RegExp(mergeHash.slice(0, 7)));
    assert.equal(await merge.locator('svg').getAttribute('aria-hidden'), 'true');
    await merge.focus(); await page.keyboard.press('Enter');
    await until(async () => (await merge.locator('..').innerText()).includes(mergeHash), 'Os detalhes do merge não foram abertos pelo teclado.');
    await graphToggle.focus(); await page.keyboard.press('Space');
    assert.equal(await graphToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await message.inputValue(), 'Versão do projeto A');
    assert.equal(await page.getByLabel('Selecionar alpha.txt').isChecked(), true);
    await graphToggle.focus(); await page.keyboard.press('Enter');
    assert.equal(await graphToggle.getAttribute('aria-expanded'), 'true');
    await changesToggle.focus(); await page.keyboard.press('Space');
    assert.equal(await changesToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await message.isVisible(), false);
    await changesToggle.focus(); await page.keyboard.press('Enter');
    assert.equal(await changesToggle.getAttribute('aria-expanded'), 'true');
    await waitDraft(page, 'Versão do projeto A', 'alpha.txt');
    await page.getByRole('button', { name: 'Atualizar Git' }).click();
    await waitDraft(page, 'Versão do projeto A', 'alpha.txt');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 620));
    await page.waitForFunction(() => innerWidth <= 940);
    await message.scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => {
      const host = document.querySelector('#panel-git').getBoundingClientRect();
      const input = document.querySelector('[data-testid="git-commit-message"]').getBoundingClientRect();
      const button = document.querySelector('[data-testid="git-commit"]').getBoundingClientRect();
      return { host: { left: host.left, right: host.right }, input: { left: input.left, right: input.right, bottom: input.bottom }, button: { left: button.left, right: button.right, top: button.top } };
    });
    assert.ok(layout.input.left >= layout.host.left - 2 && layout.input.right <= layout.host.right + 2 && layout.button.left >= layout.host.left - 2 && layout.button.right <= layout.host.right + 2, 'Mensagem e botão devem caber no painel estreito.');
    assert.ok(layout.button.top >= layout.input.bottom - 2, 'Mensagem e botão não devem se sobrepor.');
    if (process.env.DK_GIT_WORKFLOW_NARROW_SCREENSHOT) await page.screenshot({ path: process.env.DK_GIT_WORKFLOW_NARROW_SCREENSHOT });
    // Chega ao primeiro arquivo com Tab, como um usuário, sem depender apenas
    // de isVisible(), que não detecta recorte em ancestrais com overflow.
    const firstChange = changes.getByRole('button', { name: 'alpha.txt', exact: true });
    await message.focus();
    let reached = false;
    for (let attempt = 0; attempt < 16 && !reached; attempt++) {
      await page.keyboard.press('Tab');
      reached = await firstChange.evaluate(element => document.activeElement === element);
    }
    assert.equal(reached, true, 'O primeiro arquivo deve ser alcançável pelo teclado na janela estreita.');
    const fileGeometry = await firstChange.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const result = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      const clips = [];
      let within = rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        const clipX = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
        const clipY = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY);
        const left = bounds.left + parent.clientLeft, top = bounds.top + parent.clientTop;
        const right = left + parent.clientWidth, bottom = top + parent.clientHeight;
        if ((clipX && (rect.left < left - 1 || rect.right > right + 1)) || (clipY && (rect.top < top - 1 || rect.bottom > bottom + 1))) {
          within = false; clips.push({ element: parent.className || parent.id || parent.tagName, left, right, top, bottom });
        }
      }
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { rect: result, within, clips, receivesPointer: target === element || element.contains(target) };
    });
    assert.ok(fileGeometry.rect.width > 0 && fileGeometry.rect.height > 0 && fileGeometry.within, `O primeiro arquivo está cortado: ${JSON.stringify(fileGeometry)}`);
    assert.equal(fileGeometry.receivesPointer, true, `O primeiro arquivo está sobreposto: ${JSON.stringify(fileGeometry)}`);
    await firstChange.click();
    await page.getByText('+alpha completo salvo no disco', { exact: false }).waitFor();
    await firstChange.click();
    await graphToggle.scrollIntoViewIfNeeded();
    assert.equal(await graphToggle.isVisible(), true, 'O gráfico deve continuar acessível no painel estreito.');
    await merge.scrollIntoViewIfNeeded(); await merge.focus(); await page.keyboard.press('Enter');
    await until(async () => (await merge.locator('..').innerText()).includes(mergeHash), 'O gráfico deve continuar interativo na janela estreita.');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    console.log('✓ Alterações e grafo coexistem, são acessíveis por teclado e preservam o rascunho');

    await page.locator('#open-project').click();
    await page.waitForFunction(directory => document.querySelector('#breadcrumb-project')?.dataset.projectPath === directory, second);
    await openProjectPanel(page, 'git');
    await page.getByLabel('Selecionar outro.txt').waitFor();
    assert.equal(await message.inputValue(), '', 'O rascunho de A não deve aparecer em B.');
    await page.getByLabel('Selecionar outro.txt').check();
    await message.fill('Versão do projeto B');
    await page.locator('.project-select[title="Projeto A"]').click();
    await page.waitForFunction(directory => document.querySelector('#breadcrumb-project')?.dataset.projectPath === directory, first);
    await openProjectPanel(page, 'git');
    await waitDraft(page, 'Versão do projeto A', 'alpha.txt');
    assert.equal(await page.getByLabel('Selecionar beta.txt').isChecked(), false);
    await page.locator('.project-select[title="Projeto B"]').click();
    await page.waitForFunction(directory => document.querySelector('#breadcrumb-project')?.dataset.projectPath === directory, second);
    await openProjectPanel(page, 'git');
    await waitDraft(page, 'Versão do projeto B', 'outro.txt');
    await openProjectPanel(page, 'files');
    await page.locator('.tree-file[data-relative="outro.txt"]').click();
    await page.locator('.cm-content').click(); await page.keyboard.insertText(' rascunho não salvo de B');
    await page.waitForFunction(() => !!document.querySelector('.dk-editor-dirty[aria-label="Alterações não salvas"]'));
    assert.equal(fs.readFileSync(path.join(second, 'outro.txt'), 'utf8'), 'alteração B\n');
    await page.locator('.project-select[title="Projeto A"]').click();
    await page.waitForFunction(directory => document.querySelector('#breadcrumb-project')?.dataset.projectPath === directory, first);
    await openProjectPanel(page, 'git');
    await waitDraft(page, 'Versão do projeto A', 'alpha.txt');
    console.log('✓ Mensagem e seleção permanecem isoladas por projeto');

    const hook = path.join(first, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nprintf "RECUSA_FIXTURE\\n" >&2\nexit 1\n', { mode: 0o755 });
    await commit.click();
    await until(async () => /prepar/i.test(await page.locator('#panel-git').innerText()), 'A falha do hook deve avisar que o preparo pode ter mudado.');
    assert.equal(git(first, 'rev-parse', 'HEAD'), mergeHash);
    await waitDraft(page, 'Versão do projeto A', 'alpha.txt');
    assert.equal(alphaIndexBefore, 'alpha parcialmente preparado');
    assert.equal(git(first, 'show', ':alpha.txt'), 'alpha completo salvo no disco');
    assert.equal(git(first, 'show', ':beta.txt'), betaIndexBefore);
    fs.unlinkSync(hook);

    // Conteúdo não salvo no editor não pode entrar em uma versão silenciosamente.
    await openProjectPanel(page, 'files');
    await page.locator('.tree-file[data-relative="alpha.txt"]').click();
    await page.locator('.cm-content').click(); await page.keyboard.insertText(' alteração ainda não salva');
    await page.waitForFunction(() => !!document.querySelector('.dk-editor-dirty[aria-label="Alterações não salvas"]'));
    await openProjectPanel(page, 'git');
    await waitDraft(page, 'Versão do projeto A', 'alpha.txt');
    const beforeWarning = dialogs.length, disabledForEditor = await commit.isDisabled();
    await message.focus(); await message.press(shortcut);
    if (!disabledForEditor) {
      await until(() => dialogs.length > beforeWarning, 'A versão com editor não salvo deve informar o usuário.');
      assert.match(dialogs.at(-1).message, /salv/i);
    }
    await delay(250);
    assert.equal(git(first, 'rev-parse', 'HEAD'), mergeHash);
    await waitDraft(page, 'Versão do projeto A', 'alpha.txt');
    await page.locator('.cm-content').focus(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForFunction(() => !document.querySelector('.dk-editor-dirty[aria-label="Alterações não salvas"]'));
    await message.focus(); await message.press(shortcut);
    await until(() => git(first, 'rev-parse', 'HEAD') !== mergeHash, 'O atalho não salvou a versão selecionada.');
    assert.equal(git(first, 'log', '-1', '--format=%s'), 'Versão do projeto A');
    assert.equal(git(first, 'show', '--format=', '--name-only', 'HEAD'), 'alpha.txt');
    assert.equal(git(first, 'show', 'HEAD:alpha.txt'), 'alpha completo salvo no disco');
    assert.equal(git(first, 'show', ':beta.txt'), betaIndexBefore);
    assert.equal(git(first, 'diff', '--cached', '--', 'beta.txt'), betaDiffBefore);
    assert.match(git(first, 'status', '--porcelain'), /\?\? novo\.txt/);
    await page.locator('.project-select[title="Projeto B"]').click();
    await page.waitForFunction(directory => document.querySelector('#breadcrumb-project')?.dataset.projectPath === directory, second);
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('rascunho não salvo de B'));
    assert.equal(await page.locator('.dk-editor-dirty[aria-label="Alterações não salvas"]').count(), 1);
    assert.equal(fs.readFileSync(path.join(second, 'outro.txt'), 'utf8'), 'alteração B\n');
    await page.locator('.project-select[title="Projeto A"]').click();
    await page.waitForFunction(directory => document.querySelector('#breadcrumb-project')?.dataset.projectPath === directory, first);
    await openProjectPanel(page, 'git');
    console.log('✓ Hook, editor de A e atalho preservam índice e rascunho não salvo de B');

    await section(page, 'git-tools-section', /Ferramentas/, true);
    await page.getByLabel('Selecionar branch local').selectOption('feature');
    const beforeDirtyWarning = dialogs.length;
    await page.getByRole('button', { name: 'Trocar', exact: true }).click();
    await until(() => dialogs.length > beforeDirtyWarning, 'A troca de branch com arquivos pendentes deve avisar.');
    assert.match(dialogs.at(-1).message, /alteraç/i);
    assert.equal(git(first, 'branch', '--show-current'), 'main');
    assert.equal(git(first, 'show', ':beta.txt'), betaIndexBefore);

    // Limpeza da fixture permite confirmar que cada diálogo de risco pode ser cancelado.
    git(first, 'add', '-A'); git(first, 'commit', '-m', 'fixture: restantes');
    await page.getByRole('button', { name: 'Atualizar Git' }).click();
    await section(page, 'git-tools-section', /Ferramentas/, true);
    const branch = page.getByLabel('Selecionar branch local');
    await branch.selectOption('feature');
    async function cancel(button, expression) {
      const previous = dialogs.length;
      await button.click();
      await until(() => dialogs.length > previous, 'A confirmação esperada não apareceu.');
      assert.equal(dialogs.at(-1).type, 'confirm');
      assert.match(dialogs.at(-1).message, expression);
    }
    await cancel(page.getByRole('button', { name: 'Trocar', exact: true }), /trocar/i);
    assert.equal(git(first, 'branch', '--show-current'), 'main');
    await cancel(page.getByRole('button', { name: 'Excluir', exact: true }), /excluir/i);
    assert.equal(git(first, 'branch', '--list', 'feature'), 'feature');
    await page.getByLabel('Nome da nova branch').fill('design/cancelada');
    await cancel(page.getByRole('button', { name: 'Criar e trocar', exact: true }), /criar/i);
    assert.equal(git(first, 'branch', '--list', 'design/cancelada'), '');
    await cancel(page.getByRole('button', { name: 'Atualizar', exact: true }), /atualizar/i);
    await cancel(page.getByRole('button', { name: 'Enviar', exact: true }), /enviar/i);
    const refs = execFileSync('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname)'], { env: gitEnv, encoding: 'utf8' }).trim();
    assert.equal(refs, '', 'Nenhum envio deve ocorrer quando o diálogo é cancelado.');
    assert.equal(git(first, 'branch', '--show-current'), 'main');
    console.log('✓ Branches e sincronização respeitam alterações e cancelamentos');
  } finally {
    if (app) {
      if (page) {
        try { await page.evaluate(() => window.dk.setDirtyFiles([])); } catch {}
        for (const directory of [first, second]) try { await page.evaluate(root => window.dk.closeProjectSessions(root), directory); } catch {}
      }
      await app.close();
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
