const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, ShareMenu, Menu, protocol, net } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { readState, writeState, projectInfo, kitInfo, loginEnvironment, knownToolDirectories, extendPath, actionSpec, folderForFile, directory, executable } = require('./core.cjs');
const { bundledToolsPath, bundledDockToolsPath, withBundledTools } = require('./bundled-tools.cjs');
const { FilePreviews } = require('./file-preview.cjs');
const { PREVIEW_INSTRUCTIONS } = require('./preview-instructions.cjs');
const { dependencyPlan, detectPackageManager } = require('./dependency-cache.cjs');
const { Terminals } = require('./terminals.cjs');
const { Services } = require('./services.cjs');
const { Extensions } = require('./extensions.cjs');
const { listDirectory } = require('./file-tree.cjs');
const { treeAction } = require('./tree-actions.cjs');
const { Orchestration } = require('./orchestration.cjs');
const { PreviewBrowser } = require('./browser.cjs');
const { BrowserFullscreen } = require('./browser-fullscreen.cjs');
const { PreviewBridge } = require('./preview-bridge.cjs');
const { readProjectFile, saveProjectFile } = require('./files.cjs');
const { Usage } = require('./usage.cjs');
const { CodexChat } = require('./codex-chat.cjs');
const { Actions } = require('./actions.cjs');
const { ResourceMonitor } = require('./resources.cjs');
const { ClaudePluginMonitor, installClaudePlugin, updateClaudePlugin } = require('./claude-plugin.cjs');
const { Integrations } = require('./integrations.cjs');
const { LocalRepositories } = require('./local-repositories.cjs');
const { clearMachineFileCache } = require('./machine-cache.cjs');
const { Git } = require('./git.cjs');
const { windowIcon } = require('./app-icon.cjs');
const dockCli = require('./dock-cli.cjs');
const { DebugLog, captureConsole, formatArgs } = require('./debug-log.cjs');
const { SessionServices } = require('./session-services.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'dk-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const testing = process.env.DK_TERMINAL_TEST === '1' && !app.isPackaged;
if (!process.env.DK_TERMINAL_DATA_DIR && !(testing && process.env.DK_TERMINAL_TEST_DATA)) {
  // Resolve the former default exactly as the previous version did, including
  // any path Electron derives from its command line. Keep that profile while
  // changing the visible application name, before the single-instance lock.
  app.setName('DK Terminal');
  const legacyUserData = app.getPath('userData');
  fs.mkdirSync(legacyUserData, { recursive: true });
  app.setPath('userData', legacyUserData);
}
app.setName('SEA Dock');
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
// Modo debug: --sea-dock-debug, SEA_DOCK_DEBUG=1 ou a preferência salva em Perfil e configurações.
// O Electron recusa --debug na inicialização (opção antiga do Node), por isso a opção tem prefixo.
// Toda linha passa por redação antes do disco; entrada e saída de terminais nunca são gravadas.
const debugLog = new DebugLog({
  directory: path.join(app.getPath('userData'), 'logs'),
  settingsFile: path.join(app.getPath('userData'), 'debug.json'),
  forced: process.argv.includes('--sea-dock-debug') || process.env.SEA_DOCK_DEBUG === '1',
  homes: [os.homedir(), (() => { try { return fs.realpathSync(os.homedir()); } catch { return null; } })()],
  secrets: () => previewBridge ? [...previewBridge.tokens.values()] : [],
  header: () => ({ app: app.getVersion(), macOS: process.platform === 'darwin' && typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : null, sistema: `${process.platform} ${os.release()}`, arch: process.arch, electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }),
});
const originalConsole = captureConsole(debugLog);
process.on('uncaughtExceptionMonitor', error => { debugLog.error('main', `Exceção não tratada: ${formatArgs([error])}`); });
process.on('unhandledRejection', reason => {
  originalConsole.error('Promessa rejeitada sem tratamento:', reason);
  debugLog.error('main', `Promessa rejeitada sem tratamento (unhandledRejection): ${formatArgs([reason])}`);
});
const rendererLogWindow = { start: 0, count: 0 };
function rendererLog(level, message) {
  if (!['error', 'warn', 'info'].includes(level) || typeof message !== 'string') throw new Error('Registro de diagnóstico inválido.');
  if (!debugLog.enabled) return false;
  const now = Date.now();
  if (now - rendererLogWindow.start > 60000) { rendererLogWindow.start = now; rendererLogWindow.count = 0; }
  if (++rendererLogWindow.count > 120) return false;
  return debugLog.write(level, 'renderer', message.slice(0, 16 * 1024));
}
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
let filePreviews;
let sessionServices;
let window, terminals, services, extensions, orchestration, preview, previewBridge, browserFullscreen, usage, codexChat, actions, resources, integrations, localRepositories, git, config, stateFile, env;
let dirtyFiles = [], closePrompt = false, allowClose = false, quitRequested = false, machineCacheBusy = false, windowClosing = false, windowCleanupDone = false;
const selected = new Set();
const closingProjects = new Set();
// A recent project may be reopened, but closing it revokes plugin access until then.
const closedPluginProjects = new Set();
const pendingPluginPrompts = new Set();
const pluginProjectIdentities = new Map();
const pluginProjectGenerations = new Map();
let kit = null;
const pluginMonitor = new ClaudePluginMonitor();
let prepared = false, finishBoot, startupProject = null;
const bootReady = new Promise(resolve => { finishBoot = resolve; });
const pendingFiles = primaryInstance ? [...initialFiles] : [];
let focusRequested = false;

function focusWindow() {
  if (windowClosing) { focusRequested = true; return; }
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus(); app.focus({ steal: true });
}
function openFiles(files) {
  if (!prepared || windowClosing) { pendingFiles.push(...files); if(windowClosing)focusRequested=true; return; }
  for (const file of files) {
    try {
      const info = remember(folderForFile(file));
      if (!window) { startupProject = info; createWindow(); }
      else if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', () => send('project:opened', info));
      else send('project:opened', info);
    } catch (error) { dialog.showErrorBox('Abrir com SEA Dock', error.message); }
  }
}

app.on('second-instance', (_event, _argv, _cwd, data) => {
  const files = Array.isArray(data?.files) ? data.files.slice(0, 32).filter(file => typeof file === 'string' && file.length <= 8192 && !file.includes('\0') && path.isAbsolute(file)) : [];
  openFiles(files);
  if (!prepared || windowClosing) { focusRequested = true; return; }
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
    try {
      authorize(event);
      if(windowClosing && ['terminal:create','terminal:split','terminal:start','chat:send','service:start','action:run','plugin:execute'].includes(channel)) throw new Error('O aplicativo está encerrando as sessões.');
      return { ok: true, value: await handler(...args) };
    }
    catch (error) {
      debugLog.write('warn', 'ipc', `${channel} falhou: ${error?.message || error}`);
      return { ok: false, error: error.message || 'Não foi possível concluir a ação.' };
    }
  });
}
function project(root) {
  if (!selected.has(root)) throw new Error('Abra esta pasta pelo seletor de projetos.');
  return projectInfo(root);
}
function browserProject(root) {
  const info = project(root);
  if (windowClosing || closingProjects.has(info.path) || closedPluginProjects.has(info.path)) throw new Error('Abra o projeto antes de usar a prévia.');
  return info;
}
function closeProjectBrowser(root) {
  filePreviews?.close(root);
  return preview.closeProject(root);
}
function hasDirtyFilesInProject(root) {
  return dirtyFiles.some(file => {
    const rel = path.relative(root, file);
    return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  });
}
function advancePluginGeneration(root) {
  const next = (pluginProjectGenerations.get(root) || 0) + 1;
  pluginProjectGenerations.set(root, next);
  return next;
}
function rememberPluginIdentity(root) {
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error('Pasta de projeto inválida.');
  pluginProjectIdentities.set(root, { dev: stat.dev, ino: stat.ino });
}
function remember(root) {
  const info = projectInfo(root);
  selected.add(info.path);
  rememberPluginIdentity(info.path);
  advancePluginGeneration(info.path);
  closedPluginProjects.delete(info.path);
  if (!config.projects.includes(info.path)) config.projects = [...config.projects, info.path].slice(-12);
  save();
  debugLog.event('projeto', `Projeto aberto: ${info.path}`);
  return info;
}
let bundledTools = null, environmentRefreshAt = 0, environmentRefreshing = false;
let dockTools = null;
function detectedEnvironment(base) { return withBundledTools(withBundledTools(extendPath(base, knownToolDirectories()), bundledTools), dockTools); }
function applyEnvironment(next) {
  env = next;
  for (const owner of [integrations, localRepositories, terminals, services, extensions, usage, codexChat, actions]) if (owner) owner.env = env;
}
// Ferramentas instaladas com o aplicativo aberto passam a ser reconhecidas ao
// voltar para a janela, sem reiniciar. Uma leitura do shell a cada 15 s no máximo.
async function refreshEnvironment() {
  if (environmentRefreshing || Date.now() - environmentRefreshAt < 15000) return;
  environmentRefreshing = true;
  try {
    const before = JSON.stringify(extensions.list());
    applyEnvironment(detectedEnvironment(await loginEnvironment()));
    environmentRefreshAt = Date.now();
    const after = extensions.list();
    if (JSON.stringify(after) !== before) send('extensions:changed', after);
  } catch {} finally { environmentRefreshing = false; }
}
function bootstrap() {
  const projects = config.projects.flatMap(root => { try { const info = projectInfo(root); selected.add(info.path); if (!pluginProjectIdentities.has(info.path)) rememberPluginIdentity(info.path); return [info]; } catch { return []; } });
  return { projects, startupProject, remoteProjects: (config.remoteProjects || []).filter(item => item.path.startsWith('design/')), kit: kit ? { path: kit.path } : null, extensions: extensions.list(), extensionErrors: extensions.errors, platform: process.platform, version: app.getVersion() };
}
function knownProject(root) {
  const info = project(root);
  const identity = pluginProjectIdentities.get(root), actual = fs.statSync(root);
  if (info.path !== root || !identity || !actual.isDirectory() || actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error('A pasta do projeto mudou. Selecione-a novamente para continuar.');
  return info;
}
function pluginProject(root) {
  const info = knownProject(root);
  if (closingProjects.has(info.path) || closedPluginProjects.has(info.path)) throw new Error('Abra o projeto antes de usar seus plugins.');
  return info;
}
function displayPluginValue(value) {
  // Keep invisible direction/format controls visible in the confirmation so
  // they cannot reorder or hide parts of an executable, path or argument.
  return JSON.stringify(value).replace(/[\p{Cf}\u007f-\u009f\u2028\u2029]/gu, character => {
    const code = character.codePointAt(0).toString(16);
    return character.length === 1 ? `\\u${code.padStart(4, '0')}` : `\\u{${code}}`;
  });
}
async function confirmPlugin(root, pluginId, actionId, revision) {
  const info = pluginProject(root);
  const generation = pluginProjectGenerations.get(info.path) || 0;
  const ownerWindow = window;
  if (!ownerWindow || ownerWindow.isDestroyed() || windowClosing) throw new Error('A janela está sendo encerrada.');
  if (typeof pluginId !== 'string' || typeof actionId !== 'string' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Ação de plugin inválida. Atualize a lista e tente novamente.');
  if (pendingPluginPrompts.has(info.path)) throw new Error('Conclua a confirmação de plugin já aberta.');
  pendingPluginPrompts.add(info.path);
  let host;
  try {
    // Use a short-lived snapshot without watchers. UI reloads or hiding the
    // panel cannot invalidate a confirmation while it is being displayed.
    host = extensions.forVerification(env);
    await host.listPlugins(info.path);
    const before = await host.pluginSpec(info.path, pluginId, actionId, revision);
    if (window !== ownerWindow || ownerWindow.isDestroyed() || windowClosing || (pluginProjectGenerations.get(info.path) || 0) !== generation) throw new Error('O projeto ou a janela mudou; tente novamente.');
    // JSON encoding keeps control characters and each argument visible without
    // suggesting that the command is passed through a shell.
    const detail = `Ação: ${displayPluginValue(before.label)}\nProjeto: ${displayPluginValue(info.path)}\nExecutável: ${displayPluginValue(before.file)}\nDestino real: ${displayPluginValue(before.executableIdentity.realpath)}\nArgumentos: ${displayPluginValue(before.args)}\n\nO programa terá as permissões da sua conta neste computador.`;
    const answer = await dialog.showMessageBox(ownerWindow, { type: 'question', message: 'Executar ação de plugin?', detail, buttons: ['Cancelar', 'Executar'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return null;
    if (window !== ownerWindow || ownerWindow.isDestroyed() || windowClosing || (pluginProjectGenerations.get(info.path) || 0) !== generation) throw new Error('O projeto ou a janela mudou; tente novamente.');
    const current = pluginProject(root);
    const after = await host.pluginSpec(current.path, pluginId, actionId, revision);
    if (before.revision !== after.revision || before.file !== after.file || before.label !== after.label || JSON.stringify(before.args) !== JSON.stringify(after.args) || JSON.stringify(before.executableIdentity) !== JSON.stringify(after.executableIdentity)) throw new Error('O plugin ou seu executável mudou durante a confirmação. Atualize a lista e tente novamente.');
    // Recheck after asynchronous file I/O, in case the project closed meanwhile.
    pluginProject(root);
    if (window !== ownerWindow || ownerWindow.isDestroyed() || windowClosing || (pluginProjectGenerations.get(info.path) || 0) !== generation) throw new Error('O projeto ou a janela mudou; tente novamente.');
    return { info: current, spec: { ...after, pluginAction: { pluginId, actionId, revision, generation } } };
  } finally {
    host?.close();
    pendingPluginPrompts.delete(info.path);
  }
}
async function startTerminal(id, size) {
  const session = terminals.get(id), action = session.spec?.pluginAction;
  const preparation = session.spec?.dependencyInstall;
  if (preparation) {
    pluginProject(session.cwd);
    const now = dependencyPlan(session.cwd);
    if (windowClosing || (pluginProjectGenerations.get(session.cwd) || 0) !== preparation.generation ||
        !now.ok || now.revision !== preparation.revision || now.manager !== preparation.manager || JSON.stringify(now.args) !== JSON.stringify(preparation.args)) {
      throw new Error('O projeto mudou antes de iniciar a preparação. Tente novamente.');
    }
    if (preparation.fileIdentity) {
      const stat = fs.statSync(session.spec.file);
      if ([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') !== preparation.fileIdentity) throw new Error('O gerenciador mudou antes de iniciar. Tente novamente.');
    }
  }
  if (action) {
    const root = session.cwd;
    const assertProject = () => {
      pluginProject(root);
      if (windowClosing || (pluginProjectGenerations.get(root) || 0) !== action.generation) throw new Error('O projeto mudou antes do início da ação.');
      if (terminals.get(id) !== session || session.state !== 'pending') throw new Error('A sessão do plugin não está mais disponível.');
    };
    assertProject();
    let host;
    try {
      host = extensions.forVerification(env);
      await host.listPlugins(root);
      const actual = await host.pluginSpec(root, action.pluginId, action.actionId, action.revision);
      if (actual.file !== session.spec.file || actual.label !== session.spec.label || JSON.stringify(actual.args) !== JSON.stringify(session.spec.args) || JSON.stringify(actual.executableIdentity) !== JSON.stringify(session.spec.executableIdentity)) throw new Error('O plugin ou seu executável mudou antes de iniciar. Atualize a lista e tente novamente.');
    } finally { host?.close(); }
    // No asynchronous work between the last identity check and starting PTY.
    assertProject();
  }
  return terminals.start(id, size);
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
    if(action!=='delete' && hasDirtyFilesInProject(info.path)) throw new Error('Salve os arquivos abertos no editor antes de trocar de branch.');
    return git.branchAction(info.path, action, name);
  });
  handle('git:diff', (root, name) => git.diff(project(root).path, name));
  handle('git:commit-detail', (root, hash) => git.commitDetail(project(root).path, hash));
  handle('git:commit', (root, names, message) => {
    const info = project(root);
    if (hasDirtyFilesInProject(info.path)) throw new Error('Salve os arquivos abertos no editor antes de criar uma versão. O Git registra o conteúdo salvo no disco.');
    return git.commit(info.path, names, message);
  });
  handle('git:sync', (root, action) => {
    const info = project(root);
    if (action === 'pull' && hasDirtyFilesInProject(info.path)) throw new Error('Salve os arquivos abertos no editor antes de atualizar o projeto.');
    return git.sync(info.path, action);
  });
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
  handle('kit:plugin-update', async root => { pluginMonitor.invalidate(); try { return applyPlugin(await updateClaudePlugin(env, root ? project(root).path : null)); } finally { pluginMonitor.invalidate(); } });
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
  handle('project:activate', root => remember(knownProject(root).path));
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
  handle('plugin:list', root => extensions.listPlugins(root === null ? null : pluginProject(root).path));
  handle('plugin:reload', root => extensions.reloadPlugins(root === null ? null : pluginProject(root).path));
  handle('plugin:stop-watching', () => { extensions.close(); });
  handle('plugin:execute', async (root, pluginId, actionId, revision) => {
    const approved = await confirmPlugin(root, pluginId, actionId, revision);
    return approved ? terminals.create(approved.info, approved.spec) : null;
  });
  handle('browser:request-result', (id, ok) => previewBridge.finish(id, ok));
  handle('preview:copy-instructions', () => { clipboard.writeText(PREVIEW_INSTRUCTIONS); return true; });
  handle('browser:create', root => preview.create(browserProject(root).path));
  handle('browser:open', (root, url, bounds, id) => preview.open(window, browserProject(root).path, url, bounds, id));
  handle('browser:select', (root, id) => preview.select(root === null ? null : browserProject(root).path, id));
  handle('browser:resize', bounds => preview.resize(bounds));
  handle('browser:visible', visible => preview.setVisible(visible));
  handle('browser:fullscreen', enabled => {
    if (typeof enabled !== 'boolean') throw new Error('Estado de tela cheia inválido.');
    if (!browserFullscreen || !window || window.isDestroyed() || (windowClosing && enabled)) throw new Error('Janela indisponível.');
    return browserFullscreen.set(enabled);
  });
  handle('browser:fullscreen-needs-restore', () => !!browserFullscreen?.needsRestore);
  handle('browser:close', (root, id) => preview.close(project(root).path, id));
  handle('project:forget', async root => {
    const info = project(root);
    advancePluginGeneration(root);
    closedPluginProjects.add(root);
    extensions.closeProject(root);
    const closingBrowser = closeProjectBrowser(info.path);
    config.projects = config.projects.filter(p => p !== root);
    save();
    const browserResult = await closingBrowser;
    if (browserResult.partial) throw new Error('O projeto foi removido, mas não foi possível limpar todos os dados temporários das prévias.');
    // Existing sessions keep their working directory until explicitly closed.
    return bootstrap();
  });
  handle('project:close-sessions', async root => {
    const info = project(root);
    if (closingProjects.has(info.path)) throw new Error('O projeto já está sendo encerrado.');
    closingProjects.add(info.path);
    advancePluginGeneration(info.path);
    try {
      const [result, chats, browserResult] = await Promise.all([terminals.closeProject(info.path), codexChat.closeProject(info.path), closeProjectBrowser(info.path)]);
      previewBridge.revoke(info.path);
      closedPluginProjects.add(info.path);
      extensions.closeProject(info.path);
      debugLog.event('projeto', `Projeto fechado: ${info.path} · ${result.closed} sessões${result.partial || browserResult.partial ? ' · limpeza parcial' : ''}`);
      return { ...result, partial: result.partial || browserResult.partial, chats };
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
  handle('dependency:plan', root => {
    const result = detectPackageManager(project(root).path);
    if (result.ok && result.binaryLock) return { ok: false, error: 'Este projeto usa bun.lockb; prepare-o pelo terminal para controlar uma possível conversão.' };
    return result;
  });
  handle('dependency:prepare', async root => {
    const info = pluginProject(root), owner = window;
    const generation = pluginProjectGenerations.get(info.path) || 0;
    if (!owner || owner.isDestroyed() || windowClosing) throw new Error('A janela está sendo encerrada.');
    const before = dependencyPlan(info.path);
    if (!before.ok) throw new Error(before.error);
    const answer = await dialog.showMessageBox(owner, {
      type: 'question', message: 'Preparar dependências do projeto?',
      detail: `Projeto: ${info.path}\nComando: ${[before.manager, ...before.args].join(' ')}\n\n${before.notice}\n\nOs scripts têm as permissões da sua conta.`,
      buttons: ['Cancelar', 'Preparar'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (answer.response !== 1) return null;
    pluginProject(info.path);
    if (window !== owner || owner.isDestroyed() || windowClosing || (pluginProjectGenerations.get(info.path) || 0) !== generation) throw new Error('O projeto mudou durante a confirmação.');
    const after = dependencyPlan(info.path);
    if (!after.ok || after.revision !== before.revision || after.manager !== before.manager || JSON.stringify(after.args) !== JSON.stringify(before.args)) throw new Error('O projeto mudou durante a confirmação. Tente novamente.');
    let file, args, fileIdentity = null;
    if (process.platform === 'win32') {
      file = env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', [after.manager, ...after.args].join(' ')];
    } else {
      file = executable(after.manager, env);
      if (!file) throw new Error(`${after.manager} não foi encontrado no PATH.`);
      const stat = fs.statSync(file);
      fileIdentity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      args = after.args;
    }
    return terminals.create(info, { file, args, label: 'Preparar dependências', kind: 'action', dependencyInstall: { revision: after.revision, manager: after.manager, args: after.args, generation, fileIdentity } });
  });
  handle('terminal:split', async (root, id, agent) => {
    const info = project(root);
    if (closingProjects.has(info.path)) throw new Error('O projeto está sendo encerrado.');
    const original = terminals.get(id);
    if (original.cwd !== info.path) throw new Error('Este terminal pertence a outro projeto.');
    if (!agent && original.spec?.pluginAction) {
      const { pluginId, actionId, revision } = original.spec.pluginAction;
      const approved = await confirmPlugin(info.path, pluginId, actionId, revision);
      if (!approved) return null;
      if (terminals.get(id) !== original || windowClosing) throw new Error('A sessão original foi encerrada.');
      pluginProject(root);
      // Plugin actions always start in their project root, including a split.
      return terminals.create(approved.info, approved.spec);
    }
    return terminals.split(info.path, id, extensions, agent);
  });
  handle('terminal:start', (id, size) => startTerminal(id, size));
  handle('terminal:write', (id, data) => terminals.write(id, data));
  handle('terminal:resize', (id, size) => terminals.resize(id, size));
  handle('terminal:ack', (id, count) => terminals.acknowledge(id, count));
  handle('terminal:close', id => terminals.close(id));
  handle('service:list', root => services.list(project(root).path));
  handle('service:start', (root, id) => services.start(project(root).path, id));
  handle('service:stop', (root, id) => services.stop(project(root).path, id));
  handle('service:detect', root => sessionServices.detect(project(root).path));
  handle('service:terminate-detected', async (root, pid, started) => {
    const info = project(root), owner = window;
    if (!Number.isSafeInteger(pid) || pid <= 1 || typeof started !== 'string' || started.length > 64) throw new Error('Processo inválido.');
    if (!owner || owner.isDestroyed() || windowClosing) throw new Error('A janela está sendo encerrada.');
    const detected = (await sessionServices.detect(info.path)).items.find(item => item.pid === pid && item.started === started);
    if (!detected) throw new Error('O processo já foi encerrado ou não pertence às sessões deste projeto.');
    const answer = await dialog.showMessageBox(owner, {
      type: 'warning', message: 'Encerrar processo iniciado na sessão?',
      detail: `Comando: ${detected.command}\nPID: ${pid}\nPorta${detected.ports.length > 1 ? 's' : ''}: ${detected.ports.join(', ')}\nSessão: ${detected.sessionLabel}\n\nVocê iniciou este processo num terminal do SEA Dock. Ele e os processos do mesmo grupo recebem um pedido de encerramento (SIGTERM). Trabalho não salvo nele pode ser perdido.`,
      buttons: ['Cancelar', 'Encerrar processo'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (answer.response !== 1) return { status: 'cancelled' };
    const result = await sessionServices.terminate(info.path, pid, started);
    debugLog.event('serviço', `Processo detectado encerrado: PID ${pid}${result.group ? ` · grupo ${result.group}` : ''} · ${detected.command}`);
    return { status: 'terminated', pid, group: result.group };
  });
  handle('debug:state', () => debugLog.state());
  handle('debug:set', enabled => debugLog.setEnabled(enabled));
  handle('debug:renderer', (level, message) => rendererLog(level, message));
  handle('debug:export', async () => {
    const destination = testing ? path.join(app.getPath('userData'), 'exports') : app.getPath('downloads');
    const target = await debugLog.exportTo(destination);
    debugLog.event('debug', `Logs exportados: ${target}`);
    if (!testing) shell.showItemInFolder(target);
    return { file: debugLog.redact(target) };
  });
  handle('debug:open-folder', async () => {
    fs.mkdirSync(debugLog.directory, { recursive: true, mode: 0o700 });
    if (testing) return true;
    const error = await shell.openPath(debugLog.directory);
    if (error) throw new Error(error);
    return true;
  });
}
function createWindow() {
  allowClose = false; dirtyFiles = []; windowClosing = false; windowCleanupDone = false;
  codexChat = new CodexChat({ env, storeFile: path.join(app.getPath('userData'), 'codex-conversations.json'), emit: event => send('chat:event', event), previewEnvironment: root => previewBridge.environment(root) });
  window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 940, minHeight: 620, backgroundColor: '#101214',
    title: 'SEA Dock', icon: windowIcon(app.getAppPath()), titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 22 }, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, webSecurity: true },
  });
  browserFullscreen = new BrowserFullscreen(window, active => send('browser:fullscreen-changed', active));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('render-process-gone', () => {
    extensions.close(); void terminals.closeAllAndWait().catch(() => {});
    void preview.closeAll(); preview.setVisible(true);
    void browserFullscreen?.set(false).catch(() => {});
  });
  window.webContents.on('render-process-gone', (_event, details) => { debugLog.error('renderer', `Processo da interface encerrado: ${details?.reason} · código ${details?.exitCode}`); });
  window.once('ready-to-show', () => window.show());
  window.on('focus', () => { void refreshEnvironment(); });
  window.on('close', event => {
    if (dirtyFiles.length && !allowClose) {
      event.preventDefault();
      if (closePrompt) return;
      closePrompt = true;
      dialog.showMessageBox(window, { type: 'question', message: 'Há arquivos com alterações não salvas.', detail: 'Volte ao editor para salvar ou descarte as alterações antes de fechar.', buttons: ['Voltar ao editor', 'Descartar alterações'], defaultId: 0, cancelId: 0, noLink: true }).then(({ response }) => {
        if (response === 1) { allowClose = true; if (quitRequested) app.quit(); else window?.close(); }
        else { quitRequested = false; send('app:menu', 'editor'); }
      }).finally(() => { closePrompt = false; });
      return;
    }
    if(windowCleanupDone)return;
    event.preventDefault();if(windowClosing)return;windowClosing=true;
    const closingWindow=window;
    // Prevent new edits while the explicit close drains known child processes.
    try { closingWindow.setEnabled(false); } catch {}
    try { services.closeAll(); } catch {}
    void Promise.allSettled([terminals.closeAllAndWait(),actions.closeAllAndWait(),codexChat.closeAll(),preview.closeAll()]).then(async results=>{
      const terminalResult=results[0];
      const actionResult=results[1];
      const chatResult=results[2];
      const browserResult=results[3];
      const partial=terminalResult.status==='rejected' || terminalResult.value.partial || actionResult.status==='rejected' || actionResult.value.partial || chatResult.status==='rejected' || chatResult.value.partial || browserResult.status==='rejected' || browserResult.value.partial;
      if(partial && closingWindow && !closingWindow.isDestroyed()) {
        try { closingWindow.setEnabled(true); } catch {}
        try { await dialog.showMessageBox(closingWindow,{type:'warning',message:'Não foi possível concluir toda a limpeza.',detail:'Alguns processos associados podem continuar ativos ou dados temporários de prévias podem não ter sido limpos. Confira os processos no monitor de atividades do sistema.',buttons:['Fechar'],defaultId:0,noLink:true}); } catch {}
      }
      windowCleanupDone=true;
      if(closingWindow && !closingWindow.isDestroyed()) {
        try { closingWindow.setEnabled(true); } catch {}
        if(quitRequested)app.quit();else closingWindow.close();
      }
    });
  });
  window.on('closed', () => {
    browserFullscreen?.dispose(); browserFullscreen = null;
    previewBridge.revokeAll(); filePreviews.closeAll(); terminals.closeAll(); services.closeAll(); extensions.close(); orchestration.close(); preview.closeAll(); preview.setVisible(true); usage.close(); actions.closeAll(); codexChat.closeAll().catch(() => {}); window = null; dirtyFiles = [];
    const reopen=focusRequested && !quitRequested;windowClosing=false;windowCleanupDone=false;
    if(reopen){focusRequested=false;const files=pendingFiles.splice(0);if(files.length)openFiles(files);else createWindow();focusWindow();}
  });
  window.loadURL('dk-app://app/index.html');
}
let dockCommandPending = false;
async function manageDockCommand(action) {
  if (dockCommandPending) return;
  dockCommandPending = true;
  try {
    await bootReady;
    let message, detail;
    if (action === 'install') {
      if (!app.isPackaged) throw new Error('Abra uma cópia empacotada do SEA Dock, em uma pasta permanente, para instalar o comando.');
      const result = dockCli.install({ home: app.getPath('home'), executable: process.execPath, envPath: env.PATH });
      message = result.alreadyInstalled ? 'O comando dock já está instalado.' : 'Comando dock instalado.';
      detail = `Local: ${result.file}\nAplicativo: ${result.bundle}\n\nUse dock . para abrir a pasta atual. Arquivos abrem a pasta que os contém.`;
      if (!result.availableInPath) detail += '\n\nA pasta ~/.local/bin não foi encontrada no PATH desta sessão. Configure-a no seu terminal para usar o comando.';
    } else {
      const result = dockCli.uninstall({ home: app.getPath('home') });
      message = result.removed ? 'Comando dock removido.' : 'O comando dock não está instalado.';
      detail = `Local: ${result.file}`;
    }
    const options = { type: 'info', message, detail, buttons: ['OK'], noLink: true };
    if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options); else await dialog.showMessageBox(options);
  } catch (error) {
    dialog.showErrorBox('Comando dock', error.message || 'Não foi possível alterar o comando.');
  } finally { dockCommandPending = false; }
}

function menu() {
  const item = (label, accelerator, action) => ({ label, accelerator, click: () => send('app:menu', action) });
  const template = [
    ...(process.platform === 'darwin' ? [{ label: 'SEA Dock', submenu: [{ role: 'about', label: 'Sobre o SEA Dock' }, { type: 'separator' }, { label: 'Instalar comando dock no terminal', click: () => void manageDockCommand('install') }, { label: 'Remover comando dock do terminal', click: () => void manageDockCommand('uninstall') }, { type: 'separator' }, { role: 'hide', label: 'Ocultar SEA Dock' }, { role: 'unhide', label: 'Mostrar tudo' }, { type: 'separator' }, { role: 'quit', label: 'Sair' }] }] : []),
    { label: 'Arquivo', submenu: [item('Abrir projeto…', 'CmdOrCtrl+O', 'open'), item('Salvar arquivo', 'CmdOrCtrl+S', 'save'), item('Nova sessão', 'CmdOrCtrl+T', 'new'), item('Dividir à direita', 'CmdOrCtrl+D', 'split-right'), item('Dividir abaixo', 'CmdOrCtrl+Shift+D', 'split-down'), item('Fechar aba', 'CmdOrCtrl+W', 'close'), { type: 'separator' }, { role: 'quit', label: 'Sair' }] },
    { label: 'Editar', submenu: [{ role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' }, { role: 'selectAll', label: 'Selecionar tudo' }, { type: 'separator' }, item('Buscar no terminal', 'CmdOrCtrl+F', 'search')] },
    { label: 'Visualizar', submenu: [item('Expandir ou restaurar terminal', 'CmdOrCtrl+Shift+E', 'expand'), item('Limpar terminal', 'CmdOrCtrl+K', 'clear'), { role: 'togglefullscreen', label: 'Tela cheia' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: 'Ferramentas de desenvolvimento' }] : [])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
if (primaryInstance) app.whenReady().then(async () => {
  debugLog.event('app', `SEA Dock iniciado${debugLog.forced ? ' com modo debug pela linha de comando' : ''}.`);
  app.on('child-process-gone', (_event, details) => { debugLog.error('app', `Processo auxiliar encerrado: ${details?.type} · ${details?.reason} · código ${details?.exitCode}`); });
  if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(windowIcon(app.getAppPath()));
  const dist = path.resolve(__dirname, '..', 'dist');
  protocol.handle('dk-app', request => {
    const url = new URL(request.url);
    const target = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (url.hostname !== 'app' || !target.startsWith(dist + path.sep)) return new Response('Não encontrado', { status: 404 });
    return net.fetch(pathToFileURL(target).href);
  });
  stateFile = path.join(app.getPath('userData'), 'settings.json');
  config = readState(stateFile);
  bundledTools = bundledToolsPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  dockTools = bundledDockToolsPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  env = detectedEnvironment({ ...process.env });
  filePreviews = new FilePreviews();
  previewBridge = new PreviewBridge(request => { if (!window || window.isDestroyed() || !selected.has(request.root)) throw new Error('Projeto indisponível.'); send('browser:request', request); }, { resolvePath: (root, target) => { if (!selected.has(root)) throw Object.assign(new Error('O projeto desta sessão não está aberto no SEA Dock. Abra o projeto e repita.'), { status: 409 }); return filePreviews.url(root, target); } });
  try { await previewBridge.start(); } catch (error) { console.error("Prévia integrada indisponível:", error.message); }
  terminals = new Terminals(send, env, root => previewBridge.environment(root), (level, message) => debugLog.write(level, 'sessão', message));
  services = new Services(event => send('service:changed', event), env, (level, message) => debugLog.write(level, 'serviço', message));
  sessionServices = new SessionServices({ roots: root => terminals.projectRoots(root) });
  orchestration = new Orchestration(event => send('graph:changed', event));
  preview = new PreviewBrowser(event => send('browser:changed', event), () => {
    if (!browserFullscreen?.active && !browserFullscreen?.requested && !browserFullscreen?.needsRestore) return false;
    void browserFullscreen.set(false).catch(error => send('browser:fullscreen-error', error.message || 'Não foi possível sair da tela cheia.'));
    return true;
  });
  usage = new Usage(env);
  actions = new Actions({ env });
  integrations = new Integrations(env);
  git = new Git(env);
  localRepositories = new LocalRepositories('/Volumes/SEA', env);
  resources = new ResourceMonitor(() => app.getAppMetrics(), { getTerminals: () => [...terminals.resourceRoots(), ...(codexChat?.resourceRoots() || [])] });
  extensions = new Extensions([path.join(app.getAppPath(), 'extensions'), path.join(app.getPath('userData'), 'extensions')], env, event => send('plugin:changed', event));
  registerHandlers(); menu(); createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
  applyEnvironment(detectedEnvironment(await loginEnvironment()));
  environmentRefreshAt = Date.now();
  for (const candidate of [config.kitRoot, env.DK_ROOT, path.resolve(__dirname, '..', '..', 'dk')]) {
    if (!candidate) continue;
    try { kit = kitInfo(candidate); break; } catch {}
  }
  if (kit && config.kitRoot !== kit.path) { config.kitRoot = kit.path; save(); }
  if (testing && process.env.DK_TERMINAL_TEST_PROJECT) remember(process.env.DK_TERMINAL_TEST_PROJECT);
  for (const file of pendingFiles.splice(0)) { try { startupProject = remember(folderForFile(file)); } catch {} }
  prepared = true; finishBoot();
  if (focusRequested) { focusRequested=false; focusWindow(); }
}).catch(error => { dialog.showErrorBox('SEA Dock', error.message); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { quitRequested = true; });
app.on('will-quit', () => { debugLog.event('app', 'SEA Dock encerrando.'); });
app.on('will-quit', () => { filePreviews?.closeAll(); previewBridge?.close(); terminals?.closeAll(); services?.closeAll(); extensions?.close(); orchestration?.close(); preview?.closeAll(); usage?.close(); actions?.closeAll(); codexChat?.closeAll().catch(() => {}); });
