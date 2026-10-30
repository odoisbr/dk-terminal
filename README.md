# SEA Dock

Aplicativo desktop local para trabalhar com projetos do Design Kit. Primeira versão funcional, 0.1.0-alpha.1, feita com Electron, xterm.js e node-pty.

O loading usa o motion SEA fornecido para o aplicativo: um círculo se enche de água e as ondas se assentam na marca. A sequência vetorial é adaptada ao tempo de abertura, roda localmente e termina antes de o espaço de trabalho aparecer. Com redução de movimento ativada no sistema, a marca aparece estática e a espera visual é removida. Os arquivos do motion ficam em `assets/sea-motion.svg` e `src/sea-motion.mjs`.

## Abrir no desenvolvimento

Requer Node.js 22.12 ou mais recente, npm e as ferramentas de compilação da plataforma. No macOS, use Xcode ou suas ferramentas de linha de comando; no Windows, são necessárias as ferramentas C++ do Visual Studio. Python 3 e uma instalação do DK são necessários somente para as ações do kit.

```sh
npm ci
npm start
```

O `postinstall` recompila o node-pty para a versão exata do Electron. Execute `npm run postinstall` depois de trocar o Electron ou a arquitetura da máquina. O lockfile fixa as versões. Não use `npm ci --ignore-scripts` para uma instalação normal.

## Usar

1. Na tela inicial, escolha um projeto recente, **Criar projeto do zero**, **Abrir projeto local** ou **Abrir projeto GitLab SEA**. Criar projeto abre um seletor de destino e cria uma nova pasta vazia, sem sobrescrever pastas existentes. Pastas comuns também funcionam como espaços de terminal.
2. O aplicativo identifica o plugin DK do Claude automaticamente. Se estiver ausente ou desativado, use a ação de instalar ou ativar exibida na sidebar. A variável `DK_ROOT` ou um kit em `../dk` também permitem a descoberta inicial.
3. Um projeto abre sem iniciar um terminal automaticamente. Use **Nova sessão** para iniciar um terminal; cada projeto mantém suas sessões separadas enquanto o aplicativo estiver aberto.
4. Use **Auditoria**, **Validar projeto** ou **Diagnóstico** para abrir o resultado renderizado, com opção **Ver JSON** para inspecionar os dados originais.
5. A aba **Serviços**, no painel da direita, reconhece scripts `dev`, `start`, `serve`, `preview`, `watch`, `worker` e `api` do `package.json`, inclusive variantes como `dev:api`. Inicie ou desligue cada serviço pelo botão ao lado. A saída e o endereço local aparecem nessa aba.
6. O botão no topo da área de trabalho recolhe ou expande a sidebar.
7. A barra lateral do projeto começa recolhida para dar mais espaço aos terminais. Use os ícones **Pasta**, **Git**, **Contexto**, **Serviços** e **Consumo** para abrir o painel correspondente; clique novamente no ícone ativo para recolhê-lo. **Pasta** é a primeira opção e mostra a árvore de arquivos, expandindo cada diretório sob demanda; o botão de atualizar relê a árvore. Clique em um arquivo para abri-lo no editor. Textos UTF-8 até 2 MiB podem ser editados com realce de sintaxe, abas e `⌘S`; imagens até 4 MiB têm prévia. Binários e arquivos maiores ficam somente para consulta de metadados. Alterações não salvas são protegidas ao fechar, e uma revisão externa impede sobrescrever mudanças de outro programa. Links simbólicos são identificados e não expandidos pela interface; o aplicativo recusa a navegação para fora da raiz selecionada. Diretórios grandes mostram até 500 entradas por abertura.
8. Editor e terminais compartilham a mesma área de painéis e suas abas aparecem juntas. Fechar a última aba de arquivo encerra a visualização do editor. Os botões de divisão abrem até quatro terminais independentes, à direita ou abaixo. A nova sessão usa a pasta atual e, para integrações de agente abertas pelo DK, o mesmo tipo do painel selecionado. O menu de divisão com agente permite abrir Claude, Codex ou outra extensão instalada em uma nova sessão do terminal. A conversa e o histórico em execução permanecem na sessão original. `⌘D` divide à direita e `⌘⇧D` divide abaixo. A ação **Separar painel ativo do split** retira o terminal selecionado do grupo e preserva sua sessão; os demais painéis continuam agrupados. A visualização única recolhe o split sem encerrar as outras sessões.
9. O botão **Expandir terminal**, na barra de sessões, amplia a área de trabalho, mantém a sidebar de projetos visível e permite restaurá-la sem encerrar o terminal. Atalho: `⌘⇧E` no Mac, `Ctrl⇧E` nas demais plataformas.

Arquivos HTML abrem em visualização estática isolada, com folhas de estilo e imagens locais quando suportadas; **Código** permite editar a fonte. Scripts e recursos externos não são executados nessa visualização; para interagir com um projeto em execução, use o Browser.

Arquivos Markdown abrem em edição visual: títulos, ênfases, links, listas de tarefas, tabelas, imagens locais e blocos Mermaid são apresentados no próprio texto. O botão **Código** mostra a fonte completa, e **Visual** retorna à edição visual. Imagens externas não são carregadas automaticamente. Para limitar processamento, o modo visual é usado em arquivos Markdown de até 256 KB; arquivos maiores continuam disponíveis no modo de código.

Arquivos `.mmd` e `.mermaid`, assim como blocos Mermaid em Markdown, abrem com o diagrama renderizado. Em fluxogramas, selecione uma etapa para editar seu texto, adicionar uma etapa seguinte ou conectar etapas; em diagramas de sequência, participantes e mensagens reconhecidos podem ter o texto editado. Outros diagramas e estruturas não reconhecidas continuam renderizados e podem ser alterados pelo botão **Código**. Diagramas de até 50 mil caracteres são renderizados; erros de sintaxe mantêm o código disponível para correção. O Mermaid carrega somente quando um diagrama é aberto.

**Orquestração** mostra as tarefas, dependências e estados reais dos arquivos `.dk/coordenacoes/*.json`. A visualização atualiza por eventos do sistema somente enquanto está aberta e recusa registros com ciclos ou referências ausentes.

O ícone **Visualizar protótipo**, na barra de guias ao lado de Claude e Codex, fica disponível quando um serviço reconhecido como front-end está em execução. Inicie esse serviço na guia **Serviços**; a identificação usa nomes comuns como `dev`, `preview`, `web`, `frontend` e `start`. Iniciar um serviço de prévia identificado pela guia **Serviços** também abre o navegador. Serviços como API, worker e watch continuam disponíveis em segundo plano. Em `dk-terminal.services.json`, use `"role": "frontend"` ou `"role": "backend"` para identificar explicitamente serviços personalizados com nomes ambíguos. Quando uma sessão do plugin DK neste aplicativo receber um pedido de visualização, ela pode abrir a URL local diretamente na guia de navegador do projeto ativo. O serviço local precisa estar em execução; se o projeto não estiver ativo ou a página falhar, o pedido informa o problema. O navegador abre como uma guia do projeto e preserva a página ao alternar para sessões, arquivos ou outro projeto. Fechar a guia ou o projeto libera a visualização e limpa seus dados temporários; desligar o serviço é uma ação separada. O navegador é criado sob demanda, sem acesso ao Node ou à API do aplicativo, com armazenamento temporário por projeto. Navegações principais para fora de localhost, novas janelas, downloads e permissões são bloqueados. A página ainda pode carregar recursos e realizar conexões de rede externas; a prévia não é um bloqueio de rede. A execução do projeto continua local, com as permissões da conta do sistema.

Na barra do navegador, **Abrir browser em tela cheia** ocupa a tela com a prévia e seus controles. Use o mesmo botão ou `Esc` para restaurar; o serviço e o estado da página permanecem ativos. Se a janela já estava em tela cheia, ela continua assim ao sair do modo do browser. Abrir Início, GitLab ou Perfil e configurações oculta a prévia enquanto a tela está aberta e a exibe novamente ao voltar.

O [estudo do browser e suas evidências](docs/rea-browser/README.md) detalham a fronteira de segurança e o ciclo de vida da prévia.

O rodapé mostra CPU e RAM dos processos do SEA Dock. Passe o cursor sobre os indicadores para ver também os processos filhos detectados, incluindo terminais, agentes e serviços. O consumo de CPU é aproximado: 100% representa um núcleo e o total pode ultrapassar 100%. A RAM é uma soma de memória residente e pode incluir páginas compartilhadas. A leitura é atualizada a cada 10 segundos enquanto a janela está visível; processos que se desvinculam do aplicativo podem não ser detectados. Quando não for possível consultar os filhos, o detalhamento informa essa limitação.

Serviços são iniciados somente por uma ação do usuário. O aplicativo acompanha os processos que ele próprio iniciou. Comandos abertos em outro aplicativo não são descobertos; os abertos num terminal do SEA Dock aparecem à parte, como descrito abaixo. Ao desligar um serviço, o aplicativo encerra seu grupo de processos; ao fechar a janela, também encerra os serviços gerenciados. A inicialização não instala dependências do projeto.

Servidores iniciados por você num terminal do SEA Dock, como um `npm run dev` digitado, aparecem em **Serviços → Detectados nas sessões**. O aplicativo percorre a árvore de processos de cada terminal do projeto ativo e lista os que escutam numa porta TCP (`ps` e `lsof`, sem shell), com comando resumido, PID, porta e endereço `http://127.0.0.1:<porta>`. **Abrir na prévia** usa a guia de navegador do projeto; **Encerrar** pede confirmação e envia `SIGTERM` ao grupo do processo, ou só ao processo quando o grupo é o do próprio shell, que continua aberto. O botão **Atualizar** refaz a descoberta e relê os serviços declarados; com a guia visível, a lista também se atualiza ao abri-la e a cada 10 segundos. Processos de outros projetos, de outros aplicativos ou do sistema não aparecem. A detecção funciona no macOS e no Linux.

Quando há `index.html` na raiz, **Serviços → Prévia estática** abre HTML, CSS e JavaScript diretamente, sem instalar pacotes nem criar terminal. O servidor local não lista diretórios nem entrega arquivos ocultos ou `node_modules`; outros aplicativos locais ainda podem acessar os arquivos servidos. Ele não compila JSX, TypeScript ou projetos que dependam de um servidor de framework ou backend. Nesses casos, use o serviço próprio do projeto.

Para projetos com `package.json`, **Preparar dependências** apresenta o gerenciador detectado e pede confirmação antes de iniciar uma sessão de instalação. npm e pnpm priorizam o cache configurado e baixam o que faltar; Yarn e Bun usam suas configurações de cache. O aplicativo não muda configurações globais nem troca gerenciador, e não usa `npm ci`. Scripts de instalação podem executar com as permissões do usuário. Conflitos de lockfile ou gerenciador, workspaces detectados acima do projeto e `bun.lockb` exigem resolução manual; a versão declarada em `packageManager` depende da ferramenta instalada. O cache pode reduzir downloads e espaço, mas não garante economia de memória dos servidores.

Para serviços de outras linguagens, crie `dk-terminal.services.json` na pasta do projeto:

```json
{
  "services": [
    { "name": "site", "command": "python3", "args": ["-m", "http.server", "8000", "--bind", "127.0.0.1"] }
  ]
}
```

`command` e `args` são executados como um programa e argumentos separados, na pasta do projeto. Esta execução tem as permissões do usuário do Mac. Ela não constitui um ambiente isolado de execução.

As ações executam os comandos reais abaixo com Python e argumentos separados. Não injetam texto numa sessão interativa, não acrescentam `--apply` e não alteram arquivos do projeto por conta própria:

| Ação | Comando |
| --- | --- |
| Auditoria | `python3 <kit>/cli/dk audit --projeto <pasta> --json` |
| Validar projeto | `python3 <kit>/cli/dk projeto validar --projeto <pasta> --json` |
| Diagnóstico | `python3 <kit>/cli/dk doctor --json` |

O indicador **Projeto DK reconhecido** sinaliza apenas a presença de `projeto.yml` ou `.dk/projeto.json`; não representa conformidade ou aprovação do projeto. Para conferir o estado, execute a validação.

No macOS: `⌘O` abre uma pasta, `⌘T` cria uma sessão, `⌘W` encerra a sessão, `⌘F` busca e `⌘K` limpa a visualização. Em outras plataformas, use Ctrl no lugar de ⌘. Copiar e colar usam os atalhos nativos; Ctrl+C no terminal continua interrompendo o comando.

## Extensões Claude Code e Codex

As integrações vêm incluídas e seus ícones ficam na barra do terminal. Quando disponíveis no PATH, Antigravity (`agy`), Gemini CLI (`gemini`) e DK CLI (`dk`) também aparecem na barra e no menu de split; cada uma abre a CLI instalada no diretório do projeto sem alterar configurações ou autenticação. O ícone do **Claude Code** abre a CLI oficial instalada na pasta do projeto, preservando a assinatura e as configurações existentes. O DK remove os marcadores herdados `CLAUDE_CODE_CHILD_SESSION` e `CLAUDECODE` dos novos terminais e define `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, para que as conversas futuras sejam gravadas pela CLI oficial. Isso também vale para `claude` iniciado manualmente nesses terminais. Sessões abertas antes da correção precisam ser reiniciadas; transcrições que não foram gravadas não podem ser reconstruídas por essa alteração. Para retomar uma conversa salva, use `claude --resume` no projeto.

O ícone do **Codex** abre um painel de conversa do SEA Dock, com mensagens, saída de ferramentas, histórico por projeto, interrupção e aprovações explícitas. Ele usa o protocolo oficial `codex app-server`, com o login, modelo e provider configurados na CLI. O processo é iniciado quando o usuário envia uma mensagem e encerrado ao concluir o turno. Pedidos ainda não suportados pelo painel são recusados com uma mensagem para continuar pela CLI. É possível abrir `codex` manualmente no terminal para esses fluxos.

O aplicativo não lê arquivos de credenciais, não copia tokens e não passa opções para ignorar permissões. O login continua nas ferramentas oficiais. O histórico do painel Codex é gravado em `codex-conversations.json`, na pasta privada de dados do aplicativo, com permissões 0600: até 30 conversas, 200 mensagens por conversa, 64 KiB por mensagem/saída e 8 MiB no total. Há no máximo dois turnos ativos. O histórico de raciocínio privado não é exibido nem gravado pelo DK.

A guia **Consumo** consulta limites reais do Codex por `account/read` e `account/rateLimits/read`, sem iniciar conversa ou inferência. A duração de cada janela vem da ferramenta; uma janela ausente não vira 0%. A atualização é manual, com cache e intervalo mínimo de um minuto. Para Claude, a leitura usa `/usage` na CLI oficial em modo seguro, sem autorizar projetos ou efetuar login automaticamente; se a CLI não disponibilizar valores, o painel informa a indisponibilidade e permite abrir o Claude para consultar `/usage`. O DK não usa endpoints OAuth privados. A integração Claude permanece na CLI por escolha do usuário, sem Agent SDK com login de assinatura.

Para criar outra extensão declarativa, adicione uma pasta em `extensions/` na fonte do aplicativo ou em `extensions/` dentro da pasta de dados do SEA Dock, com um arquivo `extension.json`:

```json
{
  "schema": 1,
  "id": "minha-ferramenta",
  "name": "Minha ferramenta",
  "version": "0.1.0",
  "description": "Abre minha ferramenta no projeto.",
  "permission": "terminal",
  "command": "minha-ferramenta",
  "args": []
}
```

Reabra o aplicativo para carregar novas extensões. A disponibilidade de cada comando (`claude`, `codex`, `gemini`, `agy`…) é verificada procurando um executável com esse nome no `PATH` do shell de login do usuário e, em seguida, nas pastas conhecidas de instalação (`~/.local/bin`, `~/.claude/local`, `~/.codex/bin`, npm global, Volta, Bun, asdf, nvm, `/opt/homebrew/bin`, `/usr/local/bin`), que só são usadas quando existem e sempre depois do `PATH` do usuário. Alias e função de shell não contam como instalação. Uma ferramenta instalada com o aplicativo aberto passa a ser reconhecida ao voltar para a janela, sem reiniciar. A versão 1 de extensões de terceiros aceita manifestos para comandos de terminal e não carrega JavaScript de terceiros. Browser e o painel Codex são integrações internas do aplicativo. Não há um host de extensões VS Code/VSIX. Os comandos recebem as permissões normais da conta do sistema e só são iniciados pelo usuário.

### Plugins por projeto

Em **Perfil e configurações → Plugins**, consulte os plugins do aplicativo, do perfil e do projeto selecionado. Para adicionar uma ação ao projeto, crie `.dk/plugins/exemplo/plugin.json`:

```json
{
  "schema": 2,
  "id": "exemplo",
  "name": "Ferramentas do projeto",
  "version": "1.0.0",
  "permissions": ["process:spawn"],
  "contributes": {
    "actions": [
      { "id": "versao", "title": "Ver versão do Node", "command": "node", "args": ["--version"] }
    ]
  }
}
```

Cada ação exige `process:spawn`, uma ferramenta disponível no `PATH` e confirmação antes de abrir sua sessão. O diálogo mostra o executável, todos os argumentos e o projeto; o manifesto é verificado novamente após a confirmação e antes de iniciar o terminal. Dividir uma sessão de plugin também pede confirmação. Os comandos são passados como programa e argumentos separados; uma ação ainda pode escolher um interpretador, como `sh`, como executável.

**Permissões declaradas não são um isolamento do sistema.** Um programa iniciado pelo plugin tem as permissões normais da sua conta, inclusive sobre arquivos acessíveis fora do projeto. Confira a ação, o destino real do executável e a origem antes de executá-la. A verificação de identidade reduz o risco de troca do arquivo, mas a execução por caminho não é atômica contra todas as alterações concorrentes do sistema. `preview:bridge` e `agent:run`, assim como visualizações, painéis, etapas e catálogos declarados, ainda não estão disponíveis; os manifestos não carregam JavaScript no aplicativo. Se duas origens declararem o mesmo ID, prevalece aplicativo, depois perfil, depois projeto, e o conflito é informado.

Os manifestos têm limite de 16 KiB, as ações aceitam até 32 argumentos com 8 KiB no total, e cada origem inspeciona até 32 pastas. Alterações no projeto são observadas enquanto as configurações estiverem abertas; ao sair, o monitoramento é encerrado. Se a observação não estiver disponível, use **Recarregar plugins**. As extensões de terminal v1 continuam funcionando. No Windows, comandos `.cmd` não são executados pelo host v2, pois precisam de um interpretador de comandos. O fluxo foi testado no macOS; Windows e Linux ainda precisam de validação real. Teste a integração com `npm run test:plugins`.

O teste local `node benchmarks/plugins-m0.cjs`, após `npm run build`, mede a preferência de cursor e a liberação dos observadores usando um projeto temporário no macOS ou Linux. Uma [medição de referência](benchmarks/plugins-m0-macos-arm64-2026-10-28.json) contém as amostras e limitações; RSS soma processos e pode contar páginas compartilhadas mais de uma vez.

O [planejamento M0–M4](docs/planejamento/README.md) descreve as evoluções propostas de plugins, agentes, edição visual e auditoria; esses marcos ainda não fazem parte da pré-release.

Referências: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) e [Claude Code](https://code.claude.com/docs/en/overview).

### Etapas e catálogo

A barra de etapas fica visível na área de trabalho apenas para projetos DK reconhecidos pela presença de `projeto.yml` ou `.dk/projeto.json`. Em pastas comuns que não são projetos DK, a barra permanece oculta. A barra exibe quatro etapas fixas, o botão para recarregar e o botão do catálogo. Ao abrir uma etapa, a interface apresenta seus critérios, procedência, detalhes, atalhos de correção e as skills correspondentes do catálogo. Se o plugin DK estiver ausente ou desativado, um aviso informa a indisponibilidade dos critérios do kit e desabilita as correções.

O SEA Dock usa quatro das etapas do kit: Levantar, Entender, Entregar e Prototipar. Essa escolha de etapas é revisável. Etapas como audit, handoff e git não entram na barra. A barra preserva a ordem fixa: 1. Levantar, 2. Entender, 3. Entregar e 4. Prototipar. O cálculo e a avaliação das regras foram portados da versão 1.7.0-rc.14 do Design Kit (módulos `registry.py`, `lacunas.py`, `cobertura.py`, `projeto.py` e `base_prototipo.py`). Os campos `fase_atual` e `fases_concluidas` do manifesto não definem aprovação. Eles aparecem apenas como dados informativos.

#### Estados e liberação em cascata

Cada critério e cada etapa assumem um de três estados: Concluído, Pendente ou Indisponível.
- **Concluído**: todos os requisitos do critério foram atendidos e comprovados nos arquivos lidos.
- **Pendente**: indica falta de dado no projeto. Ocorre quando arquivos, chaves ou registros estão ausentes, listas estão vazias ou o registro não oferece o sinal esperado (como a ausência de `traceability.json` ou de arestas `implementa_regra`).
- **Indisponível**: indica falha de leitura ou erro estrutural. Ocorre em JSON ou YAML com sintaxe inválida, arquivos que excedem limites numéricos, links simbólicos que apontam para fora do projeto, SHA-256 divergente em adoção ou ausência do kit para critérios dependentes dele.

A etapa fica Indisponível se contiver ao menos um critério indisponível. Fica Concluída se todos os critérios estiverem concluídos. Nos demais casos, fica Pendente.

A liberação das etapas opera em cascata estrita. A etapa Levantar começa liberada. Uma etapa seguinte só é liberada quando a etapa imediatamente anterior estiver concluída. Enquanto a etapa anterior não for concluída, a etapa seguinte exibe o estado visual Bloqueada. Os critérios da etapa bloqueada continuam sendo lidos e calculados normalmente para consulta. Suas ações de correção ficam desabilitadas até o desbloqueio.

#### Critérios das etapas

| Etapa | Critério | Arquivo lido | Regra |
| --- | --- | --- | --- |
| Levantar | L1: Registro de regras com ≥1 item | `registros.regras` (v2) ou `registry/business-rules.json` ou `registry/regras.json` | JSON regular com lista de objetos ou envelope com chave única `itens` ou `items`. Cada item exige `id` em texto não vazio. Ao menos um item registrado. |
| Levantar | L2: Registro de requisitos com ≥1 item | `registros.requisitos` (v2) ou `registry/requirements.json` ou `registry/requisitos.json` | JSON regular com lista de objetos ou envelope com chave única `itens` ou `items`. Cada item exige `id` em texto não vazio. Ao menos um item registrado. |
| Levantar | L3: Todo requisito e regra com procedência | Registros de requisitos e regras | No esquema canônico, campo `sources` não vazio em cada item. No esquema DK, campo `fonte` não vazio (texto, lista ou objeto com `arquivo` e `citacao`). |
| Levantar | L4: Nenhuma lacuna CRÍTICA em AUSENTE ou PENDENTE | `<kit>/templates/checklist-discovery.json` junto a regras, requisitos, pendências e decisões | Porte de `lacunas.py`. Busca sinais nos textos por regex. Nenhuma pergunta de prioridade CRÍTICA pode ficar AUSENTE (sem menção) ou PENDENTE (sem resposta). COBERTO exige ao menos duas respostas validadas. |
| Entender | E1: Toda referência de sources existe em fontes ou evidências | `sources.json` e `evidence.json` (canônico) | Toda referência listada no campo `sources` de requisitos e regras deve existir como identificador em fontes ou evidências. |
| Entender | E2: Nenhuma regra sem requisito e nenhum RF sem regra | `traceability.json` (canônico) ou `requisitos.json` (esquema DK) | No esquema canônico, exige relações com `relation` igual a `implementa_regra`. Nenhuma regra sem aresta `to`. Nenhum requisito RF ou FUNCIONAL sem aresta `from`. No esquema DK, confere o campo `deriva_de`. |
| Entender | E3: Nenhuma prova documental resolvida só por relato | `pending.json` ou `pendencias.json` | Nenhum item com status `resolvida_por_relato`, com `pendencia_de_prova` preenchido e cujo enunciado mencione escrita, escrito ou documental. |
| Entregar | D1: Documento de requisitos existe (canônico ou adotado) | `pastas.levantamento/requisitos` (padrão `1-levantamento/requisitos`) ou `.dk/adocoes.json` | Ao menos um arquivo regular com extensão de documento permitida (`.html`, `.md`, `.txt`, `.rst`, `.adoc`, `.markdown`, `.pdf`, `.docx`) ou adoção válida com arquivo existente e SHA-256 coincidente se declarado. |
| Entregar | D2: Documento de visão existe | `pastas.levantamento/visao` (padrão `1-levantamento/visao`) ou `.dk/adocoes.json` | Ao menos um arquivo regular de documento permitido ou adoção válida com SHA-256 coincidente se declarado. |
| Entregar | D3: Todo requisito citado em algum entregável | Texto de documentos em `requisitos`, `visao` e `atas` (exclui `.pdf` e `.docx`) | Todo identificador de requisito de L2 deve constar literalmente no texto dos entregáveis, respeitando as fronteiras de palavra `(?<![A-Za-z0-9_])ID(?![A-Za-z0-9_])`. |
| Entregar | D4: checklist-dod presente (só contexto portal) | `.dk/projeto.json` e `pastas.entregaveis` (padrão `3-entregaveis`) | Aplica-se apenas quando o campo `contexto` for `portal`. Nos demais contextos o critério é omitido. Exige ao menos um documento regular na pasta de entregáveis. |
| Prototipar | P1: Pasta do protótipo contém telas HTML | `.dk/projeto.json` (`prototipo.pasta`), `pastas.design/prototipo` ou `2-design/prototipo` | Ao menos um arquivo `.html` ou `.htm` na pasta do protótipo, em busca com profundidade de até 4 níveis. |
| Prototipar | P2: Base declarada e design system presente | `.dk/projeto.json` (`prototipo.design_system`) | Validação estrutural de `base_prototipo.py`. A pasta declarada em `caminho` deve existir no projeto e cada arquivo listado no array `carga` deve existir. No modo `submodule`, confere apenas a existência física da pasta e dos arquivos. |

#### Correções e ações

As correções dos critérios só ocorrem após clique explícito da pessoa. Nenhuma ação é executada sem clique.
- Para os critérios E1 e E2 da etapa Entender, o botão executa a ação `entender` diretamente pela CLI oficial do kit (`python3 <kit>/cli/dk entender --projeto <pasta> --json`), utilizando o executável Python validado da instalação do kit. Nunca executa comando `dk` do PATH.
- Para os demais critérios (L1 a L4, E3, D1 a D4, P1 e P2), o botão copia o comando da respectiva skill para a área de transferência (como `/dk:dk-levantar`, `/dk:dk-entender`, `/dk:dk-entregar` ou `/dk:dk-prototipar`).
- A cópia do comando não inicia agentes nem injeta prompts automaticamente. A pessoa cola o comando na sessão desejada do terminal ou do agente.

#### Origens do catálogo

O painel de catálogo reúne itens de três origens:
1. **Kit instalado**: skills em `<kit>/skills/*/SKILL.md`. Quando o kit não está instalado ou o plugin DK está inativo, o catálogo do kit fica indisponível e exibe aviso. Não há varredura de `.dk/skills-ativas/`.
2. **Projeto**: catálogo `project-design`, que reúne o arquivo `DESIGN.md` da raiz do projeto (se existir) e a declaração de design system de `.dk/projeto.json` (`prototipo.design_system`), carregando o corpo de `<caminho>/DESIGN.md` quando presente.
3. **Plugins v2**: catálogos declarados por manifestos ativos via `contributes.catalogs`, dos tipos `skills` ou `design-systems`.

As entradas de catálogos nunca se sobrescrevem. Cada entrada recebe um identificador qualificado no formato `<catalogId>/<nome>` e indicação visual de sua origem (Kit, Projeto ou Plugin `<nome>`). A listagem segue a ordem Kit, Projeto e Plugins, com ordenação alfabética em cada grupo. O leitor apresenta o corpo em texto simples dentro de `<pre>` e exibe apenas campos permitidos do frontmatter (`name`, `description`, `argument-hint`, `allowed-tools` e `forma-da-saida`). O leitor não interpreta HTML nem executa scripts.

#### Atualização e eventos

A interface atualiza o estado das etapas e dos catálogos por meio de observadores de arquivos (`fs.watch`), com agrupamento de eventos por debounce de 400 ms. Alterações em plugins ou instalação e atualização do kit invalidam os caches automaticamente. A qualquer momento, o botão **Recarregar etapas** na barra e o botão **Recarregar catálogo** no painel forçam a releitura completa do disco. Ao trocar de projeto ou fechar a janela, observadores e caches da raiz ativa são encerrados imediatamente. O kit não possui observadores contínuos. Quando o sistema operacional recusa a observação de pastas, o aplicativo exibe aviso para usar o botão Recarregar.

#### Limites numéricos

Limites aplicados na leitura das etapas e catálogos:
- **Manifesto**: `projeto.yml` até 256 KiB, com limite de 50 aliases YAML e chaves únicas.
- **Registros JSON**: até 4 MiB e até 5.000 itens por arquivo de registro (`regras`, `requisitos`, `fontes`, `evidencias`, `rastreabilidade`, `pendencias`, `decisoes`).
- **Checklist de discovery**: arquivo até 256 KiB e até 5.000 itens.
- **Documentos de entregáveis**: até 2 MiB por arquivo de texto regular, no máximo 32 documentos por pasta de entregáveis e até 8 MiB somados de texto lido.
- **Adoções**: lista de até 5.000 itens em `.dk/adocoes.json`, arquivos com hash SHA-256 até 16 MiB por arquivo e limite total de 64 MiB por leitura.
- **Protótipo**: busca até profundidade 4 e limite de 2.000 entradas inspecionadas, ignorando `node_modules`, `.git` e `design-system`.
- **Identificadores de requisitos (D3)**: limite de 256 caracteres por ID.
- **Catálogos**: arquivos Markdown até 64 KiB (arquivos maiores geram erro e têm leitura recusada), frontmatter até 8 KiB (YAML com até 8 aliases e chaves únicas, com fallback por regex), até 64 entradas por origem (a 65ª marca o catálogo como truncado), até 512 entradas por diretório, profundidade fixa `<raiz>/<nome>/ARQUIVO`, nomes no padrão `^[a-z0-9][a-z0-9-]{0,63}$` e identificadores de catálogo até 128 caracteres.
- **Observadores**: limite de até 16 observadores (`fs.watch`) por projeto nas etapas e até 16 nos catálogos.
- **Segurança de caminho**: todas as leituras usam `realpath` contido na raiz e recusam links simbólicos para fora do projeto ou ciclos (`O_NOFOLLOW`).

#### Verificações não realizadas

A verificação das etapas é estrutural e documental. O aplicativo não realiza:
- Consistência semântica ou adequação conceitual entre requisitos e regras de negócio. Essa avaliação depende de revisão humana.
- Validação das regras avançadas de gabarito e padrões do protótipo declaradas em `regras.exigido` ou `regras.proibido`. Elas contêm expressões Python não interpretadas pelo aplicativo.
- Verificação do estado Git do submódulo do design system. No modo `submodule`, valida-se apenas a existência física da pasta e dos arquivos da carga.
Para a validação completa de código, regras e submódulo Git do protótipo, utilize o comando `dk prototipar --verificar` no terminal.

O recurso de etapas e catálogos foi executado e testado exclusivamente no macOS. As plataformas Windows e Linux não foram executadas nesta versão. A declaração `contributes.stages` de plugins permanece inerte.

### Tarefas com Claude

O runner de tarefas executa comandos pontuais com a CLI oficial do Claude. A comunicação ocorre por entrada e saída padrão em formato JSON estruturado (`stream-json`), utilizando o protocolo de controle da ferramenta. O painel apresenta o texto em tempo real, as ferramentas acionadas, os resultados parciais, o uso de tokens e o custo acumulado. O runner não altera arquivos sem confirmação prévia. Ele não possui modo autônomo, não oferece modo somente leitura e não executa scripts externos ao projeto.

O processo usa a CLI oficial instalada no computador e a autenticação já existente na conta do usuário (`claude auth login`). O SEA Dock não lê tokens de acesso, não armazena credenciais e não gerencia arquivos de autenticação do provedor. A inicialização passa os argumentos `-p`, `--input-format stream-json`, `--output-format stream-json`, `--include-partial-messages`, `--replay-user-messages`, `--permission-prompts host`, `--permission-prompt-tool stdio` e `--permission-mode manual`. O prompt composto de sistema é gravado em um arquivo temporário privado em `userData/agent-runs/<runId>/system-prompt.md`, com permissão de acesso estrita 0600. Esse arquivo fica fora da árvore do projeto e é apagado ao término do turno. O primeiro turno recebe um identificador único via `--session-id`. Os turnos seguintes na mesma sessão usam `--resume`.

O controle de segurança opera em modo manual fixo. As opções `bypassPermissions`, `auto`, `dontAsk` e `acceptEdits` não são permitidas. Se o processo iniciar com modo de permissão diferente de `manual`, a execução é abortada imediatamente. A execução usa `--setting-sources user,local`. Arquivos de configuração commitados no repositório não são carregados. Cada ação proposta pela CLI (leitura de arquivo, escrita em disco ou comando de terminal) gera um cartão de autorização. O usuário deve escolher entre "Permitir uma vez" ou "Recusar". Sugestões automáticas de permissão enviadas pela CLI (`permission_suggestions`) nunca são aplicadas nem salvas em disco.

O tempo limite padrão é de 15 minutos por turno de execução, com valores aceitos entre 1 e 120 minutos. Ao atingir o prazo configurado, o aplicativo exibe uma solicitação de decisão com as opções "Continuar 15 min" ou "Interromper". O processo continua ativo enquanto aguarda a resposta. Nenhuma execução é finalizada automaticamente por tempo ou inatividade.

O usuário pode cancelar a tarefa ativa a qualquer instante pelo botão Interromper. O cancelamento recusa todas as aprovações pendentes e envia um pedido de interrupção via protocolo. Se a CLI não encerrar em 5 segundos, o aplicativo envia o sinal `SIGTERM`. Após mais 1 segundo sem encerramento, envia o sinal `SIGKILL`. Processos descendentes são identificados e encerrados. O conteúdo produzido até a interrupção permanece visível na interface e no histórico, sinalizado com o estado parcial.

Limites numéricos aplicados pelo runner:
- Execuções ativas: no máximo 2 por projeto e no máximo 3 no aplicativo inteiro.
- Fila de espera: até 4 tarefas aguardando início por aplicativo.
- Prazos: entre 1 e 120 minutos por turno, com padrão de 15 minutos.
- Inicialização: tempo limite de 20 segundos para a confirmação de início.
- Linhas de protocolo: limite de 1 MiB por linha recebida; valores superiores cancelam a execução.
- Linhas inválidas: 3 ocorrências de JSON corrompido cancelam o processo.
- Mensagem do usuário: até 64 KiB incluindo o envelope estruturado.
- Texto por mensagem: até 256 KiB, com marcador visível de truncamento quando excedido.
- Entrada de autorização: até 16 KiB por pedido de ferramenta.
- Saída de ferramenta (`tool_result`): até 64 KiB por resultado.
- Prompt composto: limite total de 96 KiB somando todas as camadas (guia do aplicativo até 32 KiB, skill ativa até 24 KiB, design system até 24 KiB, instruções em AGENTS.md até 16 KiB, etapa ativa até 4 KiB e caminhos de arquivos até 8 KiB com no máximo 200 itens).
- Histórico em disco: arquivo privado `agent-runs.json` com permissão 0600, fora do projeto, com limite de 8 MiB, até 30 execuções e texto final de até 64 KiB por item.
- Eventos em memória: anel circular com capacidade para 500 eventos por execução.

O assistente Codex não utiliza este runner. O Codex permanece no seu painel de conversa próprio (`electron/codex-chat.cjs`), operando via `codex app-server` com seus limites independentes de 2 turnos ativos. A consulta de recursos do runner responde que o Codex está indisponível para este componente e direciona para o painel correspondente.

A detecção de capacidade consulta o executável `claude` no `PATH` do sistema e guarda o resultado em cache com base no caminho, na data de modificação e no tamanho do arquivo. A ferramenta requer a versão 2.1.312 ou superior da CLI e a presença das opções de controle por stdio no comando de ajuda. Também exige a confirmação dinâmica do modo `manual` na mensagem inicial de inicialização. Se o binário não atender aos requisitos ou rejeitar os argumentos, o botão "Tarefa com Claude" permanece desabilitado ou exibe o motivo da recusa, acompanhado da opção "Abrir no terminal oficial".

A identificação estática de opções não comprova o funcionamento da assinatura do usuário ou da aprovação via stdio. Até a realização da rodada manual de validação com a CLI oficial, a interface exibe o aviso "Protocolo não confirmado com a CLI oficial".

O runner de tarefas com Claude foi executado e testado unicamente no macOS. Os ambientes Windows e Linux não foram executados nesta versão.

#### Gate entre marcos

A transição entre marcos do projeto é controlada por scripts determinísticos de verificação. O script `scripts/gate-marco.mjs` avalia o cumprimento das tarefas e das evidências sem modificar o disco. O script `scripts/evidencia-marco.mjs` registra os dados de teste, os arquivos alvos e o resultado da rodada oficial em `.dk/coordenacoes/evidencias/COORD-PLUGINS-M2.verificacao.json`. A lista de pacotes e arquivos auditados é versionada em `docs/coordenacoes/pacotes-M2.json`.

O arquivo de evidência é autodeclarado no repositório. A integridade do marco é garantida pela execução do gate pelo orquestrador e pelo bloqueio de aprovações automáticas. O script de evidência recusa execução em ambientes automatizados de agentes e exige confirmação manual digitada em terminal interativo. Agentes não gravam aprovações nem liberam marcos.

### Editor visual de protótipos HTML

Arquivos `.html` e `.htm` do projeto abrem no editor visual pelo botão "Editar visualmente" do editor de código. O documento aparece num iframe isolado, com `sandbox="allow-scripts"` e sem a mesma origem do aplicativo. Um clique seleciona o elemento, e o painel ao lado mostra o que pode ser editado: texto de elementos folha, atributos permitidos (`id`, `class`, `title`, `lang`, `dir`, `hidden`, `role`, `aria-label`, `href` em links e `src`, `alt`, `width` e `height` em imagens) e 30 propriedades de estilo com gramática fechada. Nenhuma alteração é aplicada ao digitar; cada uma exige o botão "Aplicar".

O arquivo do usuário só muda ao salvar. A edição troca apenas a faixa de texto do elemento alterado, sem reserializar o documento: BOM, finais de linha (inclusive mistos e `\r` solitário), entidades, comentários e formatação do restante continuam byte a byte. Os identificadores `data-dk-node` e a ponte de comunicação existem só na cópia servida ao iframe e nunca são gravados. Cada edição passa por verificação dupla: prefixo e sufixo idênticos e reanálise da árvore com o alvo na mesma posição. Se a verificação falhar, a edição é recusada e o arquivo continua como estava.

A cópia é servida pelo esquema `dk-preview://`, com um token aleatório por abertura e uma geração por edição. Documentos de gerações antigas respondem 410. A política de segurança do documento bloqueia rede, formulários, workers e frames; só carregam CSS, imagens e fontes de dentro do projeto, com limites de tamanho e de quantidade por geração. Os scripts do próprio documento ficam desativados no modo de edição, e a interface avisa quantos scripts e manipuladores foram ignorados. Recursos externos não carregam, e a interface informa quantos foram bloqueados e de quais hosts. Para ver o comportamento com scripts, use a prévia normal.

Desfazer e refazer atuam só na cópia em memória, com até 200 entradas e 8 MiB de histórico. Salvar grava os bytes exatos com escrita atômica e confere a revisão do disco: se o arquivo mudou por fora, nada é gravado, a cópia e o histórico são mantidos, e a pessoa escolhe entre recarregar (descartando as alterações) ou continuar editando. Alterações não salvas no editor visual contam como trabalho pendente ao fechar a janela, trocar de projeto ou trocar de branch. Se o aplicativo cair, o que não foi salvo se perde.

O processamento roda num worker com prazo de 5 segundos por operação e limite de memória. Documentos que excedem os limites são recusados com motivo: acima de 2 MiB, fora de UTF-8, com `charset` diferente de UTF-8, com marcadores `<?` ou `<%` fora de comentários, `frameset` ou `plaintext`, terminados dentro de comentário ou elemento de texto bruto, com aninhamento de 512 níveis, mais de 256 atributos numa tag, mais de 200 mil elementos ou análise acima de 1,5 segundo. Elementos criados implicitamente pelo navegador, clonados por HTML mal aninhado, ou dentro de `template`, SVG ou MathML podem ser selecionados, mas ficam somente leitura com o motivo exibido.

Limites conhecidos desta versão: protótipos montados por JavaScript mostram no editor visual só o HTML estático do arquivo, porque os scripts ficam desativados; projetos React e servidores de desenvolvimento não são editáveis visualmente; um `meta refresh` para endereço externo deixa a área de edição vazia até a próxima alteração (nenhum tráfego sai); o editor visual foi testado só no macOS.

## Gerar o aplicativo

```sh
npm run package
```

A saída fica em `release/`. O pacote inclui o node-pty fora do arquivo ASAR e mantém apenas as dependências necessárias ao processo principal; as bibliotecas visuais já estão compiladas em `dist/` e são carregadas sob demanda. É gerado para a plataforma e arquitetura atuais. No Mac, abra `release/SEA Dock-darwin-arm64/SEA Dock.app` em uma máquina Apple Silicon ou a pasta `darwin-x64` em Intel. A compilação local usa assinatura ad hoc para integridade, mas não inclui assinatura de distribuição nem notarização.

### `sea` CLI embutido

O pacote inclui o `sea` CLI (gem `sea-cli`) com um Ruby portátil, em `Resources/sea-cli`, porque a gem exige Ruby 3.2 ou mais recente e o macOS traz apenas o 2.6. A pasta entra no **fim** do `PATH` das sessões do aplicativo: uma instalação própria do usuário continua tendo prioridade. Nenhum token é lido ou gravado pelo aplicativo; o login segue por `sea auth login`.

```sh
npm run vendor:sea-cli   # gera vendor/sea-cli (não versionado) e prova com `sea version`
```

O script baixa o Ruby portátil do Homebrew com verificação de sha256 e usa a gem do cache local do RubyGems, de `SEA_CLI_GEM=<arquivo.gem>` ou do gem source do Dashboard quando `SEA_DASHBOARD_TOKEN` estiver definido. Sem `vendor/sea-cli`, `npm run package` avisa e gera o pacote sem o CLI.

### DMG assinado e notarizado

```sh
xcrun notarytool store-credentials sea-dock   # uma vez: Apple ID, senha de app e Team ID
DK_NOTARY_PROFILE=sea-dock npm run release
```

`scripts/release.mjs` compila, assina os binários do Ruby embutido, empacota e assina o aplicativo com hardened runtime (`build/entitlements.mac.plist`), notariza e grampeia o aplicativo, gera o DMG com `hdiutil`, assina, notariza e grampeia o DMG e confere o resultado com `codesign`, `stapler` e `spctl`. A identidade é a única "Developer ID Application" do keychain, ou a indicada em `DK_SIGN_IDENTITY`. Opções: `--skip-notarize` (só assina, para teste local) e `--without-sea-cli`. A saída é `release/SEA-Dock-<versão>-<arquitetura>.dmg`.

## Verificar

```sh
npm test
npm run test:desktop
npm run test:editor
npm run test:launcher
npm run test:browser:tabs
npm run test:browser:fullscreen
npm run test:dock-preview
npm run test:agents-guide
npm run test:inspector
npm run test:project:sessions
npm run test:project:race
npm run test:launcher:race
npm run test:rebrand:profile
npm run test:git:workflow
npm run test:visual
npm run test:all  # suíte completa, incluindo interface gráfica e regressões de projeto
```

Os testes desktop abrem um Electron real com pastas temporárias e verificam o shell, os painéis, o editor visual, Markdown, Mermaid, split e a fronteira entre interface e processo principal. Com `DK_ROOT=/caminho/do/dk npm run test:desktop`, também executa auditoria e diagnóstico reais. Captura de tela e relatório ficam em `artifacts/`. A compilação é verificada pelo TypeScript.

O teste de tela cheia simula, por padrão, os eventos de janela para funcionar em ambientes sem foco gráfico; a prévia, seu posicionamento e o serviço de teste são reais. Em uma sessão gráfica interativa, use `DK_FULLSCREEN_NATIVE=1 npm run test:browser:fullscreen` para verificar a transição nativa. Caso o envio automatizado de teclas não alcance a prévia, use `DK_FULLSCREEN_MANUAL_ESCAPE=1 DK_FULLSCREEN_WAIT_FOCUS=1 npm run test:browser:fullscreen` e siga as instruções de foco e Escape exibidas no terminal.

## Modo debug

Para enviar logs ao suporte, ligue **Modo debug** em **Perfil e configurações → Diagnóstico**. A preferência fica em `debug.json`, na pasta de dados do aplicativo. Para uma única execução, abra o aplicativo com `SEA_DOCK_DEBUG=1` ou com a opção `--sea-dock-debug`; o Electron recusa `--debug` na inicialização, por ser uma opção antiga do Node. Com o modo ligado, o rodapé mostra **DEBUG** e o aplicativo grava em `<pasta de dados>/logs/sea-dock-<data>.log`, com no máximo cinco arquivos de até 5 MiB cada. O cabeçalho registra a versão do aplicativo, do macOS, a arquitetura e as versões de Electron, Node e Chromium. São registrados `console.*` do processo principal, exceções e promessas rejeitadas sem tratamento, falhas de IPC com canal e mensagem, erros da interface (`window.onerror`, `unhandledrejection`, `console.error` e `console.warn`, por um canal IPC autorizado) e eventos de ciclo de vida: abrir e fechar projeto, iniciar e parar serviço, criar, iniciar e fechar sessão, e falhas ao iniciar processos, com comando e código.

Antes de gravar, cada linha passa por redação: `Bearer`/`Basic`, `sea_pat_`, `glpat-`, `ghp_` e afins, `sk-`, o token da prévia, valores de variáveis cujo nome contém TOKEN, SECRET, PASSWORD, KEY, AUTH ou CREDENTIAL, senhas em URLs, e a pasta pessoal trocada por `~`. O que é digitado nos terminais e a saída deles nunca são gravados. **Exportar logs** gera um `.zip` com `ditto` na pasta Downloads e o mostra no Finder; **Abrir pasta de logs** abre a pasta. Desligar o modo para a gravação; os arquivos já gravados ficam na pasta até serem apagados.

## Abrir com SEA Dock no Finder

A integração do macOS adiciona a ação **Abrir com SEA Dock** ao menu **Ações Rápidas** ou **Serviços** do Finder. Pastas são abertas como projetos; ao escolher um arquivo, o aplicativo abre a pasta que o contém. Uma janela aberta recebe a seleção sem encerrar suas sessões. O aplicativo também se registra como opção alternativa para pastas e arquivos de texto, sem trocar o aplicativo padrão.

Depois de gerar o pacote, instale a integração com:

```sh
python3 scripts/finder.py install --app 'release/SEA Dock-darwin-arm64/SEA Dock.app'
```

O instalador prepara a ação em `integrations/macos/Abrir com DK.workflow` e a copia para `~/Library/Services/Abrir com DK.workflow`. Registra apenas o SEA Dock e atualiza os serviços do macOS. Uma ação existente com o mesmo nome e outro identificador é preservada. Para remover a integração, remova somente esse workflow da pasta de serviços.

Após mudar do DK Terminal para o SEA Dock, execute o comando novamente para atualizar uma ação gerenciada que ainda aponte para o aplicativo antigo.

`python3 scripts/finder.py validate` executa o Automator com uma pasta temporária, sem abrir o aplicativo, para verificar o formato e a passagem de caminhos com espaços e caracteres especiais. [Referência da Apple](https://support.apple.com/en-gb/guide/automator/aut73234890a/2.10/mac/15.0).

## Comando dock no terminal

No macOS, coloque o aplicativo empacotado em uma pasta permanente, como `~/Applications`, e escolha **SEA Dock → Instalar comando dock no terminal**. Essa ação explícita cria `~/.local/bin/dock`, sem alterar a configuração do shell nem substituir um comando existente. Caso o aplicativo não encontre essa pasta no `PATH`, o terminal precisa ser configurado pelo usuário. Apelidos e funções definidos apenas em shells interativos não podem ser detectados pelo aplicativo.

Use `dock .` para abrir a pasta atual, ou `dock 'pasta com espaços' 'outra pasta'`. Um arquivo abre a pasta que o contém, como na ação do Finder; o arquivo em si não é aberto no editor. Se o aplicativo já estiver aberto, a solicitação é encaminhada a ele. `dock` sem argumentos usa a pasta atual; o limite é 32 caminhos existentes por solicitação.

O comando guarda o caminho da cópia instalada. Se o aplicativo for movido ou removido, o terminal informa o problema. Para apontar para a nova localização, abra a cópia atual, escolha **SEA Dock → Remover comando dock do terminal** e instale novamente. A remoção preserva arquivos que não forem o comando original do SEA Dock ou que tenham sido editados. A instalação e a remoção dessa integração ainda não estão disponíveis no Windows e no Linux.

## Apresentar telas com IA: `dock-preview`

Toda sessão aberta pelo SEA Dock (terminal, Claude Code, Codex, Gemini CLI, Antigravity ou uma pessoa digitando) tem o comando `dock-preview`, que abre um protótipo, uma tela, uma imagem ou um documento do projeto no navegador interno do app. Nada precisa ser instalado: o comando vem no pacote, em `Resources/dock-tools/bin` (no desenvolvimento, `dock-tools/bin`), entra no fim do `PATH` das sessões e roda com o runtime do próprio SEA Dock como Node, sem depender de Python ou do Node do usuário.

```sh
dock-preview http://localhost:5173              # servidor local em execução
dock-preview prototipo/index.html --titulo "Home"
dock-preview telas/                             # index.html da pasta ou galeria dos arquivos
dock-preview docs/visao.md                      # Markdown apresentado como página
```

- **Alvo**: endereço local (`localhost`, `127.0.0.1` ou `[::1]`, com ou sem `http://`) ou arquivo ou pasta dentro do projeto da sessão. HTML, imagens (png, jpg, svg, gif, webp), PDF e Markdown são apresentados; uma pasta abre o seu `index.html` ou uma galeria dos arquivos apresentáveis. Caminhos relativos partem da pasta atual.
- **Saída**: uma linha, `OK: …` com o endereço aberto ou `ERRO: …` dizendo o que fazer (projeto não selecionado, arquivo fora do projeto, servidor local parado, sessão antiga depois de reiniciar o app). Códigos de saída: 0 sucesso, 1 recusa ou falha, 2 uso incorreto, 3 fora de uma sessão do SEA Dock.
- **Segurança**: o pedido usa a mesma ponte da prévia do plugin DK (`dk-visualizar`), com token por projeto injetado só nas sessões daquele projeto e aceito apenas em `127.0.0.1`. Endereços externos são recusados. Arquivos são servidos por um servidor local por projeto, aberto sob demanda e encerrado ao fechar o projeto, atrás de um prefixo aleatório no endereço; cada pedido revalida o caminho real, recusa links simbólicos que saiam da raiz, arquivos ocultos e `node_modules`. Markdown e galerias são gerados sem HTML do autor e com política de conteúdo que bloqueia scripts. Como na prévia estática, caminhos absolutos a partir da raiz do site (`/assets/…`) não funcionam numa página servida de subpasta; use caminhos relativos ou o servidor do projeto.
- **Nome**: o comando se chama `dock-preview`, e não `dock preview`, porque o `dock` instalado pelo menu fica em `~/.local/bin`, que costuma vir antes das ferramentas do app no `PATH` de login; nele, `dock preview` seria lido como “abrir a pasta preview”. Mudar o script do `dock` também invalidaria a conferência de integridade das cópias já instaladas. Um nome próprio funciona igual em qualquer sessão.

### Instrução para colar na IA

O botão **Copiar instrução para IA**, na guia **Serviços** do projeto e na barra do navegador, copia o texto abaixo. Cole no chat da IA ou, se quiser que valha sempre, no `AGENTS.md`, `CLAUDE.md` ou `GEMINI.md` do projeto. O app só grava o `AGENTS.md` pela ação explícita descrita em [Guia para IAs](#guia-para-ias-agentsmd).

```markdown
## Apresentar telas no SEA Dock

Quando precisar mostrar um protótipo, uma tela, uma imagem ou um documento para a pessoa, abra no navegador interno do SEA Dock rodando no terminal:

    dock-preview <alvo> [--titulo "Texto"]

- <alvo> é um endereço local (http://localhost:5173, 127.0.0.1:3000) ou um arquivo ou pasta do projeto (prototipo/index.html, telas/, tela.png, docs/visao.md). Caminhos relativos partem da pasta atual.
- A saída é uma linha: OK: quando abriu, ou ERRO: seguido do que fazer. Siga a orientação do erro antes de tentar de novo.
- Só abre endereços locais e arquivos dentro do projeto. Para um servidor de desenvolvimento, inicie-o antes e passe o endereço.
- Se o comando não existir, a sessão não foi aberta pelo SEA Dock: informe o caminho do arquivo à pessoa em vez de abrir.
```

## Guia para IAs (AGENTS.md)

O guia dos recursos do SEA Dock para agentes de IA fica em `dock-tools/agents/AGENTS.md` (no pacote, `Resources/dock-tools/agents/AGENTS.md`). Ele diz quando usar `dock-preview` (todo pedido de abrir, mostrar ou apresentar protótipo, tela, página, mockup, HTML ou resultado visual), aponta `sea help`, explica os serviços detectados nas sessões e os limites (só localhost, só arquivos do projeto, nunca imprimir tokens). É entregue sem gravar nada no projeto nem na configuração da pessoa:

| CLI | Como recebe o guia |
| --- | --- |
| Claude Code (`claude`) | `--append-system-prompt-file <guia>`, acrescentado ao prompt de sistema padrão. |
| Codex (`codex`, terminal) | `-c developer_instructions="<guia>"`, só para aquela execução; `CODEX_HOME` não muda. |
| Codex (painel de conversa) | `developerInstructions` em `thread/start` e `thread/resume` do `codex app-server`. |
| Antigravity (`agy`) | `--add-dir <pasta do guia>`; o Antigravity lê `AGENTS.md` das pastas do espaço de trabalho. |
| Gemini CLI, DK CLI e outras extensões | Não recebem automaticamente; use `dock-agents` ou a gravação no projeto. |

Vale para os ícones da barra, o menu de divisão com agente e extensões do usuário que chamem esses comandos. As opções entram antes dos argumentos já declarados, que são preservados; se a pessoa já passou a mesma opção (`--append-system-prompt[-file]`, `--system-prompt[-file]`, `-c developer_instructions=…`, o mesmo `--add-dir`), nada é acrescentado. Se o `config.toml` do Codex já define `developer_instructions` na raiz, o app não o sobrepõe. Plugins v2 não são alterados, porque a confirmação mostra os argumentos exatos.

Todas as sessões exportam `SEA_DOCK_AGENTS_MD=<caminho do guia>` e têm o comando `dock-agents`, que imprime o guia. Quando a pessoa digita `claude` ou `codex` direto no terminal, a CLI não recebe o guia: nenhuma delas lê instruções de uma variável de ambiente, e cobrir esse caso exigiria trocar o comando ou mexer na configuração da pessoa. Peça à IA para rodar `dock-agents`, ou grave o guia no projeto.

**Adicionar guia do SEA Dock ao projeto**, na guia **Serviços** (seção Apresentar com IA), grava o guia no `AGENTS.md` da raiz do projeto, entre `<!-- sea-dock:inicio -->` e `<!-- sea-dock:fim -->`. Antes, mostra o arquivo e o bloco e pede confirmação. Cria o arquivo se não existir, acrescenta o bloco ao fim ou substitui só o bloco anterior; o resto do arquivo fica igual. Marcadores incompletos ou repetidos, link simbólico e arquivo acima de 1 MiB são recusados. Nunca é feito automaticamente.

## Estrutura

- `electron/main.cjs`: janela, protocolo local, seleção nativa de pastas e mensagens autorizadas.
- `electron/preload.cjs`: API limitada exposta à interface isolada.
- `electron/terminals.cjs`: sessões PTY, fluxo de saída, redimensionamento e encerramento.
- `electron/core.cjs`: inspeção de pastas, comandos DK e persistência.
- `electron/html-patch.cjs`, `electron/visual-session.cjs`, `electron/visual-patch-worker.cjs`, `electron/visual-protocol.cjs` e `electron/visual-bridge.js`: editor visual (patch por faixa, sessão e worker, esquema `dk-preview://` e ponte do iframe).
- `src/`: interface, terminal e tokens visuais próprios deste aplicativo.

Os projetos recentes e a localização do kit ficam em `settings.json`, na pasta de dados do aplicativo. A saída dos terminais comuns e as credenciais não são gravadas pelo SEA Dock. O painel Codex mantém seu histórico privado conforme descrito acima. O shell e os programas que você executar mantêm seu comportamento normal, inclusive seu próprio histórico.

O SEA Dock continua usando a pasta de dados existente do DK Terminal, inclusive a origem das preferências da interface, para preservar projetos recentes e histórico após a mudança de nome. Os identificadores técnicos `dk-terminal` e `dk-app` também são mantidos para compatibilidade. Para usar um perfil separado, defina `DK_TERMINAL_DATA_DIR` com o caminho absoluto de uma pasta. O aplicativo cria a pasta e mantém as preferências desse perfil separadas. Os testes do pacote usam esse recurso para preservar o perfil de uso normal.

## Limites desta versão

As sessões são encerradas ao fechar a janela; apenas os projetos recentes, a preferência da sidebar e o kit são restaurados. Electron tem um custo de memória de base: não há promessa de consumo mínimo absoluto. O editor e o chat carregam sob demanda, o navegador é liberado ao sair, o grafo usa eventos em vez de polling, as cotas não são consultadas em segundo plano e as saídas têm limites. O relatório desktop registra uma amostra local, não um benchmark universal. Há limite de 16 sessões, 10 mil linhas de histórico por sessão e oito serviços ativos. Cada serviço mantém no máximo 32 KB de saída em memória. Não há atualização automática, host de extensões VS Code ou gerenciador SSH nesta versão. O editor não substitui uma IDE completa: não inclui depurador ou servidor de linguagem. Ferramentas e agentes já instalados podem ser usados normalmente pelo terminal. Windows e Linux exigem compilação e validação nas respectivas plataformas; a validação inicial é feita no macOS.

## Reuso e referências

Decisão de 28/10/2026: compor um aplicativo próprio com Electron, xterm.js e node-pty para manter a interface do DK independente de outro emulador. A prova é a execução do teste desktop com PTY real. O kit é uma dependência externa escolhida pelo usuário, sem cópia ou alteração do seu núcleo.

- [Electron: isolamento e segurança](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron: módulos nativos](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [xterm.js](https://github.com/xtermjs/xterm.js), licença MIT
- [node-pty](https://github.com/microsoft/node-pty), licença MIT

Este projeto está marcado como privado e ainda não define licença para distribuição pública. As licenças dos componentes continuam aplicáveis.

Os ícones referenciais das integrações foram obtidos das instalações oficiais locais de Claude Code e Codex; o aplicativo mantém a identidade própria DK e não representa uma extensão oficial desses fornecedores.

O tooltip dos projetos na sidebar usa o campo `projeto` de `projeto.yml`; sem nome válido, usa o nome da pasta.

O SEA Dock consulta o Claude Code em segundo plano para localizar o plugin `dk@dk` ativo e usar o pacote instalado como kit. Se o plugin estiver ausente ou desativado, a sidebar oferece a instalação ou ativação pelo Claude. A instalação usa o marketplace oficial do DK e pode depender de acesso ao repositório; se o Claude não puder verificar seus plugins, o aplicativo informa isso. A variável `DK_ROOT`, quando definida, prevalece sobre a descoberta automática.

Na barra lateral, **Máquina** apresenta CPU, memória não livre e swap do computador, além de estimativas separadas de RSS dos processos do SEA Dock, dos filhos detectados e dos demais processos. O rodapé mostra apenas o SEA Dock. RSS pode contar páginas compartilhadas mais de uma vez e não constitui uma divisão exata da memória física. A memória não livre inclui cache e não corresponde à pressão. No macOS, a parcela purgável é apenas parte do cache recuperável; a disponibilidade consultada não é uma medida de pressão. No Linux, o painel mostra a pressão PSI quando disponibilizada pelo sistema. Valores sem fonte confiável aparecem como indisponíveis.

**Otimizar recursos** limpa apenas caches temporários do SEA Dock, sem encerrar terminais, serviços ou modificar arquivos. A liberação de memória é administrada pelo sistema e pode não ser imediata; a ação não altera outros aplicativos. O painel **Máquina** pode ser recolhido e guarda essa preferência. Em **Ferramentas avançadas do macOS**, a ação opcional de limpar cache do sistema requer confirmação e pode pedir senha; ela não libera memória dos aplicativos nem swap e pode reduzir temporariamente o desempenho. O Monitor de Atividade permite examinar a pressão informada pelo macOS.

Sessões de terminal, Claude ou Codex com pelo menos 30 minutos sem entrada nem saída e 64 MiB ou mais de memória detectada geram um aviso com o processo identificado. A sessão pode estar aguardando uma operação; nada é encerrado sem a escolha explícita do usuário. Manter adia novo aviso por 30 minutos; no chat visual do Codex a ação interrompe a execução, mantendo a conversa. O encerramento explícito procura descendentes identificáveis antes de fechar; processos já desvinculados ou que não possam ser inspecionados podem não ser alcançados. No Windows, a inspeção de descendentes de terminal e Codex não está implementada e o aplicativo informa quando não consegue confirmar a limpeza.

O botão **Tema SEA** ativa ou desativa a identidade visual SEA e guarda a preferência neste computador. A marca usada é o arquivo oficial branco da SEA. O ícone **Visualizar protótipo** fica disponível quando um serviço reconhecido como front-end está em execução; inicie o serviço pela guia **Serviços**.

## Início, contas e projetos remotos

A tela inicial reúne separadamente projetos recentes locais e remotos. Fechar um projeto na barra lateral encerra seus terminais e conversas de agentes, preserva o histórico e pergunta sobre arquivos não salvos. Os serviços iniciados pela guia Serviços são gerenciados separadamente e continuam ativos até serem desligados. Projetos do grupo `design` e seus subgrupos no GitLab SEA abrem em modo de consulta, com a árvore, arquivos de texto UTF-8 e imagens PNG, JPEG, GIF ou WebP da branch padrão, sem criar uma cópia local. Para editar ou executar, use **Preparar cópia local**, escolha a pasta de destino e aguarde a cópia pelo Git, via SSH (padrão da empresa) ou, sem chave SSH, por HTTPS com credencial já salva no Git; uma pasta existente não é sobrescrita e uma falha diz o que fazer. A leitura remota requer rede e uma conta GitLab com acesso ao projeto. A lista destaca projetos com cópia encontrada no volume SEA e, ao abrir um projeto remoto, oferece essas pastas locais cujo Git `origin` corresponde ao projeto. A busca ignora pastas ocultas, dependências e saídas de build; pode ser parcial em volumes grandes e oferece continuar a busca.

Uma pasta aberta que ainda não está no GitLab SEA (sem Git, sem remoto ou com remoto de outro servidor) mostra **Criar projeto no GitLab SEA** na guia Git. O formulário pede nome, caminho (sugerido a partir da pasta), grupo de destino (`design` por padrão, mais os subgrupos em que a conta pode criar projetos), visibilidade (privado por padrão) e descrição opcional. A revisão lista o que vai acontecer e não altera nada; só **Criar e publicar** executa: inicia o Git se preciso, cria a primeira versão apenas se pedida (recusa `node_modules` ou `.env` fora do `.gitignore`), cria o projeto com `glab api projects -X POST` (argumentos separados, sem shell e sem o app tocar no token), renomeia um `origin` existente para `anterior` só com autorização, adiciona o `origin` SSH e envia a branch atual. Falhas dizem o que fazer, como `glab auth login --hostname gitlab.seatecnologia.com.br`, caminho já usado ou falta de permissão no grupo.

Em **Perfil e configurações**, escolha tema, efeito de vidro e nível de transparência (opcionais e persistentes), sidebar, tamanho da fonte, histórico do terminal e parâmetros dos avisos de inatividade. O tema SEA é padrão para novas instalações; uma preferência anterior continua sendo respeitada. O cursor fica estático por padrão para reduzir o uso de CPU; a opção **Cursor piscando** permite ativar a animação e é persistida. A tela verifica SEA CLI, Claude, Codex (opcional), Python, pnpm, Node.js, Git e GitLab CLI. A consulta ocorre na abertura do aplicativo, pois a distribuição atual é um aplicativo empacotado e não um instalador. Não instala ferramentas automaticamente.

A conta SEA usa `sea auth login` e a conta GitLab usa `glab auth login` para o host SEA; são autenticações separadas. O SEA Dock abre as ferramentas oficiais em um terminal temporário e não registra nem armazena tokens em configuração própria. Para a leitura remota e a cópia, o GitLab CLI precisa estar instalado e autenticado. Os tempos de rede e as permissões de acesso dependem dos serviços e das contas do usuário.

### Guia Git

Na guia **Git** do projeto local, as seções recolhíveis **Alterações** e **Grafo** mostram os arquivos e as versões no mesmo painel. Selecione os arquivos e informe uma mensagem para **Salvar versão**; `⌘ Enter` no Mac ou `Ctrl Enter` nas demais plataformas realiza a mesma ação. A versão inclui o conteúdo integral salvo em disco dos arquivos selecionados, e os demais arquivos preparados permanecem separados. Conflitos devem ser resolvidos antes da seleção. O rascunho da mensagem, a seleção ainda válida e as seções são mantidos por projeto enquanto o aplicativo estiver aberto.

Salve os arquivos abertos do projeto no editor antes de criar uma versão ou atualizá-lo. Se a criação falhar depois da preparação, os arquivos selecionados podem permanecer preparados no Git. Hooks configurados no repositório continuam em vigor.

O grafo apresenta até 100 versões das referências disponíveis localmente; abra uma versão para consultar seus detalhes. Em **Ferramentas**, **Buscar** consulta o remoto, **Atualizar** exige que não haja alterações locais e só aceita atualização sem merge, e **Enviar** envia a branch atual (na primeira vez, usa `origin` como remoto). Os indicadores de envio e recebimento usam as referências locais do último buscar. A autenticação segue a configuração Git do computador; caso precise de interação ou de resolver um conflito, use o terminal. A guia é atualizada ao ser aberta e também pelo botão de atualização.

Quando `origin` aponta para um projeto no grupo Design do GitLab SEA, a guia oferece atalhos para o projeto e seus merge requests. Criar merge request abre o formulário do GitLab no navegador; a publicação é confirmada lá. Projetos visualizados remotamente precisam de uma cópia local para essas operações Git.

Na guia **Pasta**, clique com o botão direito em um arquivo ou pasta para abrir o menu de ações; pelo teclado, use **Shift + F10** ou a tecla de menu. É possível abrir o item, mostrá-lo no gerenciador de arquivos e copiar o nome ou o caminho. No macOS, arquivos também oferecem **Compartilhar arquivo…**, que abre o menu de compartilhamento do sistema com os aplicativos compatíveis disponíveis. O arquivo compartilhado é a versão salva no disco; a disponibilidade de Discord, WhatsApp ou outro destino depende do suporte e da configuração de cada aplicativo no macOS.

A seção **Branches** da guia Git lista as branches locais e permite criar e trocar para uma nova branch, trocar para outra existente ou excluir uma branch local já integrada à branch atual. A exclusão não é forçada e não remove branches remotas. Para criar ou trocar, salve os arquivos no editor e registre ou resolva todas as alterações locais; as abas de editor do projeto são fechadas para não apresentar conteúdo da branch anterior.

O **Histórico em gráfico** mostra até 100 commits das referências locais e remotas já conhecidas pelo Git, com conexões entre commits e merges. Use **Buscar** para atualizar as referências remotas; selecione uma versão no gráfico para ver seus detalhes. O gráfico não consulta o servidor automaticamente.

Para reproduzir a medição local, execute `npm run build` e `npm run benchmark:resources` em uma cópia de trabalho; o resultado é gravado em `artifacts/resource-benchmark.json`. O roteiro usa projeto e terminais temporários, shell Unix, `ps` e Python 3, e não executa inferência de agentes. A medição compara RSS e CPU aproximados, heap do renderer e ciclos de sessões sem forçar coleta de lixo. Resultados e limitações da auditoria realizada no Mac estão em `benchmarks/recursos/README.md`.
