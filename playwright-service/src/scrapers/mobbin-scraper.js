import { runAuthenticatedScraper } from './auth-scraper.js';

async function loginFn(context, email, password) {
  const page = await context.newPage();
  try {
    await page.goto('https://mobbin.com/sign-in', { waitUntil: 'domcontentloaded' });
    await page.fill("input[type='email']", email);
    await page.fill("input[type='password']", password);
    await page.click("button[type='submit']");
    await page.waitForURL('**/browse/**', { timeout: 15000 });
  } finally {
    await page.close();
  }
}

async function scrapeFn(context, searchTerms) {
  const query = searchTerms.join(' ');
  const url = `https://mobbin.com/browse/web/screens?q=${encodeURIComponent(query)}`;
  const page = await context.newPage();
  const results = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    try {
      await page.waitForSelector(
        '[class*="ScreenCard"], [class*="screen-card"], .screen-card',
        { timeout: 10000 },
      );
    } catch {
      console.warn('[mobbin-scraper] Timeout aguardando ScreenCard — tentando mesmo assim');
    }

    const items = await page.$$eval(
      '[class*="ScreenCard"], [class*="screen-card"], .screen-card',
      (cards) =>
        cards.slice(0, 15).map((card) => ({
          title: card.querySelector('[class*="app-name"], [class*="AppName"], h3')?.textContent?.trim() || '',
          image_url: card.querySelector('img')?.src || '',
          url: card.querySelector('a')?.href || '',
        })),
    );

    for (const item of items) {
      if (item.image_url) {
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
