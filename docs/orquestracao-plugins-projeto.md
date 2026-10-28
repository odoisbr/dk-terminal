# Orquestração: plugins executáveis por projeto no DK Terminal

Data: 28/10/2026. Estado: G0 decidido; M0 parada em 28/10 às 16h (ver seção 9).

Atualização do planejamento: a base é `v0.1.0-alpha.1`. A ordem aprovada é
M0 → M1 → M2 → M3 → M4. Os contratos são insumos para preparação, não uma
autorização automática para executar os marcos. A conclusão de cada marco precisa
de evidência verificável; a condição baseada apenas em resultado declarado pelo
executor ainda não é um gate determinístico do estado anterior.

Este documento define quem faz o quê, com qual modelo e esforço, para executar o
[plano de plugins por projeto](plano-plugins-projeto.md). A orquestração usa o
formato nativo do DK (`dk coordenar`): um contrato por marco, em
`docs/coordenacoes/M*.json`, validado e despachado pela CLI do kit, com packets
executados no Claude Code pela ferramenta `Agent`. O DK Terminal renderiza o
estado em `.dk/coordenacoes/` na guia Orquestração, portanto o próprio aplicativo
acompanha a sua construção.

## 1. Capacidades verificadas nesta máquina

| Capacidade | Estado em 28/10/2026 | Consequência |
|---|---|---|
| Claude Code com `Agent` (modelos `haiku`, `sonnet`, `opus`, `fable`; esforço `low` a `max`) | disponível | Host dos packets; `controle_modelo` e `controle_esforco` verdadeiros |
| Observação do modelo efetivo (recibo nativo) | indisponível | `observacao_modelo` e `observacao_esforco` falsos; o resultado registra só o pedido |
| CLI do kit `dk coordenar` | plugin 1.7.0-rc.2 consultado; há outra CLI chamada `dk` no PATH | Identificar a CLI do kit efetivamente conectada pelo caminho completo antes de usar |
| `claude -p --input-format stream-json --output-format stream-json` | disponível na CLI instalada | Base do runner da fase 2 |
| `codex exec --json` | disponível | Segundo backend do runner; segunda opinião manual opcional |
| OpenRouter (MCP `openrouter`) | não configurado nesta sessão | Orquestração externa indisponível; nenhum modelo pago ou gratuito externo entra nos contratos |
| Qwen local (`qwen_simple_task`) | servidor fora do ar | Sem delegação local de resumos |
| Comando `dk etapas --json` previsto na fase 1 | não apareceu nas CLIs do kit examinadas | Conferir o kit conectado; na ausência de contrato comprovado, calcular etapas no aplicativo (`electron/stages.cjs`); ver 6.2 |

## 2. Perfis de modelo e esforço

Perfis são pedidos ao host, não observações. Os nomes de modelo são os valores
aceitos pela ferramenta `Agent`; o adaptador os passa sem tradução.

| Perfil | Modelo | Esforço | Uso |
|---|---|---|---|
| `leitor` | `haiku` | `low` | Inventário de código, âncoras de linha, hashes, leitura de catálogos |
| `analista` | `opus` | `high` | Desenho de esquema, protocolo e API antes de codar; registro de decisões |
| `implementador` | `opus` | `high` | Implementação padrão com teste unitário no mesmo packet |
| `implementador-critico` | `fable` | `xhigh` | Extração de `src/main.ts`, canais IPC autorizados, runner com ciclo de vida, protocolo do preview |
| `revisor` | `opus` | `medium` | Revisão independente em contexto novo: diff, testes, documentação |
| `revisor-seguranca` | `fable` | `high` | Revisão de CSP, sandbox, `authorize`, contenção de caminhos, permissões declaradas |
| `testador` | `sonnet` | `medium` | Testes de desktop, scripts do `package.json`, README |

Política por categoria (vale quando a tarefa não declara perfil): leitura →
`leitor`; análise → `analista`; implementação → `implementador`; revisão →
`revisor`. Tarefas críticas declaram `implementador-critico` ou
`revisor-seguranca` explicitamente.

Segunda opinião externa: enquanto o OpenRouter não estiver configurado, a única
revisão de outra família é manual, via `codex exec` na mesma pasta, fora do
contrato. Não é votação: discordância exige evidência ou teste.

## 3. Gate G0: decisões que bloqueiam a primeira escrita

As três decisões da seção 7 do plano foram registradas em 28/10/2026. A tarefa
`g0-decisoes` continua no contrato M0 como verificação: toda tarefa de escrita
depende dela com a condição `decisoes.pendentes == 0`. O runtime confere o valor
declarado pelo executor, mas isso não prova que as decisões estejam realmente
resolvidas; é necessária verificação independente antes dos packets de escrita.

1. **Contexto do repositório: compartilhado como o kit.** Fonte na SEA, autoria
   `angelo.pimentel@seatecnologia.com.br`, fork na oDois. O `[user]` local do
   `.git/config` foi removido para a autoria vir do `includeIf` da SEA; o
   `origin` ainda aponta para o futuro fork e será trocado quando o projeto
   existir no GitLab `design/`. Revisor de UX da fase 1:
   `seakit:design-ux-reviewer` e `seakit:design-ui-reviewer`.
2. **Lógica de plugin: JSON mais processos filhos.** É o que os contratos
   assumem.
3. **Ordem: M2 antes de M3.** Os contratos são independentes; M2 inicia assim
   que M1 fechar.

## 4. Estrutura de cada coordenação

Cada marco é um contrato `modo: execucao` com a mesma espinha:

| Etapa | Categoria | Perfil | O que entrega |
|---|---|---|---|
| inventário | leitura | `leitor` | Âncoras reais (arquivo, função, linha) e lacunas; sem opinião |
| desenho | análise | `analista` | Esquemas JSON, nomes de canais, limites e decisões, em `dados` |
| implementação (3 a 5 packets) | implementação | `implementador` / `implementador-critico` | Código e testes quando seus alvos forem declarados; um dono por arquivo |
| testes de desktop | implementação | `testador` | Teste `tests/*-desktop.cjs` e script no `package.json` |
| documentação | implementação | `testador` | Seção do README com limites e permissões |
| revisão | revisão | `revisor` ou `revisor-seguranca` | `bloqueantes == 0` com achados por arquivo e linha |
| verificação | revisão | `testador` | `npm run test:all` e o teste de desktop do marco, saída registrada |

Quando o teste compartilhado pertence ao packet de testes, os implementadores não
o editam fora do escopo. Esse packet deve completar os testes antes da revisão.
A revisão consulta `git status --short` e `git diff` e lê explicitamente cada
arquivo novo autorizado, porque arquivos não rastreados não aparecem no diff.
As revisões são independentes e não dependem de skills `code-review` ou
`security-review` cuja disponibilidade no host não tenha sido comprovada.
A verificação posterior executa `npm run test:all` e o teste específico do marco
em uma cópia isolada fora da árvore inspecionada. Antes de testar, compara os
inventários e hashes dos arquivos relevantes da árvore candidata e da cópia,
incluindo arquivos novos e alterações ainda não commitadas; ausência ou diferença
reprova a cópia. Registrar os inventários, hashes e saídas. O procedimento deve
ter teste negativo com arquivo ausente ou alterado. Assim, build e artefatos não
contaminam o retrato de escopo nem uma cópia incompleta substitui o código revisado.

O runtime examinado relê evidências por caminho local e hash, com limite de
4 MiB por arquivo, e exclui `.dk/coordenacoes` do retrato. Antes da primeira
execução, testar em fixture descartável se evidências compactas e sem dados
sensíveis em `.dk/coordenacoes/evidencias/` podem ser anexadas ao resultado sem
violar o escopo. Não assumir que um log em `/tmp` ou um `passou` declarado por
si só será aceito; se a estratégia não funcionar, definir outra verificável.

Regras do contrato que importam na execução:

- `contexto` e `fontes` incluem o plano, esta orquestração, o panorama integrado
  e o detalhe do marco. O runtime confere os hashes a cada dispatch; arquivo que
  muda durante o marco não pode ser fonte. O executor lê o código com as próprias
  ferramentas.
- Um arquivo tem um único dono por coordenação. `src/main.ts` pertence sempre
  ao packet `*-renderer`; `electron/main.cjs`, `electron/preload.cjs` e
  `src/api.d.ts` ao packet `*-canais`.
- Tarefa de escrita abre um changeset `core.tarefa` com os alvos declarados;
  mudança fora deles reprova o gate. Arquivo novo entra como `ausente: true`.
  O retrato do changeset não respeita `.gitignore` (inclui `dist/` e
  `node_modules/`), então packet de escrita roda só `npm test` unitário;
  `npm run build` e testes de desktop ficam nos packets de verificação.
- Duas tentativas por tarefa. Falha bloqueia dependentes; nova tentativa só
  por decisão explícita dentro do orçamento.
- Resultado de packet é JSON pequeno. Dependentes recebem os `dados` das
  dependências dentro do packet, que precisa caber em `limites.contexto_bytes`.
- Revisão e verificação não alteram o código do projeto; o registro de evidências
  segue o procedimento validado acima. `resultado_json_valor` confere o resultado
  declarado; evidências de arquivo com hash ajudam a verificar a origem, mas não
  substituem examinar os testes e o comportamento real.

## 5. Marcos e dependências

```
M0 host de plugins v2 ──► M1 catálogos e etapas ──► M2 runner de agente
                         ──► M3 preview e bridge ──► M4 auditoria
```

| Contrato | Entrega verificável (plano, seção 5) | Packets | Reserva de chamadas |
|---|---|---|---|
| `M0-host-plugins.json` | Plugin v2 em `.dk/plugins` listado e executado por ação explícita, com testes | 12 | 707 |
| `M1-catalogos-etapas.json` | Barra de etapas e catálogo de skills do kit visíveis | 11 | 707 |
| `M2-runner-agente.json` | Run do Claude com prompt composto, streaming e aprovação explícita | 11 | 735 |
| `M3-preview-bridge.json` | Tela HTML editada no preview, gravada, com undo | 12 | 847 |
| `M4-auditoria.json` | Auditoria de uma tela contra requisitos com achados renderizados | 12 | 791 |

A reserva de chamadas cobre uma tentativa por packet mais 40% para segundas
tentativas; é orçamento de transporte do runtime, não medição de tokens.

Os commits ficam fora dos contratos: ao final de cada marco, com G0.1 decidido,
a etapa `dk:dk-git` abre a branch e o merge request com os arquivos declarados.
Antes de despachar M3, implementar e testar a validação do estado real de M2;
antes de M4, validar os estados e evidências reais de M2 e M3. Atualizar a
referência textual do contrato não comprova a conclusão de nenhum marco.

## 6. Riscos técnicos que os packets de desenho precisam resolver

1. **Aprovações em `claude -p`.** O modo não interativo não exibe prompt de
   permissão. Sem `bypassPermissions` (compromisso do README), as opções são
   `--permission-prompt-tool` apontando para um servidor MCP stdio do próprio
   DK. A lista `--allowedTools` não substitui a aprovação de cada operação;
   só pode participar do desenho se houver consentimento equivalente comprovado.
   Sem mecanismo verificável, manter a CLI oficial interativa e informar que o
   runner não está disponível. `m2-revisao-seguranca` testa recusas e ausência de consentimento.
2. **`dk etapas --json` não foi encontrado nas CLIs examinadas.** Confirmar a
   capacidade no kit efetivamente conectado. Sem API comprovada,
   `electron/stages.cjs` calcula os critérios a partir de `projeto.yml` e do
   registro; futura integração exige validar contrato e equivalência.
3. **Playwright é devDependency.** A verificação visual não está incluída no
   pacote atual. Examinar uma ferramenta compatível antes do uso; não instalar
   nem executar código do projeto automaticamente. O aplicativo informa
   indisponibilidade se a ferramenta ou o isolamento não puderem ser comprovados.
4. **`src/main.ts` monolítico.** `m0-renderer` extrai o registro de views antes
   de qualquer view nova; os marcos seguintes só registram views.
5. **Volume externo lento.** Leituras síncronas novas ficam proibidas nos
   packets; `catalogs.cjs` e `stages.cjs` usam limites de tamanho e cache.

## 7. Como executar

```sh
DK=/caminho/verificado/do/kit/cli/dk
"$DK" --help
cd /caminho/da/branch/de-trabalho
git branch --show-current
git status --short

# Hashes do contrato precisam bater com o disco: atualize antes de iniciar.
node scripts/coordenacao-hashes.mjs docs/coordenacoes/M0-host-plugins.json --check

$DK coordenar validar  --projeto . --contrato docs/coordenacoes/M0-host-plugins.json
$DK coordenar iniciar  --projeto . --contrato docs/coordenacoes/M0-host-plugins.json \
    --host-context docs/coordenacoes/host-claude-code.json
$DK coordenar despachar --projeto . --id COORD-PLUGINS-M0 --tarefa g0-decisoes
# O coordenador (agente dk:dk-coordenador) executa o packet com Agent,
# usando model e effort do perfil, e devolve o JSON de resultado:
$DK coordenar receber --projeto . --id COORD-PLUGINS-M0 --resultado <resultado.json>
$DK coordenar status  --projeto . --id COORD-PLUGINS-M0
```

Confirme a raiz e a branch antes de qualquer escrita. Sem `--apply`, os comandos
são simulação: úteis para conferir o DAG antes de gastar. `--apply` só deve ser
usado quando a execução do marco tiver sido solicitada e a árvore estiver pronta. O
estado persiste em `.dk/coordenacoes/COORD-PLUGINS-M0.json` e aparece na guia
Orquestração do DK Terminal. Ao terminar um marco, rode o script de hashes no
contrato seguinte: os alvos mudaram. `node scripts/coordenacao-hashes.mjs
<contrato> --check` só confere, sem gravar; o teste do script está em
`tests/coordenacao-hashes.test.cjs`.

Simulação feita em 28/10/2026 com o contrato M0: `iniciar` aceitou o contrato e
deixou só `g0-decisoes` pronta; `despachar` emitiu um packet de 22 KiB com o
perfil `analista` (`opus`, `high`) e adaptador `delegacao_nativa`. O estado
gerado pelo runtime pesa alguns megabytes porque guarda o retrato do projeto, e
`receber` leva minutos neste volume externo: conte com isso ao planejar a
sessão, ou execute a partir de uma cópia local do repositório.

## 8. O que esta orquestração não faz

- Não decide G0; não comita; não publica pacote.
- Não chama modelos externos nem gasta crédito fora da assinatura do Claude Code.
- Não prova o modelo efetivo de cada packet: sem recibo nativo, o campo fica
  `nao_verificada`.
- Não substitui os testes: `concluido` sem `npm test` registrado é reprovado na
  verificação do marco.

## 9. Retomada de M0

Execução real de 28/10/2026: `g0-decisoes` e `m0-inventario` concluídas;
`m0-desenho-host` executada com sucesso pelo agente, mas reprovada no gate de
escopo porque outra sessão editava a mesma árvore (menu da árvore em
`electron/tree-actions.cjs`, `src/tree-menu.ts`, `main.cjs`, `main.ts`,
`preload.cjs`, `api.d.ts`) e gerou `release/` (953 caminhos fora do escopo).
A coordenação `COORD-PLUGINS-M0` foi parada com esse motivo.

Os resultados válidos estão em `docs/coordenacoes/resultados/`: decisões,
inventário e o desenho completo do host v2 (esquema do manifesto, raízes,
recarga, canais, registro de views, UI e plano de testes). Para retomar:

1. Esperar a outra sessão commitar; a árvore precisa ficar quieta durante cada
   packet, porque o retrato do changeset compara todos os caminhos, inclusive
   `release/` e `dist/`.
2. Rodar `node docs/coordenacoes/gerar.mjs` (os alvos mudaram) e iniciar uma
   nova coordenação; uma parada não é retomável. Reaproveitar os três
   resultados: `g0-decisoes` e `m0-inventario` podem ser reenviados após
   conferir as linhas; `m0-desenho-host` vale como está, atualizando só as
   linhas de migração de `src/main.ts`.
3. Risco de integração: o menu da árvore da outra sessão e `m0-renderer` tocam
   `src/main.ts` e `main.cjs`; executar M0 depois do commit do menu, nunca em
   paralelo.
4. Melhoria a propor no kit: o retrato deveria respeitar `.gitignore`.
