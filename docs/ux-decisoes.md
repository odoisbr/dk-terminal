# Decisões de UX

## Prévia de serviço local — 28/10/2026

- **Contexto:** a página aberta na prévia pode acessar outras origens, embora a navegação principal esteja restrita a endereços locais.
- **Decisão:** o rodapé informa “Projeto local · A página pode acessar a rede”. A política de rede existente continua permitindo os recursos de que o projeto necessita.
- **Justificativa:** o texto anterior, “Navegador isolado”, não distinguia o isolamento da view de um bloqueio de rede.
- **Verificação:** `tests/browser-desktop.cjs` exercita uma conexão entre origens simuladas; `tests/desktop.cjs` verifica o texto no fluxo da interface.

O plano cita um relatório JFM+D quando uma tela muda, mas não identifica um modelo nem uma definição para essa sigla. Esta decisão registra o motivo e a verificação da alteração textual sem presumir esse formato.
