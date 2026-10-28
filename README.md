# DK Terminal

Aplicativo desktop local para trabalhar com projetos do Design Kit. Primeira versão funcional, 0.1.0-alpha.1, feita com Electron, xterm.js e node-pty.

O loading usa a logo SVG fornecida pelo usuário: a seta chega pela diagonal, depois as letras DK são reveladas da esquerda para a direita. A animação é vetorial, com ciclo de 3,2 segundos; a introdução completa sua primeira revelação antes de abrir o espaço de trabalho. A preferência do sistema por redução de movimento remove a animação e essa espera visual. Os arquivos reutilizáveis ficam em `assets/dk-loading.svg` e `assets/dk-loading.html`; a prévia animada fica em `artifacts/dk-loading.gif`.

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
3. Use **Nova sessão** para abrir mais terminais. Cada projeto mantém suas sessões separadas enquanto o aplicativo estiver aberto.
4. Use **Auditoria**, **Validar projeto** ou **Diagnóstico** para abrir o resultado renderizado, com opção **Ver JSON** para inspecionar os dados originais.
5. A aba **Serviços**, no painel da direita, reconhece scripts `dev`, `start`, `serve`, `preview`, `watch`, `worker` e `api` do `package.json`, inclusive variantes como `dev:api`. Inicie ou desligue cada serviço pelo botão ao lado. A saída e o endereço local aparecem nessa aba.
6. O botão no topo da área de trabalho recolhe ou expande a sidebar.
7. As abas **Contexto**, **Serviços**, **Pasta** e **Consumo** organizam o painel do projeto. **Pasta** abre por padrão ao entrar em um projeto, mostra a árvore de arquivos e expande cada diretório sob demanda; o botão de atualizar relê a árvore. Clique em um arquivo para abri-lo no editor. Textos UTF-8 até 2 MiB podem ser editados com realce de sintaxe, abas e `⌘S`; imagens até 4 MiB têm prévia. Binários e arquivos maiores ficam somente para consulta de metadados. Alterações não salvas são protegidas ao fechar, e uma revisão externa impede sobrescrever mudanças de outro programa. Links simbólicos são identificados e não expandidos pela interface; o aplicativo recusa a navegação para fora da raiz selecionada. Diretórios grandes mostram até 500 entradas por abertura.
8. Editor e terminais compartilham a mesma área de painéis e suas abas aparecem juntas. Fechar a última aba de arquivo encerra a visualização do editor. Os botões de divisão abrem até quatro terminais independentes, à direita ou abaixo. A nova sessão usa a pasta atual e, para integrações de agente abertas pelo DK, o mesmo tipo do painel selecionado. O menu de divisão com agente permite abrir Claude, Codex ou outra extensão instalada em uma nova sessão do terminal. A conversa e o histórico em execução permanecem na sessão original. `⌘D` divide à direita e `⌘⇧D` divide abaixo. A ação **Separar painel ativo do split** retira o terminal selecionado do grupo e preserva sua sessão; os demais painéis continuam agrupados. A visualização única recolhe o split sem encerrar as outras sessões.
9. O botão **Expandir terminal**, na barra de sessões, amplia a área de trabalho, mantém a sidebar de projetos visível e permite restaurá-la sem encerrar o terminal. Atalho: `⌘⇧E` no Mac, `Ctrl⇧E` nas demais plataformas.

Arquivos HTML abrem em visualização estática isolada, com folhas de estilo e imagens locais quando suportadas; **Código** permite editar a fonte. Scripts e recursos externos não são executados nessa visualização; para interagir com um projeto em execução, use o Browser.

Arquivos Markdown abrem em edição visual: títulos, ênfases, links, listas de tarefas, tabelas, imagens locais e blocos Mermaid são apresentados no próprio texto. O botão **Código** mostra a fonte completa, e **Visual** retorna à edição visual. Imagens externas não são carregadas automaticamente. Para limitar processamento, o modo visual é usado em arquivos Markdown de até 256 KB; arquivos maiores continuam disponíveis no modo de código.

Arquivos `.mmd` e `.mermaid`, assim como blocos Mermaid em Markdown, abrem com o diagrama renderizado. Em fluxogramas, selecione uma etapa para editar seu texto, adicionar uma etapa seguinte ou conectar etapas; em diagramas de sequência, participantes e mensagens reconhecidos podem ter o texto editado. Outros diagramas e estruturas não reconhecidas continuam renderizados e podem ser alterados pelo botão **Código**. Diagramas de até 50 mil caracteres são renderizados; erros de sintaxe mantêm o código disponível para correção. O Mermaid carrega somente quando um diagrama é aberto.

**Orquestração** mostra as tarefas, dependências e estados reais dos arquivos `.dk/coordenacoes/*.json`. A visualização atualiza por eventos do sistema somente enquanto está aberta e recusa registros com ciclos ou referências ausentes.

O ícone **Visualizar protótipo**, na barra do terminal ao lado de Claude e Codex, fica disponível quando um serviço reconhecido como front-end está em execução. Inicie esse serviço na guia **Serviços**; a identificação usa nomes comuns como `dev`, `preview`, `web`, `frontend` e `start`. Iniciar um serviço de prévia identificado pela guia **Serviços** também abre o navegador. Serviços como API, worker e watch continuam disponíveis em segundo plano. Em `dk-terminal.services.json`, use `"role": "frontend"` ou `"role": "backend"` para identificar explicitamente serviços personalizados com nomes ambíguos. O navegador é criado sob demanda, sem acesso ao Node ou à API do aplicativo, com armazenamento temporário por projeto. Navegações principais para fora de localhost, novas janelas, downloads e permissões são bloqueados. A página ainda pode carregar recursos e realizar conexões de rede externas; a prévia não é um bloqueio de rede. Sair da prévia libera a visualização e aguarda a limpeza de sua sessão antes de reabrir o mesmo projeto; desligar o serviço é uma ação separada. A execução do projeto continua local, com as permissões da conta do sistema.

O [estudo do browser e suas evidências](docs/rea-browser/README.md) detalham a fronteira de segurança e o ciclo de vida da prévia.

O rodapé mostra CPU e RAM dos processos do DK Terminal. Passe o cursor sobre os indicadores para ver também os processos filhos detectados, incluindo terminais, agentes e serviços. O consumo de CPU é aproximado: 100% representa um núcleo e o total pode ultrapassar 100%. A RAM é uma soma de memória residente e pode incluir páginas compartilhadas. A leitura é atualizada a cada 10 segundos enquanto a janela está visível; processos que se desvinculam do aplicativo podem não ser detectados. Quando não for possível consultar os filhos, o detalhamento informa essa limitação.

Serviços são iniciados somente por uma ação do usuário. O aplicativo acompanha os processos que ele próprio iniciou. Comandos abertos diretamente em um terminal ou em outro aplicativo não são descobertos automaticamente. Ao desligar um serviço, o aplicativo encerra seu grupo de processos; ao fechar a janela, também encerra os serviços gerenciados. A inicialização não instala dependências do projeto.

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

O ícone do **Codex** abre um painel de conversa do próprio DK, com mensagens, saída de ferramentas, histórico por projeto, interrupção e aprovações explícitas. Ele usa o protocolo oficial `codex app-server`, com o login, modelo e provider configurados na CLI. O processo é iniciado quando o usuário envia uma mensagem e encerrado ao concluir o turno. Pedidos ainda não suportados pelo painel são recusados com uma mensagem para continuar pela CLI. É possível abrir `codex` manualmente no terminal para esses fluxos.

O aplicativo não lê arquivos de credenciais, não copia tokens e não passa opções para ignorar permissões. O login continua nas ferramentas oficiais. O histórico do painel Codex é gravado em `codex-conversations.json`, na pasta privada de dados do aplicativo, com permissões 0600: até 30 conversas, 200 mensagens por conversa, 64 KiB por mensagem/saída e 8 MiB no total. Há no máximo dois turnos ativos. O histórico de raciocínio privado não é exibido nem gravado pelo DK.

A guia **Consumo** consulta limites reais do Codex por `account/read` e `account/rateLimits/read`, sem iniciar conversa ou inferência. A duração de cada janela vem da ferramenta; uma janela ausente não vira 0%. A atualização é manual, com cache e intervalo mínimo de um minuto. Para Claude, a leitura usa `/usage` na CLI oficial em modo seguro, sem autorizar projetos ou efetuar login automaticamente; se a CLI não disponibilizar valores, o painel informa a indisponibilidade e permite abrir o Claude para consultar `/usage`. O DK não usa endpoints OAuth privados. A integração Claude permanece na CLI por escolha do usuário, sem Agent SDK com login de assinatura.

Para criar outra extensão declarativa, adicione uma pasta em `extensions/` na fonte do aplicativo ou em `extensions/` dentro da pasta de dados do DK Terminal, com um arquivo `extension.json`:

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

Reabra o aplicativo para carregar novas extensões. A versão 1 de extensões de terceiros aceita manifestos para comandos de terminal e não carrega JavaScript de terceiros. Browser e o painel Codex são integrações internas do aplicativo. Não há um host de extensões VS Code/VSIX. Os comandos recebem as permissões normais da conta do sistema e só são iniciados pelo usuário.

O [planejamento M0–M4](docs/planejamento/README.md) descreve as evoluções propostas de plugins, agentes, edição visual e auditoria; esses marcos ainda não fazem parte da pré-release.

Referências: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) e [Claude Code](https://code.claude.com/docs/en/overview).

## Gerar o aplicativo

```sh
npm run package
```

A saída fica em `release/`. O pacote inclui o node-pty fora do arquivo ASAR e mantém apenas as dependências necessárias ao processo principal; as bibliotecas visuais já estão compiladas em `dist/` e são carregadas sob demanda. É gerado para a plataforma e arquitetura atuais. No Mac, abra `release/DK Terminal-darwin-arm64/DK Terminal.app` em uma máquina Apple Silicon ou a pasta `darwin-x64` em Intel. A compilação local não inclui assinatura de distribuição nem notarização.

## Verificar

```sh
npm test
npm run test:desktop
npm run test:editor
npm run test:launcher
npm run test:all  # suíte completa, incluindo interface gráfica e regressões de projeto
```

Os testes desktop abrem um Electron real com pastas temporárias e verificam o shell, os painéis, o editor visual, Markdown, Mermaid, split e a fronteira entre interface e processo principal. Com `DK_ROOT=/caminho/do/dk npm run test:desktop`, também executa auditoria e diagnóstico reais. Captura de tela e relatório ficam em `artifacts/`. A compilação é verificada pelo TypeScript.

## Abrir com DK no Finder

A integração do macOS adiciona a ação **Abrir com DK** ao menu **Ações Rápidas** ou **Serviços** do Finder. Pastas são abertas como projetos; ao escolher um arquivo, o aplicativo abre a pasta que o contém. Uma janela aberta recebe a seleção sem encerrar suas sessões. O aplicativo também se registra como opção alternativa para pastas e arquivos de texto, sem trocar o aplicativo padrão.

Depois de gerar o pacote, instale a integração com:

```sh
python3 scripts/finder.py install --app 'release/DK Terminal-darwin-arm64/DK Terminal.app'
```

O instalador prepara a ação em `integrations/macos/Abrir com DK.workflow` e a copia para `~/Library/Services/Abrir com DK.workflow`. Registra apenas o DK Terminal e atualiza os serviços do macOS. Uma ação existente com o mesmo nome e outro identificador é preservada. Para remover a integração, remova somente esse workflow da pasta de serviços.

`python3 scripts/finder.py validate` executa o Automator com uma pasta temporária, sem abrir o aplicativo, para verificar o formato e a passagem de caminhos com espaços e caracteres especiais. [Referência da Apple](https://support.apple.com/en-gb/guide/automator/aut73234890a/2.10/mac/15.0).

## Estrutura

- `electron/main.cjs`: janela, protocolo local, seleção nativa de pastas e mensagens autorizadas.
- `electron/preload.cjs`: API limitada exposta à interface isolada.
- `electron/terminals.cjs`: sessões PTY, fluxo de saída, redimensionamento e encerramento.
- `electron/core.cjs`: inspeção de pastas, comandos DK e persistência.
- `src/`: interface, terminal e tokens visuais próprios deste aplicativo.

Os projetos recentes e a localização do kit ficam em `settings.json`, na pasta de dados do aplicativo. A saída dos terminais comuns e as credenciais não são gravadas pelo DK. O painel Codex mantém seu histórico privado conforme descrito acima. O shell e os programas que você executar mantêm seu comportamento normal, inclusive seu próprio histórico.

Para usar um perfil separado, defina `DK_TERMINAL_DATA_DIR` com o caminho absoluto de uma pasta. O aplicativo cria a pasta e mantém as preferências desse perfil separadas. Os testes do pacote usam esse recurso para preservar o perfil de uso normal.

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

O DK Terminal consulta o Claude Code em segundo plano para localizar o plugin `dk@dk` ativo e usar o pacote instalado como kit. Se o plugin estiver ausente ou desativado, a sidebar oferece a instalação ou ativação pelo Claude. A instalação usa o marketplace oficial do DK e pode depender de acesso ao repositório; se o Claude não puder verificar seus plugins, o aplicativo informa isso. A variável `DK_ROOT`, quando definida, prevalece sobre a descoberta automática.

Na barra lateral, **Máquina** apresenta CPU, memória não livre e swap do computador, além de estimativas separadas de RSS dos processos do DK, dos filhos detectados e dos demais processos. O rodapé mostra apenas o DK. RSS pode contar páginas compartilhadas mais de uma vez e não constitui uma divisão exata da memória física. A memória não livre inclui cache e não corresponde à pressão. No macOS, a parcela purgável é apenas parte do cache recuperável; a disponibilidade consultada não é uma medida de pressão. No Linux, o painel mostra a pressão PSI quando disponibilizada pelo sistema. Valores sem fonte confiável aparecem como indisponíveis.

**Otimizar recursos** limpa apenas caches temporários do próprio DK, sem encerrar terminais, serviços ou modificar arquivos. A liberação de memória é administrada pelo sistema e pode não ser imediata; a ação não altera outros aplicativos. O painel **Máquina** pode ser recolhido e guarda essa preferência. Em **Ferramentas avançadas do macOS**, a ação opcional de limpar cache do sistema requer confirmação e pode pedir senha; ela não libera memória dos aplicativos nem swap e pode reduzir temporariamente o desempenho. O Monitor de Atividade permite examinar a pressão informada pelo macOS.

Sessões de terminal, Claude ou Codex com pelo menos 30 minutos sem entrada nem saída e 64 MiB ou mais de memória detectada geram um aviso com o processo identificado. A sessão pode estar aguardando uma operação; nada é encerrado sem a escolha explícita do usuário. Manter adia novo aviso por 30 minutos; no chat visual do Codex a ação interrompe a execução, mantendo a conversa. O encerramento explícito procura descendentes identificáveis antes de fechar; processos já desvinculados ou que não possam ser inspecionados podem não ser alcançados. No Windows, a inspeção de descendentes de terminal e Codex não está implementada e o aplicativo informa quando não consegue confirmar a limpeza.

O botão **Tema SEA** ativa ou desativa a identidade visual SEA e guarda a preferência neste computador. A marca usada é o arquivo oficial branco da SEA. O ícone **Visualizar protótipo** fica disponível quando um serviço reconhecido como front-end está em execução; inicie o serviço pela guia **Serviços**.

## Início, contas e projetos remotos

A tela inicial reúne separadamente projetos recentes locais e remotos. Fechar um projeto na barra lateral encerra seus terminais e conversas de agentes, preserva o histórico e pergunta sobre arquivos não salvos. Os serviços iniciados pela guia Serviços são gerenciados separadamente e continuam ativos até serem desligados. Projetos do grupo `design` e seus subgrupos no GitLab SEA abrem em modo de consulta, com a árvore, arquivos de texto UTF-8 e imagens PNG, JPEG, GIF ou WebP da branch padrão, sem criar uma cópia local. Para editar ou executar, use **Preparar cópia local**, escolha a pasta de destino e aguarde a criação da cópia pelo GitLab CLI; uma pasta existente não é sobrescrita. A leitura remota requer rede e uma conta GitLab com acesso ao projeto. A lista destaca projetos com cópia encontrada no volume SEA e, ao abrir um projeto remoto, oferece essas pastas locais cujo Git `origin` corresponde ao projeto. A busca ignora pastas ocultas, dependências e saídas de build; pode ser parcial em volumes grandes e oferece continuar a busca.

Em **Perfil e configurações**, escolha tema, efeito de vidro e nível de transparência (opcionais e persistentes), sidebar, tamanho da fonte, histórico do terminal e parâmetros dos avisos de inatividade. A tela verifica SEA CLI, Claude, Codex (opcional), Python, pnpm, Node.js, Git e GitLab CLI. A consulta ocorre na abertura do aplicativo, pois a distribuição atual é um aplicativo empacotado e não um instalador. Não instala ferramentas automaticamente.

A conta SEA usa `sea auth login` e a conta GitLab usa `glab auth login` para o host SEA; são autenticações separadas. O DK abre as ferramentas oficiais em um terminal temporário e não registra nem armazena tokens em configuração própria. Para a leitura remota e a cópia, o GitLab CLI precisa estar instalado e autenticado. Os tempos de rede e as permissões de acesso dependem dos serviços e das contas do usuário.

### Guia Git

Na guia **Git** do projeto local, confira a branch, os arquivos alterados e a comparação de cada arquivo. Selecione os arquivos e informe uma mensagem para **Salvar versão**; o conteúdo gravado no disco é incluído na versão e os demais arquivos preparados permanecem separados. Salve os arquivos abertos no editor antes de criar uma versão. Se a criação falhar depois da preparação, os arquivos selecionados podem permanecer preparados no Git.

O histórico apresenta até 50 versões recentes; abra uma versão para consultar os arquivos que ela alterou. **Buscar** consulta o remoto, **Atualizar** exige que não haja alterações locais e só aceita atualização sem merge, e **Enviar** envia a branch atual (na primeira vez, usa `origin` como remoto). A autenticação segue a configuração Git do computador; caso precise de interação ou de resolver um conflito, use o terminal. A guia é atualizada ao ser aberta e também pelo botão de atualização.

Quando `origin` aponta para um projeto no grupo Design do GitLab SEA, a guia oferece atalhos para o projeto e seus merge requests. Criar merge request abre o formulário do GitLab no navegador; a publicação é confirmada lá. Projetos visualizados remotamente precisam de uma cópia local para essas operações Git.

Na guia **Pasta**, clique com o botão direito em um arquivo ou pasta para abrir o menu de ações; pelo teclado, use **Shift + F10** ou a tecla de menu. É possível abrir o item, mostrá-lo no gerenciador de arquivos e copiar o nome ou o caminho. No macOS, arquivos também oferecem **Compartilhar arquivo…**, que abre o menu de compartilhamento do sistema com os aplicativos compatíveis disponíveis. O arquivo compartilhado é a versão salva no disco; a disponibilidade de Discord, WhatsApp ou outro destino depende do suporte e da configuração de cada aplicativo no macOS.

A seção **Branches** da guia Git lista as branches locais e permite criar e trocar para uma nova branch, trocar para outra existente ou excluir uma branch local já integrada à branch atual. A exclusão não é forçada e não remove branches remotas. Para criar ou trocar, salve os arquivos no editor e registre ou resolva todas as alterações locais; as abas de editor do projeto são fechadas para não apresentar conteúdo da branch anterior.

O **Histórico em gráfico** mostra até 100 commits das referências locais e remotas já conhecidas pelo Git, com conexões entre commits e merges. Use **Buscar** para atualizar as referências remotas; selecione uma versão no gráfico para ver seus detalhes. O gráfico não consulta o servidor automaticamente.

Para reproduzir a medição local, execute `npm run build` e `npm run benchmark:resources` em uma cópia de trabalho; o resultado é gravado em `artifacts/resource-benchmark.json`. O roteiro usa projeto e terminais temporários, shell Unix, `ps` e Python 3, e não executa inferência de agentes. A medição compara RSS e CPU aproximados, heap do renderer e ciclos de sessões sem forçar coleta de lixo. Resultados e limitações da auditoria realizada no Mac estão em `benchmarks/recursos/README.md`.
