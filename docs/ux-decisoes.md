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

## Mapa canônico de ícones — 29/10/2026

- **Contexto:** havia dois mapas de SVG (`src/main.ts` e `src/launcher.ts`) com traços diferentes para o mesmo nome, glifos de texto (`↻ × › ▸ ◇ ↶ ↷`) fazendo papel de botão e desenhos com vários sentidos: a pasta abria o Finder, o painel de arquivos, um projeto e um diretório; o pulso era Diagnóstico, Serviços, Dividir com agente, sessão de agente e Máquina; o `+` era abrir, criar e nova sessão; “Otimizar recursos” usava o desenho de atualizar; sessão encerrada mostrava ✓ mesmo com erro.
- **Decisão:** um módulo único, `src/icons.ts`, com nomes tipados (`IconName`): nome inexistente não compila, sem fallback silencioso. Um desenho por significado:

  | Significado | Ícone |
  |---|---|
  | Abrir projeto (Início, sidebar, boas-vindas) | `folderOpen` |
  | Criar projeto | `plus` |
  | Projeto na lista da sidebar | `project` (pasta de trabalho) |
  | Diretório na árvore | `folder` |
  | Painel de arquivos | `files` |
  | Abrir no Finder | `reveal` |
  | Nova sessão de terminal | `terminalPlus` |
  | Sessão shell / sessão de agente | `terminal` / `sparkle` (estado encerrada e erro por classe e title, não por outro desenho) |
  | Dividir com agente | `sparkle` |
  | Serviços do projeto | `server` |
  | Diagnóstico DK / Auditoria / Validar | `activity` / `fileSearch` / `checkCircle` |
  | Máquina (CPU e memória) | `cpu` |
  | Otimizar recursos | `zap` |
  | Atualizar (Git, plugins, árvore, uso, orquestração, serviços) | `refresh` |
  | GitLab SEA remoto (abrir, clonar) / criar projeto no GitLab | `cloudDown` / `cloudUp` |
  | Configurações / Aparência e terminal | `settings` (engrenagem) / `sliders` |
  | Avisos de atividade / Plugins / Diagnóstico (logs) | `bell` / `blocks` / `bug` |
  | Recolher sidebar | `sidebar` (distinto de `split`) |
  | Fechar / expandir seção | `close` / `chevron` girado por CSS |
  | Resultado anterior / próximo da busca | `arrowUp` / `arrowDown` |
  | Desfazer / refazer / copiar | `undo` / `redo` / `copy` |

- **Rótulos:** botões só-ícone têm `title` e `aria-label` iguais à ação (`setIconButton`). Abas do painel: “Arquivos do projeto”, “Git”, “Contexto do projeto”, “Serviços do projeto”, “Contas e uso” (antes “Pasta” e “Consumo”, que não diziam o que abriam). `#reveal-project` passa a “Abrir pasta do projeto no Finder”; `#new-session` a “Nova sessão de terminal”.
- **Verificação:** `tsc --noEmit` rejeita nome de ícone fora do mapa; `tests/project-inspector-desktop.cjs`, `tests/plugins-desktop.cjs`, `tests/desktop.cjs` e `tests/idle-desktop.cjs` conferem os novos rótulos.

## Revisão visual das seções novas — 29/10/2026

- **Contexto:** capturas em 1280x800, temas padrão e SEA (Início, workspace com sidebar expandida e recolhida, popover Máquina, painéis Arquivos, Git, Contexto, Serviços e Contas e uso, navegador com prévia, configurações), depois da entrada da sidebar nova, do status do plugin DK, de “Detectados nas sessões”, do modo debug e do fluxo “Criar projeto no GitLab SEA”.
- **Decisões:**
  - Linha compacta da sidebar: o botão Fechar projeto (32 px, separado da seleção) só ocupa largura no hover ou com foco na linha, em vez de reservar espaço invisível; o nome do projeto com selo DK deixava de caber (“Portal do Cli…”).
  - Painel Serviços ganha cabeçalho com título “Serviços” à esquerda e Atualizar à direita, como os demais painéis; o botão “Preparar dependências” usa o mesmo corpo de texto dos outros botões do painel e fica em linha própria abaixo da descrição.
  - Painel Git: “Criar projeto no GitLab SEA” passa a botão secundário de largura total (44 px). “Salvar versão” continua a única ação principal do painel; antes as duas competiam com o mesmo peso.
  - Ferramentas do Git: “Excluir” branch fica afastado de “Trocar” e em cor de alerta.
  - Prévia: o botão Desligar serviço ganha 32 px e afastamento de 10 px de “Visualizar projeto”. A barra da prévia mantém controles de 32 px, abaixo dos 44 px das ações principais, para não dobrar a altura da barra sobre a página.
  - Contexto do projeto: `.git` aparece com ícone de pasta, não de arquivo. Nota final das configurações cita “Contas e uso” no lugar de “Consumo”.
- **Verificação:** capturas em `revisao-visual/antes` e `revisao-visual/depois` (pasta da orquestração); `tests/sidebar-desktop.cjs`, `tests/session-services-desktop.cjs`, `tests/gitlab-publish-desktop.cjs` e `tests/git-branches-desktop.cjs` cobrem os fluxos tocados.
