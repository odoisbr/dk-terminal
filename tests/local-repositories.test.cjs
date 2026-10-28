const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { LocalRepositories, remoteIdentity } = require('../electron/local-repositories.cjs');

test('identifica endereço Git por host e caminho exatos', () => {
  for (const value of ['git@gitlab.seatecnologia.com.br:design/a/projeto.git', 'https://gitlab.seatecnologia.com.br/design/a/projeto.git', 'ssh://git@gitlab.seatecnologia.com.br/design/a/projeto']) assert.equal(remoteIdentity(value), 'design/a/projeto');
  for (const value of ['https://outro.com/design/a/projeto', 'https://gitlab.seatecnologia.com.br/design2/a/projeto', 'https://gitlab.seatecnologia.com.br/design/a/projeto-extra', 'https://user:secret@gitlab.seatecnologia.com.br/design/a/projeto', 'git@gitlab.seatecnologia.com.br:design/../projeto']) assert.notEqual(remoteIdentity(value), 'design/a/projeto');
});

test('encontra cópias por origin e revalida antes de abrir', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-local-repos-')));
  t.after(() => fs.rmSync(base, {recursive:true,force:true}));
  const git = execFileSync('which', ['git'], {encoding:'utf8'}).trim();
  const repo = (name, origin) => { const folder=path.join(base,name);fs.mkdirSync(folder,{recursive:true});execFileSync(git,['init','-q',folder]);execFileSync(git,['-C',folder,'config','remote.origin.url',origin]);return folder; };
  const first=repo('clientes/primeiro','git@gitlab.seatecnologia.com.br:design/grupo/projeto.git');
  const second=repo('outros/segundo','https://gitlab.seatecnologia.com.br/design/grupo/projeto.git');
  repo('outros/nome-igual','https://gitlab.seatecnologia.com.br/design/grupo/outro.git');
  const hidden=repo('node_modules/ignorado','https://gitlab.seatecnologia.com.br/design/grupo/projeto.git');
  fs.symlinkSync(hidden,path.join(base,'alias'));
  const local=new LocalRepositories(base,process.env), result=await local.matches('design/grupo/projeto');
  assert.equal(result.available,true);assert.equal(result.incomplete,false);assert.deepEqual(result.paths.sort(),[first,second].sort());
  const badges=await local.matchingProjects([{id:1,path:'design/grupo/projeto'},{id:2,path:'design/grupo/ausente'}]);assert.deepEqual(badges.ids,[1]);
  assert.equal(await local.verify('design/grupo/projeto',first),first);
  await assert.rejects(local.verify('design/grupo/projeto',hidden),/não foi identificada/);
  execFileSync(git,['-C',first,'config','remote.origin.url','https://gitlab.seatecnologia.com.br/design/grupo/novo.git']);
  await assert.rejects(local.verify('design/grupo/projeto',first),/não corresponde/);
});

test('informa quando volume não está acessível', async () => {
  const result=await new LocalRepositories(path.join(os.tmpdir(),'dk-volume-que-nao-existe-20261028')).matches('design/a');
  assert.equal(result.available,false);assert.deepEqual(result.paths,[]);
});


test('busca parcial pode continuar sem reiniciar o percurso', async t => {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-local-partial-')));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  fs.mkdirSync(path.join(base,'um','dois'),{recursive:true});
  const local=new LocalRepositories(base,process.env,{maxDirectories:1});
  const first=await local.matches('design/projeto');assert.equal(first.incomplete,true);
  local.cache=null;const second=await local.matches('design/projeto');assert.equal(second.incomplete,true);
  local.cache=null;const third=await local.matches('design/projeto');assert.equal(third.incomplete,false);
});
