const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { GUIDE_START, GUIDE_END } = require('../electron/agent-guide.cjs');

// Guia do SEA Dock para IAs: Claude Code e Antigravity simulados, abertos pelos
// botões, recebem o guia por argumento; `dock-agents` imprime o guia numa sessão;
// a gravação no AGENTS.md pede confirmação e grava só o bloco delimitado.
const root = path.resolve(__dirname, '..'), guideFile = path.join(root, 'dock-tools', 'agents', 'AGENTS.md'), guide = fs.readFileSync(guideFile, 'utf8');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-agents-guide-'))), project = path.join(temp, 'Projeto'), bin = path.join(temp, 'bin'), record = path.join(temp, 'record'), home = path.join(temp, 'home');
for (const dir of [project, bin, record, home]) fs.mkdirSync(dir);
for (const cmd of ['claude', 'agy', 'codex']) fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh\n# Consultas do app (plugin, --version) não são o lançamento pelo botão.\ncase "$1" in plugin|--version|mcp|app-server) exit 0;; esac\n: > '${record}/${cmd}.args'\nfor a in "$@"; do printf '%s\\000' "$a" >> '${record}/${cmd}.args'; done\nprintf '%s' "$SEA_DOCK_AGENTS_MD" > '${record}/${cmd}.env'\n`, { mode: 0o755 });
const shell = path.join(temp, 'shell'); fs.writeFileSync(shell, `#!/bin/sh\nif [ "$1" = "-lc" ]; then printf '\\000%s\\000' "$PATH"; else exec /bin/zsh -f; fi\n`, { mode: 0o755 });
const recorded = cmd => fs.readFileSync(path.join(record, `${cmd}.args`), 'utf8').split('\0').slice(0, -1);
async function until(fn, description, timeout = 20000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw new Error(description); await new Promise(r => setTimeout(r, 100)); } }
let app;
(async () => {
  app = await electron.launch({ args: [root], env: { ...process.env, HOME: home, SHELL: shell, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile') }, timeout: 60000 });
  const page = await app.firstWindow(); await page.locator('#startup-loading').waitFor({ state: 'detached' });
  await page.locator('.project-select').click();
  await startProjectTerminal(page);

  // Botões: a CLI recebe o guia por argumento e a sessão exporta SEA_DOCK_AGENTS_MD.
  await page.locator('#launch-claude').click();
  await until(() => fs.existsSync(path.join(record, 'claude.env')), 'O Claude simulado não foi iniciado.');
  const claude = recorded('claude');
  assert.equal(claude[0], '--append-system-prompt-file');
  assert.equal(fs.readFileSync(claude[1], 'utf8'), guide);
  assert.equal(fs.readFileSync(path.join(record, 'claude.env'), 'utf8'), guideFile);
  await page.locator('#launch-antigravity').click();
  await until(() => fs.existsSync(path.join(record, 'agy.env')), 'O Antigravity simulado não foi iniciado.');
  assert.deepEqual(recorded('agy'), ['--add-dir', path.dirname(guideFile)]);
  // Split com agente usa o mesmo caminho: Codex recebe developer_instructions.
  await page.locator('#split-agent').click();
  await page.getByRole('menuitem', { name: 'Codex à direita' }).click();
  await until(() => fs.existsSync(path.join(record, 'codex.env')), 'O Codex simulado não foi iniciado pelo split.');
  const codex = recorded('codex');
  assert.equal(codex[0], '-c'); assert.equal(JSON.parse(codex[1].slice('developer_instructions='.length)), guide);

  // dock-agents numa sessão comum imprime o guia.
  await page.locator('#new-session').click();
  await page.locator('.terminal-pane[data-ready="true"]:visible').last().waitFor();
  await page.evaluate(() => { window.__output = ''; window.dk.onTerminalData(e => { window.__output += e.data; }); });
  const id = (await page.locator('.tab-select[aria-selected="true"]').getAttribute('id')).slice(4);
  // Digitar antes do primeiro prompt faz o zsh descartar a entrada às vezes; espere o shell responder.
  await page.evaluate(id => window.dk.writeTerminal(id, 'echo pronto-$((40+2))\r'), id);
  await page.waitForFunction(() => /pronto-42/.test(window.__output), null, { timeout: 20000 });
  await page.evaluate(({ id, command }) => window.dk.writeTerminal(id, command + '\r'), { id, command: `dock-agents > '${record}/dock-agents.txt'; echo "saida=$?"` });
  await page.waitForFunction(() => /saida=0/.test(window.__output), null, { timeout: 20000 });
  assert.equal(fs.readFileSync(path.join(record, 'dock-agents.txt'), 'utf8'), guide);

  // Gravar no projeto: cancelar não grava; confirmar grava só o bloco e preserva o resto.
  const own = '# Meu projeto\n\nRegras da equipe.\n', agents = path.join(project, 'AGENTS.md');
  fs.writeFileSync(agents, own);
  const answer = response => app.evaluate(({ dialog }, response) => { globalThis.__guideDialogs = globalThis.__guideDialogs || []; dialog.showMessageBox = async (_window, options) => { globalThis.__guideDialogs.push(options); return { response }; }; }, response);
  const dialogs = () => app.evaluate(() => globalThis.__guideDialogs || []);
  await page.locator('#tab-services').click();
  const control = page.locator('#agents-guide-write');
  await control.waitFor({ state: 'visible' });
  assert.ok((await control.boundingBox()).height >= 44);
  await answer(1); await control.click();
  await until(async () => (await dialogs()).length === 1, 'A confirmação não apareceu.');
  const asked = (await dialogs())[0];
  assert.ok(asked.detail.includes(agents) && asked.detail.includes(`${GUIDE_START}\n${guide.trim()}\n${GUIDE_END}`), 'A confirmação precisa mostrar o arquivo e o bloco.');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(fs.readFileSync(agents, 'utf8'), own, 'Cancelar não pode gravar.');
  await answer(0); await control.click();
  await until(() => fs.readFileSync(agents, 'utf8') !== own, 'O bloco não foi gravado.');
  assert.equal(fs.readFileSync(agents, 'utf8'), `${own}\n${GUIDE_START}\n${guide.trim()}\n${GUIDE_END}\n`);
  await control.click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('já tem o guia do SEA Dock atualizado'), null, { timeout: 10000 });
  assert.equal((await dialogs()).length, 2, 'Com o guia atualizado, não há nova confirmação.');
  console.log('OK: Claude, Antigravity e Codex recebem o guia, dock-agents imprime o guia e a gravação no AGENTS.md pede confirmação e grava só o bloco');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (app) await app.close().catch(() => {}); fs.rmSync(temp, { recursive: true, force: true }); });
