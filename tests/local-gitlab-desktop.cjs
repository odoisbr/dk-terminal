const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root=path.resolve(__dirname,'..'), tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-gitlab-local-'))), project=path.join(tmp,'Projeto');fs.mkdirSync(project);
let app;
(async()=>{try{
  app=await electron.launch({args:[root],env:{...process.env,DK_TERMINAL_TEST:'1',DK_TERMINAL_TEST_PROJECT:project,DK_TERMINAL_DATA_DIR:path.join(tmp,'profile')}});
  const page=await app.firstWindow();await page.locator('#startup-loading').waitFor({state:'detached'});
  await app.evaluate(({ipcMain},folder)=>{
    const add=(name,fn)=>{ipcMain.removeHandler(name);ipcMain.handle(name,async(_event,...args)=>({ok:true,value:await fn(...args)}));};
    global.__localClones=0;global.__openedExisting=0;
    add('gitlab:projects',()=>({items:[{id:42,name:'Projeto remoto',path:'design/equipe/projeto',branch:'main'}],hasMore:false}));
    add('gitlab:project',()=>({id:42,name:'Projeto remoto',path:'design/equipe/projeto',branch:'main'}));
    add('gitlab:local-projects',()=>({available:true,incomplete:false,ids:[42]}));
    add('gitlab:local-matches',()=>({available:true,incomplete:false,paths:[folder]}));
    add('gitlab:open-existing',(_id,selected)=>{if(selected!==folder)throw Error('Pasta inesperada');global.__openedExisting++;return {path:folder,name:'Projeto',title:'Projeto',isDk:false,files:[]};});
    add('gitlab:tree',()=>({entries:[],hasMore:false}));add('gitlab:local',()=>{global.__localClones++;return null;});
  },project);
  await page.locator('#launcher-open-gitlab').click();
  await page.locator('.gitlab-local-badge').waitFor();assert.equal(await page.locator('.gitlab-local-badge').innerText(),'Cópia local');
  await page.getByRole('button',{name:/Projeto remoto/}).click();
  await page.locator('.remote-local-row').waitFor();assert.equal(await page.locator('.remote-local-row span').innerText(),project);
  await page.locator('.remote-local-row').getByRole('button',{name:'Abrir projeto'}).click();await page.locator('#launcher').waitFor({state:'hidden'});
  assert.equal(await page.locator('#project-title').innerText(),'Projeto');assert.equal(await app.evaluate(()=>global.__openedExisting),1);assert.equal(await app.evaluate(()=>global.__localClones),0);
  console.log('✓ Cópia existente pode ser aberta sem criar clone');
}finally{if(app)await app.close();fs.rmSync(tmp,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
