import { getAuthenticatedContext, invalidateSession } from './session-manager.js';

/**
 * Orquestra a execução de um scraper autenticado:
 * 1. Verifica se credenciais estão configuradas no .env para o site
 * 2. Obtém contexto autenticado (session-manager restaura ou faz login)
 * 3. Executa scrapeFn
 * 4. Em erro de auth, invalida sessão e tenta uma vez com re-login
 *
 * @param {Object}   siteConfig    - Objeto do sites.json com id e credentialKey
 * @param {string[]} searchTerms   - Termos de busca
 * @param {Function} loginFn       - async (context, email, password) => void
 * @param {Function} scrapeFn      - async (context, searchTerms) => Array
 * @returns {Promise<Array>}
 */
export async function runAuthenticatedScraper(siteConfig, searchTerms, loginFn, scrapeFn) {
  const { id: siteId, credentialKey } = siteConfig;

  const email = process.env[`${credentialKey}_EMAIL`];
  const password = process.env[`${credentialKey}_PASSWORD`];

  if (!email || !password) {
    console.log(`[AuthScraper] Credenciais não configuradas para ${siteId}. Pulando.`);
    return [];
  }

  const boundLoginFn = (context) => loginFn(context, email, password);

  for (let attempt = 1; attempt <= 2; attempt++) {
    let context;
    try {
      context = await getAuthenticatedContext(siteId, boundLoginFn);
      const results = await scrapeFn(context, searchTerms);
      await context.close();
      return results;
    } catch (err) {
      await context?.close();

      const isAuthError =
        err.message?.includes('401') ||
        err.message?.includes('403') ||
        err.message?.toLowerCase().includes('login') ||
        err.message?.toLowerCase().includes('unauthorized');

      if (isAuthError && attempt === 1) {
        console.warn(
          `[AuthScraper] Erro de autenticação em ${siteId}. Invalidando sessão e tentando novamente.`,
        );
        await invalidateSession(siteId);
        continue;
      }

      console.error(
        `[AuthScraper] Falha em ${siteId} (tentativa ${attempt}): ${err.message}`,
      );
      return [];
    }
  }
  return [];
}
