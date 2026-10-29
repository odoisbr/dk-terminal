const { openFolderDialog } = require('./helpers/open-folder.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Barra de etapas e catálogo do kit DK (M1). Kit, projetos e perfil são descartáveis;
// o plugin DK real da máquina nunca é consultado (DK_ROOT aponta o kit falso).
const root = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures', 'stages');
const shots = process.env.DK_STAGES_SHOTS || '/private/tmp/claude-501/-Volumes-SEA-Ferramentas-dk-terminal/e5c609ae-d0a1-4110-adf7-7d5cfc25433a/scratchpad/M1';
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-stages-ui-')));
const bin = path.join(temp, 'bin'), kit = path.join(temp, 'kit'), project = path.join(temp, 'Projeto DK'), plain = path.join(temp, 'Projeto comum');
const marker = path.join(temp, 'entender-executado.txt');
const injection = '<img src=x onerror="window.__injected=1">';
const rtl = '‮soamirp‬ ‏عربي';
for (const folder of [bin, plain]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(plain, 'README.txt'), 'Pasta comum, sem marcadores do DK.\n');
fs.cpSync(path.join(fixtures, 'kit-minimo'), kit, { recursive: true });
fs.writeFileSync(path.join(kit, 'cli', 'dk'), '# cli falso\n');
fs.writeFileSync(path.join(kit, 'skills', 'dk-entender', 'SKILL.md'),
  `---\nname: dk-entender\ndescription: "Porta sintética ${injection} ${rtl}"\n---\nCorpo literal ${injection}\nlinha ${rtl}\n`);
// python3 falso: o SEA Dock executa `python3 <kit>/cli/dk entender ...`; o marcador prova quando rodou.
fs.writeFileSync(path.join(bin, 'python3'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(marker)}\necho '{}'\n`, { mode: 0o755 });
const fixtureShell = path.join(temp, 'shell');
fs.writeFileSync(fixtureShell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });

// Projeto DK v2 completo (fixture "completo") sem o documento de visão, com texto hostil num requisito.
fs.cpSync(path.join(fixtures, 'completo'), project, { recursive: true });
fs.rmSync(path.join(project, 'descoberta', 'visao', 'visao.md'));
fs.writeFileSync(path.join(project, 'projeto.yml'), fs.readFileSync(path.join(project, 'projeto.yml'), 'utf8').replace('Completo sintético', 'Projeto DK sintético'));
const requirementsFile = path.join(project, 'dados', 'requisitos.json');
const requirements = JSON.parse(fs.readFileSync(requirementsFile, 'utf8'));
requirements.items[0].title = `${injection} ${rtl}`;
requirements.items.push({ id: 'RF-002', title: `Segundo ${injection}`, type: 'RF', status: 'aprovado', sources: ['EVD-001', `FANTASMA-${injection}`] });
fs.writeFileSync(requirementsFile, JSON.stringify(requirements, null, 2));

// O app também consulta `python3 --version`; só `entender` conta como a ação.
const ran = () => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').split('\n').includes('entender');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(message); await delay(50); }
}
const barStates = page => page.locator('#stage-bar [data-testid="stage-button"]').evaluateAll(items => items.map(item => ({
  id: item.dataset.stage, name: item.querySelector('.stage-name').textContent, state: item.querySelector('.stage-state-text').textContent,
})));
const activeId = page => page.evaluate(() => document.activeElement?.dataset?.stage || document.activeElement?.id || document.activeElement?.tagName);

let app;
(async () => {
  if (process.platform === 'win32') { console.log('Ignorado no Windows: o python3 falso é um script sh.'); return; }
  try {
    const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
    const env = { ...process.env, PATH: bin, SHELL: fixtureShell, DK_ROOT: kit, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile') };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env });
    const page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await page.evaluate(() => {
      window.__stageEvents = [];
      window.dk.onStagesChanged(event => window.__stageEvents.push({ path: event.path, at: Date.now() }));
    });
    await page.locator('#launcher-recents .launcher-recent').first().click();
    await page.locator('#launcher').waitFor({ state: 'hidden' });
    const bar = page.locator('#stage-bar');
    await bar.waitFor({ state: 'visible' });
    const buttons = bar.locator('[data-testid="stage-button"]');

    // 1. Quatro etapas, estados textuais; projeto comum esconde a barra.
    await until(async () => (await barStates(page)).every(item => item.state && !/Carregando/i.test(item.state)), 'A barra não saiu do carregamento.');
    const states = await barStates(page);
    assert.deepEqual(states.map(item => item.id), ['levantar', 'entender', 'entregar', 'prototipar']);
    assert.deepEqual(states.map(item => item.name), ['Levantar', 'Entender', 'Entregar', 'Prototipar']);
    assert.ok(states.every(item => /^[A-Za-zÀ-ÿ ]{3,}$/.test(item.state)), `Estados devem ser textuais: ${JSON.stringify(states)}`);
    assert.ok(!states.every(item => item.state === states[0].state), 'Os estados devem refletir os registros.');
    const snapshot = await page.evaluate(dir => window.dk.readStages(dir), project);
    assert.equal(snapshot.isDk, true); assert.ok(snapshot.kit, 'O kit falso deve estar conectado.');
    assert.equal(snapshot.stages.length, 4);
    const d2 = () => page.evaluate(dir => window.dk.readStages(dir, true).then(s => s.stages.find(x => x.id === 'entregar').criterios.find(c => c.id === 'D2').estado), project);
    assert.equal(await d2(), 'pendente', 'Sem documento de visão, D2 deve estar pendente.');
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, plain);
    await openFolderDialog(app);
    await page.waitForFunction(() => document.getElementById('project-title')?.textContent === 'Projeto comum');
    await bar.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#catalog-panel, [data-testid="catalog-panel"]').first().isVisible().catch(() => false), false);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, project);
    await openFolderDialog(app);
    await page.waitForFunction(() => document.getElementById('project-title')?.textContent?.startsWith('Projeto DK'));
    await bar.waitFor({ state: 'visible' });
    await until(async () => (await barStates(page)).every(item => item.state), 'A barra não voltou ao projeto DK.');
    console.log('✓ 1 Barra com 4 etapas e estados textuais; projeto comum oculta a barra');

    // 4. Texto hostil aparece literal (detalhes de todas as etapas e catálogo).
    for (let index = 0; index < 4; index++) {
      await buttons.nth(index).click();
      await bar.locator('[data-testid="stage-details"]').waitFor({ state: 'visible' });
    }
    await buttons.nth(1).click();
    await bar.locator('[data-testid="stage-criterion"]').first().waitFor();
    const hostile = await bar.locator('[data-testid="stage-details"]').innerText();
    assert.ok(hostile.includes(`FANTASMA-${injection}`), 'A referência hostil do registro deve aparecer literal.');
    assert.ok(hostile.includes(injection) && hostile.includes(rtl), 'A descrição hostil da skill deve aparecer literal, com RTL.');
    assert.equal(await page.evaluate(() => window.__injected), undefined);
    assert.equal(await bar.locator('img').count(), 0, 'Nenhum elemento img pode nascer do texto do registro.');
    console.log('✓ 4a Registro hostil: nenhum HTML interpretado, window.__injected indefinido');
    await buttons.nth(1).click();

    // 5. Teclado: Tab chega à barra, setas movem, Enter abre, Esc fecha e devolve o foco.
    await page.evaluate(() => document.getElementById('new-session').focus());
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => !!document.activeElement?.closest('#stage-bar') && document.activeElement.dataset.testid === 'stage-button'); }
    assert.ok(reached, 'Tab deve chegar a um botão de etapa.');
    await page.locator('#stage-bar [data-testid="stage-button"]').first().focus();
    assert.equal(await activeId(page), 'levantar');
    await page.keyboard.press('ArrowRight'); assert.equal(await activeId(page), 'entender');
    await page.keyboard.press('ArrowRight'); assert.equal(await activeId(page), 'entregar');
    await page.keyboard.press('ArrowLeft'); assert.equal(await activeId(page), 'entender');
    await page.keyboard.press('Enter');
    const details = bar.locator('[data-testid="stage-details"]');
    await details.waitFor({ state: 'visible' });
    assert.equal(await buttons.nth(1).getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    await details.waitFor({ state: 'hidden' });
    assert.equal(await activeId(page), 'entender', 'Esc deve devolver o foco ao botão da etapa.');
    console.log('✓ 5 Teclado: Tab, setas, Enter abre e Esc fecha devolvendo o foco');

    // 7. Correção: etapa bloqueada fica desabilitada; ação só roda após clique.
    await buttons.nth(3).click();
    const blockedFix = details.locator('[data-testid="stage-fix"]');
    await blockedFix.first().waitFor();
    const blockedStage = snapshot.stages.find(item => item.id === 'prototipar');
    assert.equal(blockedStage.liberada, false, 'Prototipar deve estar bloqueada enquanto Entregar estiver pendente.');
    assert.ok((await blockedFix.evaluateAll(items => items.every(item => item.disabled))), 'Correções de etapa bloqueada devem estar desabilitadas.');
    await buttons.nth(3).click();
    await buttons.nth(1).click();
    const entenderFix = details.locator('[data-testid="stage-fix"][data-fix-kind="action"]').first();
    await entenderFix.waitFor();
    assert.equal(await entenderFix.isEnabled(), true);
    await delay(800);
    assert.equal(ran(), false, 'Abrir detalhes e carregar não podem executar a ação.');
    await entenderFix.click();
    await until(ran, 'A ação entender não executou após o clique.');
    const argv = fs.readFileSync(marker, 'utf8').split('\n');
    assert.ok(argv.includes('entender') && argv.includes(path.join(kit, 'cli', 'dk')), `Argumentos inesperados: ${argv.join(' ')}`);
    console.log('✓ 7 Correção bloqueada desabilitada; dk entender só roda após clique');
    await page.locator('#cancel-action').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    await bar.waitFor({ state: 'visible' });
    if (await details.isVisible()) await page.keyboard.press('Escape');

    // 8. Catálogo.
    await page.locator('#stage-bar [data-testid="stage-catalog-toggle"]').click();
    const panel = page.locator('[data-testid="catalog-panel"]');
    await panel.waitFor({ state: 'visible' });
    const entry = panel.locator('[data-testid="catalog-entry"][data-entry-name="dk-entender"]');
    await entry.first().waitFor({ timeout: 10000 });
    assert.ok(await panel.locator('[data-testid="catalog-entry"]').count() >= 3, 'O catálogo deve listar as skills do kit falso.');
    await entry.first().click();
    const body = panel.locator('pre[data-testid="catalog-body"]');
    await body.waitFor();
    await until(async () => (await body.innerText()).includes('Corpo literal'), 'O leitor não carregou o corpo da skill.');
    const text = await body.innerText();
    assert.ok(text.includes('Corpo literal') && text.includes(injection), 'O corpo deve aparecer literal em <pre>.');
    assert.ok(text.includes(rtl), 'Caracteres RTL devem permanecer no texto.');
    assert.equal(await page.evaluate(() => window.__injected), undefined);
    assert.equal(await panel.locator('img').count(), 0);
    assert.equal(await page.locator('body img[src="x"]').count(), 0);
    console.log('✓ 8 Catálogo lista a skill do kit e o leitor mostra o corpo em <pre> (4b texto hostil literal)');
    await page.screenshot({ path: path.join(shots, 'stages-1400.png') });
    await page.locator('[data-testid="catalog-close"]').click();

    // 6. 1000x700 sem overflow horizontal.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    await page.waitForFunction(() => window.innerWidth <= 1000);
    await delay(300);
    for (const open of [false, true]) {
      if (open) await buttons.nth(0).click();
      const overflow = await page.evaluate(() => {
        const nodes = ['#stage-bar', '#stage-bar .stage-bar-row', '#stage-bar .stage-buttons', '#stage-bar [data-testid="stage-details"]'].map(selector => document.querySelector(selector)).filter(node => node && !node.hidden);
        return nodes.map(node => ({ id: node.className || node.id, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
      });
      for (const item of overflow) assert.ok(item.scrollWidth <= item.clientWidth, `Overflow horizontal em ${JSON.stringify(item)}`);
    }
    await page.screenshot({ path: path.join(shots, 'stages-1000.png') });
    await buttons.nth(0).click();
    console.log('✓ 6 Janela 1000×700 sem overflow horizontal na barra');

    // 2. Documento de visão (D2): evento e mudança visível em até 3 s.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await page.evaluate(() => { window.__stageEvents.length = 0; });
    await buttons.nth(2).click();
    const d2Row = details.locator('[data-testid="stage-criterion"][data-criterion-id="D2"]');
    await d2Row.waitFor();
    const before = await d2Row.innerText();
    const visionDir = path.join(project, 'descoberta', 'visao');
    fs.mkdirSync(visionDir, { recursive: true });
    const started = Date.now();
    fs.writeFileSync(path.join(visionDir, 'visao.md'), '# Visão\n\nObjetivo do usuário no escopo.\n');
    await until(() => page.evaluate(() => window.__stageEvents.length > 0), 'stages:changed não chegou.', 3000);
    await until(async () => (await d2Row.innerText()) !== before, 'D2 não mudou na tela.', 3000 - (Date.now() - started) > 0 ? 3000 - (Date.now() - started) : 100);
    assert.ok(Date.now() - started <= 3500);
    assert.equal(await d2(), 'concluido');
    console.log(`✓ 2 Documento de visão cria evento e muda D2 em ${Date.now() - started} ms`);
    await buttons.nth(2).click();

    // 3. Fechar o projeto: nenhum stages:changed em 1,5 s.
    const row = page.locator('.project-row').filter({ hasText: 'Projeto DK' });
    await row.hover(); await row.locator('.forget-project').click();
    await page.locator('#launcher.launcher-workspace').waitFor();
    await bar.waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.__stageEvents.length = 0; });
    fs.writeFileSync(path.join(project, 'dados', 'novo.txt'), 'x');
    fs.writeFileSync(path.join(project, 'descoberta', 'visao', 'visao.md'), '# Visão alterada\n');
    fs.writeFileSync(path.join(project, 'projeto.yml'), fs.readFileSync(path.join(project, 'projeto.yml'), 'utf8') + 'responsavel: Fulano\n');
    await delay(1500);
    assert.equal(await page.evaluate(() => window.__stageEvents.length), 0, 'Projeto fechado não pode emitir stages:changed.');
    console.log('✓ 3 Projeto fechado não emite stages:changed em 1,5 s');
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
