import { chromium } from 'playwright';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let browser = null;

export async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return browser;
}

/**
 * Scraping com Playwright para sites JS-rendered.
 * Nunca lança exceção — retorna [] em qualquer falha.
 *
 * @param {Object} site  - Objeto do sites.json com url_busca e seletor_resultados
 * @param {string} query - Termo de busca
 * @param {number} maxResults
 * @returns {Promise<Array<{imageUrl, url, titulo, source}>>}
 */
export async function scrapePlaywright(site, query, maxResults = 6) {
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': USER_AGENT });

    const url = site.url_busca.replace('{query}', encodeURIComponent(query));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Aguarda o seletor principal; falha silenciosa se não aparecer
    try {
      await page.waitForSelector(site.seletor_resultados, { timeout: 8000 });
    } catch {
      console.warn(
        `[playwright-scraper] ${site.id}: timeout aguardando "${site.seletor_resultados}" — tentando mesmo assim`,
      );
    }

    const raw = await page.evaluate((seletor) => {
      const PLACEHOLDER_PATTERNS = [
        'data:image',
        '1x1',
        'transparent',
        'blank',
        'pixel',
        'placeholder',
        'spacer',
      ];

      function isValidImage(src) {
        if (!src) return false;
        if (!src.startsWith('http') && !src.startsWith('//')) return false;
        const lower = src.toLowerCase();
        return !PLACEHOLDER_PATTERNS.some((p) => lower.includes(p));
      }

      function extractImage(el) {
        // Atributos diretos no elemento
        for (const attr of ['src', 'data-src', 'data-lazy', 'data-lazy-src', 'data-original', 'data-bg']) {
          const v = el.getAttribute(attr);
          if (v && isValidImage(v)) return v;
        }
        // background-image inline
        const style = el.getAttribute('style') || '';
        const bgMatch = style.match(/background-image\s*:\s*url\(['"]?([^'"()]+)['"]?\)/i);
        if (bgMatch && isValidImage(bgMatch[1])) return bgMatch[1];
        // srcset
        const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
        if (srcset) {
          const first = srcset.split(',')[0].trim().split(/\s+/)[0];
          if (isValidImage(first)) return first;
        }
        // Imagem filha
        const img = el.querySelector('img');
        if (img) {
          for (const attr of ['src', 'data-src', 'data-lazy', 'data-lazy-src', 'data-original']) {
            const v = img.getAttribute(attr);
            if (v && isValidImage(v)) return v;
          }
          const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
          if (ss) {
            const first = ss.split(',')[0].trim().split(/\s+/)[0];
            if (isValidImage(first)) return first;
          }
        }
        // Elemento com background-image computado
        const computed = window.getComputedStyle(el).backgroundImage;
        if (computed && computed !== 'none') {
          const m = computed.match(/url\(['"]?([^'"()]+)['"]?\)/i);
          if (m && isValidImage(m[1])) return m[1];
        }
        return null;
      }

      function extractUrl(el) {
        // O próprio elemento pode ser um <a>
        if (el.tagName === 'A' && el.href) return el.href;
        // Ancestral <a>
        let current = el.parentElement;
        while (current) {
          if (current.tagName === 'A' && current.href) return current.href;
          current = current.parentElement;
        }
        // Descendente <a>
        const child = el.querySelector('a[href]');
        if (child) return child.href;
        return null;
      }

      function extractTitulo(el) {
        // Cabeçalhos dentro do elemento
        for (const tag of ['h1', 'h2', 'h3', 'h4']) {
          const h = el.querySelector(tag);
          if (h && h.innerText.trim()) return h.innerText.trim();
        }
        // Alt ou title da imagem
        const img = el.querySelector('img');
        if (img) {
          if (img.alt && img.alt.trim()) return img.alt.trim();
          if (img.title && img.title.trim()) return img.title.trim();
        }
        // Atributos do próprio elemento
        if (el.getAttribute('title')) return el.getAttribute('title').trim();
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
        // Fallback: texto do elemento
        const text = el.innerText?.trim();
        if (text && text.length < 120) return text;
        return '';
      }

      const elementos = Array.from(document.querySelectorAll(seletor));
      return elementos.map((el) => ({
        imageUrl: extractImage(el),
        url: extractUrl(el),
        titulo: extractTitulo(el),
      }));
    }, site.seletor_resultados);

    const results = raw
      .filter((r) => r.imageUrl)
      .slice(0, maxResults)
      .map((r) => ({ ...r, source: site.id }));

    console.log(`[playwright-scraper] ${site.id}: ${results.length} resultados`);
    return results;
  } catch (err) {
    console.warn(`[playwright-scraper] ${site.id}: erro — ${err.message}`);
    return [];
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // ignora erro ao fechar page
      }
    }
  }
}

export async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // ignora
    }
    browser = null;
  }
}

process.on('SIGTERM', closeBrowser);
process.on('SIGINT', closeBrowser);
