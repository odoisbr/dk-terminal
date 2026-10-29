// Open a specific project panel without accidentally toggling it closed.
async function openProjectPanel(page, name = 'files') {
  const button = page.locator(`#tab-${name}`);
  await button.waitFor();
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await page.locator(`#panel-${name}`).waitFor();
}

module.exports = { openProjectPanel };
