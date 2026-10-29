import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Gera docs/coordenacoes/M*.json e host-claude-code.json a partir da definição abaixo. Uso: node docs/coordenacoes/gerar.mjs
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'docs/coordenacoes');
const PLANO = 'docs/plano-plugins-projeto.md', ORQ = 'docs/orquestracao-plugins-projeto.md';
const VISAO = 'docs/planejamento/README.md';
const DETALHE = { M0: 'docs/planejamento/01-m0-m1.md', M1: 'docs/planejamento/01-m0-m1.md', M2: 'docs/planejamento/02-m2-m3.md', M3: 'docs/planejamento/02-m2-m3.md', M4: 'docs/planejamento/03-m4-qualidade.md' };
const sha = rel => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
const exists = rel => fs.existsSync(path.join(root, rel));
const KiB = 1024, MiB = 1024 * KiB;
const perfis = {
  leitor: { modelo: 'haiku', esforco: 'low', host: 'claude_code' },
  analista: { modelo: 'opus', esforco: 'high', host: 'claude_code' },
  implementador: { modelo: 'opus', esforco: 'high', host: 'claude_code' },
  'implementador-critico': { modelo: 'fable', esforco: 'xhigh', host: 'claude_code' },
  revisor: { modelo: 'opus', esforco: 'medium', host: 'claude_code' },
  'revisor-seguranca': { modelo: 'fable', esforco: 'high', host: 'claude_code' },
  testador: { modelo: 'sonnet', esforco: 'medium', host: 'claude_code' },
};
const politica_modelos = { leitura: 'leitor', analise: 'analista', implementacao: 'implementador', revisao: 'revisor' };
const LIM = {
  leitura: { chamadas: 15, contexto_bytes: 256 * KiB, tentativas: 2 },
  analise: { chamadas: 25, contexto_bytes: 512 * KiB, tentativas: 2 },
  implementacao: { chamadas: 60, contexto_bytes: 768 * KiB, tentativas: 2 },
  critico: { chamadas: 80, contexto_bytes: 1 * MiB, tentativas: 2 },
  revisao: { chamadas: 30, contexto_bytes: 512 * KiB, tentativas: 2 },
  verificacao: { chamadas: 20, contexto_bytes: 256 * KiB, tentativas: 2 },
};
const RESTRICOES_BASE = [
  'Nenhum token lido ou gravado pelo DK; login continua nas CLIs oficiais.',
  'Nenhum JavaScript de terceiros no renderer; UI de plugin declarada em JSON.',
  'Sem --permission-mode bypassPermissions; aprovações passam pela UI.',
  'Não encerrar automaticamente sessão ou agente ativo nem descartar trabalho não salvo; prazo gera aviso e decisão do usuário.',
  'Arquivos do usuário permanecem limpos: bridges e prompts injetados em memória.',
  'Nomenclatura dk em tudo (data-dk-*, dk-edit-*, DK_*, .dk/).',
  'Resultado de packet é JSON de até 4 KiB em dados; nada de histórico nem código colado.',
  'Critérios de texto e resultados declarados são sinais preliminares; o aceite depende de testes e revisão independente vinculados à revisão real.',
  'Alterar somente os arquivos declarados no packet; mudança fora do escopo reprova.',
  'Sem leitura síncrona nova no main sem limite de tamanho.',
  'Quando houver marco anterior, não despachar implementação até verificar seu estado e evidências reais; resultado declarado pelo executor não é prova suficiente.',
  'Packet de escrita roda só npm test unitário; npm run build e testes de desktop ficam nos packets de verificação, porque dist/ entra no retrato do changeset.',
];
function fileCrit(id, descricao, arquivo, valor) {
  return valor === undefined ? { id, descricao, tipo: 'arquivo_existe', arquivo } : { id, descricao, tipo: 'contem', arquivo, valor };
}
function jsonCrit(id, descricao, ponteiro, valor) { return { id, descricao, tipo: 'resultado_json_valor', ponteiro, valor }; }
function build(coord, { pedido, objetivo, lacunas, saida, extras = [] }, defs) {
  const marco = coord.slice(-2), detalhe = DETALHE[marco];
  if (!detalhe) throw new Error(`Marco sem planejamento associado: ${coord}`);
  const fontes = [PLANO, ORQ, VISAO, detalhe];
  const fontesComHash = () => fontes.map(arquivo => ({ arquivo, sha256: sha(arquivo) }));
  const owners = new Map();
  const tarefas = defs.map(d => {
    const t = { id: d.id, objetivo: d.objetivo, categoria: d.categoria, depende_de: d.depende_de || [], condicao: d.condicao || null,
      fontes: [...fontes], arquivos: d.arquivos || [], skills: d.skills || [], tools: d.tools || ['Read', 'Grep', 'Glob'],
      criterios: d.criterios, limites: LIM[d.limites || d.categoria], perfil: d.perfil || null, contrato_tarefa: null, acao_externa: null, autorizacao: null, repositorio_verificado_por: null };
    if (t.arquivos.length) {
      for (const a of t.arquivos) { if (owners.has(a)) throw new Error(`${coord}: ${a} tem dois donos (${owners.get(a)}, ${d.id})`); owners.set(a, d.id); }
      t.tools = d.tools || ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];
      t.contrato_tarefa = { schema_version: 1, id: `${coord}-${d.id}`.toUpperCase().replace(/[^A-Z0-9_-]/g, '-').slice(0, 80), objetivo: d.objetivo, origem: `${PLANO} seção 3 e ${ORQ}`,
        fontes: fontesComHash(),
        alvos: t.arquivos.map(a => exists(a) ? { arquivo: a, sha256: sha(a) } : { arquivo: a, ausente: true }),
        criterios: d.criterios, saida: { arquivo: t.arquivos[0], formato: d.formato || 'texto', max_palavras: d.max_palavras || 6000, max_passos: 40 },
        parada: { sucesso: 'todos_criterios', max_tentativas: 2 } };
    }
    return t;
  });
  // Reserva: uma tentativa por tarefa mais 40% para as segundas tentativas excepcionais.
  const chamadas = Math.ceil(tarefas.reduce((s, t) => s + t.limites.chamadas, 0) * 1.4);
  const contexto = Math.ceil(tarefas.reduce((s, t) => s + t.limites.contexto_bytes, 0) * 1.4);
  if (contexto > 16 * MiB || chamadas > 1000) throw new Error(`${coord}: orçamento estoura (${chamadas} chamadas, ${contexto} bytes)`);
  return { schema_version: 1, id: coord, pedido, objetivo, modo: 'execucao',
    contexto: fontesComHash(),
    restricoes: [...RESTRICOES_BASE, ...extras], lacunas, saida,
    orcamento: { max_tarefas: tarefas.length, max_chamadas: chamadas, max_contexto_bytes: contexto, max_tentativas: Math.min(100, tarefas.length + Math.ceil(tarefas.length * 0.4)) },
    perfis, politica_modelos, tarefas };
}
// Blocos repetidos
const G0 = { id: 'g0-decisoes', objetivo: 'Ler a seção 7 do plano e o gate G0 da orquestração e declarar quais decisões já estão registradas no plano; não decidir por ninguém.', categoria: 'analise',
  criterios: [jsonCrit('C1', 'As três decisões de G0 estão registradas no plano', '/decisoes/pendentes', 0)],
  skills: ['dk:dk-entender-csd'] };
const COND = { dependencia: 'g0-decisoes', ponteiro: '/decisoes/pendentes', igual: 0 };
const marcoAnterior = (id, coordAnterior, entrega) => ({ id, objetivo: `Confirmar que ${coordAnterior} foi concluída: ${entrega}. Ler o estado em .dk/coordenacoes e o README; devolver dados.anterior.concluida.`, categoria: 'leitura',
  criterios: [jsonCrit('C1', 'Marco anterior concluído com verificação registrada', '/anterior/concluida', true)] });
const CONDA = id => ({ dependencia: id, ponteiro: '/anterior/concluida', igual: true });
const revisao = (id, deps, perfil, foco) => ({ id, objetivo: `Revisar em contexto novo todas as alterações do marco contra o plano e a orquestração: conferir git status --short e git diff e ler explicitamente cada arquivo novo autorizado ainda não rastreado. Foco em: ${foco}. Devolver achados por arquivo e linha, classificados em bloqueante, importante e sugestão.`, categoria: 'revisao', depende_de: deps, perfil, tools: ['Read', 'Grep', 'Glob', 'Bash'],
  criterios: [jsonCrit('C1', 'Nenhum achado bloqueante aberto', '/revisao/bloqueantes', 0)] });
const verificacao = (id, deps, testeDesktop, extra = '') => ({ id, objetivo: `Executar npm run test:all e node ${testeDesktop} em cópia isolada fora da árvore inspecionada, com perfil temporário, depois dos packets de escrita. Antes dos testes, comparar o inventário e os hashes da árvore candidata e da cópia, incluindo alterações não commitadas e arquivos novos relevantes; rejeitar cópia com arquivo ausente ou divergente. Medir cenários de recursos pertinentes ao marco em condições comparáveis, identificando CPU, RSS, processos, watchers e limitações quando aplicável; marcar como não verificado o cenário que não puder ser executado. Registrar inventários, hashes, medições, saída, contagem e falhas em evidências compactas, sem dados sensíveis, vinculadas ao resultado por caminho local e hash. Validar previamente em fixture descartável se o runtime aceita evidências em .dk/coordenacoes/evidencias sem reprovar o retrato e respeita o limite de 4 MiB por arquivo; se não, definir outro mecanismo verificável antes do despacho. Conferir testes adversariais do planejamento. Não corrigir código: falha reprova a tarefa; aceite de desempenho depende de exame independente das evidências, não de uma declaração. ${extra}`, categoria: 'revisao', perfil: 'testador', limites: 'verificacao', depende_de: deps, tools: ['Bash', 'Read'],
  criterios: [jsonCrit('C1', 'Suíte completa passou', '/testes/completos', 'passou'), jsonCrit('C2', 'Teste de desktop do marco passou', '/testes/desktop', 'passou')] });
const docs = (id, deps, secao, sinal) => ({ id, objetivo: `Documentar no README a seção "${secao}": o que o recurso faz e não faz, permissões, limites e como testar. Sem promessas de recursos futuros.`, categoria: 'implementacao', perfil: 'testador', depende_de: deps, arquivos: ['README.md'], formato: 'markdown',
  criterios: [fileCrit('C1', 'README documenta o recurso', 'README.md', sinal)] });
const testesDesktop = (id, deps, arquivo, script, extraFiles = [], extraCrit = []) => ({ id, objetivo: `Criar ${arquivo} no padrão de tests/desktop.cjs (perfil temporário, projeto temporário, sem rede) cobrindo a entrega verificável do marco, e registrar o script "${script}" e a entrada em test:all no package.json.`, categoria: 'implementacao', perfil: 'testador', depende_de: deps, arquivos: [arquivo, 'package.json', ...extraFiles],
  criterios: [fileCrit('C1', 'Teste de desktop existe', arquivo), fileCrit('C2', 'Script registrado', 'package.json', `"${script}"`), ...extraCrit] });

// ---------- M0 ----------
const M0 = build('COORD-PLUGINS-M0', {
  pedido: 'Fase 0 do plano: host de plugins v2 com plugin.json schema 2, raiz por projeto em .dk/plugins, permissões declaradas, recarga por fs.watch e registro de views no renderer.',
  objetivo: 'M0: plugin v2 carregado de .dk/plugins, listado e executado após ação explícita, com teste unitário e desktop.',
  lacunas: ['Origin ainda aponta para o fork odoisbr; o projeto no GitLab design/ não existe. Commits ficam fora desta coordenação.'],
  saida: 'Código, testes e README no repositório; estado em .dk/coordenacoes/COORD-PLUGINS-M0.json.',
  extras: ['Manifestos v1 continuam aceitos sem mudança de comportamento.', 'Plugin de projeto só é carregado se .dk/plugins estiver dentro do projeto (realpath).'],
}, [
  G0,
  { id: 'm0-inventario', objetivo: 'Mapear com arquivo e linha: usos de selectMainView e mainView em src/main.ts, parser v1 em electron/extensions.cjs, canais handle/authorize em electron/main.cjs, padrão de watch em electron/orchestration.cjs, testes em tests/extensions.test.cjs e filtros de scripts/package-filter.mjs. Devolver dados.inventario compacto.', categoria: 'leitura', depende_de: ['g0-decisoes'], condicao: COND,
    criterios: [jsonCrit('C1', 'Inventário inclui as âncoras de selectMainView', '/inventario/completo', true)] },
  { id: 'm0-desenho-host', objetivo: 'Desenhar de forma compacta plugin.json schema 2, campos, permissões, contribuições, limites e raízes de carga. Registrar resumo JSON em dados.desenho dentro do limite de 4 KiB; os desenhos de canais e views ficam em tarefas separadas. Respeitar G0.2.', categoria: 'analise', depende_de: ['m0-inventario'],
    criterios: [jsonCrit('C1', 'Esquema declarado é a versão 2', '/desenho/schema', 2)] },
  { id: 'm0-desenho-canais', objetivo: 'Desenhar recarga com debounce e canais plugin:list|plugin:reload|plugin:execute|plugin:changed, autorização, ciclo de vida e execução explícita sem shell. Registrar JSON compacto em dados.canais dentro do limite de 4 KiB.', categoria: 'analise', depende_de: ['m0-desenho-host'],
    criterios: [jsonCrit('C1', 'Desenho dos canais apresentado', '/canais/definidos', true)] },
  { id: 'm0-desenho-views', objetivo: 'Desenhar a API do registro de views em src/views.ts preservando editor, split, terminal, browser e grafo. Registrar JSON compacto em dados.views dentro do limite de 4 KiB.', categoria: 'analise', depende_de: ['m0-desenho-host'],
    criterios: [jsonCrit('C1', 'Desenho das views apresentado', '/views/definidas', true)] },
  { id: 'm0-parser-v2', objetivo: 'Implementar em electron/extensions.cjs o parser de plugin.json schema 2 conforme dados.desenho, mantendo v1; raiz <projeto>/.dk/plugins com contenção por realpath; limites de tamanho e quantidade; recarga por fs.watch com debounce no padrão de Orchestration.watch; erros por pasta sem derrubar o host.', categoria: 'implementacao', depende_de: ['m0-desenho-host'], arquivos: ['electron/extensions.cjs'],
    criterios: [fileCrit('C1', 'Parser reconhece permissões v2', 'electron/extensions.cjs', 'permissions'), fileCrit('C2', 'Parser reconhece contribuições v2', 'electron/extensions.cjs', 'contributes'), fileCrit('C3', 'Raiz por projeto', 'electron/extensions.cjs', '.dk')] },
  { id: 'm0-canais-ipc', objetivo: 'Expor em electron/main.cjs os canais autorizados plugin:list, plugin:reload e plugin:execute e o evento plugin:changed, com raiz de projeto por project(root); executar ação v2 somente após interação explícita e permissão process:spawn, preservando as extensões v1. Incluir preload e tipos; recarregar ao trocar de projeto e encerrar watchers em project:close-sessions e will-quit.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m0-parser-v2', 'm0-desenho-canais'], arquivos: ['electron/main.cjs', 'electron/preload.cjs', 'src/api.d.ts'],
    criterios: [fileCrit('C1', 'Canal de listagem registrado', 'electron/main.cjs', 'plugin:list'), fileCrit('C2', 'Preload expõe a API', 'electron/preload.cjs', 'plugin:list'), fileCrit('C3', 'Tipos declarados', 'src/api.d.ts', 'listPlugins'), fileCrit('C4', 'Canal de execução declarado', 'electron/main.cjs', 'plugin:execute')] },
  { id: 'm0-renderer', objetivo: 'Extrair de src/main.ts o registro de views para src/views.ts (registrar, selecionar, voltar, estado atual) sem mudar comportamento; criar src/plugins.ts com lista, permissões visíveis, ação de execução explícita e erros de manifesto; ligar plugin:changed à recarga; estilos em src/style.css.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m0-canais-ipc', 'm0-desenho-views'], arquivos: ['src/main.ts', 'src/views.ts', 'src/plugins.ts', 'src/style.css'],
    criterios: [fileCrit('C1', 'Registro de views existe', 'src/views.ts'), fileCrit('C2', 'main.ts usa o registro', 'src/main.ts', "from './views'"), fileCrit('C3', 'Painel de plugins existe', 'src/plugins.ts'), fileCrit('C4', 'Permissões mostradas ao usuário', 'src/plugins.ts', 'permissions')] },
  { id: 'm0-testes', objetivo: 'Atualizar tests/extensions.test.cjs (v2 válido, permissões inválidas recusadas, raiz fora do projeto recusada, recarga) e tests/package-filter.test.cjs se necessário; criar tests/plugins-desktop.cjs com projeto temporário que lista e executa ação sintética após clique e recusa execução sem process:spawn; preservar v1, editor, split, browser e sessões; registrar test:plugins e entrada em test:all.', categoria: 'implementacao', perfil: 'testador', depende_de: ['m0-renderer'], arquivos: ['tests/extensions.test.cjs', 'tests/plugins-desktop.cjs', 'tests/package-filter.test.cjs', 'scripts/package-filter.mjs', 'package.json'],
    criterios: [fileCrit('C1', 'Teste unitário cobre schema 2', 'tests/extensions.test.cjs', 'schema: 2'), fileCrit('C2', 'Teste de desktop existe', 'tests/plugins-desktop.cjs'), fileCrit('C3', 'Script registrado', 'package.json', '"test:plugins"')] },
  docs('m0-docs', ['m0-testes'], 'Plugins por projeto', '"schema": 2'),
  revisao('m0-revisao', ['m0-docs'], 'revisor-seguranca', 'contenção de .dk/plugins por realpath, permissões declaradas e exibidas, ausência de JS de terceiros, watchers encerrados, compatibilidade v1'),
  verificacao('m0-verificacao', ['m0-revisao'], 'tests/plugins-desktop.cjs'),
]);

// ---------- M1 ----------
const M1 = build('COORD-PLUGINS-M1', {
  pedido: 'Fase 1 do plano: catálogos de skills e design systems do kit e do projeto, barra de etapas gateadas na .action-bar com critérios calculados no aplicativo.',
  objetivo: 'M1: barra de etapas lendo critérios reais e catálogo de skills do kit visível.',
  lacunas: ['dk etapas --json não foi encontrado nas CLIs do kit examinadas; confirmar capacidades do kit efetivamente conectado antes de calcular critérios em electron/stages.cjs.'],
  saida: 'Código, testes e README; estado em .dk/coordenacoes/COORD-PLUGINS-M1.json.',
  extras: ['Etapas em português: levantamento, fluxos, documentacao, telas; cascata estrita.', 'Catálogos com limite de 64 KiB por arquivo e 64 itens por raiz.'],
}, [
  marcoAnterior('m1-anterior', 'COORD-PLUGINS-M0', 'plugin v2 listado na UI com testes passando'),
  { id: 'm1-inventario', objetivo: 'Mapear kitInfo e o uso de yaml em electron, os limites de projectTitle, as ações e o DEADLINE de electron/actions.cjs, a .action-bar e renderProject em src/main.ts, e o que projeto.yml e o registro do projeto já informam por etapa. Devolver dados.inventario.', categoria: 'leitura', depende_de: ['m1-anterior'], condicao: CONDA('m1-anterior'),
    criterios: [jsonCrit('C1', 'Inventário completo', '/inventario/completo', true)] },
  { id: 'm1-desenho', objetivo: 'Desenhar o modelo de etapas (nome, critérios com id, descrição, estado pendente|concluído|indisponível, procedência e fix agent|action), a cascata de desbloqueio, o esquema do catálogo (frontmatter de SKILL.md e DESIGN.md, origem kit|projeto) e os canais catalog:list, catalog:read, stages:read. Não tratar fonte ilegível como requisito não atendido ou concluído. Registrar em dados.desenho.', categoria: 'analise', depende_de: ['m1-inventario'],
    criterios: [jsonCrit('C1', 'Quatro etapas na cascata', '/desenho/etapas', 4)] },
  { id: 'm1-catalogos', objetivo: 'Criar electron/catalogs.cjs: listar e ler skills/*/SKILL.md e design-systems/*/DESIGN.md do kit e de <projeto>/.dk, frontmatter via yaml, limites de tamanho e quantidade, contenção por realpath; teste unitário em tests/catalogs.test.cjs.', categoria: 'implementacao', depende_de: ['m1-desenho'], arquivos: ['electron/catalogs.cjs', 'tests/catalogs.test.cjs'],
    criterios: [fileCrit('C1', 'Módulo existe', 'electron/catalogs.cjs'), fileCrit('C2', 'Lê SKILL.md', 'electron/catalogs.cjs', 'SKILL.md'), fileCrit('C3', 'Teste existe', 'tests/catalogs.test.cjs')] },
  { id: 'm1-etapas', objetivo: 'Criar electron/stages.cjs: calcular critérios por etapa a partir de projeto.yml e do registro do projeto, cascata estrita, fixes declarados; teste unitário em tests/stages.test.cjs com projetos sintéticos em cada estado.', categoria: 'implementacao', depende_de: ['m1-desenho'], arquivos: ['electron/stages.cjs', 'tests/stages.test.cjs'],
    criterios: [fileCrit('C1', 'Módulo existe', 'electron/stages.cjs'), fileCrit('C2', 'Etapa de levantamento modelada', 'electron/stages.cjs', 'levantamento'), fileCrit('C3', 'Teste existe', 'tests/stages.test.cjs')] },
  { id: 'm1-canais', objetivo: 'Expor catalog:list, catalog:read e stages:read em electron/main.cjs com project(root) e kitInfo, preload e src/api.d.ts; invalidar cache ao trocar de projeto.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m1-catalogos', 'm1-etapas'], arquivos: ['electron/main.cjs', 'electron/preload.cjs', 'src/api.d.ts'],
    criterios: [fileCrit('C1', 'Canal de etapas', 'electron/main.cjs', 'stages:read'), fileCrit('C2', 'Canal de catálogo', 'electron/main.cjs', 'catalog:list'), fileCrit('C3', 'Tipos declarados', 'src/api.d.ts', 'readStages')] },
  { id: 'm1-renderer', objetivo: 'Criar src/stages.ts (barra de etapas na .action-bar: estado, critérios, botão de correção que abre terminal Claude com o prompt da skill da etapa ou roda a ação do CLI) e src/catalogs.ts (view de catálogo registrada em src/views.ts); ligar em src/main.ts dentro de renderProject; estilos em src/style.css; área de toque mínima de 44 px.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m1-canais'], arquivos: ['src/main.ts', 'src/stages.ts', 'src/catalogs.ts', 'src/style.css'],
    criterios: [fileCrit('C1', 'Barra de etapas existe', 'src/stages.ts'), fileCrit('C2', 'Catálogo existe', 'src/catalogs.ts'), fileCrit('C3', 'main.ts liga as etapas', 'src/main.ts', "from './stages'")] },
  testesDesktop('m1-testes', ['m1-renderer'], 'tests/stages-desktop.cjs', 'test:stages'),
  docs('m1-docs', ['m1-testes'], 'Etapas e catálogos', 'levantamento'),
  revisao('m1-revisao', ['m1-docs'], 'revisor', 'cascata de etapas correta, limites dos catálogos, contenção de caminhos e UX da barra; revisar acessibilidade e estados de interação, delegando a revisores especializados apenas se o host oferecer essa capacidade'),
  verificacao('m1-verificacao', ['m1-revisao'], 'tests/stages-desktop.cjs'),
]);

// ---------- M2 ----------
const M2 = build('COORD-PLUGINS-M2', {
  pedido: 'Fase 2 do plano: runner de agente com CLIs oficiais, Claude stream-json quando suportar aprovação segura, preservação do Codex app-server existente, prompt em camadas, aprovação explícita e ciclo de vida completo.',
  objetivo: 'M2: run do Claude com prompt composto, streaming na UI e aprovação explícita.',
  lacunas: ['Aprovação interativa em claude -p ainda precisa ser comprovada. allowedTools não substitui o consentimento por operação; sem mecanismo equivalente, manter a CLI oficial interativa e informar indisponibilidade do runner.'],
  saida: 'Código, testes e README; estado em .dk/coordenacoes/COORD-PLUGINS-M2.json.',
  extras: ['Prazo por run configurável; o DEADLINE de 60 s das ações não se aplica.', 'Limite de runs simultâneos por projeto declarado e testado.'],
}, [
  marcoAnterior('m2-anterior', 'COORD-PLUGINS-M1', 'barra de etapas e catálogo visíveis com testes passando'),
  { id: 'm2-inventario', objetivo: 'Mapear o ciclo de vida de electron/codex-chat.cjs (spawn, eventos, aprovações, cancel, close), electron/session-processes.cjs, project:close-sessions e will-quit em electron/main.cjs, e as flags reais de claude --help (input-format, output-format, permission-prompt-tool, allowedTools) e codex exec --help (--json, sandbox). Devolver dados.inventario.', categoria: 'leitura', depende_de: ['m2-anterior'], condicao: CONDA('m2-anterior'), tools: ['Read', 'Grep', 'Glob', 'Bash'],
    criterios: [jsonCrit('C1', 'Inventário completo', '/inventario/completo', true)] },
  { id: 'm2-desenho', objetivo: 'Desenhar eventos normalizados (text_delta, tool_use, tool_result, status, usage, error, approval), o mecanismo de aprovação por operação sem bypassPermissions, as camadas do system prompt (charter DK, skill ativa, DESIGN.md, craft, instruções do projeto, etapa ativa, lista de arquivos) com limites de bytes, e os canais agent:start|cancel|approve|event. allowedTools não substitui o consentimento por operação; sem mecanismo comprovado, manter a CLI oficial interativa e informar indisponibilidade do runner. Registrar em dados.desenho.', categoria: 'analise', depende_de: ['m2-inventario'],
    criterios: [jsonCrit('C1', 'Aprovação sem bypass definida', '/desenho/aprovacao/bypass', false)] },
  { id: 'm2-prompt', objetivo: 'Criar electron/prompt-composer.cjs: compor o system prompt em camadas conforme dados.desenho, com limites por camada e lista de arquivos truncada; teste unitário em tests/prompt-composer.test.cjs.', categoria: 'implementacao', depende_de: ['m2-desenho'], arquivos: ['electron/prompt-composer.cjs', 'tests/prompt-composer.test.cjs'],
    criterios: [fileCrit('C1', 'Compositor existe', 'electron/prompt-composer.cjs'), fileCrit('C2', 'Camada da skill', 'electron/prompt-composer.cjs', 'SKILL.md'), fileCrit('C3', 'Teste existe', 'tests/prompt-composer.test.cjs')] },
  { id: 'm2-runner', objetivo: 'Criar electron/agent-run.cjs: usar a CLI oficial do Claude em stream-json somente se a aprovação segura for comprovada; preservar o Codex app-server e suas aprovações e histórico, avaliando alternativa só após prova de equivalência. Normalizar eventos, aprovação, cancelamento, prazo e concorrência; teste unitário em tests/agent-run.test.cjs com CLI falsa.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m2-prompt'], arquivos: ['electron/agent-run.cjs', 'tests/agent-run.test.cjs'],
    criterios: [fileCrit('C1', 'Runner existe', 'electron/agent-run.cjs'), fileCrit('C2', 'Usa stream-json', 'electron/agent-run.cjs', 'stream-json'), fileCrit('C3', 'Não usa bypass', 'electron/agent-run.cjs', 'bypassPermissions', ), fileCrit('C4', 'Teste existe', 'tests/agent-run.test.cjs')].map(c => c.id === 'C3' ? { ...c, tipo: 'nao_contem' } : c) },
  { id: 'm2-canais', objetivo: 'Expor agent:start, agent:cancel, agent:approve e o evento agent:event em electron/main.cjs; incluir runs em project:close-sessions, closed e will-quit e em electron/session-processes.cjs; preload e src/api.d.ts.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m2-runner'], arquivos: ['electron/main.cjs', 'electron/preload.cjs', 'src/api.d.ts', 'electron/session-processes.cjs'],
    criterios: [fileCrit('C1', 'Canal de início', 'electron/main.cjs', 'agent:start'), fileCrit('C2', 'Encerramento no fechamento do projeto', 'electron/main.cjs', 'agent'), fileCrit('C3', 'Tipos declarados', 'src/api.d.ts', 'startAgent')] },
  { id: 'm2-renderer', objetivo: 'Criar src/agent.ts: view registrada em src/views.ts com streaming de texto, lista de ferramentas chamadas, pedido de aprovação explícito (aceitar e recusar afastados, estilos distintos), cancelar e consumo; reaproveitar padrões de src/chat.ts; ligar em src/main.ts e estilos em src/style.css.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m2-canais'], arquivos: ['src/agent.ts', 'src/main.ts', 'src/style.css'],
    criterios: [fileCrit('C1', 'View do agente existe', 'src/agent.ts'), fileCrit('C2', 'Aprovação na UI', 'src/agent.ts', 'approve'), fileCrit('C3', 'main.ts registra a view', 'src/main.ts', "from './agent'")] },
  { ...testesDesktop('m2-testes', ['m2-renderer'], 'tests/agent-desktop.cjs', 'test:agent'), objetivo: 'Criar teste desktop com runner sintético: streaming, aprovação e recusa, isolamento de pedidos pendentes ao alternar projetos, prazo que solicita decisão sem encerrar agente ativo e cancelamento confirmado; registrar test:agent e inclusão em test:all.' },
  docs('m2-docs', ['m2-testes'], 'Runner de agente', 'bypassPermissions'),
  revisao('m2-revisao', ['m2-docs'], 'revisor-seguranca', 'ausência de bypass, aprovação obrigatória, pedidos pendentes preservados ao alternar projetos e isolados por sessão, nenhum token lido, encerramento de processos, limites de runs e prazo, prompt sem vazamento de arquivos fora do projeto; sem evidência autorizada da CLI oficial ou decisão explícita de rever o escopo, M2 permanece incompleto e não libera M3'),
  verificacao('m2-verificacao', ['m2-revisao'], 'tests/agent-desktop.cjs', 'Teste sintético não prova compatibilidade real. Sem validação autorizada da CLI oficial ou decisão explícita de rever o escopo, M2 permanece incompleto e não libera M3.'),
]);

// ---------- M3 ----------
const M3 = build('COORD-PLUGINS-M3', {
  pedido: 'Fase 3 do plano: esquema dk-preview:// servido pelo main com contenção, iframe sandbox sem same-origin, bridges dk-edit-* em memória, patch que preserve conteúdo não editado e undo com gravação por file:save.',
  objetivo: 'M3: tela HTML editada no preview e gravada, com undo e teste de desktop com PTY desligado.',
  lacunas: ['Projetos React (carimbo data-dk-source, proxy de dev server) ficam fora deste marco.'],
  saida: 'Código, testes e README; estado em .dk/coordenacoes/COORD-PLUGINS-M3.json.',
  extras: ['Preview sem rede: connect-src none e sub-recursos só de dk-preview:.', 'Arquivo editável até 2 MiB; histórico de undo limitado e verificado contra o disco.', 'Antes de despachar M3, verificar o estado e as evidências reais de M2; resultado declarado não comprova o gate.', 'regenerar o contrato M3 antes do despacho, depois que M2 entrar'],
}, [
  { ...marcoAnterior('m3-anterior', 'COORD-PLUGINS-M2', 'runner de agente com aprovação e testes verificados'),
    objetivo: 'Executar node scripts/gate-marco.mjs COORD-PLUGINS-M2 --projeto . --json na raiz do projeto. Usar o código de saída e o JSON do gate: devolver dados.anterior.concluida=true somente com saída 0 e concluida=true; em qualquer falha devolver false e os motivos. O gate verifica pacotes aprovados, eventual estado runtime concluído, identidade do projeto, HEAD/conjunto sujo e hashes dos alvos, testes unitários e desktop e rodada autorizada da CLI oficial (P2–P5) ou decisão explícita de escopo. Não gravar evidência nem executar outros comandos; somente consultar o gate. Não inferir conclusão pelo README, histórico ou campo concluida declarado; sem liberação, não despachar tarefas dependentes de M3.',
    tools: ['Bash(node scripts/gate-marco.mjs COORD-PLUGINS-M2 --projeto . --json)'] },
  { id: 'm3-inventario', objetivo: 'Mapear resolveFile e TEXT_LIMIT em electron/files.cjs, o registro de dk-app:// e protocol.handle em electron/main.cjs, PreviewBrowser em electron/browser.cjs, renderHtml em src/editor.ts, a CSP de index.html e file:save com revisão. Devolver dados.inventario.', categoria: 'leitura', depende_de: ['m3-anterior'], condicao: CONDA('m3-anterior'),
    criterios: [jsonCrit('C1', 'Inventário completo', '/inventario/completo', true)] },
  { id: 'm3-desenho', objetivo: 'Desenhar o esquema dk-preview://<hash-projeto>/<caminho>, a injeção em memória dos bridges, o protocolo dk-edit-* (seleção, texto inline, estilo, link, imagem, ações estruturais, resize, inserção armada, copy/paste, undo/redo) com esquema JSON por mensagem, o modelo de patch e undo (beforeSource, afterSource, revisão do disco) e os canais preview:open|close. Registrar em dados.desenho.', categoria: 'analise', depende_de: ['m3-inventario'],
    criterios: [jsonCrit('C1', 'Iframe sem same-origin', '/desenho/iframe/allow_same_origin', false)] },
  { id: 'm3-protocolo', objetivo: 'Criar electron/preview-protocol.cjs: handler de dk-preview com contenção de resolveFile, tipos MIME, injeção dos bridges só em HTML, bloqueio de rede e de caminhos fora do projeto; teste unitário em tests/preview-protocol.test.cjs.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m3-desenho'], arquivos: ['electron/preview-protocol.cjs', 'tests/preview-protocol.test.cjs'],
    criterios: [fileCrit('C1', 'Handler existe', 'electron/preview-protocol.cjs'), fileCrit('C2', 'Esquema dk-preview', 'electron/preview-protocol.cjs', 'dk-preview'), fileCrit('C3', 'Teste existe', 'tests/preview-protocol.test.cjs')] },
  { id: 'm3-bridge', objetivo: 'Criar assets/dk-edit-bridge.js, assets/dk-edit-bridge.css e assets/dk-flow-runtime.js: seleção com data-dk-id, mensagens dk-edit-* por postMessage ao parent, navegação data-dk-navigate, overlays data-dk-overlay*, Escape, find bridge; sem dependências e sem rede.', categoria: 'implementacao', depende_de: ['m3-desenho'], arquivos: ['assets/dk-edit-bridge.js', 'assets/dk-edit-bridge.css', 'assets/dk-flow-runtime.js'],
    criterios: [fileCrit('C1', 'Bridge existe', 'assets/dk-edit-bridge.js'), fileCrit('C2', 'Mensagens dk-edit', 'assets/dk-edit-bridge.js', 'dk-edit-'), fileCrit('C3', 'Runtime de fluxo existe', 'assets/dk-flow-runtime.js')] },
  { id: 'm3-patch', objetivo: 'Criar src/preview-patch.ts: aplicar mensagens dk-edit-* com estratégia que preserve trechos não editados, comentários, doctype, entidades, BOM e fins de linha; histórico de undo/redo com beforeSource/afterSource e limite; testes em tests/preview-patch.test.cjs. DOMParser não é exigido e sua reserialização não deve alterar conteúdo silenciosamente.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m3-desenho'], arquivos: ['src/preview-patch.ts', 'tests/preview-patch.test.cjs'],
    criterios: [fileCrit('C1', 'Patch existe', 'src/preview-patch.ts'), fileCrit('C2', 'Teste dedicado existe', 'tests/preview-patch.test.cjs')] },
  { id: 'm3-csp-canais', objetivo: 'Registrar dk-preview com privilégios mínimos, sem bypassCSP, e ligar o handler em electron/main.cjs; expor preview:open e preview:close; adicionar frame-src dk-preview: à CSP do host e aplicar política sem rede ao documento filho; preload e src/api.d.ts.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m3-protocolo'], arquivos: ['index.html', 'electron/main.cjs', 'electron/preload.cjs', 'src/api.d.ts'],
    criterios: [fileCrit('C1', 'CSP permite o esquema', 'index.html', 'frame-src dk-preview:'), fileCrit('C2', 'CSP mantém connect-src none', 'index.html', "connect-src 'none'"), fileCrit('C3', 'Esquema registrado', 'electron/main.cjs', 'dk-preview')] },
  { id: 'm3-renderer', objetivo: 'Criar src/preview.ts: view registrada com iframe sandbox="allow-scripts" (sem allow-same-origin), barra com undo/redo e salvar, escuta de postMessage com event.source igual ao contentWindow, geração ativa e esquema validado; tratar mensagens como propostas não confiáveis sem escrita automática. Aplicar o patch e gravar por file:save com revisão; ligar em src/main.ts e estilos em src/style.css.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m3-bridge', 'm3-patch', 'm3-csp-canais'], arquivos: ['src/preview.ts', 'src/main.ts', 'src/style.css'],
    criterios: [fileCrit('C1', 'View existe', 'src/preview.ts'), fileCrit('C2', 'Sandbox só com scripts', 'src/preview.ts', 'allow-scripts'), fileCrit('C3', 'Sem same-origin', 'src/preview.ts', 'allow-same-origin'), fileCrit('C4', 'main.ts registra a view', 'src/main.ts', "from './preview'")].map(c => c.id === 'C3' ? { ...c, tipo: 'nao_contem' } : c) },
  { ...testesDesktop('m3-testes', ['m3-renderer'], 'tests/preview-desktop.cjs', 'test:preview'), objetivo: 'Criar teste desktop com HTML temporário, edição e undo; verificar preservação dos bytes não editados, conflitos, mensagens forjadas e bloqueio de fetch, WebSocket, imagens e CSS do iframe sem afetar o browser atual; registrar test:preview e inclusão em test:all.' },
  docs('m3-docs', ['m3-testes'], 'Preview com edição', 'dk-preview'),
  revisao('m3-revisao', ['m3-docs'], 'revisor-seguranca', 'iframe sem same-origin e sem acesso ao IPC, CSP, contenção do esquema, validação de mensagens, nenhum bridge gravado em disco, undo verificado contra o disco'),
  verificacao('m3-verificacao', ['m3-revisao'], 'tests/preview-desktop.cjs'),
]);

// ---------- M4 ----------
const M4 = build('COORD-PLUGINS-M4', {
  pedido: 'Fase 4 do plano: auditoria do protótipo contra o Documento de Requisitos com achados em JSON, skill de calibração editável como plugin v2 de primeira parte e loop de verificação visual com pré-gate determinístico.',
  objetivo: 'M4: auditoria de uma tela contra requisitos com achados renderizados.',
  lacunas: ['Playwright é devDependency: a verificação visual declara indisponibilidade no aplicativo empacotado.'],
  saida: 'Código, testes e README; estado em .dk/coordenacoes/COORD-PLUGINS-M4.json.',
  extras: ['Achados somente nos tipos tela_obsoleta, regra_nao_documentada e regra_divergente com fix.target prototype|document.', 'Screenshot não vai à rede: manter no host, fora do alcance do runner, prompt e saída; se não for possível comprovar, desabilitar a captura.', 'Antes de despachar M4, verificar o estado e as evidências reais de M2 e M3; resultado declarado não comprova o gate.'],
}, [
  marcoAnterior('m4-anterior', 'COORD-PLUGINS-M2 e COORD-PLUGINS-M3', 'runner com aprovação e preview com edição, com testes passando'),
  { id: 'm4-inventario', objetivo: 'Mapear a ação audit em electron/actions.cjs, a API do runner (electron/agent-run.cjs) e do compositor, o host de plugins v2, a presença e versão do Playwright e onde o Documento de Requisitos e as telas HTML ficam em um projeto DK. Devolver dados.inventario.', categoria: 'leitura', depende_de: ['m4-anterior'], condicao: CONDA('m4-anterior'),
    criterios: [jsonCrit('C1', 'Inventário completo', '/inventario/completo', true)] },
  { id: 'm4-desenho', objetivo: 'Desenhar o esquema JSON dos achados (tipo, requisito, trecho, severidade, fix.target, fix.sugestao), o prompt de auditoria com a skill de calibração, o pré-gate determinístico (elementos-chave, console sem erros) e o fluxo de screenshot; canais audit:prototype e visual:check. Registrar em dados.desenho.', categoria: 'analise', depende_de: ['m4-inventario'],
    criterios: [jsonCrit('C1', 'Três tipos de achado', '/desenho/achados/tipos', 3)] },
  { id: 'm4-auditoria', objetivo: 'Criar electron/prototype-audit.cjs: selecionar requisitos e HTML com consentimento para envio ao provedor, sem incluir capturas; rodar pelo runner com skill de calibração, validar JSON de achados e limitar tamanho; teste unitário em tests/prototype-audit.test.cjs com runner falso e entradas adversariais.', categoria: 'implementacao', depende_de: ['m4-desenho'], arquivos: ['electron/prototype-audit.cjs', 'tests/prototype-audit.test.cjs'],
    criterios: [fileCrit('C1', 'Módulo existe', 'electron/prototype-audit.cjs'), fileCrit('C2', 'Tipos de achado validados', 'electron/prototype-audit.cjs', 'regra_divergente'), fileCrit('C3', 'Teste existe', 'tests/prototype-audit.test.cjs')] },
  { id: 'm4-plugin-calibracao', objetivo: 'Criar o plugin v2 de primeira parte extensions/dk-auditoria/plugin.json com contributes.catalogs e a skill extensions/dk-auditoria/skills/auditoria-prototipo/SKILL.md (critérios de calibração editáveis por cópia para .dk/plugins do projeto).', categoria: 'implementacao', perfil: 'testador', depende_de: ['m4-desenho'], arquivos: ['extensions/dk-auditoria/plugin.json', 'extensions/dk-auditoria/skills/auditoria-prototipo/SKILL.md'], formato: 'markdown',
    criterios: [fileCrit('C1', 'Manifesto v2', 'extensions/dk-auditoria/plugin.json', '"schema": 2'), fileCrit('C2', 'Skill existe', 'extensions/dk-auditoria/skills/auditoria-prototipo/SKILL.md')] },
  { id: 'm4-visual', objetivo: 'Criar electron/visual-check.cjs: pré-gate sobre HTML em dk-preview e captura em memória isolada do runner; usar Playwright quando disponível e declarar indisponibilidade quando a ferramenta ou a proteção da captura não puderem ser comprovadas. Teste unitário em tests/visual-check.test.cjs.', categoria: 'implementacao', depende_de: ['m4-desenho'], arquivos: ['electron/visual-check.cjs', 'tests/visual-check.test.cjs'],
    criterios: [fileCrit('C1', 'Módulo existe', 'electron/visual-check.cjs'), fileCrit('C2', 'Indisponibilidade declarada', 'electron/visual-check.cjs', 'playwright'), fileCrit('C3', 'Teste existe', 'tests/visual-check.test.cjs')] },
  { id: 'm4-canais', objetivo: 'Expor audit:prototype e visual:check em electron/main.cjs com project(root), aprovação do runner reaproveitada; preload e src/api.d.ts.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m4-auditoria', 'm4-visual', 'm4-plugin-calibracao'], arquivos: ['electron/main.cjs', 'electron/preload.cjs', 'src/api.d.ts'],
    criterios: [fileCrit('C1', 'Canal de auditoria', 'electron/main.cjs', 'audit:prototype'), fileCrit('C2', 'Tipos declarados', 'src/api.d.ts', 'auditPrototype')] },
  { id: 'm4-renderer', objetivo: 'Criar src/audit.ts: view registrada com achados agrupados por tipo, ação por fix.target (abrir no preview ou no editor do documento), estado de carregamento e resultado do pré-gate; ligar ao botão Auditoria em src/main.ts; estilos em src/style.css.', categoria: 'implementacao', perfil: 'implementador-critico', limites: 'critico', depende_de: ['m4-canais'], arquivos: ['src/audit.ts', 'src/main.ts', 'src/style.css'],
    criterios: [fileCrit('C1', 'View existe', 'src/audit.ts'), fileCrit('C2', 'Ação por alvo do fix', 'src/audit.ts', 'target'), fileCrit('C3', 'main.ts registra a view', 'src/main.ts', "from './audit'")] },
  { ...testesDesktop('m4-testes', ['m4-renderer'], 'tests/audit-desktop.cjs', 'test:audit'), objetivo: 'Criar teste desktop com runner/provedor falsos, consentimento de HTML e requisitos, achados válidos e inválidos, conflito de arquivos e tentativas de ler ou transmitir captura por ferramentas e imagem embutida; confirmar indisponibilidade quando não houver proteção comprovada; registrar test:audit em test:all.' },
  docs('m4-docs', ['m4-testes'], 'Auditoria do protótipo', 'regra_divergente'),
  revisao('m4-revisao', ['m4-docs'], 'revisor-seguranca', 'consentimento de conteúdo, esquema validado, isolamento da captura frente ao runner, testes adversariais, indisponibilidade do Playwright e UX dos achados'),
  verificacao('m4-verificacao', ['m4-revisao'], 'tests/audit-desktop.cjs'),
]);

const hostContext = { host: 'claude_code', capacidades: { delegacao_nativa: true, controle_modelo: true, controle_esforco: true, observacao_modelo: false, observacao_esforco: false }, identidade: null, autorizacoes: [] };
fs.mkdirSync(out, { recursive: true });
for (const [name, c] of [['M0-host-plugins', M0], ['M1-catalogos-etapas', M1], ['M2-runner-agente', M2], ['M3-preview-bridge', M3], ['M4-auditoria', M4]]) {
  fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(c, null, 2) + '\n');
  console.log(name, c.tarefas.length, 'tarefas', c.orcamento.max_chamadas, 'chamadas', (c.orcamento.max_contexto_bytes / MiB).toFixed(1), 'MiB');
}
fs.writeFileSync(path.join(out, 'host-claude-code.json'), JSON.stringify(hostContext, null, 2) + '\n');
