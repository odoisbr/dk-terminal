// Texto do bloco de status do plugin DK na sidebar. Nunca mostra caminhos: o caminho do kit vai só
// para o `title` (suporte). A ação indica o que o botão faz; `null` esconde o botão.
export type KitStatusInput = {
  status: ClaudePlugin['status'] | 'checking';
  version?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  kitActive: boolean;
};
export type KitStatusView = { label: string; description: string; action: 'install' | 'enable' | 'update' | null; actionLabel: string };

const tag = (version?: string) => version ? `v${version.replace(/^v/, '')}` : '';

export function describeKit(input: KitStatusInput): KitStatusView {
  const none = { action: null, actionLabel: '' } as const;
  switch (input.status) {
    case 'installed':
      if (input.updateAvailable && input.version && input.latestVersion) return { label: 'Plugin DK conectado', description: `Atualização disponível · ${tag(input.version)} → ${tag(input.latestVersion)}`, action: 'update', actionLabel: 'Atualizar plugin DK' };
      return { label: 'Plugin DK conectado', description: input.version ? `${tag(input.version)} · ${input.latestVersion ? 'versão mais recente' : 'versão em uso no Claude'}` : 'Versão em uso no Claude', ...none };
    case 'missing': return { label: 'Plugin DK não instalado', description: 'Instale o plugin para usar as ações do DK', action: 'install', actionLabel: 'Instalar plugin DK no Claude' };
    case 'disabled': return { label: 'Plugin DK desativado', description: 'Ative o plugin no Claude para usar as ações', action: 'enable', actionLabel: 'Ativar plugin DK no Claude' };
    case 'no-claude': return { label: input.kitActive ? 'Design Kit conectado' : 'Plugin DK indisponível', description: 'Instale o Claude Code para usar o plugin', ...none };
    case 'unavailable': return { label: input.kitActive ? 'Design Kit conectado' : 'Plugin DK indisponível', description: 'Não foi possível verificar o plugin', ...none };
    default: return { label: input.kitActive ? 'Design Kit conectado' : 'Detectando plugin DK', description: 'Verificando instalação do Claude', ...none };
  }
}
