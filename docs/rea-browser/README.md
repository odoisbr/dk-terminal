# Browser do DK Terminal — estudo REA

Estudo realizado em 28/10/2026 a partir do plano `docs/plano-estudo-browser-rea.md`, da implementação do DK Terminal e dos estudos locais indicados pelo plano. As verificações distinguem fonte, artefato empacotado e execução.

- [01 — Prévia e ciclo de vida](01-browser-preview.md)
- [02 — Observação em execução](02-observacao-runtime.md)
- [03 — Comparação com o estudo do ChatGPT](03-comparacao-chatgpt.md)
- [04 — Evidências e limites](04-evidencias-rea.md)

O browser executa a página de um serviço local em uma `WebContentsView` separada, sem Node nem API do DK. A navegação principal aceita somente HTTP(S) em loopback; permissões, pop-ups e downloads são negados. **A página pode acessar outros endereços por sub-recursos e requisições**, como confirmado por teste com dois nomes que apontam para um servidor local. Isso não é uma rede isolada.

O plano futuro do editor M3 descreve outra superfície, um iframe servido por `dk-preview:`, com restrições próprias. Este estudo e suas correções não implementam o M3 nem alteram a política de rede do browser atual.
