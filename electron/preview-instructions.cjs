// Texto que a pessoa cola numa IA (ou num AGENTS.md, CLAUDE.md ou GEMINI.md) para
// ela apresentar telas no navegador do SEA Dock. O README repete este texto
// literalmente; tests/preview-instructions.test.cjs confere os dois.
const PREVIEW_INSTRUCTIONS = `## Apresentar telas no SEA Dock

Quando precisar mostrar um protótipo, uma tela, uma imagem ou um documento para a pessoa, abra no navegador interno do SEA Dock rodando no terminal:

    dock-preview <alvo> [--titulo "Texto"]

- <alvo> é um endereço local (http://localhost:5173, 127.0.0.1:3000) ou um arquivo ou pasta do projeto (prototipo/index.html, telas/, tela.png, docs/visao.md). Caminhos relativos partem da pasta atual.
- A saída é uma linha: OK: quando abriu, ou ERRO: seguido do que fazer. Siga a orientação do erro antes de tentar de novo.
- Só abre endereços locais e arquivos dentro do projeto. Para um servidor de desenvolvimento, inicie-o antes e passe o endereço.
- Se o comando não existir, a sessão não foi aberta pelo SEA Dock: informe o caminho do arquivo à pessoa em vez de abrir.
`;
module.exports = { PREVIEW_INSTRUCTIONS };
