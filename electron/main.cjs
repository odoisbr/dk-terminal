const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, ShareMenu, Menu, protocol, net } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { readState, writeState, projectInfo, kitInfo, loginEnvironment, actionSpec, folderForFile, directory } = require('./core.cjs');
const { Terminals } = require('./terminals.cjs');
const { Services } = require('./services.cjs');
const { Extensions } = require('./extensions.cjs');
const { listDirectory } = require('./file-tree.cjs');
const { treeAction } = require('./tree-actions.cjs');
const { Orchestration } = require('./orchestration.cjs');
const { PreviewBrowser } = require('./browser.cjs');
const { PreviewBridge } = require('./preview-bridge.cjs');
const { readProjectFile, saveProjectFile } = require('./files.cjs');
const { Usage } = require('./usage.cjs');
const { CodexChat } = require('./codex-chat.cjs');
const { Actions } = require('./actions.cjs');
const { ResourceMonitor } = require('./resources.cjs');
const { ClaudePluginMonitor, installClaudePlugin } = require('./claude-plugin.cjs');
const { Integrations } = require('./integrations.cjs');
const { LocalRepositories } = require('./local-repositories.cjs');
const { clearMachineFileCache } = require('./machine-cache.cjs');
const { Git } = require('./git.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'dk-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('DK Terminal');
const testing = process.env.DK_TERMINAL_TEST === '1' && !app.isPackaged;
if (process.env.DK_TERMINAL_DATA_DIR) {
  const dataDir = process.env.DK_TERMINAL_DATA_DIR;
  if (!path.isAbsolute(dataDir)) throw new Error('DK_TERMINAL_DATA_DIR precisa ser um caminho absoluto.');
  require('node:fs').mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
}
if (testing && process.env.DK_TERMINAL_TEST_DATA) app.setPath('userData', process.env.DK_TERMINAL_TEST_DATA);
// Electron scopes its process lock to userData. Resolve aliases so two paths to
// the same profile cannot create independent writers for its private stores.
fs.mkdirSync(app.getPath('userData'), { recursive: true });
app.setPath('userData', fs.realpathSync(app.getPath('userData')));
function launchFiles(argv, cwd, skip = process.defaultApp ? 2 : 1) {
  return argv.slice(skip).filter(value => typeof value === 'string' && value && value.length <= 8192 && !value.startsWith('-') && !value.includes('\0'))
    .slice(0, 32).flatMap(value => {
      const file = path.resolve(cwd, value);
      try { folderForFile(file); return [file]; } catch { return []; }
    });
}
const initialFiles = launchFiles(process.argv, process.cwd());
const primaryInstance = app.requestSingleInstanceLock({ files: initialFiles });
if (!primaryInstance) app.quit();
let window, terminals, services, extensions, orchestration, preview, previewBridge, usage, codexChat, actions, resources, integrations, localRepositories, git, config, stateFile, env;
let dirtyFiles = [], closePrompt = false, allowClose = false, quitRequested = false, machineCacheBusy = false;
const selected = new Set();
const closingProjects = new Set();
let kit = null;
const pluginMonitor = new ClaudePluginMonitor();
let prepared = false, finishBoot, startupProject = null;
const bootReady = new Promise(resolve => { finishBoot = resolve; });
const pendingFiles = primaryInstance ? [...initialFiles] : [];
let focusRequested = false;

function focusWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus(); app.focus({ steal: true });
}
function openFiles(files) {
  if (!prepared) { pendingFiles.push(...files); return; }
  for (const file of files) {
    try {
      const info = remember(folderForFile(file));
      if (!window) { startupProject = info; createWindow(); }
      else if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', () => send('project:opened', info));
      else send('project:opened', info);
    } catch (error) { dialog.showErrorBox('Abrir com DK', error.message); }
  }
}

app.on('second-instance', (_event, _argv, _cwd, data) => {
  const files = Array.isArray(data?.files) ? data.files.slice(0, 32).filter(file => typeof file === 'string' && file.length <= 8192 && !file.includes('\0') && path.isAbsolute(file)) : [];
  openFiles(files);
  if (!prepared) { focusRequested = true; return; }
  if (!window) createWindow();
  focusWindow();
});

// macOS can deliver a file before the first window or its renderer exists.
app.on('open-file', (event, file) => {
  event.preventDefault();
  if (!primaryInstance) return;
  openFiles([file]); focusWindow();
});

function save() { writeState(stateFile, config); }
function send(channel, payload) { if (window && !window.isDestroyed()) window.webContents.send(channel, payload); }
function authorize(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== 'dk-app://app/index.html') throw new Error('Origem não autorizada.');
}
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { authorize(event); return { ok: true, value: await handler(...args) }; }
    catch (error) { return { ok: false, error: error.message || 'Não foi possível concluir a ação.' }; }
  });
}
function project(root) {
  if (!selected.has(root)) throw new Error('Abra esta pasta pelo seletor de projetos.');
  return projectInfo(root);
}
function remember(root) {
  const info = projectInfo(root);
  selected.add(info.path);
  if (!config.projects.includes(info.path)) config.projects = [...config.projects, info.path].slice(-12);
  save();
  return info;
}
function bootstrap() {
  const projects = config.projects.flatMap(root => { try { const info = projectInfo(root); selected.add(info.path); return [info]; } catch { return []; } });
  return { projects, startupProject, remoteProjects: (config.remoteProjects || []).filter(item => item.path.startsWith('design/')), kit: kit ? { path: kit.path } : null, extensions: extensions.list(), extensionErrors: extensions.errors, platform: process.platform, version: app.getVersion() };
}
function registerHandlers() {
  handle('app:bootstrap', async () => { await bootReady; const state = bootstrap(); startupProject = null; return state; });
  handle('app:resources', () => resources.read());
  handle('setup:tools', refresh => integrations.tools(refresh === true));
  handle('account:status', provider => integrations.account(provider));
  handle('account:start', provider => terminals.create({path: os.homedir()}, integrations.authSpec(provider)));
  handle('gitlab:projects', (query,page) => integrations.listProjects(query,page));
  handle('git:status', root => git.status(project(root).path));
  handle('git:history', root => git.history(project(root).path));
  handle('git:branches', root => git.branches(project(root).path));
  handle('git:graph', root => git.graph(project(root).path));
  handle('git:branch-action', (root, action, name) => {
    const info=project(root);
    if(action!=='delete' && dirtyFiles.some(file=>{const rel=path.relative(info.path,file);return rel && rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);})) throw new Error('Salve os arquivos abertos no editor antes de trocar de branch.');
    return git.branchAction(info.path, action, name);
  });
  handle('git:diff', (root, name) => git.diff(project(root).path, name));
  handle('git:commit-detail', (root, hash) => git.commitDetail(project(root).path, hash));
  handle('git:commit', (root, names, message) => git.commit(project(root).path, names, message));
  handle('git:sync', (root, action) => git.sync(project(root).path, action));
  handle('git:gitlab', async (root, destination) => {
    if (!['project','merge-requests','new-merge-request'].includes(destination)) throw new Error('Destino GitLab inválido.');
    const state = await git.status(project(root).path);
    if (!state.gitlab) throw new Error('O projeto não está vinculado ao grupo Design do GitLab SEA.');
    const base = `https://gitlab.seatecnologia.com.br/${state.gitlab}`;
    const url = destination === 'project' ? base : destination === 'merge-requests' ? `${base}/-/merge_requests` : `${base}/-/merge_requests/new?${new URLSearchParams({'merge_request[source_branch]':state.branch})}`;
    await shell.openExternal(url); return true;
  });
  handle('gitlab:project', async id => {
    const remote = await integrations.getProject(id);
    config.remoteProjects = [{id:remote.id,name:remote.name,path:remote.path}, ...(config.remoteProjects || []).filter(item=>item.id!==id)].slice(0,12); save();
    return remote;
  });
  handle('gitlab:local-projects', async (ids,refresh) => {
    if (!Array.isArray(ids) || ids.length > 30 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Lista de projetos inválida.');
    const projects = ids.map(id => integrations.project(id));
    if (refresh === true) localRepositories.cache = null;
    return localRepositories.matchingProjects(projects);
  });
  handle('gitlab:local-matches', async (id,refresh) => {
    integrations.project(id); const remote = await integrations.getProject(id);
    if (refresh === true) localRepositories.cache = null;
    return localRepositories.matches(remote.path);
  });
  handle('gitlab:open-existing', async (id,folder) => {
    integrations.project(id); const remote = await integrations.getProject(id);
    return remember(await localRepositories.verify(remote.path, folder));
  });
  handle('gitlab:tree', (id,folder,page) => integrations.tree(id,folder,page));
  handle('gitlab:file', (id,name) => integrations.file(id,name));
  handle('gitlab:local', async id => {
    integrations.project(id);
    const selection = await dialog.showOpenDialog(window,{title:'Escolha onde preparar a cópia local',properties:['openDirectory','createDirectory']});
    if (selection.canceled) return null;
    const base=directory(selection.filePaths[0]);
    return remember(await integrations.materialize(id,base));
  });
  handle('app:optimize', async () => { if (!window || window.isDestroyed()) throw new Error('Janela indisponível.'); await window.webContents.session.clearCache(); return true; });
  handle('app:clear-system-cache', async () => {
    if (machineCacheBusy) throw new Error('A limpeza já está em andamento.');
    machineCacheBusy = true;
    try {
      return await clearMachineFileCache({confirm: async () => {
        const result=await dialog.showMessageBox(window,{type:'question',message:'Limpar o cache de arquivos do macOS?',detail:'O macOS libera esse cache quando necessário. Limpá-lo pode deixar arquivos e aplicativos mais lentos temporariamente. Não encerra projetos nem libera a memória usada pelos aplicativos. O macOS pode solicitar a senha de administrador.',buttons:['Cancelar','Limpar cache'],defaultId:0,cancelId:0,noLink:true});
        return result.response===1;
      }});
    } finally { machineCacheBusy = false; }
  });
  handle('app:activity-monitor', async () => {
    if (process.platform !== 'darwin') throw new Error('Disponível apenas no macOS.');
    const error = await shell.openPath('/System/Applications/Utilities/Activity Monitor.app');
    if (error) throw new Error('Não foi possível abrir o Monitor de Atividade.');
    return true;
  });
  const applyPlugin = result => {
    if (result.kit && !env.DK_ROOT) kit = kitInfo(result.kit.path);
    return { ...result, activeKit: kit ? { path: kit.path } : null };
  };
  handle('kit:plugin-check', async root => applyPlugin(await pluginMonitor.check(env, root ? project(root).path : null)));
  handle('kit:plugin-install', async root => { pluginMonitor.invalidate(); try { return applyPlugin(await installClaudePlugin(env, root ? project(root).path : null)); } finally { pluginMonitor.invalidate(); } });
  handle('project:select', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Abrir projeto ou pasta', properties: ['openDirectory'] });
    return result.canceled ? null : remember(result.filePaths[0]);
  });
  handle('project:create', async name => {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 120 || name === '.' || name === '..' || /[\/\\\0]/.test(name)) throw new Error('Informe um nome de pasta válido, sem barras.');
    const result = await dialog.showOpenDialog(window, { title: 'Escolha onde criar o projeto', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const parent = directory(result.filePaths[0]);
    const target = path.join(parent, name);
    try { await fs.promises.mkdir(target); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Já existe uma pasta com esse nome no local escolhido.'); throw error; }
    return remember(target);
  });
  handle('project:activate', root => remember(project(root).path));
  handle('tree:list', (root, relative) => listDirectory(project(root).path, relative));
  handle('tree:action', (root, relative, action) => treeAction(project(root).path, relative, action, {shell,clipboard,ShareMenu,window}));
  handle('file:read', (root, relative) => readProjectFile(project(root).path, relative));
  handle('file:save', (root, relative, text, revision) => saveProjectFile(project(root).path, relative, text, revision));
  handle('file:dirty', files => {
    if (!Array.isArray(files) || files.length > 12 || files.some(file => typeof file !== 'string' || file.length > 8192)) throw new Error('Lista de arquivos inválida.');
    dirtyFiles = files;
    window?.setDocumentEdited(!!files.length);
  });
  handle('file:confirm-close', async name => {
    if (typeof name !== 'string' || name.length > 8192) throw new Error('Nome de arquivo inválido.');
    const result = await dialog.showMessageBox(window, { type: 'question', message: `Salvar alterações em ${path.basename(name)}?`, buttons: ['Salvar', 'Descartar', 'Cancelar'], defaultId: 0, cancelId: 2, noLink: true });
    return ['save', 'discard', 'cancel'][result.response];
  });
  handle('usage:read', (root, refresh) => usage.read(project(root).path, refresh === true));
  handle('chat:create', root => codexChat.create(project(root).path));
  handle('chat:list', root => codexChat.list(project(root).path));
  handle('chat:read', (root, id) => codexChat.read(project(root).path, id));
  handle('chat:send', (root, id, text) => { const info=project(root); if(closingProjects.has(info.path)) throw new Error('O projeto está sendo encerrado.'); return codexChat.send(info.path, id, text); });
  handle('chat:cancel', (root, id) => codexChat.cancel(project(root).path, id));
  handle('chat:approve', (root, id, requestId, choice) => codexChat.approve(project(root).path, id, requestId, choice));
  handle('action:run', (root, action) => actions.run(action, project(root), kit && kitInfo(kit.path)));
  handle('action:cancel', root => actions.cancel(project(root).path));
  handle('graph:list', root => orchestration.list(project(root).path));
  handle('graph:watch', root => orchestration.watch(root === null ? null : project(root).path));
  handle('browser:request-result', (id, ok) => previewBridge.finish(id, ok));
  handle('browser:open', (root, url, bounds) => preview.open(window, project(root).path, url, bounds));
  handle('browser:resize', bounds => preview.resize(bounds));
  handle('browser:close', () => preview.close());
  handle('project:forget', root => {
    project(root);
    config.projects = config.projects.filter(p => p !== root);
    save();
    // Existing sessions keep their working directory until explicitly closed.
    return bootstrap();
  });
  handle('project:close-sessions', async root => {
    const info = project(root);
    if (closingProjects.has(info.path)) throw new Error('O projeto já está sendo encerrado.');
    closingProjects.add(info.path);
    try {
      const [result, chats] = await Promise.all([terminals.closeProject(info.path), codexChat.closeProject(info.path)]);
      previewBridge.revoke(info.path);
      return { ...result, chats };
    } finally { closingProjects.delete(info.path); }
  });
  handle('project:reveal', async root => {
    const error = await shell.openPath(project(root).path);
    if (error) throw new Error(error);
  });
  handle('terminal:create', (root, action) => {
    const info = project(root);
    if (closingProjects.has(info.path)) throw new Error('O projeto está sendo encerrado.');
    if (action != null && typeof action !== 'string') throw new Error('Ação inválida.');
    const spec = action == null ? null : action.startsWith('extension:') ? extensions.spec(action.slice(10)) : actionSpec(action, info, kit && kitInfo(kit.path), env);
    return terminals.create(info, spec);
  });
  handle('terminal:split', (root, id, agent) => { const info=project(root); if(closingProjects.has(info.path)) throw new Error('O projeto está sendo encerrado.'); return terminals.split(info.path, id, extensions, agent); });
  handle('terminal:start', (id, size) => terminals.start(id, size));
  handle('terminal:write', (id, data) => terminals.write(id, data));
  handle('terminal:resize', (id, size) => terminals.resize(id, size));
  handle('terminal:ack', (id, count) => terminals.acknowledge(id, count));
  handle('terminal:close', id => terminals.close(id));
  handle('service:list', root => services.list(project(root).path));
  handle('service:start', (root, id) => services.start(project(root).path, id));
  handle('service:stop', (root, id) => services.stop(project(root).path, id));
}
function createWindow() {
  allowClose = false; dirtyFiles = [];
  codexChat = new CodexChat({ env, storeFile: path.join(app.getPath('userData'), 'codex-conversations.json'), emit: event => send('chat:event', event), previewEnvironment: root => previewBridge.environment(root) });
  window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 940, minHeight: 620, backgroundColor: '#101214',
    title: 'DK Terminal', icon: path.join(app.getAppPath(), 'assets', 'dk-terminal.png'), titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 22 }, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('render-process-gone', () => terminals.closeAll());
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (!dirtyFiles.length || allowClose) return;
    event.preventDefault();
    if (closePrompt) return;
    closePrompt = true;
    dialog.showMessageBox(window, { type: 'question', message: 'Há arquivos com alterações não salvas.', detail: 'Volte ao editor para salvar ou descarte as alterações antes de fechar.', buttons: ['Voltar ao editor', 'Descartar alterações'], defaultId: 0, cancelId: 0, noLink: true }).then(({ response }) => {
      if (response === 1) { allowClose = true; if (quitRequested) app.quit(); else window?.close(); }
      else { quitRequested = false; send('app:menu', 'editor'); }
    }).finally(() => { closePrompt = false; });
  });
  window.on('closed', () => { previewBridge.revokeAll(); terminals.closeAll(); services.closeAll(); orchestration.close(); preview.close(); usage.close(); actions.closeAll(); codexChat.closeAll().catch(() => {}); window = null; dirtyFiles = []; });
  window.loadURL('dk-app://app/index.html');
}
function menu() {
  const item = (label, accelerator, action) => ({ label, accelerator, click: () => send('app:menu', action) });
  const template = [
    ...(process.platform === 'darwin' ? [{ label: 'DK Terminal', submenu: [{ role: 'about', label: 'Sobre o DK Terminal' }, { type: 'separator' }, { role: 'hide', label: 'Ocultar DK Terminal' }, { role: 'unhide', label: 'Mostrar tudo' }, { type: 'separator' }, { role: 'quit', label: 'Sair' }] }] : []),
    { label: 'Arquivo', submenu: [item('Abrir projeto…', 'CmdOrCtrl+O', 'open'), item('Salvar arquivo', 'CmdOrCtrl+S', 'save'), item('Nova sessão', 'CmdOrCtrl+T', 'new'), item('Dividir à direita', 'CmdOrCtrl+D', 'split-right'), item('Dividir abaixo', 'CmdOrCtrl+Shift+D', 'split-down'), item('Fechar aba', 'CmdOrCtrl+W', 'close'), { type: 'separator' }, { role: 'quit', label: 'Sair' }] },
    { label: 'Editar', submenu: [{ role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' }, { role: 'selectAll', label: 'Selecionar tudo' }, { type: 'separator' }, item('Buscar no terminal', 'CmdOrCtrl+F', 'search')] },
    { label: 'Visualizar', submenu: [item('Expandir ou restaurar terminal', 'CmdOrCtrl+Shift+E', 'expand'), item('Limpar terminal', 'CmdOrCtrl+K', 'clear'), { role: 'togglefullscreen', label: 'Tela cheia' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: 'Ferramentas de desenvolvimento' }] : [])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
if (primaryInstance) app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(path.join(app.getAppPath(), 'assets', 'dk-terminal.png'));
  const dist = path.resolve(__dirname, '..', 'dist');
  protocol.handle('dk-app', request => {
    const url = new URL(request.url);
    const target = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (url.hostname !== 'app' || !target.startsWith(dist + path.sep)) return new Response('Não encontrado', { status: 404 });
    return net.fetch(pathToFileURL(target).href);
  });
  stateFile = path.join(app.getPath('userData'), 'settings.json');
  config = readState(stateFile);
  env = { ...process.env };
  previewBridge = new PreviewBridge(request => { if (!window || window.isDestroyed() || !selected.has(request.root)) throw new Error('Projeto indisponível.'); send('browser:request', request); });
  try { await previewBridge.start(); } catch (error) { console.error("Prévia integrada indisponível:", error.message); }
  terminals = new Terminals(send, env, root => previewBridge.environment(root));
  services = new Services(event => send('service:changed', event), env);
  orchestration = new Orchestration(event => send('graph:changed', event));
  preview = new PreviewBrowser(event => send('browser:changed', event));
  usage = new Usage(env);
  actions = new Actions({ env });
  integrations = new Integrations(env);
  git = new Git(env);
  localRepositories = new LocalRepositories('/Volumes/SEA', env);
  resources = new ResourceMonitor(() => app.getAppMetrics(), { getTerminals: () => [...terminals.resourceRoots(), ...(codexChat?.resourceRoots() || [])] });
  extensions = new Extensions([path.join(app.getAppPath(), 'extensions'), path.join(app.getPath('userData'), 'extensions')], env);
  registerHandlers(); menu(); createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
  env = await loginEnvironment();
  integrations.env = env; localRepositories.env = env; terminals.env = env; services.env = env; extensions.env = env; usage.env = env; codexChat.env = env; actions.env = env;
  for (const candidate of [config.kitRoot, env.DK_ROOT, path.resolve(__dirname, '..', '..', 'dk')]) {
    if (!candidate) continue;
    try { kit = kitInfo(candidate); break; } catch {}
  }
  if (kit && config.kitRoot !== kit.path) { config.kitRoot = kit.path; save(); }
  if (testing && process.env.DK_TERMINAL_TEST_PROJECT) remember(process.env.DK_TERMINAL_TEST_PROJECT);
  for (const file of pendingFiles.splice(0)) { try { startupProject = remember(folderForFile(file)); } catch {} }
  prepared = true; finishBoot();
  if (focusRequested) focusWindow();
}).catch(error => { dialog.showErrorBox('DK Terminal', error.message); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { quitRequested = true; });
app.on('will-quit', () => { previewBridge?.close(); terminals?.closeAll(); services?.closeAll(); orchestration?.close(); preview?.close(); usage?.close(); actions?.closeAll(); codexChat?.closeAll().catch(() => {}); });
