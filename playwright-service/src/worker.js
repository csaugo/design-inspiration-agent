import 'dotenv/config';
import Bull from 'bull';
import { createClient } from 'redis';
import { searchUnsplash } from './scrapers/api-scraper.js';
import { scrapeSimple } from './scrapers/simple-scraper.js';
import { scrapePlaywright } from './scrapers/playwright-scraper.js';
import { selectSites } from './site-selector.js';
import { generateMoodboard } from './moodboard/generator.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const moodboardBaseUrl = process.env.MOODBOARD_BASE_URL ?? 'http://localhost:8081';
const maxResultsPerSite = parseInt(process.env.MAX_RESULTS_PER_SITE ?? '6', 10);
const maxTotalResults = 12;

const queue = new Bull('inspiration-jobs', redisUrl);

async function updateJobInRedis(redis, jobId, updates) {
  const key = `job:${jobId}`;
  const raw = await redis.get(key);
  const existing = raw ? JSON.parse(raw) : {};
  const updated = { ...existing, ...updates };
  await redis.set(key, JSON.stringify(updated), { EX: 86400 });
}

/**
 * Normaliza um resultado de qualquer fonte para o formato esperado
 * pelo generateMoodboard: { source, description, author, url_thumb, url_full, url_page }
 */
function normalizeResult(item) {
  if (item.imageUrl) {
    return {
      source: item.source ?? 'Web',
      description: item.titulo ?? '',
      author: item.source ?? '',
      url_thumb: item.imageUrl,
      url_full: item.imageUrl,
      url_page: item.originalUrl ?? item.url ?? item.imageUrl,
    };
  }
  return item;
}

/**
 * Deduplica resultados por url_thumb, mantendo a primeira ocorrência.
 */
function deduplicate(results) {
  const seen = new Set();
  return results.filter((r) => {
    const key = r.url_thumb ?? r.imageUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

queue.process(async (job) => {
  const { job_id: jobId, brief } = job.data;

  const redis = createClient({ url: redisUrl });
  await redis.connect();

  try {
    const keywords = Array.isArray(brief?.keywords) ? brief.keywords : [];

    if (keywords.length === 0) {
      throw new Error('Brief não contém keywords válidas');
    }

    const query = keywords.join(' ');

    // Query curta para scraping HTTP (sites de inspiração não suportam frases longas)
    const scrapeQuery = [brief.component, brief.context]
      .filter(Boolean)
      .join(' ') || keywords[0] || query;

    const selectedSites = selectSites(brief, {
      maxTier: 3,
      limit: 5,
      includeUnsplash: true,
      minPlaywright: 2,
    });

    console.log(
      `[worker] job=${jobId} — sites selecionados: ${selectedSites.map((s) => s.id).join(', ')}`,
    );

    const settledResults = await Promise.allSettled(
      selectedSites.map(async (site) => {
        if (site.tier === 'unsplash') {
          const items = await searchUnsplash(keywords, maxResultsPerSite);
          console.log(`[worker] Unsplash → ${items.length} resultados`);
          return items;
        }

        if (site.tier === 'tier2_simple') {
          const items = await scrapeSimple(site, scrapeQuery, maxResultsPerSite);
          console.log(`[worker] ${site.nome} (tier2_simple) → ${items.length} resultados`);
          return items;
        }

        if (site.tier === 'tier2_playwright') {
          const items = await scrapePlaywright(site, scrapeQuery, maxResultsPerSite);
          console.log(`[worker] ${site.nome} (tier2_playwright) → ${items.length} resultados`);
          return items;
        }

        console.log(`[worker] ${site.id} tier=${site.tier} — não suportado neste passo, pulando`);
        return [];
      }),
    );

    const rawResults = settledResults.flatMap((r) =>
      r.status === 'fulfilled' ? r.value : [],
    );

    const normalized = rawResults.map(normalizeResult);
    const deduped = deduplicate(normalized);
    const results = deduped.slice(0, maxTotalResults);

    console.log(
      `[worker] job=${jobId} — total após dedup: ${deduped.length}, usando: ${results.length}`,
    );

    const relativePath = await generateMoodboard(jobId, brief, results);
    const boardUrl = `${moodboardBaseUrl}/${relativePath}`;

    await updateJobInRedis(redis, jobId, {
      status: 'ready',
      board_url: boardUrl,
      results_count: results.length,
      sources: [...new Set(results.map((r) => r.source))],
      completed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[worker] job=${jobId} — erro: ${err.message}`);
    await updateJobInRedis(redis, jobId, {
      status: 'error',
      error: err.message,
      completed_at: new Date().toISOString(),
    }).catch(() => {});
    throw err;
  } finally {
    await redis.disconnect();
  }
});

console.log('[worker] Aguardando jobs na fila inspiration-jobs…');
