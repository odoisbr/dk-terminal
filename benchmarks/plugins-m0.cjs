#!/usr/bin/env node
// Local, isolated comparison for plugins in settings. No plugins are executed.
const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform === 'win32') {
  console.error('Este benchmark requer ps; Windows não foi verificado.');
  process.exit(2);
}
const appRoot = path.resolve(process.env.DK_PLUGIN_BENCH_APP || path.join(__dirname, '..'));
const mode = process.env.DK_PLUGIN_BENCH_MODE === 'control' ? 'control' : 'm0';
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-plugin-bench-')));
const project = path.join(temp, 'projeto'), pluginRoot = path.join(project, '.dk', 'plugins');
fs.mkdirSync(pluginRoot, { recursive: true });
const fixtureShell = path.join(temp, 'shell');
fs.writeFileSync(fixtureShell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then printf "\\0%s\\0" "$PATH"; else exec /bin/sh; fi\n', { mode: 0o755 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let app, page;

function processCounters(pids) {
  const raw = execFileSync('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,rss=,time='], { encoding: 'utf8' });
  const rows = new Map();
  for (const line of raw.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+(?::\d+){1,2}(?:\.\d+)?)\s*$/.exec(line);
    if (!match) continue;
    const seconds = match[3].split(':').reduce((total, part) => total * 60 + Number(part), 0);
    rows.set(Number(match[1]), { rssKiB: Number(match[2]), cpuSeconds: seconds });
  }
  return rows;
}
function makePlugins(count) {
  for (let i = 0; i < count; i++) {
    const id = `measure-${String(i).padStart(2, '0')}`;
    const folder = path.join(pluginRoot, id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ schema: 2, id, name: `Plugin ${i}`, version: '1.0.0', permissions: ['process:spawn'], contributes: { actions: [{ id: 'versao', title: 'Ver versão', command: 'node', args: ['--version'] }] } }));
  }
}
async function sample(label) {
  // Allow startup activity to settle before the baseline sample.
  await sleep(label === 'projeto_em_repouso' ? 30000 : label.startsWith('cursor_') ? 10000 : 5000);
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const metrics = await app.evaluate(({ app }) => ({
      processes: app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type })),
      watchers: globalThis.__dkBenchmarkWatchers.size,
    }));
    const pids = [...new Set(metrics.processes.map(item => item.pid))];
    const before = processCounters(pids), started = process.hrtime.bigint();
    await sleep(1500);
    const after = processCounters(pids), elapsed = Number(process.hrtime.bigint() - started) / 1e9;
    const finalPids = await app.evaluate(({ app }) => app.getAppMetrics().map(item => item.pid));
    const finalSet = new Set(finalPids);
    if (!pids.length || finalSet.size !== pids.length || pids.some(pid => !finalSet.has(pid) || !before.has(pid) || !after.has(pid) || after.get(pid).cpuSeconds < before.get(pid).cpuSeconds)) throw new Error('Processos mudaram durante a amostra; repita a medição.');
    const parts = metrics.processes.map(({ pid, type }) => ({ type,
      memoryMiB: after.get(pid).rssKiB / 1024,
      cpuPercent: 100 * (after.get(pid).cpuSeconds - before.get(pid).cpuSeconds) / elapsed }));
    runs.push({ appMiB: pids.reduce((sum, pid) => sum + after.get(pid).rssKiB, 0) / 1024,
      cpuPercent: 100 * pids.reduce((sum, pid) => sum + after.get(pid).cpuSeconds - before.get(pid).cpuSeconds, 0) / elapsed,
      processCount: pids.length, watchers: metrics.watchers, parts });
  }
  return { label, appMiB: median(runs.map(run => run.appMiB)), cpuPercent: median(runs.map(run => run.cpuPercent)), watchers: median(runs.map(run => run.watchers)), samples: runs };
}

(async () => {
  try {
    app = await electron.launch({ args: [appRoot], env: { ...process.env, SHELL: fixtureShell, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_TEST_DATA: path.join(temp, 'profile'), DK_TERMINAL_DATA_DIR: path.join(temp, 'profile') } });
    page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    await page.locator('#launcher-recents .launcher-recent').first().click();
    await page.locator('.terminal-pane[data-ready=true]').waitFor();
    // persistent:false watchers are not reliably listed by _getActiveHandles.
    // Count only observers created after the project has opened in this fixture.
    await app.evaluate(() => {
      const fs = process.getBuiltinModule('fs'), original = fs.watch, active = new Set();
      fs.watch = function (...args) {
        const watcher = Reflect.apply(original, this, args), close = watcher.close;
        active.add(watcher);
        watcher.close = function (...values) { active.delete(watcher); return Reflect.apply(close, this, values); };
        watcher.once('close', () => active.delete(watcher));
        return watcher;
      };
      globalThis.__dkBenchmarkWatchers = active;
    });
    const samples = [await sample('projeto_em_repouso')], loadMs = {};
    const monitoring = { status: 'nao_exercitado', observations: [], cleanupConfirmed: null, reason: null };
    if (mode === 'm0') {
      const watcherCount = () => app.evaluate(() => globalThis.__dkBenchmarkWatchers.size);
      const settingsSection = () => page.getByTestId('settings-plugins');
      const openSettings = async () => {
        await page.locator('#profile-show').click();
        const section = settingsSection();
        await section.waitFor();
        await section.getByTestId('plugins-status').filter({ hasText: /encontrado/ }).waitFor();
        return section;
      };
      const observeWatchers = async (section, label, expected) => {
        const count = await watcherCount();
        monitoring.observations.push({ label, count, expectedMinimum: expected });
        if (count >= expected) {
          if (monitoring.status === 'nao_exercitado') monitoring.status = 'observado';
          return;
        }
        const errors = await section.getByTestId('plugins-errors').textContent() || '';
        if (/monitoramento de plugins indispon[ií]vel/i.test(errors)) {
          monitoring.status = 'indisponivel'; monitoring.reason = errors.trim(); return;
        }
        throw new Error(`Não foi possível confirmar os observadores em ${label}: ${count}/${expected}.`);
      };
      const closeSettings = async () => {
        await page.locator('#launcher-close').click();
        const deadline = Date.now() + 10000;
        let zeroSince = null;
        while (Date.now() <= deadline) {
          if (await watcherCount() === 0) {
            if (zeroSince === null) zeroSince = Date.now();
            if (Date.now() - zeroSince >= 300) return;
          } else zeroSince = null;
          await sleep(50);
        }
        throw new Error('Observadores não foram encerrados ao sair das configurações.');
      };
      const focusCursor = async animated => {
        await page.locator('.xterm-helper-textarea').focus();
        await page.waitForFunction(wantAnimation => {
          const cursor = document.querySelector('.terminal-pane:not([hidden]) .xterm-cursor');
          return !!cursor && !!document.activeElement?.classList.contains('xterm-helper-textarea') && (getComputedStyle(cursor).animationName !== 'none') === wantAnimation;
        }, animated);
      };
      await page.locator('#toggle-sidebar').focus();
      await page.waitForFunction(() => document.activeElement?.id === 'toggle-sidebar');
      samples.push(await sample('terminal_sem_foco'));
      await focusCursor(false);
      samples.push(await sample('cursor_estatico_antes'));
      let section = await openSettings();
      await observeWatchers(section, 'antes_ativar_cursor', 1);
      await page.getByRole('checkbox', { name: 'Cursor piscando' }).check();
      await closeSettings();
      await focusCursor(true);
      samples.push(await sample('cursor_piscando'));
      section = await openSettings();
      await observeWatchers(section, 'antes_desativar_cursor', 1);
      await page.getByRole('checkbox', { name: 'Cursor piscando' }).uncheck();
      await closeSettings();
      await focusCursor(false);
      samples.push(await sample('cursor_estatico_depois'));
      let started = Date.now();
      const settingsPlugins = await openSettings();
      if (await settingsPlugins.locator('[data-testid="plugin-card"][data-plugin-id^="measure-"]').count() !== 0) throw new Error('A fixture deveria iniciar sem plugins de projeto.');
      loadMs.zero = Date.now() - started;
      await observeWatchers(settingsPlugins, 'zero_plugins', 1);
      samples.push(await sample('configuracoes_abertas_zero_plugins'));
      makePlugins(1);
      started = Date.now();
      await settingsPlugins.getByTestId('plugins-reload').click();
      await settingsPlugins.locator('[data-testid="plugin-card"][data-plugin-id="measure-00"]').waitFor();
      loadMs.one = Date.now() - started;
      await observeWatchers(settingsPlugins, 'um_plugin', 2);
      if (process.env.DK_PLUGIN_BENCH_SCREENSHOT) await page.screenshot({ path: process.env.DK_PLUGIN_BENCH_SCREENSHOT });
      samples.push(await sample('configuracoes_abertas_um_plugin'));
      makePlugins(32);
      started = Date.now();
      await settingsPlugins.getByTestId('plugins-reload').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="settings-plugins"] [data-testid="plugin-card"][data-plugin-id^="measure-"]').length === 32);
      loadMs.thirtyTwo = Date.now() - started;
      await observeWatchers(settingsPlugins, '32_plugins', 33);
      samples.push(await sample('configuracoes_abertas_32_plugins'));
      await closeSettings();
      const closed = await sample('configuracoes_fechadas_32_plugins');
      if (closed.samples.some(run => run.watchers !== 0)) throw new Error('Observadores reapareceram após sair das configurações.');
      if (monitoring.status === 'observado') monitoring.cleanupConfirmed = true;
      samples.push(closed);
    }
    // Close only the fixture shell after measuring, before closing the test app.
    if (await page.locator('#tabs .tab-close').count()) {
      await page.locator('#tabs .tab-close').last().click();
      await page.waitForFunction(() => document.querySelectorAll('#tabs .tab-close').length === 0);
    }
    const closeMessage = await page.locator('#toast').textContent();
    const result = { mode, platform: process.platform, arch: process.arch, samples, loadMs, monitoring, cleanupPartial: /não foi possível confirmar o encerramento/i.test(closeMessage || ''), limits: ['Uma execução, uma janela e um terminal; não representa a variabilidade entre execuções ou máquinas.', 'RSS soma processos Electron e pode duplicar páginas compartilhadas; exclui o shell filho.', 'CPU soma tempo acumulado dos processos Electron por intervalos de 1,5 s; 100% equivale a um núcleo e não à CPU da máquina inteira.', 'A resolução do tempo exibido por ps limita amostras curtas: com centésimos de segundo, um incremento equivale a aproximadamente 0,67 ponto percentual por processo.', 'A lista de PIDs é comparada no início e fim de cada amostra, sem garantir a captura de processos transitórios entre eles.', 'Observadores contam chamadas fs.watch no processo principal instrumentadas após a abertura do projeto; não incluem todos os recursos do sistema.', 'O A/B/A usa a preferência do aplicativo, terminal focado e estilo computado verificado; não mede consumo de energia.', 'Nenhum plugin ou agente foi executado.'] };
    console.log(JSON.stringify(result));
  } finally {
    if (app) {
      // A failed measurement must not leave its disposable shell waiting on a
      // close confirmation. Do not touch any session outside this fixture.
      if (page && !page.isClosed()) await page.evaluate(async () => {
        const ids = [...document.querySelectorAll('#tabs .tab-select[id^="tab-"]')].map(tab => tab.id.slice(4));
        await Promise.all(ids.map(id => window.dk.closeTerminal(id).catch(() => {})));
      }).catch(() => {});
      await app.close();
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
