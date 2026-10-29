# Plano: plugins executáveis por projeto no DK Terminal

Data: 28/10/2026. Estado: aprovado; decisões registradas na seção 7.

Objetivo: trazer para o DK Terminal os recursos de protótipo assistido por IA e editor
ao vivo observados no Vision Design 0.8.41 (fork do Open Design), na forma de um host
de plugins com plugins executáveis a nível de projeto. A nomenclatura `od` do Open
Design vira `dk` em tudo que for construído.

Referência de leitura: análise de engenharia reversa em
`/Volumes/oDois/Produtos/rea-regenerate/Vision/` (capítulos 02, 03, 07 e 10). Nenhum
arquivo daquele volume é copiado para cá; o plano cita o que aprendeu.

## 1. Ponto de partida (observado no código do DK Terminal)

| Recurso do Vision | O que o DK Terminal já tem | Lacuna |
|---|---|---|
| Daemon Express; runs de agente via CLI com `stream-json`; system prompt em camadas | `electron/actions.cjs` (`Actions.run`, CLI `dk` com JSON, prazo de 60 s) e `electron/codex-chat.cjs` (`codex app-server` por JSON-RPC stdio, streaming, aprovações) | Runner genérico de agente; compositor de prompt; Claude só abre em PTY |
| Preview com edit bridge por `postMessage`; `data-od-source` em React | `src/editor.ts#renderHtml` (iframe `srcdoc` sandbox sem scripts) e `electron/browser.cjs` (`PreviewBrowser`, `WebContentsView` só localhost, uma instância) | Canal iframe → host; CSP sem `frame-src`; patch e undo |
| Skills `SKILL.md`, `DESIGN.md`, `craft/`, templates | `electron/extensions.cjs` (`extension.json` v1, só comando de terminal, lido na inicialização) e `electron/orchestration.cjs` (`list`/`watch` de `.dk/coordenacoes`) | Raiz por projeto; catálogos de conteúdo; recarga |
| Etapas gateadas `levantamento → fluxos → documentacao → telas`; auditoria do protótipo | `.action-bar` com Auditoria, Validar, Diagnóstico; `isDk` por `projeto.yml` | Modelo de etapas e critérios; auditoria contra requisitos |

Decisão de arquitetura: **não portar o daemon**. O que no Vision é servidor HTTP vira
IPC autorizado (`handle`/`authorize` em `electron/main.cjs`); o que é SQLite vira
arquivos em `.dk/`; o que é "run em memória" vira um gerenciador no main com o mesmo
ciclo de vida de `Services` e `CodexChat`.

## 2. Nomenclatura

| Open Design | DK |
|---|---|
| `data-od-id`, `data-od-source`, `data-od-navigate`, `data-od-overlay*`, `data-od-frame` | `data-dk-id`, `data-dk-source`, `data-dk-navigate`, `data-dk-overlay*`, `data-dk-frame` |
| mensagens `od-edit-*`, `od:*` | `dk-edit-*`, `dk:*` |
| `.od/`, `.od-skills/` | `.dk/`, `.dk/skills-ativas/` |
| `od-source-stamp.mjs`, `od-component-harness.mjs` | `dk-source-stamp.mjs`, `dk-component-harness.mjs` |
| `OD_*` (env) | `DK_*` |
| `edit-bridge.js`, `edit-bridge.css` | `dk-edit-bridge.js`, `dk-edit-bridge.css` |
| esquema `od://app/` | já existe `dk-app://`; preview em `dk-preview://` |

Etapas mantêm os nomes em português que o Vision já usa.

## 3. Fases

### Fase 0 — Host de plugins v2

- `plugin.json` com `schema: 2`. Raízes: `<app>/extensions`, `<userData>/extensions`,
  `<projeto>/.dk/plugins`. Recarga por `fs.watch` com debounce, como `Orchestration.watch`.
- Campos: `id`, `name`, `version`, `permissions` (`fs:project`, `process:spawn`,
  `preview:bridge`, `agent:run`), `contributes` (`views`, `panels`, `actions`,
  `stages`, `catalogs`).
- Renderer sem JS de terceiros, mantendo a decisão atual. UI declarada em JSON; lógica
  em processos filhos do main, conforme a decisão da seção 7.3.
- Alterações: `extensions.cjs` (parser v2 e raiz por projeto), `main.cjs` (novos
  canais autorizados), `src/main.ts` (`selectMainView` vira registro de views),
  `scripts/package-filter.mjs` (novas dependências do main), testes em
  `tests/extensions.test.cjs`.

### Fase 1 — Catálogos e barra de etapas

- Catálogos `skills/*/SKILL.md` e `design-systems/*/DESIGN.md` do kit (`kitInfo`) e
  do projeto, frontmatter via `yaml` existente, limites de tamanho como em
  `projectTitle`. Canais `catalog:list` e `catalog:read`.
- Barra de etapas na `.action-bar`, renderizada em `renderProject()`. Os critérios
  devem ser calculados com procedência a partir dos registros do projeto. O comando
  `dk etapas --json` não foi encontrado nas CLIs do kit examinadas; a proposta atual
  é calcular os critérios no aplicativo e só delegar ao kit se uma API compatível
  for verificada. Cada etapa depende dos critérios da anterior. Correções via
  `fix: "agent"` (abre prompt) ou `fix: "action"` (roda CLI).
- As skills do plugin Claude `dk:dk-levantar`, `dk:dk-entender`, `dk:dk-entregar` e
  `dk:dk-prototipar` são o backend das etapas.

### Fase 2 — Runner de agente

- `electron/agent-run.cjs` integra as CLIs oficiais, incluindo `claude -p` em
  `stream-json` somente quando as aprovações seguras forem comprovadas. Preservar
  o `codex app-server` e seu histórico/aprovações; outro modo só entra após prova
  de equivalência. Eventos normalizados (`text_delta`, `tool_use`, `tool_result`,
  `status`, `usage`, `error`) seguem por `agent:event`.
- Compositor de system prompt em camadas: charter do DK, skill ativa, `DESIGN.md`,
  seções de craft pedidas pela skill, instruções do projeto, bloco da etapa ativa,
  lista de arquivos do projeto.
- Sem `--permission-mode bypassPermissions`: contraria o compromisso do README.
  Aprovações passam pela UI, como no painel Codex; sem mecanismo comprovado, o
  runner fica indisponível e a CLI oficial interativa permanece disponível.
- Ciclo de vida: incluir em `project:close-sessions`, `closed` e `will-quit`; prazo
  por run configurável (o `DEADLINE` de 60 s das ações não serve).

### Fase 3 — Preview com edit bridge

- Esquema `dk-preview://<hash-projeto>/<caminho>` servido pelo main com a contenção de
  `resolveFile` (`electron/files.cjs`), injetando `dk-edit-bridge.js|css`, o runtime de
  fluxo (`data-dk-navigate`, overlays, `Escape`) e um find bridge.
- Nova view com `<iframe sandbox="allow-scripts">` sem `allow-same-origin`; CSP de
  `index.html` ganha `frame-src dk-preview:`. O iframe não alcança o IPC porque
  `authorize` exige o frame principal.
- Protocolo `dk-edit-*` (seleção, texto inline, estilo, link, imagem, ações
  estruturais, resize, inserção armada, copy/paste, undo/redo). O renderer aplica
  patch com estratégia validada para preservar conteúdo não editado e grava por
  `file:save`; histórico de undo com `beforeSource`/`afterSource` e verificação de
  que o disco não mudou. `DOMParser` não garante preservação textual por si só.
- Fora desta fase: projetos React (plugin Babel de carimbo `data-dk-source`, proxy de
  dev server, patch JSX com recast). O `PreviewBrowser` segue cobrindo o caso
  "serviço em execução".

### Fase 4 — Auditoria e verificação

- `dk audit --prototipo`: Documento de Requisitos mais HTML da tela ao agente, resposta
  em JSON com achados `tela_obsoleta`, `regra_nao_documentada`, `regra_divergente` e
  `fix.target` `prototype|document`. Skill de calibração editável pelo projeto.
- Verificação visual opcional: pré-gate determinístico e captura isolada do runner.
  Playwright é devDependency e não está no pacote atual; sem ferramenta ou
  isolamento comprovados, informar indisponibilidade.

## 4. Segurança e limites a preservar

- Nenhum token lido ou gravado pelo DK; login continua nas CLIs oficiais.
- Nenhum JS de terceiros no renderer; permissões declaradas e mostradas ao usuário.
- O futuro preview de edição M3 não deve carregar rede externa: `connect-src 'none'`
  e sub-recursos só do esquema `dk-preview:`. O browser atual de serviço local tem
  política própria e pode fazer requisições de sub-recursos a outras origens.
- Arquivos do usuário permanecem limpos: bridges injetados em memória, nunca em
  disco, inclusive em projetos Vite.
- Limites explícitos: tamanho de arquivo editável (2 MiB atual), número de runs
  simultâneos, histórico de undo.

## 5. Ordem sugerida e marcos

| Marco | Entrega verificável |
|---|---|
| M0 | Plugin v2 carregado de `.dk/plugins`, listado e executado por ação explícita, com testes |
| M1 | Barra de etapas com critérios verificáveis; catálogo de skills do kit visível |
| M2 | Run do Claude com prompt composto, streaming na UI, aprovação explícita |
| M3 | Tela HTML editada no preview e gravada; undo; teste desktop com PTY desligado |
| M4 | Auditoria de uma tela contra requisitos com achados renderizados |

## 6. Riscos

- `src/main.ts` monolítico (cerca de 1.050 linhas em `innerHTML`): a fase 0 exige
  extrair o registro de views antes de adicionar as novas.
- Operações de arquivo síncronas no main com volume externo lento.
- Caminhos fixos (`/Volumes/SEA` em `local-repositories.cjs`; `.app` no workflow do
  Finder) atrapalham empacotamento e testes em outra máquina.
- Vision depende de `NODE_ENV=development` para carimbar `data-od-source`; se a fase
  React entrar, o mesmo cuidado vale aqui.
- Pacote ad hoc sem notarização: não bloqueia o plano, mas limita distribuição.

## 7. Decisões

Registradas em 28/10/2026 pelo responsável do projeto.

1. ~~Onde gravar o plano~~ — decidido: este arquivo.
2. **Contexto do repositório** — decidido: projeto compartilhado, no mesmo modelo
   do kit (`~/SEA/Ferramentas/kit`). A fonte fica na SEA, com autoria
   `angelo.pimentel@seatecnologia.com.br`; a oDois recebe um fork, e o remote
   `github.com/odoisbr/dk-terminal` passa a ser esse fork. Pendência operacional:
   criar o projeto no GitLab `design/` e apontar o `origin` para ele.
3. **Lógica de plugin** — decidido: só JSON mais processos filhos. Nenhum módulo
   de terceiros é carregado no renderer nem no main.
4. **Ordem das fases 2 e 3** — decidido: fase 2 (runner) antes da fase 3
   (preview), porque as correções por agente da barra de etapas e a auditoria
   dependem do runner.
