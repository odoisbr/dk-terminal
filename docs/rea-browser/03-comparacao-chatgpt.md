# 03 — Comparação com o estudo do ChatGPT

A coluna ChatGPT resume o estudo estático local `/Volumes/oDois/Produtos/rea-regenerate/ChatGPT/01-browser-integrado.md` e suas seções; não foi executada uma instância do ChatGPT nesta comparação. As conclusões e os limites daquele estudo pertencem ao artefato e à versão estudados, não a todas as versões do produto.

| Camada | Estudo do ChatGPT | DK Terminal observado | Relevância para uma evolução futura |
|---|---|---|---|
| View e abas | `<webview>` por aba, validado no processo principal (§3.1–3.2). | Uma `WebContentsView` de prévia por janela. | Múltiplas abas exigiriam orçamento e ciclo de vida por aba. |
| Sessão | Partições persistentes associadas à rota (§4.1). | Partição temporária por projeto, limpa ao sair. | Persistência de login ou estado exigiria escolha explícita e política de dados. |
| Rede | Restrições por sessão e política adicional durante Browser Use (§4.2). | Navegação principal restrita; sub-recursos podem acessar outra origem. | Separar o caso do serviço local do futuro iframe M3, que propõe não acessar rede. |
| Anotações | Preload e sinais de interação observados no pacote (§5); canal descrito como inferência no estudo. | Nenhum preload ou canal da página para o DK na view. | Um futuro bridge deve ter contrato, origem e permissões próprios. |
| Agente | Gerenciamento de debugger e restrições de comandos analisados estaticamente (§6). | Nenhum controle por agente sobre a view de prévia. | Não introduzir controle de agente sem definir escopo e autorização. |
| Recursos | Orçamento e restauração de abas observados estaticamente (§3.4). | Uma view, com throttling de fundo e liberação ao sair. | Medir antes de adicionar múltiplas views ou snapshots. |

O plano `docs/plano-plugins-projeto.md`, fase 3, descreve um **iframe separado** para edição de HTML por `dk-preview:` e diz que o `PreviewBrowser` continua atendendo serviços em execução. Assim, bloquear todos os pedidos externos da view atual seria uma mudança de produto adicional, não uma consequência automática da regra proposta para o futuro iframe.
