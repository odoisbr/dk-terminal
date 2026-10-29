# Plano: estudo REA do browser integrado do DK Terminal

Data: 28/10/2026. Estado: proposto, aguardando confirmação dos itens da seção 8.

> Nota histórica: o estudo foi executado e está em `docs/rea-browser/`. A primeira
> pré-release do GitHub foi autorizada pelo responsável para `v0.1.0-alpha.1`;
> isso não resolve, por si só, a definição da fonte principal no GitLab SEA.

Objetivo: produzir, para o DK Terminal 0.1.0, um estudo no mesmo formato dos estudos
`Vision/` e `ChatGPT/` do rea-regenerate: como o browser integrado (`PreviewBrowser`)
é feito, o que o artefato empacotado realmente entrega, como se comporta em execução
e o que o separa do browser integrado do ChatGPT.app. O estudo serve de base para o
marco M3 (preview bridge) do plano de plugins.

Referências de leitura (citadas, nunca copiadas para este volume):
`/Volumes/oDois/Produtos/rea-regenerate/ChatGPT/` (capítulos 01 e 02) e
`/Volumes/oDois/Produtos/rea-regenerate/Vision/` (capítulos 03, 06, 07 e 09).

## 1. Diferença de natureza em relação ao estudo do ChatGPT

| | ChatGPT.app | DK Terminal |
|---|---|---|
| Fonte disponível | Não (bundle minificado, fork owl) | Sim (`electron/`, `src/`, testes) |
| Artefato empacotado | Assinado, ASAR com integridade, fuses fechados | `release/DK Terminal-darwin-arm64`, identidade de assinatura `Electron`, fuses no padrão |
| Observação em execução | Inviável (`--inspect` ignorado) | Viável (`EnableNodeCliInspectArguments` ligado) e já há testes Playwright em `tests/*-desktop.cjs` |
| Papel do REA | Única fonte de verdade | Confirmar que o **artefato** bate com a **fonte** e registrar postura de empacotamento |

Consequência de método: a regra do REA é usar ferramentas comuns de repositório quando
a fonte completa existe. Aqui o REA entra em três pontos onde a fonte não responde:
o que foi empacotado (ASAR, fuses, assinatura, módulos nativos), o comportamento
observado em execução e a comparação com o artefato de terceiro.

## 2. O que já foi levantado (28/10, leitura rápida)

- `electron/browser.cjs` (3,5 KB): classe `PreviewBrowser`, uma instância por janela,
  `WebContentsView` criada sob demanda com `session.fromPartition('dk-preview-' +
  sha256(root)[0:20])` (partição **não** persistente), `webPreferences` com
  `sandbox`, `contextIsolation`, `nodeIntegration:false`, `webviewTag:false`,
  `backgroundThrottling:true`; `localURL()` aceita só `http(s)` em
  `localhost`/`127.0.0.1`/`[::1]`, sem credenciais; `setWindowOpenHandler → deny`;
  `will-navigate` e `will-redirect` passam pelo mesmo filtro; permissões negadas por
  `setPermissionRequestHandler` e `setPermissionCheckHandler`; `will-download →
  cancel`; `close()` remove a view, fecha o `webContents`, limpa storage e cache.
- `electron/main.cjs`: IPC `browser:open|resize|close` por `handle()` com
  `authorize(event)`; evento `browser:changed`; janela principal com
  `will-attach-webview → preventDefault` e `setWindowOpenHandler → deny`.
- `electron/preload.cjs`: `openBrowser`, `resizeBrowser`, `closeBrowser`,
  `onBrowserChanged` expostos ao renderer.
- `src/main.ts`: `openBrowserView`, `startBrowserService`, `navigatePreview`,
  `previewBounds` (a view é posicionada sobre `#browser-canvas` via
  `ResizeObserver`); detecção de serviço de front-end por nome do script e por
  `role` em `dk-terminal.services.json`.
- `src/editor.ts#renderHtml`: visualização estática de HTML em `iframe srcdoc`
  sem scripts. É um segundo "browser", separado do `PreviewBrowser`.
- `extensions/browser/extension.json`: extensão declarativa `type: browser`,
  `permission: browser.preview`, validada em `electron/extensions.cjs`.
- Testes: `tests/graph-browser-usage.test.cjs` cobre só `localURL()`;
  `tests/desktop.cjs` toca a UI. Não há teste que abra a prévia contra um serviço
  real nem que prove os bloqueios (navegação externa, download, permissão).
- Fuses do artefato (REA, Evidence
  `ev_643cc335fe16269b1a030bb99245f029bac2a360b9b9171ac2b4469b2c8e7ff3`,
  `inspect-electron-fuses`, Electron Framework arm64, sentinela em
  `0x9A2F75C`): `RunAsNode` ligado, `EnableCookieEncryption` desligado,
  `EnableNodeOptionsEnvironmentVariable` ligado, `EnableNodeCliInspectArguments`
  ligado, `EnableEmbeddedAsarIntegrityValidation` desligado, `OnlyLoadAppFromAsar`
  desligado, `GrantFileProtocolExtraPrivileges` ligado. Ou seja: padrão do
  `@electron/packager`, sem endurecimento. `Info.plist` tem a chave
  `ElectronAsarIntegrity`, mas o fuse que a aplica está desligado.
- Drift: o `app.asar` do release foi gerado às 13:16 e `electron/main.cjs` e
  `src/main.ts` mudaram às 16:06. O artefato atual **não** representa a fonte atual.

## 3. Perguntas que o estudo precisa responder

1. **Ciclo de vida.** Quando a view nasce, quem a posiciona, o que acontece ao trocar
   de projeto, ao fechar a aba, ao fechar a janela e ao encerrar o serviço. Há
   vazamento de view ou de sessão em algum caminho (erro em `loadURL`, janela
   destruída, dois `open` concorrentes)?
2. **Fronteira de segurança.** O que a página carregada na prévia consegue fazer:
   abrir janela, navegar para fora, baixar arquivo, pedir permissão, acessar
   `file://`, usar `<webview>`, ler storage de outro projeto. Qual a diferença real
   entre a prévia (`WebContentsView`) e a visualização estática (`iframe srcdoc`)?
3. **Rede.** A prévia tem rede livre para qualquer origem a partir de uma página
   local? (O filtro só cobre navegação de topo; sub-recursos e `fetch` não passam
   por `will-navigate`.) Isso contradiz a restrição "preview sem rede" do marco M3.
4. **Artefato.** O ASAR empacotado contém exatamente o que a fonte diz? Que módulos
   nativos vão em `app.asar.unpacked` (62 MB) e com que assinatura? Qual a postura
   de fuses, assinatura e integridade, e o que isso implica para distribuição na SEA?
5. **Execução.** O comportamento observado em execução confirma o que a fonte
   promete: partição criada com o nome esperado, permissões negadas, download
   cancelado, navegação externa bloqueada, limpeza de storage ao fechar?
6. **Comparação com o ChatGPT.** Camada a camada (view/aba, sessão, política de
   rede, preload/overlay, controle por agente, transporte, economia de recursos), o
   que o DK Terminal tem, o que não tem e o que vale importar como ideia para M3.
7. **Lições para o rea-regenerate.** Que padrões do DK Terminal são reutilizáveis
   como referência de "browser mínimo seguro em Electron padrão".

## 4. Etapas

### Etapa 0 — Preparação (30 min)

- Confirmar os itens da seção 8.
- Reconstruir o artefato com `npm run package` a partir da fonte atual, para que
  REA e fonte descrevam a mesma coisa. Registrar SHA-256 do `app.asar` novo e do
  antigo (o antigo vira evidência do drift, não é apagado).
- Conferir `git config user.email` (SEA) antes de qualquer commit.
- Scratchpad para saídas grandes; nada de log na raiz do volume.

### Etapa 1 — Leitura da fonte, sem REA (2 h)

Arquivos, nesta ordem: `electron/browser.cjs`, `electron/main.cjs` (`authorize`,
`handle`, criação da janela, handlers `browser:*`), `electron/preload.cjs`,
`src/main.ts` (bloco da prévia e `selectMainView`), `src/editor.ts#renderHtml`,
`electron/services.cjs` (descoberta de URL do serviço), `electron/extensions.cjs`,
`src/api.d.ts`, `index.html` (CSP), testes citados na seção 2.

Saída: capítulo 01 com diagrama de sequência (renderer → IPC → main → view) e
tabela de bloqueios com a linha de código que sustenta cada um. Tudo marcado como
**observado na fonte**.

### Etapa 2 — REA estático no artefato (1 h)

```bash
# no release recém-gerado
npx -y rea-agents@6.5.0 inspect-electron-fuses "DK Terminal.app" --json
npx -y rea-agents@6.5.0 analyze-javascript-application \
  "DK Terminal.app/Contents/Resources/app.asar" --json
```

O ASAR tem 10 MB e o Electron é padrão (framework com o nome original), então
não deve precisar de `--source-path` nem de `record-and-continue`. Se
`node-pty` em `unpacked` causar `artifact_integrity_mismatch`, repetir com
`--integrity-policy record-and-continue` e registrar a contradição. Verificar se
o REA resolve `BrowserWindow`/`WebContentsView`/`webPreferences` aqui (no ChatGPT
não resolveu por causa do alias do bundler); isso vale como calibração da
ferramenta. Complementar com `codesign -dv --entitlements`, `otool -L` e listagem
de `app.asar.unpacked`.

Saída: seção do capítulo 03 com Evidence IDs, estatísticas, cobertura e
limitações; seção do capítulo 01 sobre postura de empacotamento.

### Etapa 3 — Observação em execução (2 h)

Possível porque os fuses permitem `--inspect` e o app é da casa. Duas vias, usar
a que o REA instalado suportar primeiro:

- `rea list-electron-targets` / `capture-electron-scenario` com o app lançado com
  `--inspect`, cenário declarado: abrir projeto de teste, subir
  `python3 -m http.server 8000 --bind 127.0.0.1` como serviço, abrir a prévia,
  tentar `window.open`, link para `https://example.com`, download, `fetch` para
  origem externa, pedido de permissão (`navigator.geolocation`), fechar a prévia.
- Fallback: teste Playwright novo em `tests/browser-desktop.cjs`, no padrão dos
  testes existentes, com página de teste em `tests/fixtures/preview/` contendo
  esses mesmos gatilhos. Esse teste fica no repositório, independente do estudo.

Observar e registrar: nome da partição criada, respostas aos gatilhos, estado da
sessão após `close()` (storage e cache limpos), contagem de `webContents` vivos
antes e depois. Nada aqui é inferido: ou foi observado, ou fica como (TESTAR).

Saída: capítulo 02 "Observação em execução", no modelo do capítulo 09 do Vision.

### Etapa 4 — Comparação com o browser integrado do ChatGPT (1 h)

Tabela por camada, citando o estudo em `rea-regenerate/ChatGPT/01` por seção, sem
copiar trechos:

| Camada | ChatGPT (IAB) | DK Terminal (PreviewBrowser) | Lacuna relevante para M3? |
|---|---|---|---|
| Aba/view | `<webview>` por aba validado em `will-attach-webview` | uma `WebContentsView` por janela | várias prévias? |
| Sessão | `persist:` por conversa+aba, opções do fork owl | partição em memória por projeto | persistência de login do protótipo? |
| Política de rede | restrição por request, flags de background, UA escopado | só navegação de topo filtrada | rede livre em sub-recursos |
| Preload/overlay | preload de anotações, binding CDP | nenhum preload na prévia | bridge `dk-edit-*` do M3 |
| Controle por agente | CDP com allowlist, lease, captura própria | nenhum | fora de escopo por ora |
| Transporte | pipe nativo com autorização por assinatura | IPC `handle/authorize` | n/a |
| Economia | throttling, orçamento de abas, snapshots | throttling | n/a |

Saída: capítulo 02 ou 04 (decidir na escrita), com lista curta "o que importar
como ideia" e "o que não faz sentido aqui".

### Etapa 5 — Escrita e fechamento (1,5 h)

Pasta `docs/rea-browser/` no próprio dk-terminal (ver seção 8 sobre o local):

| Arquivo | Conteúdo |
|---|---|
| `README.md` | O que é, índice, resumo em dez linhas |
| `01-browser-preview.md` | Fonte, ciclo de vida, bloqueios, artefato e postura de empacotamento |
| `02-observacao-runtime.md` | Cenário executado, o que foi observado, o que falhou |
| `03-comparacao-chatgpt.md` | Tabela por camada e recomendações para M3 |
| `04-evidencias-rea.md` | Comandos, Evidence IDs, SHA-256, limitações, observado × inferido × desconhecido |

Registrar decisões de UX que surgirem em `docs/ux-decisoes.md` e fechar com o
Relatório JFM+D se alguma tela for alterada (o teste Playwright não altera tela).

## 5. Critérios de aceite do estudo

- Toda afirmação sobre comportamento tem uma de três marcas: observado na fonte
  (arquivo:linha), observado em execução (cenário e evidência), ou inferido.
- Os Evidence IDs do REA e os SHA-256 do artefato analisado constam no capítulo 04.
- O artefato analisado foi gerado da mesma revisão da fonte lida (sem drift).
- A pergunta 3 (rede em sub-recursos) tem resposta observada, não inferida.
- O capítulo de comparação cita o estudo do ChatGPT por seção e não copia texto.

## 6. Riscos e limites

- `analyze-javascript-application` pode não resolver as APIs Electron se o Vite
  reescrever imports no renderer; o main (`.cjs`, sem bundler) deve resolver bem.
- `capture-electron-scenario` pode não estar disponível na versão 6.5.0 do CLI ou
  exigir o MCP (registro em `config_drift`); por isso o fallback Playwright.
- O release em `release/` tem sete variantes de build antigas; o estudo usa só a
  recém-gerada e declara as demais como fora de escopo.
- Esforço total estimado: cerca de 8 h, em duas sessões.

## 7. O que já dá para afirmar sem o estudo (para não repetir trabalho)

- A prévia é um `WebContentsView` sobre a janela, não um `<webview>` nem iframe.
- Só navegação de topo para localhost é permitida; sub-recursos não são filtrados.
- Não há preload nem canal página → host na prévia; o M3 terá de criar um.
- O empacotamento atual não endurece fuses nem valida integridade do ASAR.

## 8. Pendências de confirmação

1. **Local do estudo.** Proposta: `docs/rea-browser/` dentro do dk-terminal (volume
   SEA, autoria SEA), citando o rea-regenerate por caminho. Alternativa: pasta
   `DKTerminal/` no rea-regenerate (volume oDois), o que levaria dados de um
   projeto SEA para o volume oDois e contraria a regra de não cruzar contextos.
2. **Remote do repositório.** O dk-terminal está em `/Volumes/SEA/Ferramentas`
   com autoria SEA e bundle id `br.com.sea.dk.terminal`, mas o `origin` aponta
   para `github.com/odoisbr/dk-terminal.git`. O estudo não depende disso, mas
   qualquer commit deveria esperar essa definição.
3. **Regerar o release** antes do REA estático (etapa 0). Sobrescreve
   `release/DK Terminal-darwin-arm64`.
4. **Teste Playwright novo** (`tests/browser-desktop.cjs`) entra no repositório
   como entrega paralela ao estudo, ou fica só como instrumento do estudo?
