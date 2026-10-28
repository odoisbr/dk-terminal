const fs = require('node:fs');
const path = require('node:path');

// Only existing regular files and folders inside the selected project may be
// handed to the OS. Resolve links as well as the lexical path before use.
function resolveTreeEntry(root, relative) {
  if(typeof relative !== 'string' || !relative || relative.length > 8192 || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Caminho inválido.');
  const base=fs.realpathSync(root), candidate=path.resolve(base,relative);
  const inside = target => {const rel=path.relative(base,target);return rel && rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);};
  if(!inside(candidate)) throw new Error('O item está fora do projeto.');
  const target=fs.realpathSync(candidate);
  if(!inside(target)) throw new Error('O item aponta para fora do projeto.');
  const stat=fs.statSync(target);
  if(!stat.isFile() && !stat.isDirectory()) throw new Error('Este tipo de item não é compatível com a ação.');
  return {path:target,selectedPath:candidate,name:path.basename(candidate),kind:stat.isFile()?'file':'directory'};
}
async function treeAction(root,relative,action,{shell,clipboard,ShareMenu,window,platform=process.platform}) {
  if(!['reveal','open-system','copy-path','copy-name','share'].includes(action)) throw new Error('Ação desconhecida.');
  const entry=resolveTreeEntry(root,relative);
  if(action==='reveal') shell.showItemInFolder(entry.path);
  else if(action==='open-system') {const error=await shell.openPath(entry.path);if(error)throw new Error('Não foi possível abrir este item no sistema.');}
  else if(action==='copy-path') clipboard.writeText(entry.selectedPath);
  else if(action==='copy-name') clipboard.writeText(entry.name);
  else if(action==='share') {
    if(entry.kind!=='file') throw new Error('Selecione um arquivo para compartilhar.');
    if(platform!=='darwin' || !ShareMenu) throw new Error('O compartilhamento nativo está disponível no macOS.');
    new ShareMenu({filePaths:[entry.path]}).popup({window});
  }
  return true;
}
module.exports={resolveTreeEntry,treeAction};
