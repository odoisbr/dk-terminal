const { openFolderDialog } = require('./helpers/open-folder.cjs');
const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openProjectPanel } = require('./helpers/project-inspector.cjs');

// A fixture não utiliza projetos ou sessões do usuário.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-project-inspector-')));
const first = path.join(temp, 'pasta-a'), second = path.join(temp, 'pasta-b'), bin = path.join(temp, 'bin');
for (const directory of [first, second, bin]) fs.mkdirSync(directory);
fs.writeFileSync(path.join(first, 'projeto.yml'), 'projeto: Projeto A oficial\n');
fs.writeFileSync(path.join(second, 'projeto.yml'), 'projeto: Projeto B oficial\n');
fs.writeFileSync(path.join(first, 'nota.txt'), 'Conteúdo original do projeto A\n');
fs.writeFileSync(path.join(second, 'outro.txt'), 'Conteúdo do projeto B\n');
const shell = path.join(temp, 'shell');
if (process.platform !== 'win32') fs.writeFileSync(shell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });
const env = {
  ...process.env, PATH: bin, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: first, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile'),
  ...(process.platform === 'win32' ? {} : { SHELL: shell }),
};
const controls = [['files', 'Arquivos do projeto'], ['git', 'Git'], ['context', 'Contexto do projeto'], ['services', 'Serviços do projeto'], ['usage', 'Contas e uso']];
let app, page;

async function assertCollapsed() {
  assert.equal(await page.locator('#project-inspector-panel').isVisible(), false);
  for (const [id] of controls) assert.equal(await page.locator(`#tab-${id}`).getAttribute('aria-expanded'), 'false');
}
async function assertOpened(name) {
  assert.equal(await page.locator('#project-inspector-panel').isVisible(), true);
  for (const [id] of controls) {
    assert.equal(await page.locator(`#tab-${id}`).getAttribute('aria-expanded'), String(id === name));
    assert.equal(await page.locator(`#panel-${id}`).isVisible(), id === name);
  }
}
async function expectProject(directory, title) {
  await page.waitForFunction(value => document.querySelector('#breadcrumb-project')?.dataset.projectPath === value, directory);
  assert.equal(await page.locator('#project-title').innerText(), title);
}

(async () => {
  try {
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env, timeout: 60000 });
    page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    if (executablePath) {
      await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, first);
      await page.locator('#launcher-open-local').click();
    } else await page.locator('#launcher-recents .launcher-recent').first().click();
    await startProjectTerminal(page);
    await expectProject(first, 'Projeto A oficial');
    assert.equal(await page.locator('.project-select[aria-current=page] strong').innerText(), 'Projeto A oficial');
    assert.equal(await page.locator('.project-header').count(), 0, 'O cabeçalho redundante deve ser removido.');
    assert.equal(await page.locator('#project-path').count(), 0);
    assert.equal(await page.locator('#project-type').count(), 0);
    const reveal = page.locator('#reveal-project');
    assert.equal(await reveal.getAttribute('aria-label'), 'Abrir pasta do projeto no Finder');
    assert.match((await reveal.getAttribute('title')) || (await reveal.getAttribute('aria-description')) || '', /pasta-a/);
    await assertCollapsed();
    if (process.env.DK_PROJECT_INSPECTOR_COLLAPSED_SCREENSHOT) await page.screenshot({ path: process.env.DK_PROJECT_INSPECTOR_COLLAPSED_SCREENSHOT });

    for (const [id, name] of controls) {
      const button = page.locator(`#tab-${id}`);
      assert.equal(await button.getAttribute('aria-label'), name);
      assert.equal(await button.getAttribute('title'), name);
      assert.equal(await button.getAttribute('aria-controls'), `panel-${id}`);
    }
    await page.locator('#tab-files').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tab-git');
    await assertCollapsed();
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tab-usage');
    await page.keyboard.press('Enter'); await assertOpened('usage');
    await page.keyboard.press('Space'); await assertCollapsed();
    await page.locator('#tab-usage').focus(); await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tab-files');
    await page.keyboard.press('Enter'); await assertOpened('files');

    const terminalId = (await page.locator('.tab-select[aria-selected=true]').getAttribute('id')).slice(4);
    await page.evaluate(id => {
      window.__inspectorOutput = '';
      window.dk.onTerminalData(event => { if (event.id === id) window.__inspectorOutput += event.data; });
    }, terminalId);
    await page.locator('.tree-file[data-relative="nota.txt"]').click();
    await page.locator('.cm-content').click(); await page.keyboard.insertText(' rascunho preservado');
    await page.locator('.dk-editor-dirty[aria-label="Alterações não salvas"]').waitFor();

    if (process.env.DK_PROJECT_INSPECTOR_SCREENSHOT) await page.screenshot({ path: process.env.DK_PROJECT_INSPECTOR_SCREENSHOT });
    for (const [id] of controls) {
      await openProjectPanel(page, id);
      await assertOpened(id);
      assert.equal(await page.locator('#editor-view').isVisible(), true);
      assert.equal(await page.locator(`#pane-${terminalId}`).count(), 1);
      assert.match(await page.locator('.cm-content').innerText(), /rascunho preservado/);
      await page.locator(`#tab-${id}`).click();
      await assertCollapsed();
    }
    assert.equal(fs.readFileSync(path.join(first, 'nota.txt'), 'utf8'), 'Conteúdo original do projeto A\n');
    const aliveCommand = process.platform === 'win32' ? 'echo DK_INSPECTOR_ALIVE\r' : 'printf "\\nDK_INSPECTOR_ALIVE\\n"\r';
    await page.evaluate(({ id, command }) => window.dk.writeTerminal(id, command), { id: terminalId, command: aliveCommand });
    await page.waitForFunction(() => window.__inspectorOutput.includes('DK_INSPECTOR_ALIVE\r\n'));
    console.log('✓ Ícones abrem, alternam e recolhem painéis preservando editor e terminal');

    // A barra continua utilizável na janela mínima, sem ícones recortados ou sobrepostos.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 620));
    await page.waitForFunction(() => innerWidth <= 940);
    await openProjectPanel(page, 'files');
    const geometry = await page.evaluate(ids => ids.map(id => {
      const button = document.getElementById(`tab-${id}`), rect = button.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, hit: target === button || button.contains(target), viewportWidth: innerWidth, viewportHeight: innerHeight };
    }), controls.map(([id]) => id));
    assert.ok(geometry.every(item => item.width >= 24 && item.height >= 24 && item.left >= 0 && item.right <= item.viewportWidth && item.top >= 0 && item.bottom <= item.viewportHeight && item.hit), `Barra inacessível na janela mínima: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.every((item, index) => index === 0 || item.top >= geometry[index - 1].bottom - 1), 'Os ícones não devem se sobrepor.');

    // Cada botão da barra rolável precisa poder ser trazido inteiro à vista;
    // os testes de geometria e hit-test não disparam suas ações.
    const toolbar = page.locator('.terminal-controls');
    const terminalButtons = toolbar.locator('button:visible');
    const buttonLabels = await terminalButtons.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    assert.ok(buttonLabels.includes('Dividir terminal à direita') && buttonLabels.includes('Nova sessão de terminal'));
    assert.ok(buttonLabels.every(Boolean), 'Cada ação visível deve ter nome acessível.');
    for (const label of buttonLabels) {
      const button = toolbar.getByRole('button', { name: label, exact: true });
      assert.equal(await button.count(), 1);
      await button.scrollIntoViewIfNeeded();
      const sample = await button.evaluate(node => {
        const container = node.closest('.terminal-controls');
        const outer = container.getBoundingClientRect(), rect = node.getBoundingClientRect();
        const left = outer.left + container.clientLeft, top = outer.top + container.clientTop;
        const right = left + container.clientWidth, bottom = top + container.clientHeight;
        const points = [['esquerda', rect.left + 2, rect.top + rect.height / 2], ['direita', rect.right - 2, rect.top + rect.height / 2], ['superior', rect.left + rect.width / 2, rect.top + 2], ['inferior', rect.left + rect.width / 2, rect.bottom - 2], ['centro', rect.left + rect.width / 2, rect.top + rect.height / 2]];
        const hits = points.map(([point, x, y]) => {
          const target = document.elementFromPoint(x, y);
          return { point, x, y, hit: target === node || node.contains(target), target: target ? { tag: target.tagName, id: target.id, class: target.getAttribute('class'), label: target.getAttribute('aria-label') } : null };
        });
        const receives = hits.every(result => result.hit);
        return { label: node.getAttribute('aria-label'), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, containerLeft: left, containerRight: right, containerTop: top, containerBottom: bottom, receives, hits };
      });
      assert.ok(sample.left >= sample.containerLeft - 1 && sample.right <= sample.containerRight + 1 && sample.top >= sample.containerTop - 1 && sample.bottom <= sample.containerBottom + 1 && sample.receives, `Ação do terminal inacessível na janela mínima: ${JSON.stringify(sample)}`);
    }
    await toolbar.evaluate(node => { node.scrollLeft = 0; });

    // Teste de ação experimental não dispara Salvar/Recarregar nem modifica o rascunho.
    const editorControls = page.locator('.dk-editor-actions button:visible');
    const editorGeometry = await editorControls.evaluateAll(nodes => {
      const editor = document.querySelector('#editor-view').getBoundingClientRect();
      return nodes.map(node => {
        const rect = node.getBoundingClientRect();
        const points = [[rect.left + 2, rect.top + rect.height / 2], [rect.right - 2, rect.top + rect.height / 2], [rect.left + rect.width / 2, rect.top + 2], [rect.left + rect.width / 2, rect.bottom - 2], [rect.left + rect.width / 2, rect.top + rect.height / 2]];
        const receives = points.every(([x, y]) => { const target = document.elementFromPoint(x, y); return target === node || node.contains(target); });
        return { label: node.getAttribute('aria-label') || node.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, editorLeft: editor.left, editorRight: editor.right, editorTop: editor.top, editorBottom: editor.bottom, receives };
      });
    });
    assert.ok(editorGeometry.some(item => item.label === 'Salvar'), 'Salvar precisa continuar disponível.');
    assert.ok(editorGeometry.every(item => item.left >= item.editorLeft - 1 && item.right <= item.editorRight + 1 && item.top >= item.editorTop - 1 && item.bottom <= item.editorBottom + 1 && item.receives), `Um controle do editor está cortado ou coberto na janela mínima: ${JSON.stringify(editorGeometry)}`);
    for (let index = 0; index < await editorControls.count(); index++) {
      const control = editorControls.nth(index);
      if (await control.isEnabled()) await control.click({ trial: true });
    }
    assert.match(await page.locator('.cm-content').innerText(), /rascunho preservado/);
    assert.equal(fs.readFileSync(path.join(first, 'nota.txt'), 'utf8'), 'Conteúdo original do projeto A\n');
    await page.locator('.dk-editor-dirty[aria-label="Alterações não salvas"]').waitFor();
    if (process.env.DK_PROJECT_INSPECTOR_NARROW_SCREENSHOT) await page.screenshot({ path: process.env.DK_PROJECT_INSPECTOR_NARROW_SCREENSHOT });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));

    // Com o painel aberto, trocar de projeto mostra a Pasta do projeto atual.
    await openProjectPanel(page, 'files');
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, second);
    await openFolderDialog(app);
    await expectProject(second, 'Projeto B oficial');
    await assertOpened('files');
    await page.locator('.tree-file[data-relative="outro.txt"]').waitFor();
    await page.locator('.project-select[title="Projeto A oficial"]').click();
    await expectProject(first, 'Projeto A oficial');
    await assertOpened('files');
    assert.equal(await page.locator('.tree-file[data-relative="nota.txt"]').getAttribute('aria-current'), 'true');
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('rascunho preservado'));
    assert.equal(await page.locator('.dk-editor-dirty[aria-label="Alterações não salvas"]').count(), 1);
    assert.equal(await page.locator(`#pane-${terminalId}`).count(), 1);
    console.log('✓ Janela mínima e troca de projeto preservam identidade, editor e sessões');
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
