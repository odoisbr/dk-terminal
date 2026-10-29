const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..'), temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-sidebar-')));
const data = path.join(temp, 'profile'); fs.mkdirSync(data);
const projects = Array.from({ length: 12 }, (_, i) => { const folder = path.join(temp, `Projeto ${String(i + 1).padStart(2, '0')}`); fs.mkdirSync(folder); return folder; });
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ projects }));
let app;
const fitsWindow = page => page.evaluate(() => {
  const side = document.querySelector('.sidebar'), list = document.getElementById('project-list'), lr = list.getBoundingClientRect();
  const whole = [...list.querySelectorAll('.project-row')].filter(row => { const b = row.getBoundingClientRect(); return b.top >= lr.top - 1 && b.bottom <= lr.bottom + 1; }).length;
  return { inner: innerHeight, content: side.scrollHeight, footer: document.querySelector('.sidebar-footnote').getBoundingClientRect().bottom, machine: document.getElementById('system-resources').getBoundingClientRect().bottom, whole };
});
(async () => { try {
  app = await electron.launch({ executablePath: process.env.DK_TERMINAL_EXECUTABLE || undefined, args: process.env.DK_TERMINAL_EXECUTABLE ? [] : [root], env: { ...process.env, DK_TERMINAL_TEST: '1', DK_TERMINAL_DATA_DIR: data } });
  const page = await app.firstWindow(); await page.locator('#startup-loading').waitFor({ state: 'detached' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const height of [800, 620]) {
    await app.evaluate(({ BrowserWindow }, h) => BrowserWindow.getAllWindows()[0].setContentSize(1280, h), height);
    await page.waitForFunction(h => innerHeight === h, height);
    const m = await fitsWindow(page);
    assert.ok(m.content <= m.inner && m.footer <= m.inner && m.machine <= m.inner, `sidebar cabe em ${height} px: ${JSON.stringify(m)}`);
    assert.ok(m.whole >= 3, `lista mostra ao menos 3 linhas em ${height} px: ${JSON.stringify(m)}`);
    const toggle = page.locator('#system-resources-toggle'), popover = page.locator('#system-resources-content');
    await toggle.click(); await popover.waitFor();
    const box = await popover.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= height, `popover dentro da janela em ${height} px`);
    assert.equal((await fitsWindow(page)).content <= height, true);
    await page.keyboard.press('Escape'); await popover.waitFor({ state: 'hidden' });
  }
  // Lista com 12 projetos: filtro visível, linhas compactas e grupo de recentes.
  const filter = page.locator('#project-filter');
  assert.equal(await filter.isVisible(), true);
  assert.equal(await page.locator('.project-row').count(), 12);
  assert.equal(await page.locator('.project-row.compact .project-select small').count(), 0);
  assert.deepEqual(await page.locator('.project-group-label').allInnerTexts(), ['RECENTES']);
  await filter.fill('07'); assert.equal(await page.locator('.project-row').count(), 1);
  await filter.fill('nada assim'); await page.getByText('Nenhum projeto com esse nome', { exact: false }).waitFor();
  await filter.press('Escape'); assert.equal(await filter.inputValue(), ''); assert.equal(await page.locator('.project-row').count(), 12);
  // Selecionar um projeto o move para "Abertos" com a linha completa.
  await page.locator('.project-select[title="Projeto 03"]').click();
  await page.locator('.project-row.selected .project-select[title="Projeto 03"]').waitFor();
  assert.deepEqual(await page.locator('.project-group-label').allInnerTexts(), ['ABERTOS', 'RECENTES']);
  assert.equal(await page.locator('.project-row.selected small').innerText(), 'Pasta de trabalho');
  await page.locator('.project-select[title="Projeto 05"]').click();
  await page.locator('.project-row.selected .project-select[title="Projeto 05"]').waitFor();
  assert.equal(await page.locator('.project-row.compact .project-select[title="Projeto 03"]').count(), 1, 'projeto aberto anterior continua em Abertos, compacto');
  assert.equal(await page.locator('.project-group-label').first().innerText(), 'ABERTOS');
  // Fechar projeto: alvo de 32 px, separado do clique de seleção.
  const row = page.locator('.project-row').filter({ has: page.locator('.project-select[title="Projeto 11"]') });
  await row.hover();
  const close = await row.locator('.forget-project').boundingBox(), select = await row.locator('.project-select').boundingBox();
  assert.ok(close.width >= 32 && close.height >= 32, `alvo de fechar ${close.width}x${close.height}`);
  assert.ok(close.x - (select.x + select.width) >= 4, 'fechar fica separado da seleção');
  // Com menos de 8 projetos o filtro some.
  for (const name of ['Projeto 12', 'Projeto 11', 'Projeto 10', 'Projeto 09', 'Projeto 08']) {
    const target = page.locator('.project-row').filter({ has: page.locator(`.project-select[title="${name}"]`) });
    await target.hover(); await target.locator('.forget-project').click(); await target.waitFor({ state: 'detached' });
  }
  assert.equal(await page.locator('.project-row').count(), 7);
  assert.equal(await filter.isVisible(), false);
  // Sidebar recolhida: a máquina vira ícone com o mesmo popover.
  await page.getByRole('button', { name: 'Recolher sidebar' }).click();
  const toggle = page.locator('#system-resources-toggle'); assert.equal(await toggle.isVisible(), true);
  await toggle.click(); const box = await page.locator('#system-resources-content').boundingBox();
  const sidebarBox = await page.locator('.sidebar').boundingBox();
  assert.ok(box.x >= sidebarBox.x + sidebarBox.width && box.y >= 0 && box.y + box.height <= 620, 'popover ao lado da sidebar recolhida');
  await page.keyboard.press('Escape'); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: 'Expandir sidebar' }).click();
  assert.deepEqual(errors, []);
  console.log('✓ Sidebar cabe em 800 e 620 px; Abertos e Recentes, filtro, alvo de fechar e popover da máquina');
} finally { if (app) await app.close(); fs.rmSync(temp, { recursive: true, force: true }); } })().catch(error => { console.error(error); process.exitCode = 1; });
