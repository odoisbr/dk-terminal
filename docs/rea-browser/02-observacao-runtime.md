# 02 — Observação em execução

## Cenário

`tests/browser-desktop.cjs` abre uma instância isolada do DK e dois projetos temporários. Um servidor HTTP escuta apenas em `127.0.0.1`; o nome de teste `outside.test` é resolvido pelo Chromium para esse mesmo servidor. Assim, o teste verifica uma origem diferente sem enviar dados para um serviço externo. O teste usa um perfil e arquivos descartáveis.

## Resultados observados

| Verificação | Resultado |
|---|---|
| Preferências da view | `sandbox` e `contextIsolation` ativos, `nodeIntegration` inativo; `window.require` e `window.dk` indisponíveis. |
| Partição | A sessão da primeira view corresponde à partição em memória `dk-preview-` mais o hash esperado do projeto. |
| Permissão | A solicitação de geolocalização foi negada. |
| Nova janela | `window.open` retornou `null`; nenhuma janela adicional foi criada. |
| Navegação | URL externa, `file:` e redirecionamento de uma URL local para outra origem foram bloqueados. |
| Outra origem | `fetch` para `outside.test` recebeu a resposta do servidor de teste; a prévia atual permite essa conexão. |
| Download | O evento foi cancelado e o arquivo de teste não foi gravado. |
| Dados e cache | O `localStorage` não passou para outro projeto e estava vazio após fechar e reabrir. Um recurso HTTP com cache foi solicitado novamente ao servidor depois da reabertura. |
| Ciclo de vida | Após fechar, as views testadas não apareciam mais em `webContents.fromId`; aberturas repetidas não deixaram views ativas. |
| Concorrência | Trocar de projeto durante um carregamento e substituir uma navegação lenta preservaram apenas a view e a URL mais recentes. |

Os testes de `tests/browser-lifecycle.test.cjs` usam objetos simulados para adiar ou falhar deliberadamente a limpeza; mostram que a reabertura aguarda a limpeza e recusa uma partição se a limpeza continuar falhando. Isso complementa, mas não substitui, o teste com Electron real.

Executar na árvore de trabalho: `npm run build`, `node --test tests/browser-lifecycle.test.cjs` e `node tests/browser-desktop.cjs`. O teste de desktop também aceita `DK_TERMINAL_EXECUTABLE` apontando para o executável de um pacote local. A execução depende de um ambiente gráfico e de permissão para escutar em loopback.

Não foram verificados todos os tipos de permissão, protocolos e recursos, comportamento em Windows/Linux ou uma página real de terceiro. O acesso de sub-recursos à internet foi inferido da política e da conexão entre origens simuladas, sem efetuar acesso à internet no teste.
