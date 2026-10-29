# 04 — Evidências, artefatos e limites

## Identidade dos artefatos

O pacote examinado neste estudo foi produzido na árvore isolada a partir de `9e62cbc` e das alterações locais do browser, sem sobrescrever o release da pasta principal. Ele antecede a identificação da release `v0.1.0-alpha.1`; não representa o hash do pacote gerado posteriormente para essa versão. O ASAR anterior da árvore isolada foi preservado em `/private/tmp/dk-browser-baseline-9e62cbc.asar`.

| Artefato | SHA-256 |
|---|---|
| ASAR anterior da árvore isolada | `1a247be3589b1f74767632490805bcd6b28ca7fb17817854e3a8a965eefc3919` |
| ASAR já existente na pasta principal | `c7ca8087e7705d1b7200b4c7f1ea65cf211c53c1d95ad0d7f32bc2d7c5adf003` |
| ASAR examinado no estudo | `7f98b84ff672327a89a1e4b9f82b05970ac0d3a1a9244c6697575f84380f3e0b` |
| `electron/browser.cjs` final, fonte e ASAR | `e3e8ca542748a554b2941107eb1e42e548e7de7ec1306975c858b8719ca7afc1` |
| `electron/main.cjs`, fonte e ASAR | `304f8d46bd3accf8eb65bbc3d7e3ef64e42663738bfabd3f7574525cc8cb54b9` |
| `electron/preload.cjs`, fonte e ASAR | `4d22990dfea6433d364174095b73bcde4e6c2f0bdaf6e67e8e826df3a14509c2` |
| `dist/index.html`, build e ASAR | `11dc7d97846d5f6bade7e06bfffc7fcb9c067911692975a1cd3980c27961daf3` |
| Bundle principal `dist/assets/index-DuTTg0xp.js`, build e ASAR | `fa4cd36ce5da3e63d5b591f364ea50cc8549f76afee8f0cb8245dc2579d267e8` |

Foram comparados os bytes desses arquivos específicos. Isso não prova igualdade de todos os módulos e recursos do pacote. O `package.json` empacotado é transformado pelo empacotador: `private`, `scripts` e `devDependencies` não constam nele; sua diferença binária é esperada e não foi escondida como igualdade.

## REA 6.5.0

| Operação | Evidence ID | Observação |
|---|---|---|
| `analyze_javascript_application` no ASAR final | `ev_3e8ba45cd5b807c4553a5d32eccccf306c2ebc619ac53614b1201154bcaabe7c` | Seleção de `electron/browser.cjs`, `electron/main.cjs`, `electron/preload.cjs` e `package.json`; 1.596 nós e 1.724 arestas. |
| `inspect_electron_fuses` no app final | `ev_1483cd0eec3e43cba9eedfb3c71eb33bdebdf4a070a41285e067e78385e7b952` | Framework arm64, SHA-256 `f306e137162780be6def961f372ffa7e9bcd3aea1fa957e244119ae686858323`. |

A evidência completa da análise está em [`evidencias/rea-analise-final.json.gz`](evidencias/rea-analise-final.json.gz); os fuses estão em [`evidencias/rea-fuses-final.json`](evidencias/rea-fuses-final.json). A análise estática é **parcial**: 450 arquivos inventariados ficaram fora da seleção, canais dinâmicos não foram resolvidos e o grafo não prova execução ou aplicação completa de políticas. A tentativa inicial em ambiente restrito produziu uma observação parcial porque o auxiliar do macOS não compilou; a análise final foi concluída com acesso apropriado, sem alterar a configuração do REA ou dos providers.

O leitor de fuses observou `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` e `GrantFileProtocolExtraPrivileges` ativos; `EnableCookieEncryption`, `EnableEmbeddedAsarIntegrityValidation` e `OnlyLoadAppFromAsar` estavam inativos. Esses fatos descrevem o artefato analisado, não provam por si só um ataque ou a política em execução.

`codesign -dv` identificou assinatura ad hoc, sem Team ID, para o app e os módulos `node-pty` arm64 examinados. O diretório `app.asar.unpacked` ocupa aproximadamente 62 MiB e contém `node-pty`, inclusive prebuilds para outras plataformas. Não foi avaliada a necessidade de todos eles nem alterada a distribuição. A definição de assinatura de distribuição e endurecimento de fuses é uma decisão separada.

## Execução e reprodução

O [registro do teste no aplicativo empacotado](evidencias/teste-empacotado.txt) contém as verificações descritas no capítulo 02. A suíte `npm run test:all` passou com 111 testes Node e os testes de desktop; o teste novo de browser foi incorporado à suíte.

Comandos principais, na árvore isolada:

```sh
npm run package
rea inspect-electron-fuses 'release/DK Terminal-darwin-arm64/DK Terminal.app' --format json
rea analyze-javascript-application 'release/DK Terminal-darwin-arm64/DK Terminal.app/Contents/Resources/app.asar' \
  --source-path electron/browser.cjs --source-path electron/main.cjs \
  --source-path electron/preload.cjs --source-path package.json \
  --max-heap-mb 512 --analysis-timeout-ms 45000 --format json
node tests/browser-desktop.cjs
```

O teste de desktop do pacote usa `DK_TERMINAL_EXECUTABLE` com o executável dentro do `.app`; o teste de rede usa somente loopback. Outras versões, Windows e Linux, todos os serviços reais e todos os tipos de permissão permanecem fora da cobertura executada.
