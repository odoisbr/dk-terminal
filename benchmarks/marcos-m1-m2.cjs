#!/usr/bin/env node
// Medição local de M1/M2: dist, perfil/kit/projeto descartáveis e Claude falso.
const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startProjectTerminal } = require('../tests/helpers/project-session.cjs');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--gravar')) {
  console.error('Uso: node benchmarks/marcos-m1-m2.cjs [--gravar]');
  process.exit(2);
}
if (process.platform !== 'darwin') {
  console.error('Este benchmark requer macOS (darwin): a medição de CPU usa a resolução de ps do macOS.');
  process.exit(2);
}
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('Compile o app com npm run build antes de medir.');
  process.exit(2);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const restMs = 5000, intervalMs = 1500, sampleCount = 3;
let app, page, temp, result, launchPromise, cleanupPromise, interrupted = false;
const samples = [], limits = [
  'Uma execução sequencial em uma máquina; não mede variabilidade entre execuções nem consumo de energia.',
  'A carga externa do sistema não é controlada; loadAverage e freeMemoryBytes são registrados no início de cada cenário.',
  'RSS soma processos Electron e pode duplicar páginas compartilhadas; exclui shells e outros filhos externos.',
  'CPU é a média do tempo acumulado por ps no macOS em intervalos de 1,5 s; 100% corresponde a um núcleo.',
  'A resolução de ps limita amostras curtas: 0,01 s equivale a aproximadamente 0,67 ponto percentual por processo.',
  'PIDs Electron são conferidos nos extremos de cada amostra, com uma repetição se mudarem; processos transitórios podem escapar. Filhos são contados no fim do intervalo.',
  'childCount conta descendentes externos ao Electron; descendantCount inclui também os descendentes Electron.',
  'A tarefa concluída mantém uma sessão sh ociosa; os dois cenários de projeto anteriores não têm terminal.',
  'CLI e kit sintéticos, DNS externo desabilitado e requisições HTTP/WebSocket bloqueadas; não mede Claude real.',
  'As medianas por PID usam somente as amostras em que o PID foi observado; sampleCount registra essa cobertura.',
];
function warn(message) { console.error(message); limits.push(message); }
function writeResult(error) {
  if (!result) return;
  result.finished = new Date().toISOString();
  result.status = error ? 'incomplete' : 'complete';
  if (error) result.error = error.message;
  const json = JSON.stringify(result, null, 2);
  if (args.includes('--gravar')) fs.writeFileSync(path.join(__dirname, `marcos-m1-m2-${process.platform}-${result.started.slice(0, 10)}.json`), json + '\n');
  console.log(json);
}
function newestSource(dir) {
  let newest = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const candidate = entry.isDirectory() ? newestSource(file) : entry.isFile() ? { path: path.relative(root, file), mtimeMs: fs.statSync(file).mtimeMs } : null;
    if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) newest = candidate;
  }
  return newest;
}

function processTable() {
  const raw = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  const rows = new Map();
  for (const line of raw.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d+)-)?(\d+(?::\d+){1,2}(?:\.\d+)?)\s+(.+)$/.exec(line);
    if (!match) continue;
    const cpuSeconds = Number(match[4] || 0) * 86400 + match[5].split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
    rows.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), cpuSeconds, command: match[6].trim() });
  }
  return rows;
}
function descendants(rows, mainPid) {
  const children = new Map();
  for (const row of rows.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const found = new Set(), pending = [mainPid];
  while (pending.length) {
    for (const pid of children.get(pending.pop()) || []) {
      if (pid === mainPid || found.has(pid)) continue;
      found.add(pid); pending.push(pid);
    }
  }
  return found;
}
const metrics = () => app.evaluate(({ app }) => app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type })));
async function sample(label) {
  const scenario = { label, at: new Date().toISOString(), loadAverage: os.loadavg(), freeMemoryBytes: os.freemem(), samples: [], pidChanges: [] };
  samples.push(scenario);
  const logicalCpus = os.cpus().length;
  if (scenario.loadAverage[0] > logicalCpus * 0.5) warn(`${label}: load1 ${scenario.loadAverage[0]} excede 50% dos ${logicalCpus} CPUs lógicos; a carga externa pode afetar a medição.`);
  // Mesmo intervalo de CPU do M0; nenhuma coleta de lixo ou limpeza manual.
  await sleep(restMs);
  const runs = scenario.samples;
  for (let index = 0; index < sampleCount; index++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const processes = await metrics(), pids = [...new Set(processes.map(item => item.pid))];
      const before = processTable(), started = process.hrtime.bigint();
      await sleep(intervalMs);
      const after = processTable(), elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      const final = new Set((await metrics()).map(item => item.pid));
      if (!pids.length || final.size !== pids.length || pids.some(pid => !final.has(pid) || !before.has(pid) || !after.has(pid) || after.get(pid).cpuSeconds < before.get(pid).cpuSeconds)) {
        scenario.pidChanges.push({ index, attempt: attempt + 1, at: new Date().toISOString(), elapsedSeconds,
          initialPids: pids, finalPids: [...final], before: pids.map(pid => before.get(pid) || { pid, missing: true }),
          after: [...new Set([...pids, ...final])].map(pid => after.get(pid) || { pid, missing: true }),
        });
        if (attempt === 0) { console.error(`Processos Electron mudaram durante ${label}; repetindo a amostra ${index + 1}.`); continue; }
        throw new Error(`Processos Electron mudaram duas vezes durante ${label}; amostras parciais preservadas.`);
      }
      const parts = pids.map(pid => ({ pid, type: processes.find(item => item.pid === pid).type,
        memoryMiB: after.get(pid).rssKiB / 1024,
        cpuPercent: 100 * (after.get(pid).cpuSeconds - before.get(pid).cpuSeconds) / elapsedSeconds,
      }));
      const childPids = descendants(after, app.process().pid);
      // childCount exclui Electron, como o benchmark de recursos; descendantCount
      // inclui todos os descendentes, inclusive renderers/GPU/utilitários Electron.
      const children = [...childPids].filter(pid => !final.has(pid)).map(pid => ({ pid, ppid: after.get(pid).ppid, command: after.get(pid).command }));
      runs.push({ at: new Date().toISOString(), elapsedSeconds,
        appMiB: parts.reduce((sum, part) => sum + part.memoryMiB, 0),
        cpuPercent: parts.reduce((sum, part) => sum + part.cpuPercent, 0),
        processCount: pids.length, childCount: children.length, descendantCount: childPids.size, parts, children,
      });
      break;
    }
  }
  const parts = [];
  for (const pid of new Set(runs.flatMap(run => run.parts.map(part => part.pid)))) {
    const observed = runs.flatMap(run => run.parts.filter(part => part.pid === pid));
    parts.push({ pid, type: observed[0].type, sampleCount: observed.length,
      memoryMiB: median(observed.map(part => part.memoryMiB)), cpuPercent: median(observed.map(part => part.cpuPercent)),
    });
  }
  return Object.assign(scenario, Object.fromEntries(['appMiB', 'cpuPercent', 'processCount', 'childCount', 'descendantCount'].map(key => [key, median(runs.map(run => run[key]))])), { parts });
}

async function withTimeout(operation, ms) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tempo de limpeza excedido.')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function terminateTree(mainPid, knownPids) {
  const pids = new Set([...knownPids, ...descendants(processTable(), mainPid), mainPid]);
  const alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  // Descendentes primeiro; a lista anterior ao close também inclui órfãos.
  for (const pid of [...pids].reverse().filter(pid => pid !== mainPid).concat(mainPid)) {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 3000;
  while ([...pids].some(alive) && Date.now() < deadline) await sleep(50);
  if ([...pids].some(alive)) throw new Error(`Árvore de PID ${mainPid} ainda ativa; temporários preservados em ${temp}.`);
}
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    // Um sinal pode chegar enquanto o Playwright ainda está iniciando o app.
    if (!app && launchPromise) app = await launchPromise.catch(() => null);
    if (app) {
      const mainPid = app.process().pid, knownPids = descendants(processTable(), mainPid);
      if (page && !page.isClosed()) await withTimeout(page.evaluate(async () => {
        const ids = [...document.querySelectorAll('#tabs .tab-select[id^="tab-"]')].map(tab => tab.id.slice(4));
        await Promise.all(ids.map(id => window.dk.closeTerminal(id).catch(() => {})));
      }), 3000).catch(() => {});
      try { await withTimeout(app.close(), 5000); }
      catch (error) {
        console.error(`Falha em app.close(): ${error.message}; encerrando a árvore por PID.`);
        await terminateTree(mainPid, knownPids);
      }
    }
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

async function main() {
  const started = new Date().toISOString();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  const workingTree = dirty ? {
    diffHeadSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).digest('hex'),
    untrackedFiles: execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean),
  } : null;
  const distMtimeMs = fs.statSync(path.join(root, 'dist', 'index.html')).mtimeMs;
  const newest = [newestSource(path.join(root, 'src')), newestSource(path.join(root, 'electron'))]
    .filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (newest && distMtimeMs < newest.mtimeMs) warn(`dist/index.html é mais antigo que ${newest.path}; execute npm run build para medir o código atual.`);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  result = { benchmark: 'marcos-m1-m2', commit, dirty, workingTree, version, started,
    platform: process.platform, arch: process.arch,
    build: { distMtimeMs, newestSource: newest },
    environment: { os: os.type(), release: os.release(), osVersion: os.version(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
      totalMemoryMiB: os.totalmem() / 1024 ** 2, freeMemoryMiB: os.freemem() / 1024 ** 2, loadAverage: os.loadavg(), benchmarkNode: process.version },
    protocol: { restMs, intervalMs, sampleCount, window: { width: 1400, height: 900 }, cli: 'tests/fixtures/agent-run/fake-claude.cjs', kit: 'tests/fixtures/stages/kit-minimo', project: 'tests/fixtures/stages/completo' },
    samples, checks: {}, limits,
  };
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-marcos-bench-')));
  try {
    const project = path.join(temp, 'Projeto DK'), kit = path.join(temp, 'kit'), bin = path.join(temp, 'bin');
    const fixtures = path.join(root, 'tests', 'fixtures');
    fs.cpSync(path.join(fixtures, 'stages', 'completo'), project, { recursive: true });
    fs.cpSync(path.join(fixtures, 'stages', 'kit-minimo'), kit, { recursive: true });
    fs.mkdirSync(bin);
    const binary = path.join(bin, 'claude'), logFile = path.join(temp, 'fake-claude.jsonl');
    // Força modo ok mesmo se o ambiente do orquestrador contiver flags de teste.
    fs.writeFileSync(binary, `#!${process.execPath}\nfor (const key of Object.keys(process.env)) if (key.startsWith('DK_FAKE_')) delete process.env[key];\n${fs.readFileSync(path.join(fixtures, 'agent-run', 'fake-claude.cjs'), 'utf8')}`, { mode: 0o755 });
    fs.copyFileSync(path.join(fixtures, 'agent-run', 'claude-help.txt'), path.join(bin, 'claude-help.txt'));
    const fixtureShell = path.join(temp, 'shell');
    fs.writeFileSync(fixtureShell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });
    const profile = path.join(temp, 'profile');
    const env = { ...process.env, SHELL: fixtureShell, PATH: bin, DK_ROOT: kit, DK_TEST_LOG: logFile,
      DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_TEST_DATA: profile, DK_TERMINAL_DATA_DIR: profile,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SEA_DOCK_DEBUG;
    launchPromise = electron.launch({ args: [root, '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'], env });
    app = await launchPromise;
    if (interrupted) return;
    await app.evaluate(({ session, dialog, BrowserWindow }) => {
      globalThis.__dkBenchmarkBlockedRequests = 0;
      const blockNetwork = current => current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => {
        globalThis.__dkBenchmarkBlockedRequests++; callback({ cancel: true });
      });
      blockNetwork(session.defaultSession);
      for (const window of BrowserWindow.getAllWindows()) if (window.webContents.session !== session.defaultSession) blockNetwork(window.webContents.session);
      // Resposta 1 confirma o encerramento das sessões descartáveis.
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    assert.ok(page.url().startsWith('dk-app://app/'), 'O app deve carregar o dist local.');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await page.locator('#launcher').waitFor({ state: 'visible' });
    await sample('repouso_sem_projeto');

    await page.locator('#launcher-recents .launcher-recent').first().click();
    await page.locator('#launcher').waitFor({ state: 'hidden' });
    await page.locator('#stage-bar').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const states = [...document.querySelectorAll('#stage-bar .stage-state-text')];
      return states.length === 4 && states.every(item => item.textContent.trim() && !/Carregando/i.test(item.textContent));
    });
    await sample('projeto_dk_barra_visivel');

    await page.getByTestId('stage-catalog-toggle').click();
    const panel = page.getByTestId('catalog-panel');
    await panel.waitFor({ state: 'visible' });
    await panel.locator('[data-testid="catalog-entry"][data-entry-name="dk-entender"]').first().waitFor();
    await sample('catalogo_aberto');
    await page.getByTestId('catalog-close').click();
    await panel.waitFor({ state: 'hidden' });

    // O botão de tarefa fica na toolbar do terminal. Há uma única sessão sh
    // ociosa nesta etapa; ela é encerrada junto com o projeto.
    await startProjectTerminal(page);
    await page.locator('#launch-agent').click();
    const view = page.locator('#agent-view');
    await view.waitFor({ state: 'visible' });
    await view.getByTestId('agent-prompt-input').fill('Faça uma tarefa sintética de medição.');
    await view.getByTestId('agent-submit').click();
    await view.getByTestId('agent-status').filter({ hasText: 'Concluído' }).waitFor({ timeout: 30000 });
    assert.match(await view.getByTestId('agent-stream').innerText(), /Resposta completa\./);
    const wire = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const spawns = wire.filter(event => event.spawn);
    assert.ok(spawns.length > 0 && spawns.every(event => event.executable === binary), 'Somente a CLI falsa deve ser usada.');
    assert.equal(spawns.filter(event => event.spawn.includes('-p') && event.cwd === project).length, 1);
    assert.ok(wire.some(event => event.result === true));
    result.checks.fakeClaudeCompleted = true;
    const task = await sample('tarefa_claude_concluida');
    result.checks.idleShellInTaskScenario = task.samples.every(run => run.childCount === 1 && path.basename(run.children[0].command) === 'sh');

    const row = page.locator('.project-row');
    await row.hover(); await row.locator('.forget-project').click();
    await row.waitFor({ state: 'detached' });
    await page.locator('#launcher.launcher-workspace').waitFor();
    await page.locator('#stage-bar').waitFor({ state: 'hidden' });
    await view.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.terminal-pane').count(), 0);
    await sample('apos_fechar_projeto');
    result.checks.noExternalChildrenAfterClose = samples.at(-1).childCount === 0;

    const runtime = await app.evaluate(({ app }) => ({ appVersion: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, blockedRequests: globalThis.__dkBenchmarkBlockedRequests }));
    Object.assign(result.environment, runtime);
    await cleanup();
    if (!interrupted) writeResult();
  } catch (error) {
    if (!interrupted) writeResult(error);
    throw error;
  } finally {
    await cleanup();
  }
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => {
  interrupted = true;
  cleanup().catch(error => console.error(error)).finally(() => {
    try { writeResult(new Error(`Medição interrompida por ${signal}; amostras parciais preservadas.`)); }
    finally { process.exit(code); }
  });
});
main().catch(error => { if (!interrupted) { console.error(error); process.exitCode = 1; } });
