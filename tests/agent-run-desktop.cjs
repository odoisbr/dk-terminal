const { openFolderDialog } = require('./helpers/open-folder.cjs');
const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// "Tarefa com Claude" (M2) ponta a ponta. A CLI é SEMPRE a falsa de tests/fixtures/agent-run, instalada como `claude`
// num bin temporário que é o único diretório do PATH do app; nenhum provedor real é contatado.
const root = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures', 'agent-run');
const shots = process.env.DK_AGENT_SHOTS || '/private/tmp/claude-501/-Volumes-SEA-Ferramentas-dk-terminal/e5c609ae-d0a1-4110-adf7-7d5cfc25433a/scratchpad/M2';
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-agent-ui-')));
const bin = path.join(temp, 'bin'), emptyBin = path.join(temp, 'bin-vazio');
const dirs = { A: path.join(temp, 'Projeto A'), B: path.join(temp, 'Projeto B'), C: path.join(temp, 'Projeto C') };
for (const folder of [bin, emptyBin, ...Object.values(dirs)]) fs.mkdirSync(folder, { recursive: true });
const logFile = path.join(temp, 'wire.jsonl'), modesFile = path.join(temp, 'modes.json'), binary = path.join(bin, 'claude');
const injection = '<img src=x onerror="window.__injected=1">';
// O modo da CLI falsa é escolhido por projeto (cwd) em tempo de execução; "hostil" reescreve o texto de saída.
const prefix = `const __fs = require('node:fs'); {
  let modes = {}; try { modes = JSON.parse(__fs.readFileSync(${JSON.stringify(modesFile)}, 'utf8')); } catch {}
  const selected = modes[process.cwd()] || 'ok';
  process.env.DK_FAKE_CLAUDE_MODE = selected === 'hostil' ? 'ok' : selected;
  if (selected === 'hostil') { const write = process.stdout.write.bind(process.stdout); const fake = ${JSON.stringify(JSON.stringify(injection).slice(1, -1))};
    process.stdout.write = (chunk, ...rest) => write(typeof chunk === 'string' ? chunk.replaceAll('Resposta ', fake) : chunk, ...rest); }
}\n`;
fs.writeFileSync(binary, `#!${process.execPath}\n${prefix}${fs.readFileSync(path.join(fixtures, 'fake-claude.cjs'), 'utf8')}`, { mode: 0o755 });
fs.copyFileSync(path.join(fixtures, 'claude-help.txt'), path.join(bin, 'claude-help.txt'));
// O app acrescenta diretórios conhecidos (ex.: /opt/homebrew/bin) ao FIM do PATH, onde pode existir um claude real da máquina.
// O bin "vazio" recebe um claude inutilizável que vem antes, para que nenhuma CLI real seja sondada ou usada.
fs.writeFileSync(path.join(emptyBin, 'claude'), '#!/bin/sh\necho "claude indisponível nesta fixture" >&2\nexit 1\n', { mode: 0o755 });
const setModes = modes => fs.writeFileSync(modesFile, JSON.stringify(Object.fromEntries(Object.entries(modes).map(([key, mode]) => [dirs[key], mode]))));
const fixtureShell = path.join(temp, 'shell');
fs.writeFileSync(fixtureShell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(message); await delay(50); }
}
const wire = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const spawns = cwd => wire().filter(e => e.spawn?.includes('-p') && e.cwd === cwd);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const responses = () => wire().filter(e => e.stdin?.type === 'control_response').map(e => e.stdin.response);
const psHas = pid => execFileSync('/bin/ps', ['-axo', 'pid=']).toString().split('\n').some(line => Number(line.trim()) === pid);

async function launch(binDir, profile) {
  const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
  const env = { ...process.env, PATH: binDir, SHELL: fixtureShell, DK_FAKE_CLAUDE_MODE: undefined, DK_TEST_LOG: logFile, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: dirs.A, DK_TERMINAL_DATA_DIR: path.join(temp, profile) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.DK_FAKE_CLAUDE_MODE;
  const app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env });
  const page = await app.firstWindow();
  await page.locator('#startup-loading').waitFor({ state: 'detached' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.locator('#launcher-recents .launcher-recent').first().click();
  await page.locator('#launcher').waitFor({ state: 'hidden' });
  return { app, page };
}
const openProject = async (app, page, dir, name) => {
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, dir);
  await openFolderDialog(app);
  await page.waitForFunction(title => document.getElementById('project-title')?.textContent === title, name);
};
const selectProject = async (page, name) => {
  await page.locator(`.project-select[title="${name}"]`).click();
  await page.waitForFunction(title => document.getElementById('project-title')?.textContent === title, name);
};
const openAgent = async page => {
  if (!await page.locator('#agent-view').isVisible()) {
    if (!await page.locator('#launch-agent').isVisible()) await startProjectTerminal(page);
    await page.locator('#launch-agent').click();
  }
  await page.locator('#agent-view').waitFor({ state: 'visible' });
  await page.locator('#agent-view [data-testid="agent-prompt-input"]').waitFor();
};
const status = page => page.locator('#agent-view [data-testid="agent-status"]').innerText();
const stateIs = (page, text) => until(async () => (await status(page)).includes(text), `Estado esperado "${text}"`);
async function sendPrompt(page, prompt) {
  const view = page.locator('#agent-view');
  const fresh = view.locator('[data-testid="agent-new"]');
  if (await fresh.isEnabled().catch(() => false)) await fresh.click();
  await view.locator('[data-testid="agent-prompt-input"]').fill(prompt);
  await view.locator('[data-testid="agent-submit"]').click();
}
const runsOf = (page, dir) => page.evaluate(folder => window.dk.listAgentRuns(folder), dir);
const pendingApproval = async (page, dir, runId) => page.evaluate(([folder, id]) => window.dk.readAgentRun(folder, id).then(s => s.eventos.find(e => e.type === 'approval' && e.kind === 'tool' && e.status === 'pending')), [dir, runId]);

(async () => {
  if (process.platform === 'win32') { console.log('Ignorado no Windows: a CLI falsa é um executável com shebang.'); return; }
  const apps = [];
  try {
    const first = await launch(bin, 'profile');
    const { app, page } = first; apps.push(app);
    const view = page.locator('#agent-view');

    // 5 (início): execução com prazo mínimo (60 s) no projeto C, para não atrasar os demais cenários.
    setModes({ A: 'ok', B: 'slow', C: 'slow' });
    await openProject(app, page, dirs.C, 'Projeto C');
    await openAgent(page);
    const deadlineRun = await page.evaluate(folder => window.dk.startAgentRun(folder, { provider: 'claude', prompt: 'Execução longa com prazo curto.', prazoMs: 60000 }), dirs.C);
    const deadlineStarted = Date.now();
    await openProject(app, page, dirs.B, 'Projeto B');
    await openProject(app, page, dirs.A, 'Projeto A');

    // 1. Streaming e conclusão; argv sem bypass; binário é a CLI falsa.
    await openAgent(page);
    await sendPrompt(page, 'Faça uma tarefa sintética.');
    await view.locator('[data-testid="agent-stream"]').getByText('Resposta', { exact: false }).first().waitFor({ timeout: 15000 });
    await stateIs(page, 'Concluído');
    assert.match(await view.locator('[data-testid="agent-stream"]').innerText(), /Resposta completa\./);
    const a1 = spawns(dirs.A)[0];
    assert.ok(a1, 'A CLI falsa deve ter sido iniciada no projeto A.');
    assert.equal(a1.executable, binary, 'O binário usado deve ser a CLI falsa instalada no bin temporário.');
    assert.equal(a1.spawn[a1.spawn.indexOf('--permission-mode') + 1], 'manual');
    assert.equal(a1.spawn[a1.spawn.indexOf('--setting-sources') + 1], 'user,local');
    assert.ok(!a1.spawn.some(s => /bypassPermissions|dontAsk|acceptEdits|--dangerously/.test(s)), `argv inseguro: ${a1.spawn}`);
    assert.ok(wire().filter(e => e.spawn).every(e => e.executable === binary));
    console.log('✓ 1 Streaming, conclusão e argv manual/user,local sem bypassPermissions (CLI falsa)');

    // 2. Aprovação: Recusar → deny; nova execução + Permitir → allow.
    setModes({ A: 'approval', B: 'slow', C: 'slow' });
    const card = view.locator('[data-testid="agent-approval-tool"]');
    await sendPrompt(page, 'Preciso de aprovação 1.');
    await card.first().waitFor({ timeout: 15000 });
    assert.equal(await card.getByRole('button', { name: 'Permitir uma vez' }).count(), 1);
    await page.screenshot({ path: path.join(shots, 'agent-1400.png') }).catch(async () => { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'agent-1400.png') }); });
    await card.getByRole('button', { name: 'Recusar' }).click();
    await stateIs(page, 'Concluído');
    await until(() => responses().some(r => r.response?.behavior === 'deny'), 'A CLI falsa deve receber deny.');
    assert.equal(responses().filter(r => r.response?.behavior === 'allow').length, 0);
    await sendPrompt(page, 'Preciso de aprovação 2.');
    await card.first().waitFor({ timeout: 15000 });
    await card.getByRole('button', { name: 'Permitir uma vez' }).click();
    await stateIs(page, 'Concluído');
    await until(() => responses().some(r => r.response?.behavior === 'allow'), 'A CLI falsa deve receber allow.');
    console.log('✓ 2 Cartão Permitir uma vez/Recusar: deny e allow chegam à CLI falsa');

    // 7. Texto hostil literal.
    setModes({ A: 'hostil', B: 'slow', C: 'slow' });
    await sendPrompt(page, 'Saída hostil.');
    await stateIs(page, 'Concluído');
    const streamText = await view.locator('[data-testid="agent-stream"]').innerText();
    assert.ok(streamText.includes(injection), `Texto hostil deve aparecer literal: ${streamText}`);
    assert.equal(await page.evaluate(() => window.__injected), undefined);
    assert.equal(await view.locator('[data-testid="agent-stream"] img').count(), 0);
    console.log('✓ 7 Saída hostil literal; window.__injected indefinido');

    // 4. Interromper execução que ignora SIGTERM.
    setModes({ A: 'cancel-resistant', B: 'slow', C: 'slow' });
    const before = spawns(dirs.A).length;
    await sendPrompt(page, 'Execução resistente.');
    await stateIs(page, 'Claude executando');
    const resistant = spawns(dirs.A)[before].pid;
    assert.ok(alive(resistant));
    await view.locator('[data-testid="agent-cancel"]').click();
    await stateIs(page, 'Interrompido');
    await view.locator('[data-testid="agent-partial-banner"]').waitFor({ state: 'visible' });
    assert.match(await view.locator('[data-testid="agent-partial-banner"]').innerText(), /parcial/i);
    await until(() => !alive(resistant) && !psHas(resistant), 'O processo fake-claude resistente sobreviveu.', 12000);
    console.log('✓ 4 Interromper: estado interrompido, aviso de parcial e nenhum fake-claude sobrevivente');

    // 3. Aprovação pendente isolada por projeto.
    setModes({ A: 'approval', B: 'slow', C: 'slow' });
    await sendPrompt(page, 'Aprovação pendente.');
    await card.first().waitFor({ timeout: 15000 });
    const pendingRun = (await runsOf(page, dirs.A)).find(run => run.estado === 'aguardando_aprovacao');
    assert.ok(pendingRun);
    const approval = await pendingApproval(page, dirs.A, pendingRun.runId);
    assert.ok(approval?.requestId);
    await selectProject(page, 'Projeto B');
    await view.locator('[data-testid="agent-prompt-input"]').waitFor();
    assert.equal(await card.count(), 0, 'Projeto B não pode mostrar o cartão de A.');
    const refused = await page.evaluate(([folder, runId, requestId]) => window.dk.approveAgentRun(folder, runId, requestId, 'allow').then(() => 'aceito', error => String(error.message || error)), [dirs.B, pendingRun.runId, approval.requestId]);
    assert.notEqual(refused, 'aceito', 'approveAgentRun(B, runA, ...) deve ser recusado.');
    assert.equal(responses().length, 2, 'Nenhuma resposta nova pode chegar à CLI.');
    await selectProject(page, 'Projeto A');
    await card.first().waitFor({ timeout: 15000 });
    assert.equal((await runsOf(page, dirs.A)).find(run => run.runId === pendingRun.runId).estado, 'aguardando_aprovacao');
    console.log('✓ 3 Aprovação pendente não vaza para B, é recusada por B e continua em A');

    // 6. Fechar A encerra as execuções de A (aprovação pendente) e preserva a de B.
    const bRun = await page.evaluate(folder => window.dk.startAgentRun(folder, { provider: 'claude', prompt: 'Execução em B.' }), dirs.B);
    await until(async () => (await runsOf(page, dirs.B)).some(run => run.runId === bRun.runId && run.estado === 'executando'), 'A execução de B deve estar executando.');
    const pidsA = spawns(dirs.A).map(e => e.pid).filter(alive), pidB = spawns(dirs.B)[0].pid;
    assert.ok(pidsA.length >= 1 && alive(pidB));
    const row = page.locator('.project-row').filter({ has: page.locator('.project-select[title="Projeto A"]') });
    await row.hover(); await row.locator('.forget-project').click();
    await row.waitFor({ state: 'detached' });
    await until(() => pidsA.every(pid => !alive(pid)), 'Os processos de A devem encerrar ao fechar o projeto.', 12000);
    assert.ok(alive(pidB), 'A execução de B não pode ser afetada.');
    assert.equal((await runsOf(page, dirs.B)).find(run => run.runId === bRun.runId).estado, 'executando');
    console.log('✓ 6 Fechar A encerra as execuções de A e mantém a de B viva');

    // 5. Prazo vencido: cartão com Continuar/Interromper e execução viva sem decisão.
    const wait = deadlineStarted + 62000 - Date.now();
    if (wait > 0) await delay(wait);
    await selectProject(page, 'Projeto C');
    await openAgent(page);
    await view.locator('[data-testid="agent-approval-prazo"]').waitFor({ timeout: 15000 });
    await view.locator('[data-testid="agent-prazo-continue"]').waitFor();
    assert.match(await view.locator('[data-testid="agent-prazo-continue"]').innerText(), /Continuar 15 min/);
    assert.match(await view.locator('[data-testid="agent-prazo-stop"]').innerText(), /Interromper/);
    const cRun = (await runsOf(page, dirs.C)).find(run => run.runId === deadlineRun.runId);
    assert.equal(cRun.estado, 'prazo_vencido');
    assert.ok(alive(spawns(dirs.C)[0].pid), 'Sem decisão, a execução segue viva.');
    console.log('✓ 5 Prazo curto: Continuar 15 min/Interromper e execução viva sem decisão');
    await app.close(); apps.pop();

    // 8. Sem CLI no PATH.
    const second = await launch(emptyBin, 'profile-vazio'); apps.push(second.app);
    await openAgent(second.page);
    await second.page.locator('#agent-view [data-testid="agent-capability"]').waitFor();
    await until(async () => /indispon/i.test(await second.page.locator('#agent-view [data-testid="agent-capability"]').innerText()), 'Indicador de indisponível.');
    assert.ok((await second.page.locator('#agent-view [data-testid="agent-capability-reason"]').innerText()).trim().length > 3, 'Deve haver motivo.');
    const official = second.page.locator('#agent-view [data-testid="agent-open-terminal"]');
    await official.waitFor({ state: 'visible' });
    assert.match(await official.innerText(), /Abrir no terminal oficial/);
    console.log('✓ 8 Sem CLI: indicador de indisponível com motivo e botão Abrir no terminal oficial');
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
