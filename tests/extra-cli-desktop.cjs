const { _electron: electron }=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..'),temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-cli-icons-'))),project=path.join(temp,'Projeto'),bin=path.join(temp,'bin');fs.mkdirSync(project);fs.mkdirSync(bin);
for(const cmd of ['agy','gemini','dk'])fs.writeFileSync(path.join(bin,cmd),`#!/bin/sh\nprintf '${cmd} simulated\\n'\n`,{mode:0o755});
const shell=path.join(temp,'shell');fs.writeFileSync(shell,`#!/bin/sh\nif [ "$1" = "-lc" ]; then printf '\\000%s\\000' "$PATH"; else exec /bin/zsh -f; fi\n`,{mode:0o755});let app;
(async()=>{try{
 app=await electron.launch({executablePath:process.env.DK_TERMINAL_EXECUTABLE||undefined,args:process.env.DK_TERMINAL_EXECUTABLE?[]:[root],env:{...process.env,SHELL:shell,PATH:`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,DK_TERMINAL_TEST:'1',DK_TERMINAL_TEST_PROJECT:project,DK_TERMINAL_DATA_DIR:path.join(temp,'profile')}});
 const page=await app.firstWindow();await page.locator('#startup-loading').waitFor({state:'detached'});
 if(process.env.DK_TERMINAL_EXECUTABLE){await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},project);await page.locator('#launcher-open-local').click();}else await page.locator('.project-select').click();
 await page.locator('.terminal-pane[data-ready=true]').waitFor();
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(940,620));
 for(const id of ['antigravity','gemini','dk']){const bounds=await page.locator(`#launch-${id}`).boundingBox();assert.ok(bounds&&bounds.x+bounds.width<=940,`${id} está fora da janela`);}
 await page.locator('#split-agent').click();for(const name of ['Antigravity à direita','Gemini CLI à direita','DK CLI à direita'])assert.equal(await page.getByRole('menuitem',{name}).isEnabled(),true);await page.keyboard.press('Escape');
 // Capture exit events before opening the short-lived CLIs: tab creation does not
 // imply that the PTY's exit has already been delivered to the application.
 await page.evaluate(() => {
   window.__extraCliExits = Object.create(null);
   window.dk.onTerminalExit(({ id, exitCode }) => { window.__extraCliExits[id] = exitCode; });
 });
 for(const [id,label] of [['antigravity','Antigravity'],['gemini','Gemini CLI'],['dk','DK CLI']]) {
   const button=page.locator(`#launch-${id}`);assert.equal(await button.isVisible(),true);await button.click();
   const tab=page.getByRole('tab',{name:label,exact:true});await tab.waitFor();
   const tabId=await tab.getAttribute('id');assert.ok(tabId?.startsWith('tab-'),`${label}: sessão sem identificador`);
   const sessionId=tabId.slice(4);
   await page.waitForFunction(id => Object.hasOwn(window.__extraCliExits, id), sessionId, {timeout:30000});
   assert.equal(await page.evaluate(id => window.__extraCliExits[id], sessionId),0,`${label}: a CLI simulada deve terminar sem erro`);
 }
 assert.equal(await page.locator('#extension-bar').isVisible(),false);
 await app.close();app=null;for(const cmd of ['agy','gemini','dk'])fs.unlinkSync(path.join(bin,cmd));
 app=await electron.launch({executablePath:process.env.DK_TERMINAL_EXECUTABLE||undefined,args:process.env.DK_TERMINAL_EXECUTABLE?[]:[root],env:{...process.env,SHELL:shell,PATH:`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,DK_TERMINAL_TEST:'1',DK_TERMINAL_TEST_PROJECT:project,DK_TERMINAL_DATA_DIR:path.join(temp,'profile')}});
 const reopened=await app.firstWindow();await reopened.locator('#startup-loading').waitFor({state:'detached'});await reopened.locator('.project-select').click();
 for(const id of ['antigravity','gemini','dk'])assert.equal(await reopened.locator(`#launch-${id}`).isVisible(),false);
 console.log('✓ Ícones opcionais abrem CLIs simuladas, integram split e somem quando indisponíveis');
}finally{if(app)await app.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
