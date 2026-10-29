# Decisões de UX

## Prévia de serviço local — 28/10/2026

- **Contexto:** a página aberta na prévia pode acessar outras origens, embora a navegação principal esteja restrita a endereços locais.
- **Decisão:** o rodapé informa “Projeto local · A página pode acessar a rede”. A política de rede existente continua permitindo os recursos de que o projeto necessita.
- **Justificativa:** o texto anterior, “Navegador isolado”, não distinguia o isolamento da view de um bloqueio de rede.
- **Verificação:** `tests/browser-desktop.cjs` exercita uma conexão entre origens simuladas; `tests/desktop.cjs` verifica o texto no fluxo da interface.

O plano cita um relatório JFM+D quando uma tela muda, mas não identifica um modelo nem uma definição para essa sigla. Esta decisão registra o motivo e a verificação da alteração textual sem presumir esse formato.

## Assinatura e distribuição do DMG — 29/10/2026

- **Contexto:** o SEA Dock passa a ser distribuído como DMG assinado e notarizado, com o `sea` CLI embutido. A única Developer ID Application disponível é a da oDois (`ODOIS TECNOLOGIA E INOVACAO LTDA`, T44Q8TNUX8); a Sea Tecnologia não tem conta no Apple Developer Program.
- **Decisão:** decisão do responsável pelo projeto: assinar e notarizar com a identidade da oDois, por ser o produto compartilhado no modelo do kit. O bundle id continua `br.com.sea.dk.terminal`.
- **Consequência visível:** o Gatekeeper abre o app sem aviso; a distribuidora exibida nas propriedades é a oDois.
- **Revisão:** trocar a identidade quando a SEA tiver conta própria; a troca não afeta instalações existentes, só os DMGs seguintes.
- **Verificação:** `npm run release` valida com `codesign --verify --deep --strict`, `stapler validate` e `spctl --assess`.
