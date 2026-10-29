// Traduz a saída de git e glab em orientações para a pessoa. Nunca devolve a
// saída bruta inteira: só uma linha curta, sem URLs com credenciais.
const HOST = 'gitlab.seatecnologia.com.br';
const LOGIN = `glab auth login --hostname ${HOST}`;
const SSH_KEYS = `https://${HOST}/-/user_settings/ssh_keys`;

function output(error) {
  return [error?.stderr, error?.stdout, error?.message].map(value => Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : '').join('\n');
}

// Classifica uma falha de transporte do Git (clone, push, fetch).
function gitFailure(error) {
  const text = output(error);
  if (error?.killed) return 'timeout';
  if (/already exists and is not an empty directory/i.test(text)) return 'exists';
  if (/No space left on device/i.test(text)) return 'disk';
  if (/could not be found or you don't have permission|Repository not found|project you were looking for could not be found|404 Not Found/i.test(text)) return 'access';
  if (/You are not allowed to push|not allowed to push code|protected branch|pre-receive hook declined/i.test(text)) return 'protected';
  if (/Permission denied \(publickey|Host key verification failed|no such identity|Too many authentication failures|sign_and_send_pubkey|Load key .*: (invalid format|bad permissions)/i.test(text)) return 'ssh';
  if (/could not read Username|could not read Password|terminal prompts disabled|Authentication failed|HTTP Basic: Access denied|The requested URL returned error: 40[13]/i.test(text)) return 'https';
  if (/Could not resolve host|Could not resolve hostname|Network is unreachable|Operation timed out|Connection timed out|Connection refused|Connection reset|Failed to connect|unable to access|kex_exchange_identification|Connection closed by/i.test(text)) return 'network';
  return 'other';
}

function lastLine(error) {
  const lines = output(error).split(/\r?\n/).map(line => line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(Boolean)
    .filter(line => !/^Cloning into|^remote: (Counting|Compressing|Enumerating|Total)|^Receiving objects|^Resolving deltas/.test(line));
  const line = lines.find(item => /^(fatal|error|ERROR):/.test(item)) || lines[0] || '';
  return line.replace(/https?:\/\/[^\s/@]+@/g, 'https://').slice(0, 300);
}

const GIT_MESSAGES = {
  timeout: 'A operação demorou demais e foi interrompida. Confira a conexão (e a VPN, se usar) e tente novamente.',
  disk: 'Não há espaço livre no disco de destino. Libere espaço e tente novamente.',
  access: 'Sua conta não tem acesso a este projeto no GitLab SEA, ou ele não existe mais. Peça acesso a quem administra o grupo.',
  protected: 'O GitLab recusou o envio: a branch está protegida ou sua conta não pode enviar para ela.',
  ssh: `O GitLab recusou sua chave SSH. Cadastre a chave pública em ${SSH_KEYS} ou configure o acesso por HTTPS com \`${LOGIN}\` (aceite configurar o Git quando perguntado).`,
  https: `O Git não tem credencial para o GitLab SEA. Cadastre sua chave SSH em ${SSH_KEYS} ou rode \`${LOGIN}\` no terminal e aceite configurar o Git.`,
  network: 'Não foi possível conectar ao GitLab SEA. Confira a internet (e a VPN, se usar) e tente novamente.',
};

function gitMessage(kind, error, prefix) {
  if (kind === 'other') { const detail = lastLine(error); return `${prefix}${detail ? ` Detalhe do Git: ${detail}` : ''}`; }
  return `${prefix} ${GIT_MESSAGES[kind]}`;
}

// Erros de `glab api`: o corpo JSON sai no stdout e o status no stderr.
function glabFailure(error) {
  const text = output(error);
  if (error?.code === 'ENOENT') return 'missing';
  if (error?.killed) return 'timeout';
  if (/HTTP 401|401 Unauthorized|not authenticated|no token|glab auth login|token (is )?(invalid|expired)/i.test(text)) return 'auth';
  if (/has already been taken|already exists/i.test(text)) return 'taken';
  if (/HTTP 403|403 Forbidden|not allowed|don't have permission|You cannot create projects|namespace.*(is not valid|invalid)/i.test(text)) return 'forbidden';
  if (/HTTP 404|404 .*Not Found/i.test(text)) return 'not-found';
  if (/no such host|dial tcp|i\/o timeout|connection refused|network is unreachable|TLS handshake/i.test(text)) return 'network';
  if (/HTTP 400|400 Bad Request/i.test(text)) return 'invalid';
  return 'other';
}

const GLAB_MESSAGES = {
  missing: `Instale o GitLab CLI (glab) e entre com \`${LOGIN}\`.`,
  timeout: 'O GitLab SEA demorou demais para responder. Tente novamente em instantes.',
  auth: `O GitLab CLI não está conectado ao GitLab SEA. Rode \`${LOGIN}\` no terminal (ou use Perfil e configurações > Contas) e tente novamente.`,
  taken: 'Já existe um projeto com esse caminho no grupo escolhido. Escolha outro caminho ou outro grupo.',
  forbidden: 'Sua conta não tem permissão para criar projetos nesse grupo. Escolha outro grupo ou peça permissão a quem administra o grupo.',
  'not-found': 'O grupo escolhido não foi encontrado ou não está visível para sua conta.',
  network: 'Não foi possível conectar ao GitLab SEA. Confira a internet (e a VPN, se usar) e tente novamente.',
  invalid: 'O GitLab recusou os dados do projeto. Confira o nome e o caminho (use letras minúsculas, números e hífens).',
};

function glabMessage(kind, error) {
  if (kind === 'other') { const detail = lastLine(error); return `Não foi possível concluir a operação no GitLab SEA.${detail ? ` Detalhe: ${detail}` : ''}`; }
  return GLAB_MESSAGES[kind];
}

module.exports = { HOST, LOGIN, SSH_KEYS, gitFailure, gitMessage, glabFailure, glabMessage, lastLine };
