const { _electron: electron }=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..'), temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-machine-')));let app;
(async()=>{try{
 app=await electron.launch({executablePath:process.env.DK_TERMINAL_EXECUTABLE||undefined,args:process.env.DK_TERMINAL_EXECUTABLE?[]:[root],env:{...process.env,DK_TERMINAL_TEST:'1',DK_TERMINAL_DATA_DIR:path.join(temp,'profile')}});
 const page=await app.firstWindow();await page.locator('#startup-loading').waitFor({state:'detached'});
 if(process.platform==='darwin'){
   await page.locator('#system-resources-toggle').click();await page.locator('#system-resources-content').waitFor();
   await app.evaluate(({dialog})=>{dialog.showMessageBox=async(_window,options)=>{global.__cacheConfirmation=options;return {response:0};};});
   await page.locator('#mac-memory-tools summary').click();
   await page.locator('#clear-system-cache').click();await page.getByText('Limpeza cancelada.',{exact:true}).waitFor();
   const dialog=await app.evaluate(()=>global.__cacheConfirmation);assert.match(dialog.detail,/nem libera a memória/i);assert.match(dialog.detail,/senha de administrador/i);
   await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('app:clear-system-cache');ipcMain.handle('app:clear-system-cache',()=>({ok:true,value:{status:'completed'}}));});
   await page.locator('#clear-system-cache').click();await page.getByText('Cache de arquivos do macOS limpo.',{exact:true}).waitFor();
 }
 console.log('✓ Gestão do cache solicita confirmação; conclusão simulada sem executar limpeza do sistema');
}finally{if(app)await app.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
