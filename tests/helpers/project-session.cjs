// Open the first session explicitly; merely selecting a project no longer creates one.
async function startProjectTerminal(page) {
  await page.locator('#launcher').waitFor({ state: 'hidden' });
  await page.locator('#new-session').click();
  await page.locator('.terminal-pane[data-ready=true]:visible').last().waitFor();
}
module.exports = { startProjectTerminal };
