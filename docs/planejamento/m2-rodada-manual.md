# Rodada Manual com CLI Oficial do Claude (M2)

Este documento descreve o roteiro operacional para a pessoa autorizada validar o runner de tarefas do marco M2. A rodada utiliza a CLI oficial do Claude em um projeto descartável.

A execução utiliza a assinatura contratada da pessoa usuária. Todos os prompts e interações são enviados diretamente aos servidores do provedor.

A finalidade deste procedimento é comprovar o protocolo de controle por stdio (`--permission-prompts host --permission-prompt-tool stdio`) com a CLI oficial instalada. Testes automatizados com CLIs simuladas comprovam apenas o adaptador interno, não a assinatura real ou o protocolo do provedor.

## Pré-requisitos

1. Computador com macOS.
2. CLI oficial do Claude instalada no PATH (`claude`), versão 2.1.312 ou superior.
3. Login ativo verificado na CLI do Claude (`claude auth status`).
4. Repositório SEA Dock compilado com `npm run build`.
5. Uma pasta vazia e descartável criada fora de projetos reais de trabalho.
6. Sessão em terminal interativo real do sistema operacional, fora de ambientes de agentes (variáveis como `ANTIGRAVITY_AGENT`, `CLAUDECODE` ou `CODEX_SANDBOX` bloqueiam o registro).

## Roteiro Passo a Passo (P0 a P9)

### P0. Verificação de ambiente e autorização

Ação:
No terminal do sistema, execute `claude --version` para conferir a versão instalada. Execute `claude auth status` para validar o login ativo. Crie uma pasta vazia descartável para os testes. Abra essa pasta no SEA Dock. Obtenha a autorização explícita da pessoa titular da assinatura antes de iniciar.

Resultado esperado:
Versão 2.1.312 ou superior confirmada. Login ativo validado. O SEA Dock abre a pasta descartável sem ler tokens ou arquivos de credenciais.

### P1. Inicialização do runner e resposta em streaming

Ação:
No SEA Dock, clique em "Tarefa com Claude". Digite o prompt: "Liste os arquivos desta pasta". Envie a mensagem.

Resultado esperado:
O processo inicia com confirmação de `permissionMode: 'manual'`. A resposta de texto surge progressivamente na interface. A execução termina com sucesso (`result` com `is_error: false`).

### P2. Recusa de ferramenta de escrita

Ação:
Envie o prompt: "Crie teste-m2.txt com ok". A interface apresenta o cartão de autorização para a ferramenta `Write` com o caminho do arquivo e o resumo da operação. Clique em "Recusar".

Resultado esperado:
O runner envia a resposta de recusa (`behavior: 'deny'`). A CLI recebe um resultado de erro (`is_error: true`). O arquivo `teste-m2.txt` não é criado no disco.

### P3. Autorização de ferramenta de escrita

Ação:
Repita o mesmo prompt: "Crie teste-m2.txt com ok". O cartão de aprovação surge novamente para a ferramenta `Write`. Clique em "Permitir uma vez".

Resultado esperado:
A ferramenta `Write` é liberada (`behavior: 'allow'`). O arquivo `teste-m2.txt` é criado na pasta descartável com o conteúdo solicitado. A execução conclui com a lista `permission_denials` vazia.

### P4. Autorização única e rejeição de sugestões persistidas

Ação:
Envie o prompt: "Execute ls". O cartão de aprovação surge para a ferramenta `Bash`. Clique em "Permitir uma vez". Aguarde a conclusão da listagem. Em seguida, envie novamente o mesmo prompt: "Execute ls".

Resultado esperado:
O primeiro comando executa após a permissão. O segundo comando gera um novo cartão de aprovação independente. Sugestões de permissão enviadas pela CLI não são persistidas nem aceitas automaticamente.

### P5. Isolamento de pedidos de autorização entre projetos

Ação:
Inicie uma tarefa que solicite aprovação no projeto descartável A. Com o cartão de autorização pendente, alterne para outro projeto aberto B na barra lateral do SEA Dock. Verifique a tela de B. Retorne ao projeto A e responda ao pedido.

Resultado esperado:
No projeto B, o cartão de aprovação do projeto A não aparece. O processo principal rejeita qualquer tentativa de autorização enviada de outra raiz. Ao retornar ao projeto A, o cartão continua pendente e recebe a decisão normalmente.

### P6. Cancelamento de execução e limpeza de processos

Ação:
Envie um prompt que gere processamento longo. Durante a execução, clique no botão "Interromper".

Resultado esperado:
O runner encerra os pedidos pendentes, envia a interrupção pelo protocolo e aplica os sinais de encerramento necessários. O estado muda para interrompido com marcação de resultado parcial (`parcial: true`). A consulta com `ps` no sistema confirma que não há processos filhos órfãos do Claude.

### P7. Vencimento de prazo e decisão da pessoa usuária

Ação:
Inicie uma tarefa configurada com prazo de 1 minuto. Aguarde o vencimento do prazo sem responder.

Resultado esperado:
O processo não é cancelado automaticamente por ociosidade. A interface exibe um cartão de prazo com as opções "Continuar 15 min" e "Interromper". Clique em "Continuar 15 min" e confirme que o processo permanece em execução. Em seguida, clique em "Interromper" e confirme a finalização imediata.

### P8. Fechamento de projeto com proteção de alterações

Ação:
Abra um arquivo no editor do projeto A e faça uma alteração sem salvar. Inicie uma tarefa com Claude no projeto A. Mantenha outro projeto B com tarefas ativas. Feche o projeto A na barra lateral do aplicativo.

Resultado esperado:
O aplicativo apresenta o diálogo de proteção para o arquivo alterado antes de fechar. As tarefas ativas do projeto A são canceladas e encerradas. O projeto B e suas tarefas permanecem intactos.

### P9. Registro da evidência oficial no marco

Ação:
Após executar os passos anteriores, abra um terminal interativo do sistema. Execute o script de registro da rodada oficial com os passos cumpridos.

Resultado esperado:
A evidência do marco M2 é gravada em `.dk/coordenacoes/evidencias/COORD-PLUGINS-M2.verificacao.json` com os passos registrados e aprovação comprovada.

## Como Registrar a Evidência

O registro deve ser executado por uma pessoa autorizada em terminal interativo real. O script rejeita ambientes automatizados de agentes e solicita confirmação manual digitada.

Comando de registro:

```sh
node scripts/evidencia-marco.mjs cli-oficial COORD-PLUGINS-M2 \
  --autorizado-por autor@seatecnologia.com.br \
  --versao 2.1.312 \
  --passo P0=ok \
  --passo P1=ok \
  --passo P2=ok \
  --passo P3=ok \
  --passo P4=ok \
  --passo P5=ok \
  --passo P6=ok \
  --passo P7=ok \
  --passo P8=ok \
  --passo P9=ok
```

O comando solicita confirmação no terminal:

```text
Confirme digitando COORD-PLUGINS-M2:
```

Digite `COORD-PLUGINS-M2` para confirmar a gravação.

Para validar a evidência com `aprovacao_host_provada: true`, os passos P2, P3, P4 e P5 devem ter resultado `ok`. Sem a execução da rodada, a evidência mantém `executada: false` e bloqueia o avanço para o próximo marco. O único substituto previsto é uma decisão formal registrada por `node scripts/evidencia-marco.mjs decisao-escopo COORD-PLUGINS-M2 --autor <nome> --motivo <texto>`.

## Como Conferir o Gate

O script `scripts/gate-marco.mjs` valida o marco sem modificar arquivos.

Comando de conferência:

```sh
node scripts/gate-marco.mjs COORD-PLUGINS-M2 --json
```

Se a evidência ainda não foi registrada, o comando retorna código 1 e o motivo:

```json
{"coordenacao":"COORD-PLUGINS-M2","concluida":false,"motivos":["Evidência de verificação ausente."]}
```

Após o registro correto de todas as etapas e aprovação dos pacotes, a verificação sem a opção `--json` confirma a liberação do marco com código de saída 0:

```text
COORD-PLUGINS-M2: gate liberado.
```
