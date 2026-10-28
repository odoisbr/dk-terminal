const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-welcome-'));
const project = path.join(temp, 'Projeto recente');
fs.mkdirSync(project);
let app;
(async () => {
  try {
    app = await electron.launch({ args: [root], env: { ...process.env, DK_TERMINAL_TEST: '1', DK_TERMINAL_TEST_PROJECT: project, DK_TERMINAL_DATA_DIR: path.join(temp, 'profile') } });
    const page = await app.firstWindow();
    await page.locator('#startup-loading').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#launcher.launcher-workspace').isVisible(), true);
    assert.equal(await page.locator('#launcher-close').isVisible(), false);
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#launcher').isVisible(), true);
    await page.getByRole('button', { name: 'Recolher sidebar' }).click();
    const sidebar = await page.locator('.sidebar').boundingBox();
    const launcher = await page.locator('#launcher').boundingBox();
    assert.equal(Math.round(launcher.x), Math.round(sidebar.width));
    await page.locator('.project-select').click();
    await page.locator('#launcher').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#project-title').innerText(), 'Projeto recente');
    await page.getByRole('button', { name: 'Página inicial' }).click();
    assert.equal(await page.locator('#launcher-close').isVisible(), true);
    await page.locator('#launcher-close').click();
    assert.equal(await page.locator('#launcher').isVisible(), false);
    console.log('✓ Boas-vindas, sidebar recolhida e abertura de projeto');
  } finally {
    if (app) await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
