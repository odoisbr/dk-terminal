const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');
const artifact = path.join(root, 'artifacts');
fs.mkdirSync(artifact, { recursive: true });
require('./create-motion.cjs');
const logo = fs.readFileSync(path.join(assets, 'dk-logo.svg'), 'utf8');
let application;
(async () => {
  application = await electron.launch({ args: [path.join(__dirname, 'motion-host.cjs'), path.join(assets, 'dk-loading.html')] });
  const page = await application.firstWindow();
  await page.waitForSelector('#seta');
  const iconOnly = process.argv.includes('--icon-only');
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.pause(); });
  const frames = path.join(artifact, 'motion-frames'); fs.mkdirSync(frames, { recursive: true });
  for (let frame = 0; !iconOnly && frame < 64; frame++) {
    await page.evaluate(time => { for (const animation of document.getAnimations()) animation.currentTime = time; }, frame * 50);
    await page.screenshot({ path: path.join(frames, `frame-${String(frame).padStart(3, '0')}.png`), scale: 'css' });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const styles = await page.locator('#seta').evaluate(el => ({ animation: getComputedStyle(el).animationName, offset: getComputedStyle(el).strokeDashoffset }));
  if (styles.animation !== 'none' || Number.parseFloat(styles.offset) !== 0) throw new Error('Redução de movimento não foi respeitada.');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 1024));
  await page.setContent(`<html style="width:1024px;height:1024px;overflow:hidden;scrollbar-width:none"><head><style>::-webkit-scrollbar{display:none}</style></head><body style="margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden"><div style="position:absolute;left:80px;top:80px;width:864px;height:864px;border-radius:190px;background:linear-gradient(145deg,#273129,#101714);border:3px solid #4b5748;box-sizing:border-box;display:flex;align-items:center;justify-content:center">${logo.replace('width="744" height="444"', 'width="650" height="388"')}</div></body></html>`);
  await page.screenshot({ path: path.join(assets, 'dk-terminal.png'), omitBackground: true, scale: 'css', fullPage: true });
  if (!iconOnly) execFileSync('ffmpeg', ['-y', '-framerate', '20', '-i', path.join(frames, 'frame-%03d.png'), '-filter_complex', '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a', '-loop', '0', path.join(artifact, 'dk-loading.gif')], { stdio: 'ignore' });
  console.log('Motion: 3,2 segundos, 20 quadros/s; seta primeiro, DK depois. SVG, HTML e GIF exportados. Redução de movimento verificada.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (application) await application.close(); });
