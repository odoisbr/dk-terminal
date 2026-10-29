const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// O processo do terminal usa uma fixture em pasta própria, sem CLIs de agentes.
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-cursor-ui-')));
const project = path.join(temp, 'Projeto de teste');
const profile = path.join(temp, 'profile');
fs.mkdirSync(project);
const fixtureProgram = path.join(temp, 'terminal-fixture.cjs');
fs.writeFileSync(fixtureProgram, String.raw`
const readline = require('node:readline');
process.stdout.write('DK_CURSOR_READY\r\n');
const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on('line', command => {
  if (command === 'history') {
    for (let i = 1; i <= 180; i++) process.stdout.write('DK_HISTORY_' + String(i).padStart(4, '0') + '\r\n');
    process.stdout.write('DK_HISTORY_DONE\r\n');
  } else if (command === 'sequence') {
    process.stdout.write('\x1b[1 q\x1b[?12hDK_CURSOR_SEQUENCE_DONE\r\n');
  } else if (command === 'input') {
    process.stdout.write('DK_CURSOR_INPUT_OK\r\n');
  } else if (command === 'quit') {
    process.exit(0);
  }
});
`);
const fixtureShell = path.join(temp, process.platform === 'win32' ? 'shell-fixture.exe' : 'shell-fixture');
const quoteShell = value => `'${value.replace(/'/g, "'\\''")}'`;
if (process.platform === 'win32') {
  // Windows inicia Node em modo interativo; cada comando escreve a mesma saída da fixture.
  fs.copyFileSync(process.execPath, fixtureShell);
} else {
  fs.writeFileSync(fixtureShell, `#!/bin/sh\nif [ "$1" = "-lc" ]; then printf '\\0%s\\0' "$PATH"; exit; fi\nexec ${quoteShell(process.execPath)} ${quoteShell(fixtureProgram)}\n`, { mode: 0o755 });
}

const env = {
  ...process.env, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_DATA_DIR: profile,
  ...(process.platform === 'win32' ? { ComSpec: fixtureShell } : { SHELL: fixtureShell }),
};
const outputs = {
  history: Array.from({ length: 180 }, (_, index) => `DK_HISTORY_${String(index + 1).padStart(4, '0')}`).join('\r\n') + '\r\nDK_HISTORY_DONE\r\n',
  sequence: '\x1b[1 q\x1b[?12hDK_CURSOR_SEQUENCE_DONE\r\n',
  input: 'DK_CURSOR_INPUT_OK\r\n',
};
const markers = { history: 'DK_HISTORY_DONE', sequence: 'DK_CURSOR_SEQUENCE_DONE', input: 'DK_CURSOR_INPUT_OK' };
let app, activePage, activeId;

async function launch() {
  const executablePath = process.env.DK_TERMINAL_EXECUTABLE || undefined;
  app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env, timeout: 60000 });
  const page = await app.firstWindow();
  await page.locator('#startup-loading').waitFor({ state: 'detached' });
  if (executablePath) {
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, project);
    await page.locator('#launcher-open-local').click();
  } else await page.locator('#launcher-recents .launcher-recent').first().click();
  await startProjectTerminal(page);
  const id = (await page.locator('.tab-select[aria-selected=true]').getAttribute('id')).slice(4);
  activePage = page; activeId = id;
  await page.evaluate(() => {
    window.__cursorTestOutput = {};
    window.dk.onTerminalData(({ id, data }) => { window.__cursorTestOutput[id] = ((window.__cursorTestOutput[id] || '') + data).slice(-65536); });
  });
  return { page, id };
}

async function focusTerminal(page, id) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await page.bringToFront();
  await page.locator(`#pane-${id} .xterm-helper-textarea`).focus();
}

async function expectCursor(page, id, blinking) {
  await focusTerminal(page, id);
  // xterm can replace its cursor element while rendering. Capture visibility and
  // animation from the same connected element in one browser-side sample.
  const handle = await page.waitForFunction(({ id, blinking }) => {
    const terminal = document.querySelector(`#pane-${id} .xterm`);
    const cursor = terminal?.querySelector('.xterm-cursor');
    if (!terminal?.classList.contains('focus') || !cursor?.isConnected) return false;
    const style = getComputedStyle(cursor), rect = cursor.getBoundingClientRect();
    const visible = style.display !== 'none' && style.visibility === 'visible' && rect.width > 0 && rect.height > 0;
    const animation = style.animationName;
    const matches = blinking ? !!animation && animation !== 'none' : animation === 'none';
    return visible && matches ? { visible, animation } : false;
  }, { id, blinking }, { timeout: 10000 });
  const sample = await handle.jsonValue();
  await handle.dispose();
  assert.equal(sample.visible, true, 'O cursor precisa continuar visível.');
  if (blinking) assert.ok(sample.animation && sample.animation !== 'none');
  else assert.equal(sample.animation, 'none');
}

async function setBlink(page, enabled) {
  await page.locator('#profile-show').click();
  const checkbox = page.getByRole('checkbox', { name: 'Cursor piscando' });
  await checkbox.waitFor();
  if (enabled) await checkbox.check(); else await checkbox.uncheck();
  assert.equal(await checkbox.isChecked(), enabled);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('terminalPreferences')).cursorBlink), enabled);
  await page.locator('#launcher-close').click();
}

async function emit(page, id, command) {
  const input = process.platform === 'win32' ? `process.stdout.write(${JSON.stringify(outputs[command])});\r` : `${command}\r`;
  await page.evaluate(({ id, input }) => window.dk.writeTerminal(id, input), { id, input });
  await page.waitForFunction(({ id, marker }) => new RegExp(`${marker}\\r*\\n`).test(window.__cursorTestOutput[id] || ''), { id, marker: markers[command] }, { timeout: 15000 });
}

async function closeSession(page, id) {
  const input = process.platform === 'win32' ? 'process.exit(0)\r' : 'quit\r';
  await page.evaluate(({ id, input }) => {
    window.__cursorTestExited = false;
    window.dk.onTerminalExit(event => { if (event.id === id) window.__cursorTestExited = true; });
    return window.dk.writeTerminal(id, input);
  }, { id, input });
  await page.waitForFunction(() => window.__cursorTestExited, null, { timeout: 15000 });
  await page.locator(`#tab-${id}`).locator('..').locator('.tab-close').click();
  await page.locator(`#pane-${id}`).waitFor({ state: 'detached' });
  assert.doesNotMatch(await page.locator('#toast').textContent(), /não foi possível confirmar.*encerramento|processos associados/i, 'A sessão temporária não deve produzir aviso de encerramento parcial.');
}

(async () => {
  try {
    let { page, id } = await launch();
    await expectCursor(page, id, false);
    await page.locator('#profile-show').click();
    const initial = page.getByRole('checkbox', { name: 'Cursor piscando' });
    await initial.waitFor();
    assert.equal(await initial.isChecked(), false, 'O cursor deve ser estático por padrão.');
    await page.locator('#launcher-close').click();

    await emit(page, id, 'history');
    await setBlink(page, true);
    await expectCursor(page, id, true);
    await setBlink(page, false);
    await expectCursor(page, id, false);
    await emit(page, id, 'sequence');
    await page.waitForFunction(({ id, marker }) => document.querySelector(`#pane-${id} .xterm-rows`)?.textContent?.includes(marker), { id, marker: markers.sequence });
    await expectCursor(page, id, false);
    await page.waitForTimeout(1200);
    await expectCursor(page, id, false);

    await page.locator('#search-toggle').click();
    await page.locator('#terminal-search').fill('DK_HISTORY_0001');
    await page.waitForFunction(id => document.querySelector(`#pane-${id} .xterm-rows`)?.textContent?.includes('DK_HISTORY_0001'), id, { timeout: 15000 });
    assert.equal(await page.locator('#terminal-search').evaluate(element => element.classList.contains('no-match')), false);
    await page.locator('#search-close').click();
    await emit(page, id, 'input');
    console.log('✓ Cursor estático por padrão, alternância, sequências DEC e histórico do terminal');

    await setBlink(page, true);
    await closeSession(page, id);
    await app.close(); app = null;
    ({ page, id } = await launch());
    await page.locator('#profile-show').click();
    const restoredOn = page.getByRole('checkbox', { name: 'Cursor piscando' });
    await restoredOn.waitFor();
    assert.equal(await restoredOn.isChecked(), true, 'A preferência ligada precisa persistir.');
    await page.locator('#launcher-close').click();
    await expectCursor(page, id, true);
    await setBlink(page, false);
    await closeSession(page, id);
    await app.close(); app = null;

    ({ page, id } = await launch());
    await page.locator('#profile-show').click();
    const restoredOff = page.getByRole('checkbox', { name: 'Cursor piscando' });
    await restoredOff.waitFor();
    assert.equal(await restoredOff.isChecked(), false, 'A preferência desligada precisa persistir.');
    await page.locator('#launcher-close').click();
    await expectCursor(page, id, false);
    await emit(page, id, 'input');
    await closeSession(page, id);
    console.log('✓ As duas preferências persistem após reiniciar e o terminal segue funcionando');
  } finally {
    if (app) {
      // Mesmo se uma asserção falhar, encerre somente a sessão da fixture.
      if (activePage && activeId) {
        try {
          const result = await activePage.evaluate(async id => { try { return await window.dk.closeTerminal(id); } catch { return null; } }, activeId);
          if (result?.partial) { console.error('Encerramento parcial da sessão temporária.'); process.exitCode = 1; }
        } catch {}
      }
      await app.close();
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
