# Revisão ponta a ponta — DK Terminal

28/10/2026 · macOS Apple Silicon · revisão colaborativa de segurança, estabilidade e distribuição. Os testes usam perfis e projetos temporários; não são uma auditoria independente nem garantia de ausência de falhas.

## Correções implementadas

- Leituras de configuração de serviços recusam caminhos reais fora do projeto, arquivos especiais e conteúdo acima de 256 KiB; leitura usa descritor, tamanho limitado e abertura não bloqueante quando disponível.
- Ao desligar serviço, a supervisão do grupo continua por até quatro segundos quando o processo principal termina antes de filhos que resistem ao encerramento. O teste cobre filho no mesmo grupo com saída desconectada; não garante controle de processos que deliberadamente criem outro grupo ou sessão.
- A busca e o acesso remoto ao GitLab ficam limitados ao grupo `design` e seus subgrupos. A verificação inclui seleção e revalidação ao abrir arquivos e preparar cópias. O cliente não pode eliminar a janela entre verificação de namespace e execução subsequente no servidor.
- Aparência opcional de vidro para os temas DK e SEA, guardada nas preferências e respeitando redução de transparência do sistema.
- A trava de instância por perfil protege configurações e histórico contra gravações simultâneas; novas aberturas são encaminhadas à instância existente. Perfis separados continuam independentes.
- Verificação consolidada `npm run test:all` cobre também as regressões de projetos, boas-vindas e avisos de inatividade.

## Riscos e pendências

1. **Distribuição:** o pacote é arm64 e tem assinatura ad hoc, sem identidade de desenvolvedor nem notarização. Não é uma entrega oficial pronta para distribuição. Necessário assinar/notarizar com a identidade autorizada e testar a instalação em Mac limpo.
2. **Processos de terminal:** fechar um terminal pode deixar processo filho ativo se ele ignorar o sinal recebido. Jobs podem ter grupos distintos; não é seguro matar processos globais por nome ou porta. Acompanhamento de descendentes e testes adicionais ainda são necessários.
3. **Desempenho:** há operações de arquivos síncronas no processo principal, que podem atrasar a interface em disco externo lento. A inicialização depende da consulta ao shell de login e da animação; medir cenários reais antes de modificar. Amostras de memória não são benchmarks nem garantias.
4. **Instalação:** SEA CLI e suas dependências ainda não são empacotados, e o chat pelo gateway com permissões não está implementado. A CLI Codex existente é uma integração diferente.
5. **Segurança e privacidade:** terminais, serviços e extensões executam código com as permissões do usuário. O browser impede navegação principal para fora do localhost, mas subrecursos podem acessar redes externas. Conversas do chat Codex são armazenadas em texto no perfil privado.
6. **Confiabilidade:** validar em máquinas limpas, com contas de teste reais, rede lenta/indisponível, armazenamento lento e uso prolongado; definir suporte, atualização, reversão e política de dependências antes do piloto ampliado.

## Verificações

- 68 testes de unidade e integração passaram, incluindo processos temporários; a suíte gráfica completa passou em perfis isolados. O aplicativo empacotado passou pelo teste de launcher, tema, aparência de vidro e persistência.
- Consulta npm audit realizada para dependências de produção e desenvolvimento sem alertas conhecidos retornados nesta data; não garante ausência de vulnerabilidades.
- Consulta GitLab de leitura retornou 30 projetos, todos com namespace `design/`, com paginação disponível; não foi feita cópia local nem alteração remota.
- Autenticação, permissões de agentes, projeto remoto e cópia usam simulações nos testes automatizados; não houve inferência real em contas Claude ou Codex nesta revisão.
