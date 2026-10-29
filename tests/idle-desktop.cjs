const { startProjectTerminal } = require('./helpers/project-session.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-idle-desktop-')));
const project = path.join(temp, 'Projeto'); fs.mkdirSync(project);
let app;
async function main() {
  app = await electron.launch({executablePath:process.env.DK_TERMINAL_EXECUTABLE || undefined,args:process.env.DK_TERMINAL_EXECUTABLE ? [] : [root],timeout:60000,env:{...process.env,DK_TERMINAL_TEST:'1',DK_TERMINAL_TEST_PROJECT:project,DK_TERMINAL_DATA_DIR:path.join(temp,'profile')}});
  const page = await app.firstWindow();
  await page.locator('#startup-loading').waitFor({state:'detached'});
  if(process.env.DK_TERMINAL_EXECUTABLE) { await app.evaluate(({dialog},root)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]});},project); await page.locator('#launcher-open-local').click(); }
  else await page.locator('#launcher-recents .launcher-recent').first().click();
  await startProjectTerminal(page);
  await page.waitForFunction(()=>document.querySelector('#system-cpu')?.textContent!=='—',null,{timeout:20000});
  const first=(await page.locator('.tab-select[aria-selected=true]').getAttribute('id')).slice(4);
  await app.evaluate(({ipcMain},id)=>{
    global.__idleTarget=id;
    const original=ipcMain._invokeHandlers.get('app:resources');
    ipcMain._invokeHandlers.set('app:resources',async (...args)=>{
      const result=await original(...args);
      if(result.ok) result.value.sessions=[{id:global.__idleTarget,kind:global.__idleKind||'terminal',root:global.__idleRoot,memoryKiB:150*1024,lastActivity:Date.now()-31*60*1000}];
      return result;
    });
  },first);
  const refresh=async()=>{await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));};
  await refresh(); await page.locator('#idle-notice').waitFor({state:'visible',timeout:15000});
  assert.match(await page.locator('#idle-description').innerText(),/30 minutos/);
  await page.getByRole('button',{name:'Manter sessão'}).click();
  assert.equal(await page.locator('#idle-notice').isVisible(),false);
  assert.equal(await page.locator('.terminal-pane').count(),1);
  await refresh(); await page.waitForTimeout(300); assert.equal(await page.locator('#idle-notice').isVisible(),false);
  await page.getByRole('button',{name:'Nova sessão',exact:true}).click();
  await page.waitForFunction(id=>document.querySelector('.tab-select[aria-selected=true]')?.id!==`tab-${id}`,first);
  const second=(await page.locator('.tab-select[aria-selected=true]').getAttribute('id')).slice(4);
  await page.locator(`#pane-${second}[data-ready=true]`).waitFor(); await page.waitForTimeout(1200);
  await app.evaluate((_,id)=>{global.__idleTarget=id;},second);
  await refresh(); await page.locator('#idle-notice').waitFor({state:'visible',timeout:15000});
  assert.equal(await page.locator('.terminal-pane').count(),2);
  await page.getByRole('button',{name:'Encerrar sessão'}).click();
  await page.locator(`#pane-${second}`).waitFor({state:'detached'});
  assert.equal(await page.locator(`#pane-${first}`).count(),1);
  await app.evaluate(({ipcMain},root)=>{
    global.__idleTarget='fake-codex';global.__idleKind='codex';global.__idleRoot=root;
    ipcMain.removeHandler('chat:cancel'); ipcMain.handle('chat:cancel',(_event,root,id)=>{global.__codexCancelled={root,id};return {ok:true,value:true};});
  },project);
  await refresh(); await page.locator('#idle-notice').waitFor({state:'visible',timeout:15000});
  await page.getByRole('button',{name:'Interromper Codex'}).click();
  await page.waitForFunction(()=>document.querySelector('#idle-notice').hidden);
  const cancelled=await app.evaluate(()=>global.__codexCancelled);
  assert.deepEqual(cancelled,{root:project,id:'fake-codex'});
  assert.equal(await page.locator(`#pane-${first}`).count(),1);
  console.log('✓ Aviso sugere manter ou encerrar e não fecha sessões automaticamente');
  console.log('✓ Aviso do Codex interrompe apenas a execução escolhida');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(temp,{recursive:true,force:true});});
