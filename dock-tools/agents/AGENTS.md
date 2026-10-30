# SEA Dock: recursos para agentes de IA

Você está numa sessão do SEA Dock, app desktop com projeto, terminais, navegador interno e painel de serviços. Rode os comandos abaixo pelo terminal da sessão (sua ferramenta de shell), em vez de alternativas externas.

## Mostrar algo para a pessoa: `dock-preview`

Regra: quando a pessoa pedir para abrir, mostrar, ver, apresentar ou visualizar um protótipo, tela, página, mockup, HTML, imagem, PDF, documento Markdown ou o resultado visual do que você fez, rode `dock-preview`. Não use `open`, `xdg-open`, navegador externo nem responda só com o caminho do arquivo.

    dock-preview <alvo> [--titulo "Texto"]

- `<alvo>`: endereço local (`http://localhost:5173`, `127.0.0.1:3000`) ou arquivo ou pasta dentro do projeto (`prototipo/index.html`, `telas/`, `tela.png`, `docs/visao.md`, `relatorio.pdf`). Caminho relativo parte da pasta atual. Uma pasta abre o seu `index.html` ou uma galeria dos arquivos apresentáveis.
- `--titulo "Texto"`: nome mostrado na barra do navegador (uma linha, até 120 caracteres).
- Saída: uma linha. `OK: ...` quando abriu; `ERRO: ...` dizendo o que fazer. Siga a orientação antes de repetir.
- Código de saída: 0 abriu; 1 recusado ou falhou (fora do projeto, não encontrado, nada respondendo no endereço, app fechado); 2 uso incorreto (sem alvo, opção desconhecida, endereço externo); 3 fora de uma sessão do SEA Dock.
- Projeto com servidor (Vite, Next, React etc.): inicie o servidor em segundo plano (ex.: `npm run dev`), espere a porta aparecer na saída e passe o endereço. HTML estático: passe o arquivo, sem servidor.
- Se o comando não existir ou sair com 3, a sessão não é do SEA Dock: informe o caminho ou o endereço à pessoa.

Pedidos que disparam:
- "abre o protótipo", "mostra a tela de login" → `dock-preview prototipo/index.html --titulo "Protótipo"`
- "quero ver como ficou" (depois de editar HTML/CSS) → `dock-preview <arquivo alterado>`
- "apresenta o documento de visão" → `dock-preview docs/visao.md`
- "mostra as telas" → `dock-preview telas/`
- "roda o projeto e me mostra" → `npm run dev` em segundo plano, depois `dock-preview http://localhost:<porta>`

## Serviços do projeto

Um servidor iniciado num terminal do SEA Dock, por você ou pela pessoa, aparece sozinho no painel Serviços → Detectados nas sessões, com porta e botões para abrir na prévia ou encerrar. Não há nada a registrar. A porta está na saída do servidor. Encerre os servidores que você iniciou quando não forem mais necessários.

- "em que porta está rodando?" → leia a saída do servidor que você iniciou.
- "para o servidor" → encerre o processo que você iniciou.

## Sea Dashboard: `sea`

O `sea` (CLI do Sea Dashboard) está disponível nas sessões. Para tarefas, projetos, horas e demais dados do Dashboard, rode `sea help` e siga a ajuda. O login é da pessoa (`sea auth login`); nunca peça nem mostre tokens.

- "lista minhas tarefas no Dashboard", "lança minhas horas" → `sea help` para achar o comando.

## Plugin DK

Em projeto DK (com `projeto.yml` ou `.dk/`), se as skills `dk:*` estiverem disponíveis (Claude Code com o plugin DK), use-as: elas seguem o fluxo do Design Kit.

## Etapas do DK

A barra de etapas do DK (levantar, entender, entregar, prototipar) tem critérios que vêm dos registros do projeto. Para avançar uma etapa, trabalhe nos registros e documentos indicados pelo critério pendente; não declare etapa concluída. Registre só o que tem origem nos documentos do projeto, com a fonte real; se faltar dado, pergunte à pessoa em vez de preencher.

## Catálogo de skills e design systems

O catálogo reúne skills e design systems. Com o plugin DK ativo, as skills do kit são invocadas como `/dk:<nome-da-skill>` no Claude Code (ex.: `/dk:dk-levantar`).

## Tarefas com Claude

No runner de tarefas com Claude, operações que exigem permissão aparecem como cartão de aprovação no app. Aguarde a decisão da pessoa; se for recusada, não repita nem busque outro caminho. Não tente contornar aprovação nem pedir bypass.

## Plugins por projeto

Plugins por projeto em `.dk/plugins` definem ações locais. Suas ações só rodam após clique e confirmação da pessoa; não crie nem altere plugins sem pedido explícito.

## Este guia

`dock-agents` imprime este guia; a variável `SEA_DOCK_AGENTS_MD` traz o caminho do arquivo.

- "o que o SEA Dock permite?", "quais comandos do terminal você tem?" → `dock-agents`

## Ambiente da sessão

- `DK_TERMINAL_PROJECT`: pasta raiz do projeto desta sessão.
- `TERM_PROGRAM=DK_Terminal`: indica uma sessão do SEA Dock.
- `DK_TERMINAL_PREVIEW_PORT` e `DK_TERMINAL_PREVIEW_TOKEN`: credencial interna do `dock-preview`. Nunca imprima, registre, copie para arquivos nem envie esses valores; não rode `env` ou `printenv` sem filtro.

## Limites

- O navegador interno só abre endereços locais (localhost, 127.0.0.1, ::1); endereço externo é recusado.
- Só arquivos dentro do projeto desta sessão; arquivos ocultos, `node_modules` e links que saem do projeto são recusados. Gere o arquivo dentro do projeto e repita.
- Nunca imprima tokens, senhas ou variáveis com TOKEN, SECRET, KEY ou PASSWORD no nome.
