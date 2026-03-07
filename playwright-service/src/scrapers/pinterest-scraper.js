import { runAuthenticatedScraper } from './auth-scraper.js';

async function loginFn(context, email, password) {
  const page = await context.newPage();
  try {
    await page.goto('https://pinterest.com/login/', { waitUntil: 'domcontentloaded' });
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click("button[type='submit']");
    await page.waitForURL('**pinterest.com/**', { timeout: 15000 });
    await page.waitForFunction(
      () => !window.location.pathname.includes('/login'),
      { timeout: 10000 },
    );
  } finally {
    await page.close();
  }
}

async function scrapeFn(context, searchTerms) {
  const query = searchTerms.join(' ');
  const url = `https://pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
  const page = await context.newPage();
  const results = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    try {
      await page.waitForSelector('[data-test-id="pin"], div[role="listitem"]', {
        timeout: 10000,
      });
    } catch {
      console.warn('[pinterest-scraper] Timeout aguardando pins — tentando mesmo assim');
    }

    // Scroll suave para carregar mais pins
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(1500);

    const items = await page.$$eval(
      '[data-test-id="pin"], div[role="listitem"]',
      (pins) =>
        pins.slice(0, 15).map((pin) => ({
          title: pin.querySelector('img')?.alt?.trim() || '',
          image_url: pin.querySelector('img')?.src || '',
          url: pin.querySelector('a')?.href || '',
        })),
    );

    for (const item of items) {
      // Remove thumbnails minúsculas (75x75)
      if (item.image_url && !item.image_url.includes('75x75')) {
        results.push({
          title: item.title || 'Pinterest Pin',
          imageUrl: item.image_url,
          source: 'pinterest',
          url: item.url,
          tags: ['inspiration', 'visual', 'design'],
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
