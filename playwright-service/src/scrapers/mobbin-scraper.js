import { runAuthenticatedScraper } from './auth-scraper.js';

async function loginFn(context, email, password) {
  const page = await context.newPage();
  try {
    // URL correta: /login (não /sign-in, que redireciona para homepage)
    await page.goto('https://mobbin.com/login', { waitUntil: 'domcontentloaded' });

    // Passo 1: preenche email e submete (form de 2 etapas)
    await page.waitForSelector("input[type='email']", { timeout: 10000 });
    await page.fill("input[type='email']", email);
    // Clica no último button[type=submit] do form (botão "Continue")
    const submitBtns = page.locator("button[type='submit']");
    await submitBtns.last().click();

    // Passo 2: aguarda o campo de password ficar visível e preenche
    await page.waitForSelector("input[type='password']:visible", { timeout: 10000 });
    await page.fill("input[type='password']", password);
    await page.click("button[type='submit']");

    // Após login, redireciona para /discover/... — aguarda sair da página /login
    await page.waitForFunction(
      () => !window.location.pathname.startsWith('/login'),
      { timeout: 20000 },
    );
  } finally {
    await page.close();
  }
}

async function scrapeFn(context, searchTerms) {
  const query = searchTerms.join(' ');
  // URL correta da busca autenticada: /search/apps/ios?content_type=screens&q={query}
  const url = `https://mobbin.com/search/apps/ios?content_type=screens&q=${encodeURIComponent(query)}`;
  const page = await context.newPage();
  const results = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    try {
      // Seletor correto na estrutura atual do Mobbin
      await page.waitForSelector('.screen-border-radius.relative.block', { timeout: 10000 });
    } catch {
      console.warn('[mobbin-scraper] Timeout aguardando screen-border-radius — tentando mesmo assim');
    }

    const items = await page.$$eval(
      '.screen-border-radius.relative.block',
      (cards) =>
        cards.slice(0, 15).map((card) => ({
          title: card.querySelector('img')?.alt?.trim() || '',
          image_url: card.querySelector('img')?.src || '',
          url: card.href || card.getAttribute('href') || '',
        })),
    );

    for (const item of items) {
      if (item.image_url && item.image_url.includes('app_screens')) {
        results.push({
          title: item.title || 'Mobbin Screen',
          imageUrl: item.image_url,
          source: 'mobbin',
          url: item.url,
          tags: ['ui', 'screen', 'mobile'],
        });
      }
    }
  } finally {
    await page.close();
  }
  return results;
}

export async function scrape(siteConfig, searchTerms) {
  return runAuthenticatedScraper(siteConfig, searchTerms, loginFn, scrapeFn);
}
