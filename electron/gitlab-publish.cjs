// "Criar projeto no Git": cria o projeto no GitLab SEA pelo glab (que guarda
// a credencial; o app nunca lê nem grava token) e publica a pasta local com o
// Git. Toda execução recebe argumentos separados, sem shell. Nada é criado sem
// um plano revisado pela pessoa (`plan` devolve um id de uso único).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { executable } = require('./core.cjs');
const { run } = require('./integrations.cjs');
const { remoteIdentity } = require('./local-repositories.cjs');
const { HOST, LOGIN, gitFailure, gitMessage, glabFailure, glabMessage, lastLine } = require('./gitlab-errors.cjs');

const ROOT_GROUP = 'design';
const VISIBILITIES = ['private', 'internal'];
const CREATION_LEVEL = { developer: 30, maintainer: 40, owner: 50 };
const PLAN_TTL = 10 * 60 * 1000;
const FIRST_COMMIT = 'Primeira versão';

function slugify(value) {
  const slug = String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/[._-]{2,}/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 100).replace(/[._-]+$/, '');
  return slug || 'projeto';
}
function validSlug(value) {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(value) && !/[._-]{2,}/.test(value) && !/\.(git|atom)$/.test(value);
}
function validName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 120 && /^[\p{L}\p{N}_][\p{L}\p{N}_.+\- ]*$/u.test(value);
}
// Host of a Git remote URL (scp-like or URL); null when it cannot be parsed.
function remoteHost(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim(), scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)/.exec(text);
  if (scp && !/^[a-z]+:\/\//i.test(text)) return scp[1].toLowerCase();
  try { return new URL(text).hostname.toLowerCase() || null; } catch { return null; }
}
function freeRemoteName(remotes) {
  for (let index = 1; index < 100; index++) { const name = index === 1 ? 'anterior' : `anterior-${index}`; if (!remotes.includes(name)) return name; }
  throw new Error('Não foi possível escolher um nome para o remoto atual.');
}

class GitlabPublisher {
  constructor(getEnv, execute = run, busy = new Set()) {
    this.getEnv = typeof getEnv === 'function' ? getEnv : () => getEnv;
    this.execute = execute; this.busy = busy; this.plans = new Map();
  }
  env() {
    const env = { ...this.getEnv(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', NO_COLOR: '1' };
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|TRACE|CURL_VERBOSE|ASKPASS|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key)) delete env[key];
    delete env.GLAB_DEBUG_HTTP; delete env.DEBUG;
    return env;
  }
  glabFile() {
    const file = executable('glab', this.getEnv());
    if (!file) throw new Error(glabMessage('missing'));
    return file;
  }
  gitFile() {
    const file = executable('git', this.getEnv());
    if (!file) throw new Error('Instale o Git para publicar o projeto.');
    return file;
  }
  async glab(args, options = {}) {
    const file = this.glabFile();
    // Run from the filesystem root: glab must not infer a host from the cwd.
    try { return await this.execute(file, [...args, '--hostname', HOST], this.env(), { timeout: 20000, maxBuffer: 2 * 1024 * 1024, cwd: path.parse(process.cwd()).root, ...options }); }
    catch (error) { const kind = glabFailure(error); throw Object.assign(new Error(glabMessage(kind, error)), { kind }); }
  }
  async json(args, options) {
    const text = await this.glab(args, options);
    try { return JSON.parse(text); } catch { throw new Error('Resposta inválida do GitLab SEA. Tente novamente.'); }
  }
  git(root, args, options = {}) {
    return this.execute(this.gitFile(), ['-C', root, ...args], options.env || this.env(), { timeout: 20000, maxBuffer: 2 * 1024 * 1024, ...options, env: undefined });
  }
  async gitStep(root, args, failure) {
    try { return await this.git(root, args); }
    catch (error) { const detail = lastLine(error); throw new Error(`${failure}${detail ? ` Detalhe do Git: ${detail}` : ''}`); }
  }
  async networkEnv(root) {
    const env = this.env();
    if (env.GIT_SSH_COMMAND || env.GIT_SSH) return env;
    let configured = '';
    try { configured = String(await this.git(root, ['config', '--get', 'core.sshCommand'])).trim(); } catch {}
    // Never wait for an SSH passphrase or host-key prompt.
    if (!configured) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=20';
    return env;
  }

  // Groups under `design` where the account may create projects.
  async namespaces() {
    const byLevel = {};
    for (const level of [30, 40, 50]) {
      const found = [];
      for (let page = 1; page <= 5; page++) {
        const values = await this.json(['api', `groups?${new URLSearchParams({ min_access_level: String(level), per_page: '100', page: String(page), order_by: 'path', sort: 'asc' })}`]);
        if (!Array.isArray(values)) throw new Error('Resposta inválida do GitLab SEA. Tente novamente.');
        found.push(...values); if (values.length < 100) break;
      }
      byLevel[level] = new Set(found.map(group => group?.id));
      if (level === 30) byLevel.groups = found;
    }
    const result = [];
    for (const group of byLevel.groups) {
      if (!group || !Number.isSafeInteger(group.id) || typeof group.full_path !== 'string' || group.full_path.length > 500) continue;
      const parts = group.full_path.split('/');
      if (parts[0] !== ROOT_GROUP || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) continue;
      const needed = CREATION_LEVEL[group.project_creation_level || 'maintainer'];
      if (!needed || !byLevel[needed]?.has(group.id)) continue;
      result.push({ id: group.id, fullPath: group.full_path, name: typeof group.full_name === 'string' ? group.full_name.slice(0, 200) : group.full_path, visibility: typeof group.visibility === 'string' ? group.visibility : 'private' });
    }
    return result.sort((a, b) => a.fullPath === ROOT_GROUP ? -1 : b.fullPath === ROOT_GROUP ? 1 : a.fullPath.localeCompare(b.fullPath));
  }

  async local(root) {
    let top = null;
    try { top = String(await this.git(root, ['rev-parse', '--show-toplevel'])).trim(); } catch {}
    if (!top) return { repository: false, branch: 'main', hasHead: false, origin: null, remotes: [], changes: this.folderEntries(root) };
    if (fs.realpathSync(top) !== fs.realpathSync(root)) throw new Error(`Esta pasta fica dentro do repositório ${top}. Abra a pasta raiz do repositório para publicá-lo.`);
    const [branch, head, origin, remotes, status] = await Promise.all([
      this.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(value => String(value).trim(), () => null),
      this.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(value => !!String(value).trim(), () => false),
      this.git(root, ['config', '--local', '--no-includes', '--get', 'remote.origin.url']).then(value => String(value).trim() || null, () => null),
      this.git(root, ['remote']).then(value => String(value).split('\n').map(item => item.trim()).filter(Boolean), () => []),
      this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).then(String, () => ''),
    ]);
    return { repository: true, branch, hasHead: head, origin, remotes, changes: status.split('\0').filter(Boolean).length };
  }
  folderEntries(root) {
    try { return fs.readdirSync(root).filter(name => name !== '.DS_Store').length; } catch { return 0; }
  }
  // Paths that must not go into a first version without a .gitignore entry.
  async exposed(root, repository) {
    const risky = ['node_modules', '.env'].filter(name => fs.existsSync(path.join(root, name)));
    if (!risky.length) return [];
    if (repository) {
      const ignored = await Promise.all(risky.map(name => this.git(root, ['check-ignore', '-q', '--', name]).then(() => true, () => false)));
      return risky.filter((_name, index) => !ignored[index]);
    }
    let lines = [];
    try { lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map(line => line.trim()); } catch {}
    return risky.filter(name => !lines.some(line => [name, `/${name}`, `${name}/`, `/${name}/`, `${name}*`, `${name}.*`].includes(line)));
  }

  async options(root) {
    const [namespaces, local] = await Promise.all([this.namespaces(), this.local(root)]);
    const company = local.origin ? remoteHost(local.origin) === HOST : false;
    const name = path.basename(root);
    return {
      name: validName(name) ? name : slugify(name), path: slugify(name),
      namespaces, defaultNamespace: namespaces.find(item => item.fullPath === ROOT_GROUP)?.id ?? namespaces[0]?.id ?? null,
      visibilities: VISIBILITIES,
      local: { repository: local.repository, branch: local.branch, hasHead: local.hasHead, changes: local.changes, origin: local.origin ? { url: local.origin.replace(/\/\/[^/@]+@/, '//'), company } : null },
    };
  }

  normalize(input) {
    if (!input || typeof input !== 'object') throw new Error('Preencha os dados do projeto.');
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    const slug = typeof input.path === 'string' ? input.path.trim() : '';
    const description = typeof input.description === 'string' ? input.description.replace(/\s+/g, ' ').trim() : '';
    if (!validName(name)) throw new Error('Informe um nome de até 120 caracteres, começando por letra ou número (letras, números, espaço, ponto, hífen, sublinhado e +).');
    if (!validSlug(slug)) throw new Error('O caminho deve ter letras minúsculas, números, ponto, hífen ou sublinhado, começar e terminar com letra ou número, e não terminar em .git.');
    if (description.length > 500 || /[\u0000-\u001f\u007f]/.test(description)) throw new Error('A descrição deve ter até 500 caracteres.');
    if (!Number.isSafeInteger(input.namespaceId) || input.namespaceId <= 0) throw new Error('Escolha o grupo de destino.');
    if (!VISIBILITIES.includes(input.visibility)) throw new Error('Escolha a visibilidade: privado ou interno.');
    return { name, path: slug, description, namespaceId: input.namespaceId, visibility: input.visibility, commit: input.commit === true, renameOrigin: input.renameOrigin === true };
  }

  async plan(root, rawInput) {
    const input = this.normalize(rawInput);
    const local = await this.local(root);
    if (local.repository && !local.branch) throw new Error('O repositório está em um HEAD destacado. Troque para uma branch antes de publicar.');
    let renameTo = null;
    if (local.origin) {
      if (remoteHost(local.origin) === HOST) throw new Error('Esta pasta já está ligada ao GitLab SEA. Use Enviar no painel Git para publicar as versões.');
      if (!input.renameOrigin) throw new Error('Já existe um remoto “origin” apontando para outro servidor. Marque a opção para renomeá-lo antes de continuar.');
      renameTo = freeRemoteName(local.remotes);
    }
    const commit = !local.hasHead && input.commit;
    if (commit) {
      if (!local.changes) throw new Error('A pasta não tem arquivos para a primeira versão.');
      const exposed = await this.exposed(root, local.repository);
      if (exposed.length) throw new Error(`${exposed.join(' e ')} entraria na primeira versão. Adicione ${exposed.map(name => `${name}${name === 'node_modules' ? '/' : ''}`).join(' e ')} ao .gitignore da pasta e tente novamente.`);
      const identity = await Promise.all(['user.name', 'user.email'].map(key => local.repository ? this.git(root, ['config', '--get', key]).then(value => String(value).trim(), () => '') : this.execute(this.gitFile(), ['config', '--get', key], this.env(), { cwd: path.parse(process.cwd()).root, timeout: 5000 }).then(value => String(value).trim(), () => '')));
      if (identity.some(value => !value)) throw new Error('Configure seu nome e e-mail no Git antes da primeira versão: git config --global user.name "Seu Nome" e git config --global user.email "voce@seatecnologia.com.br".');
    }
    const namespaces = await this.namespaces();
    const namespace = namespaces.find(item => item.id === input.namespaceId);
    if (!namespace) throw new Error('Sua conta não pode criar projetos nesse grupo. Escolha outro grupo do Design.');
    if (input.visibility === 'internal' && namespace.visibility === 'private') throw new Error('O grupo escolhido é privado; o projeto também precisa ser privado.');
    const fullPath = `${namespace.fullPath}/${input.path}`;
    try {
      await this.glab(['api', `projects/${encodeURIComponent(fullPath)}`]);
      throw Object.assign(new Error(`Já existe um projeto em ${fullPath}. Escolha outro caminho.`), { kind: 'taken' });
    } catch (error) { if (error.kind !== 'not-found') throw error; }
    const branch = local.branch || 'main';
    const push = local.hasHead || commit;
    const webUrl = `https://${HOST}/${fullPath}`, sshUrl = `git@${HOST}:${fullPath}.git`;
    const steps = [];
    if (!local.repository) steps.push(`Iniciar o Git nesta pasta (branch ${branch}).`);
    if (commit) steps.push(`Criar a primeira versão (“${FIRST_COMMIT}”) com os arquivos da pasta.`);
    steps.push(`Criar o projeto ${input.visibility === 'private' ? 'privado' : 'interno'} “${input.name}” em ${fullPath}.`);
    if (renameTo) steps.push(`Renomear o remoto atual “origin” para “${renameTo}”.`);
    steps.push(`Ligar esta pasta ao novo projeto como “origin” (${sshUrl}).`);
    steps.push(push ? `Enviar a branch ${branch} para o GitLab SEA.` : 'Nada será enviado agora: a pasta ainda não tem versões salvas.');
    const notes = [];
    if (local.hasHead && local.changes) notes.push(`${local.changes} alteração(ões) ainda não salvas não serão enviadas.`);
    if (!push) notes.push('Depois de salvar a primeira versão no painel Git, use Enviar.');
    const id = crypto.randomUUID();
    const plan = { id, root, input, namespace: { id: namespace.id, fullPath: namespace.fullPath }, fullPath, webUrl, sshUrl, branch, init: !local.repository, commit, renameTo, push, steps, notes, fingerprint: JSON.stringify([local.repository, local.branch, local.hasHead, local.origin]), at: Date.now() };
    for (const [key, value] of this.plans) if (value.root === root || Date.now() - value.at > PLAN_TTL) this.plans.delete(key);
    this.plans.set(id, plan);
    return { id, fullPath, webUrl, sshUrl, branch, steps, notes };
  }

  // Executes a plan the person confirmed. Local steps run first, so a local
  // problem never leaves an empty project behind on the server.
  async publish(root, planId) {
    const plan = this.plans.get(planId);
    if (!plan || plan.root !== root || Date.now() - plan.at > PLAN_TTL) throw new Error('A revisão expirou. Revise os dados e confirme novamente.');
    this.plans.delete(planId);
    if (this.busy.has(root)) throw new Error('Já existe uma operação Git em andamento.');
    this.busy.add(root);
    const done = [];
    try {
      const local = await this.local(root);
      if (JSON.stringify([local.repository, local.branch, local.hasHead, local.origin]) !== plan.fingerprint) throw new Error('O repositório mudou depois da revisão. Revise os dados e confirme novamente.');
      if (plan.init) { await this.gitStep(root, ['init', '-b', plan.branch], 'Não foi possível iniciar o Git nesta pasta.'); done.push('init'); }
      if (plan.commit) {
        await this.gitStep(root, ['add', '-A', '--', '.'], 'Não foi possível preparar os arquivos da primeira versão.');
        await this.gitStep(root, ['commit', '-m', FIRST_COMMIT], 'Não foi possível salvar a primeira versão.');
        done.push('commit');
      }
      const body = ['api', 'projects', '-X', 'POST', '-f', `name=${plan.input.name}`, '-f', `path=${plan.input.path}`, '-f', `namespace_id=${plan.namespace.id}`, '-f', `visibility=${plan.input.visibility}`];
      if (plan.input.description) body.push('-f', `description=${plan.input.description}`);
      const created = await this.json(body, { timeout: 30000 });
      done.push('project');
      if (!created || created.path_with_namespace !== plan.fullPath || !Number.isSafeInteger(created.id)) throw new Error(`O GitLab SEA respondeu com um projeto diferente do pedido. Confira ${plan.webUrl} antes de tentar de novo; a pasta não foi ligada a ele.`);
      const webUrl = typeof created.web_url === 'string' && created.web_url === plan.webUrl ? created.web_url : plan.webUrl;
      const sshUrl = typeof created.ssh_url_to_repo === 'string' && remoteIdentity(created.ssh_url_to_repo) === plan.fullPath ? created.ssh_url_to_repo : plan.sshUrl;
      const result = { webUrl, fullPath: plan.fullPath, branch: plan.branch, pushed: false, renamed: plan.renameTo, notes: plan.notes, error: null };
      try {
        if (plan.renameTo) { await this.gitStep(root, ['remote', 'rename', 'origin', plan.renameTo], 'Não foi possível renomear o remoto atual.'); done.push('rename'); }
        await this.gitStep(root, ['remote', 'add', 'origin', sshUrl], 'Não foi possível ligar a pasta ao projeto.'); done.push('remote');
        if (plan.push) {
          const env = await this.networkEnv(root);
          try { await this.git(root, ['push', '--set-upstream', 'origin', `refs/heads/${plan.branch}:refs/heads/${plan.branch}`], { env, timeout: 900000, maxBuffer: 4 * 1024 * 1024 }); }
          catch (error) { throw new Error(gitMessage(gitFailure(error), error, 'O envio não foi concluído.')); }
          result.pushed = true;
        }
      } catch (error) {
        // The project exists: report it with the link instead of hiding it.
        result.error = `O projeto foi criado em ${webUrl}, mas ${done.includes('remote') ? 'o envio' : 'a ligação com a pasta'} falhou. ${error.message}`;
      }
      return result;
    } catch (error) {
      if (done.includes('project')) throw error;
      const local = [done.includes('init') && 'o Git foi iniciado nesta pasta', done.includes('commit') && 'a primeira versão foi salva'].filter(Boolean);
      throw new Error(`Nada foi criado no GitLab SEA${local.length ? ` (${local.join(' e ')})` : ''}. ${error.message}`);
    } finally { this.busy.delete(root); }
  }
}

module.exports = { GitlabPublisher, slugify, validSlug, validName, remoteHost, LOGIN };
