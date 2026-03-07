import fs from 'fs/promises';
import path from 'path';
import { getBrowser } from './playwright-scraper.js';

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
const SESSION_TTL_MS =
  parseInt(process.env.SESSION_TTL_HOURS || '12', 10) * 60 * 60 * 1000;

/**
 * Retorna um contexto Playwright já autenticado para o site.
 * Se sessão válida existir em disco, restaura sem novo login.
 * Se não existir ou estiver expirada, executa loginFn e salva a sessão.
 *
 * @param {string}   siteId   - ID do site (ex: 'mobbin')
 * @param {Function} loginFn  - async (context, email, password) => void
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function getAuthenticatedContext(siteId, loginFn) {
  const browser = await getBrowser();
  const sessionPath = path.join(SESSIONS_DIR, `${siteId}.json`);

  try {
    const raw = await fs.readFile(sessionPath, 'utf8');
    const data = JSON.parse(raw);
    const age = Date.now() - data.savedAt;

    if (age < SESSION_TTL_MS) {
      const context = await browser.newContext({ storageState: data.storageState });
      console.log(
        `[Session] Sessão restaurada para ${siteId} (${Math.round(age / 60000)}min atrás)`,
      );
      return context;
    }
    console.log(`[Session] Sessão expirada para ${siteId}. Fazendo novo login.`);
  } catch {
    console.log(`[Session] Nenhuma sessão salva para ${siteId}. Fazendo login.`);
  }

  const context = await browser.newContext();
  await loginFn(context);

  const storageState = await context.storageState();
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.writeFile(
    sessionPath,
    JSON.stringify({ siteId, savedAt: Date.now(), storageState }),
  );
  console.log(`[Session] Sessão salva para ${siteId}`);

  return context;
}

/**
 * Invalida a sessão salva de um site (força re-login na próxima chamada).
 *
 * @param {string} siteId
 */
export async function invalidateSession(siteId) {
  const sessionPath = path.join(SESSIONS_DIR, `${siteId}.json`);
  try {
    await fs.unlink(sessionPath);
    console.log(`[Session] Sessão invalidada para ${siteId}`);
  } catch {
    // arquivo não existia, ok
  }
}
