// ⌘O (Arquivo › Abrir projeto…) abre o diálogo de pasta; o botão "Abrir projeto" da sidebar leva ao Início.
async function openFolderDialog(app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu', 'open'));
}
module.exports = { openFolderDialog };
