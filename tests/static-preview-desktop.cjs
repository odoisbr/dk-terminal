const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-static-ui-')));
const project = path.join(temporary, 'Projeto estático'); fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><h1>Prévia estática SEA</h1><script src="site.js"></script>');
fs.writeFileSync(path.join(project, 'site.js'), 'document.body.dataset.script = "executado"');
let app;
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(fn, description) { const end=Date.now()+15000; while (!await fn()) { if(Date.now()>end) throw new Error(description); await delay(50); } }
(async()=>{
  try {
    const executablePath=process.env.DK_TERMINAL_EXECUTABLE || undefined;
    app=await electron.launch({ executablePath, args:executablePath?[]:[root], env:{ ...process.env, DK_TERMINAL_TEST:'1', DK_TERMINAL_TEST_PROJECT:project, DK_TERMINAL_DATA_DIR:path.join(temporary,'profile') }, timeout:60000 });
    const page=await app.firstWindow();
    await page.locator('#startup-loading').waitFor({state:'detached'});
    if (executablePath) {
      await app.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},project);
      await page.locator('#launcher-open-local').click();
    } else await page.locator('#launcher-recents .launcher-recent').first().click();
    await page.waitForFunction(dir=>document.querySelector('#breadcrumb-project')?.dataset.projectPath===dir,project);
    await until(async()=>await page.locator('#open-browser').isEnabled(),'A ação de prévia estática não ficou disponível.');
    await page.locator('#open-browser').click();
    await page.locator('#browser-view').waitFor({state:'visible'});
    let address;
    await until(async()=>{ const item=(await page.evaluate(dir=>window.dk.listServices(dir),project)).find(s=>s.id==='static:preview'); address=item?.url; return item?.status==='running' && !!address; },'O servidor estático não iniciou.');
    await until(async()=>await app.evaluate(async({BrowserWindow})=>{ const view=BrowserWindow.getAllWindows()[0].contentView.children.find(item=>item.webContents && item.getVisible()); return view && await view.webContents.executeJavaScript('document.body.dataset.script === "executado"'); }),'A prévia estática não renderizou.');
    assert.equal(fs.existsSync(path.join(project,'node_modules')),false);
    assert.equal(await page.locator('.terminal-pane').count(),0);
    await page.locator('#browser-tab-close').click();
    assert.equal((await page.evaluate(dir=>window.dk.listServices(dir),project)).find(s=>s.id==='static:preview').status,'running');
    assert.equal((await fetch(address)).status,200);
    await app.close(); app=null;
    await until(async()=>{try{await fetch(address); return false;}catch{return true;}},'O servidor não foi encerrado com o aplicativo.');
    console.log('✓ Prévia estática abre por ação, executa HTML e JS sem instalação e encerra com o aplicativo');
  } finally { if(app) await app.close().catch(()=>{}); fs.rmSync(temporary,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
