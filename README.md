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

Serviços são iniciados somente por uma ação do usuário. O aplicativo acompanha os processos que ele próprio iniciou. Comandos abertos diretamente em um terminal ou em outro aplicativo não são descobertos automaticamente. Ao desligar um serviço, o aplicativo encerra seu grupo de processos; ao fechar a janela, também encerra os serviços gerenciados. A inicialização não instala dependências do projeto.

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

Reabra o aplicativo para carregar novas extensões. A versão 1 de extensões de terceiros aceita manifestos para comandos de terminal e não carrega JavaScript de terceiros. Browser e o painel Codex são integrações internas do aplicativo. Não há um host de extensões VS Code/VSIX. Os comandos recebem as permissões normais da conta do sistema e só são iniciados pelo usuário.

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
npm run test:inspector
npm run test:project:sessions
npm run test:project:race
npm run test:launcher:race
npm run test:rebrand:profile
npm run test:git:workflow
npm run test:all  # suíte completa, incluindo interface gráfica e regressões de projeto
```

Os testes desktop abrem um Electron real com pastas temporárias e verificam o shell, os painéis, o editor visual, Markdown, Mermaid, split e a fronteira entre interface e processo principal. Com `DK_ROOT=/caminho/do/dk npm run test:desktop`, também executa auditoria e diagnóstico reais. Captura de tela e relatório ficam em `artifacts/`. A compilação é verificada pelo TypeScript.

O teste de tela cheia simula, por padrão, os eventos de janela para funcionar em ambientes sem foco gráfico; a prévia, seu posicionamento e o serviço de teste são reais. Em uma sessão gráfica interativa, use `DK_FULLSCREEN_NATIVE=1 npm run test:browser:fullscreen` para verificar a transição nativa. Caso o envio automatizado de teclas não alcance a prévia, use `DK_FULLSCREEN_MANUAL_ESCAPE=1 DK_FULLSCREEN_WAIT_FOCUS=1 npm run test:browser:fullscreen` e siga as instruções de foco e Escape exibidas no terminal.

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

## Estrutura

- `electron/main.cjs`: janela, protocolo local, seleção nativa de pastas e mensagens autorizadas.
- `electron/preload.cjs`: API limitada exposta à interface isolada.
- `electron/terminals.cjs`: sessões PTY, fluxo de saída, redimensionamento e encerramento.
- `electron/core.cjs`: inspeção de pastas, comandos DK e persistência.
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

A tela inicial reúne separadamente projetos recentes locais e remotos. Fechar um projeto na barra lateral encerra seus terminais e conversas de agentes, preserva o histórico e pergunta sobre arquivos não salvos. Os serviços iniciados pela guia Serviços são gerenciados separadamente e continuam ativos até serem desligados. Projetos do grupo `design` e seus subgrupos no GitLab SEA abrem em modo de consulta, com a árvore, arquivos de texto UTF-8 e imagens PNG, JPEG, GIF ou WebP da branch padrão, sem criar uma cópia local. Para editar ou executar, use **Preparar cópia local**, escolha a pasta de destino e aguarde a criação da cópia pelo GitLab CLI; uma pasta existente não é sobrescrita. A leitura remota requer rede e uma conta GitLab com acesso ao projeto. A lista destaca projetos com cópia encontrada no volume SEA e, ao abrir um projeto remoto, oferece essas pastas locais cujo Git `origin` corresponde ao projeto. A busca ignora pastas ocultas, dependências e saídas de build; pode ser parcial em volumes grandes e oferece continuar a busca.

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
