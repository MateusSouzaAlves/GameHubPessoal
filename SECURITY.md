# Política de segurança

## Versões suportadas

Correções de segurança são aplicadas à versão mais recente disponível neste repositório.

## Reportar uma vulnerabilidade

Não publique tokens OAuth, arquivos de credenciais, saves, caminhos pessoais ou outros dados privados em uma issue.

Use o canal privado de segurança do repositório (GitHub Security Advisories, quando habilitado) e informe:

- versão/commit afetado;
- impacto observado;
- passos mínimos para reproduzir;
- sugestão de correção, se houver.

Remova ou substitua qualquer dado pessoal dos anexos. Se uma credencial do Google tiver sido exposta, revogue-a imediatamente no Google Cloud Console e desconecte o aplicativo da conta.

## Modelo de dados

O Nexus não opera um backend próprio. Configuração, catálogo, saves e tokens permanecem no computador do usuário. A sincronização opcional usa diretamente a Google Drive API e o espaço privado `appDataFolder` da conta escolhida.
