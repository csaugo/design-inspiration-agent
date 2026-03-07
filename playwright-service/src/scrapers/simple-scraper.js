import axios from 'axios';
import * as cheerio from 'cheerio';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Cache-Control': 'no-cache',
};

/**
 * Extrai a URL de imagem de um elemento cheerio.
 * Tenta src, data-src, data-lazy-src e src de img filho.
 * @param {CheerioElement} el
 * @param {CheerioAPI} $
 * @returns {string|null}
 */
function extractImageUrl(el, $) {
  const elem = $(el);

  const attrs = ['src', 'data-src', 'data-lazy-src', 'data-original'];
  if (elem.is('img')) {
    for (const attr of attrs) {
      const val = elem.attr(attr);
      if (val && val.startsWith('http') && !val.includes('data:image')) return val;
    }
  }

  const img = elem.find('img').first();
  if (img.length) {
    for (const attr of attrs) {
      const val = img.attr(attr);
      if (val && val.startsWith('http') && !val.includes('data:image')) return val;
    }
  }

  return null;
}

/**
 * Extrai a URL de página de um elemento cheerio.
 * @param {CheerioElement} el
 * @param {CheerioAPI} $
 * @param {string} baseUrl
 * @returns {string|null}
 */
function extractPageUrl(el, $, baseUrl) {
  const elem = $(el);
  let href = elem.is('a') ? elem.attr('href') : elem.closest('a').attr('href');
  if (!href) href = elem.find('a').first().attr('href');
  if (!href) return null;
  if (href.startsWith('http')) return href;
  if (href.startsWith('/')) return new URL(href, baseUrl).href;
  return null;
}

/**
 * Extrai o título de um elemento cheerio.
 * @param {CheerioElement} el
 * @param {CheerioAPI} $
 * @returns {string}
 */
function extractTitle(el, $) {
  const elem = $(el);

  const heading = elem.find('h2, h3, h4').first().text().trim();
  if (heading) return heading;

  const img = elem.find('img').first();
  const alt = img.attr('alt')?.trim();
  if (alt) return alt;

  const titleAttr = elem.attr('title')?.trim();
  if (titleAttr) return titleAttr;

  return '';
}

/**
 * Scraper HTTP simples (axios + cheerio) para sites Tier 2 scraping_simples.
 *
 * @param {Object} site - Objeto do sites.json com url_busca, seletor_resultados, extrai, id
 * @param {string} query - String de busca (keywords do brief)
 * @param {number} [maxResults=6] - Máximo de resultados a retornar
 * @returns {Promise<Array<{source, titulo, url, imageUrl, originalUrl}>>}
 */
export async function scrapeSimple(site, query, maxResults = 6) {
  if (!site?.url_busca || !site?.seletor_resultados) {
    console.warn(`[simple-scraper] Site ${site?.id}: url_busca ou seletor_resultados ausentes — pulando`);
    return [];
  }

  const encodedQuery = encodeURIComponent(query);
  const url = site.url_busca.replace('{query}', encodedQuery);

  let html;
  try {
    const response = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 10_000,
      maxRedirects: 5,
    });
    html = response.data;
  } catch (err) {
    console.warn(`[simple-scraper] ${site.id}: falha no GET para ${url} — ${err.message}`);
    return [];
  }

  let $;
  try {
    $ = cheerio.load(html);
  } catch (err) {
    console.warn(`[simple-scraper] ${site.id}: falha ao parsear HTML — ${err.message}`);
    return [];
  }

  const elements = $(site.seletor_resultados);
  if (!elements.length) {
    console.warn(`[simple-scraper] ${site.id}: seletor "${site.seletor_resultados}" não encontrou elementos em ${url}`);
    return [];
  }

  const results = [];
  const extrai = site.extrai ?? [];

  elements.each((_, el) => {
    if (results.length >= maxResults) return false;

    const imageUrl = extrai.includes('imagem') ? extractImageUrl(el, $) : null;
    const pageUrl = extrai.includes('url') ? extractPageUrl(el, $, site.url_base) : null;
    const titulo = extrai.includes('titulo') ? extractTitle(el, $) : '';

    if (!imageUrl) return;

    results.push({
      source: site.nome ?? site.id,
      titulo,
      url: pageUrl ?? url,
      imageUrl,
      originalUrl: pageUrl ?? url,
    });
  });

  if (results.length === 0) {
    console.warn(`[simple-scraper] ${site.id}: 0 resultados com imagem em ${url}`);
  }

  return results;
}
