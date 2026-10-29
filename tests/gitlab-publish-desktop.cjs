// "Criar projeto no GitLab SEA" na guia Git: formulário, revisão e resultado.
// Os canais do processo principal são substituídos: nada vai à rede.
const { openProjectPanel } = require('./helpers/project-inspector.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..'), tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-gitlab-publish-'))), project = path.join(tmp, 'Portal Sesc');
fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'index.html'), '<h1>oi</h1>\n');
let app;
(async () => {
  try {
    app = await electron.launch({ args: [root], env: { ...process.env, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_DATA_DIR: path.join(tmp, 'perfil') } });
    const page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await app.evaluate(({ ipcMain, shell }) => {
      const add = (name, fn) => { ipcMain.removeHandler(name); ipcMain.handle(name, async (_event, ...args) => { try { return { ok: true, value: await fn(...args) }; } catch (error) { return { ok: false, error: error.message }; } }); };
      global.__calls = [];
      shell.openExternal = async url => { global.__external = url; };
      add('gitlab:publish-options', root => { global.__calls.push(['options', root]); return { name: 'Portal Sesc', path: 'portal-sesc', namespaces: [{ id: 1712, fullPath: 'design', name: 'design', visibility: 'internal' }, { id: 1772, fullPath: 'design/sesc-df', name: 'design / Sesc DF', visibility: 'internal' }], defaultNamespace: 1712, visibilities: ['private', 'internal'], local: { repository: false, branch: 'main', hasHead: false, changes: 1, origin: null } }; });
      add('gitlab:publish-plan', (root, input) => {
        global.__calls.push(['plan', input]);
        if (input.path === 'ja-existe') throw new Error('Já existe um projeto em design/sesc-df/ja-existe. Escolha outro caminho.');
        return { id: 'plano-1', fullPath: `design/sesc-df/${input.path}`, webUrl: `https://gitlab.seatecnologia.com.br/design/sesc-df/${input.path}`, sshUrl: 'x', branch: 'main', steps: ['Iniciar o Git nesta pasta (branch main).', 'Criar a primeira versão (“Primeira versão”) com os arquivos da pasta.', `Criar o projeto privado “${input.name}” em design/sesc-df/${input.path}.`, 'Enviar a branch main para o GitLab SEA.'], notes: [] };
      });
      add('gitlab:publish', (root, id) => { global.__calls.push(['publish', id]); return { webUrl: 'https://gitlab.seatecnologia.com.br/design/sesc-df/portal-sesc-df', fullPath: 'design/sesc-df/portal-sesc-df', branch: 'main', pushed: true, renamed: null, notes: [], error: null }; });
    });
    await page.locator('.project-select').click();
    await openProjectPanel(page, 'git');
    const start = page.getByTestId('gitlab-publish-start');
    await start.waitFor();
    const box = await start.boundingBox(); assert.ok(box.height >= 44, `ação principal com ${box.height}px`);
    await start.click();
    const flow = page.getByTestId('gitlab-publish');
    await flow.getByLabel('Nome do projeto').waitFor();
    assert.equal(await flow.getByLabel('Caminho').inputValue(), 'portal-sesc');
    assert.equal(await flow.getByLabel('Visibilidade').inputValue(), 'private');
    assert.equal(await flow.getByLabel('Grupo de destino').inputValue(), '1712');
    await flow.getByLabel('Nome do projeto').fill('Portal Sesc DF');
    assert.equal(await flow.getByLabel('Caminho').inputValue(), 'portal-sesc-df', 'caminho acompanha o nome');
    await flow.getByLabel('Grupo de destino').selectOption('1772');
    await flow.getByText('Endereço: gitlab.seatecnologia.com.br/design/sesc-df/portal-sesc-df').waitFor();
    await flow.getByLabel('Criar a primeira versão com todos os arquivos da pasta').check();
    // Caminho inválido não sai do formulário.
    await flow.getByLabel('Caminho').fill('Portal Sesc');
    await flow.getByRole('button', { name: 'Revisar' }).click();
    await flow.getByText(/O caminho deve ter letras minúsculas/).waitFor();
    // Erro do GitLab aparece no formulário e mantém os dados.
    await flow.getByLabel('Caminho').fill('ja-existe');
    await flow.getByRole('button', { name: 'Revisar' }).click();
    await flow.getByText('Já existe um projeto em design/sesc-df/ja-existe. Escolha outro caminho.').waitFor();
    await flow.getByLabel('Caminho').fill('portal-sesc-df');
    await flow.getByRole('button', { name: 'Revisar' }).click();
    const steps = page.getByTestId('gitlab-publish-steps');
    await steps.waitFor();
    assert.equal(await steps.locator('li').count(), 4);
    await page.getByText('Link do projeto: https://gitlab.seatecnologia.com.br/design/sesc-df/portal-sesc-df').waitFor();
    let calls = await app.evaluate(() => global.__calls);
    assert.ok(!calls.some(call => call[0] === 'publish'), 'nada é criado antes da confirmação');
    assert.deepEqual(calls.filter(call => call[0] === 'plan').at(-1)[1], { name: 'Portal Sesc DF', path: 'portal-sesc-df', namespaceId: 1772, visibility: 'private', description: '', commit: true, renameOrigin: false });
    // Voltar preserva o que foi digitado.
    await page.getByRole('button', { name: 'Voltar e editar' }).click();
    assert.equal(await flow.getByLabel('Nome do projeto').inputValue(), 'Portal Sesc DF');
    await flow.getByRole('button', { name: 'Revisar' }).click();
    const confirm = page.getByTestId('gitlab-publish-confirm');
    await confirm.waitFor();
    assert.ok((await confirm.boundingBox()).height >= 44);
    await confirm.click();
    await page.getByText('A branch main foi enviada para design/sesc-df/portal-sesc-df.').waitFor();
    calls = await app.evaluate(() => global.__calls);
    assert.deepEqual(calls.filter(call => call[0] === 'publish'), [['publish', 'plano-1']]);
    await page.getByText('https://gitlab.seatecnologia.com.br/design/sesc-df/portal-sesc-df', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Concluir' }).click();
    await page.getByTestId('gitlab-publish').waitFor({ state: 'detached' });
    console.log('✓ Criar projeto no GitLab SEA: formulário, revisão sem efeitos e confirmação explícita');
  } finally { if (app) await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
