# Avaliação para piloto — DK Terminal

Data: 28/10/2026. Ambiente avaliado: macOS Apple Silicon. Esta revisão não substitui auditoria de segurança independente nem confirma o funcionamento em outras máquinas.

## Situação

Não considerar o pacote atual uma versão oficial de distribuição. Ele tem assinatura ad hoc, sem identidade de desenvolvedor ou notarização. Antes de distribuí-lo, preparar uma versão assinada e notarizada e instalá-la em um Mac de teste limpo, com um procedimento de suporte e atualização definido. A versão exibida continua 0.1.0 (alpha).

O SEA CLI ainda não acompanha o aplicativo e suas dependências não são instaladas automaticamente. O chat por projeto com o gateway local e sua interface de permissões também não foram implementados. O chat visual Codex existente é uma integração diferente, com testes simulados das permissões, e não deve ser anunciado como o gateway.

## Segurança e privacidade

- A interface principal usa isolamento de contexto, sandbox do Electron e política de conteúdo; a prévia usa outra sessão e nega permissões e downloads. A navegação principal da prévia aceita somente endereços locais. Isso não impede necessariamente que uma página carregue recursos ou faça conexões externas; não apresente a prévia como isolamento de rede completo.
- Terminais, extensões e serviços executam programas com as permissões da conta do usuário. Iniciar um serviço ou extensão de um projeto executa código desse projeto ou ferramenta. Abra apenas projetos e extensões em que confie.
- A CLI oficial controla autenticação; as conversas do chat Codex são guardadas localmente em arquivo privado, em texto, fora do projeto. O histórico e os arquivos do projeto podem conter informações sensíveis.
- O navegador de arquivos remotos usa o GitLab CLI, separado da conta SEA; não faz cópia local até o usuário solicitar. As credenciais continuam sob controle das ferramentas oficiais.
- A distribuição agora usa lista explícita de componentes necessários e exclui nomes típicos de credenciais. Isso reduz inclusões acidentais, mas não substitui revisar o conteúdo e a procedência de cada pacote.

## Verificações realizadas

- 59 testes automatizados existentes, mais verificação da seleção de arquivos do pacote: passaram.
- Testes gráficos em perfis temporários: boas-vindas, conta simulada, launcher, editor, Mermaid, alerta de inatividade e preferências.
- Testes com Electron e PTY reais, em projetos temporários, tanto no código quanto no aplicativo empacotado: terminais, split, editor, serviços, prévia e proteção de arquivos sem salvar. As respostas de IA e as etapas de login/cópia cobertas por testes simulados não comprovam inferência ou autenticação real em uma conta de teste.
- Consulta ao npm audit, para dependências de produção e desenvolvimento: nenhum aviso retornado na consulta realizada nesta data. Isso não garante ausência de vulnerabilidades.
- Inspeção do arquivo empacotado: somente assets, dist, electron, extensions, node_modules necessários e package.json na raiz.
- Amostra pontual de recursos durante o teste completo: cerca de 649 MiB de memória e 1,15% de CPU nos processos Electron em execução a partir do código, e 613 MiB e 1,74% no aplicativo empacotado. A medição depende da carga e da máquina; não é limite nem benchmark comparativo.

## Antes de ampliar o piloto

1. Assinar e notarizar o aplicativo, definir versão e canal de distribuição e verificar instalação em Mac limpo. Validar arquiteturas adicionais apenas quando houver pacotes e testes próprios.
2. Definir qual parte do escopo inicial é necessária para o piloto: empacotamento do SEA CLI; gateway de chat e permissões; distribuição da integração Finder. Hoje nenhum dos dois primeiros está concluído.
3. Testar com contas e permissões reais de teste, projetos representativos, conexões lentas/indisponíveis e arquivos grandes; checar perda de trabalho em encerramento e falhas de processo.
4. Medir memória, CPU e tempo de abertura em cenário reproduzível de uso dos designers e estabelecer metas antes de afirmar melhoria de desempenho.
5. Definir manutenção de dependências, atualização, canal de suporte, privacidade dos históricos e política de correções. Revisar licenças e identidade de distribuição.
