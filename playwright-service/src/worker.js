import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import Bull from 'bull';
import { createClient } from 'redis';
import { searchUnsplash } from './scrapers/api-scraper.js';
import { scrapeSimple } from './scrapers/simple-scraper.js';
import { scrapePlaywright } from './scrapers/playwright-scraper.js';
import { scrape as mobbinScrape } from './scrapers/mobbin-scraper.js';
import { scrape as pinterestScrape } from './scrapers/pinterest-scraper.js';
import { selectSites, getTier3Sites } from './site-selector.js';
import { generateMoodboard } from './moodboard/generator.js';
import { downloadAssets } from './moodboard/asset-downloader.js';
import { packageSelection } from './moodboard/zip-packager.js';
import { curateResults } from './agent/curator-skill.js';
import { enrichBrief } from './agent/enrich-skill.js';
import { cleanupExpiredJobs } from './cleanup.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const moodboardBaseUrl = process.env.MOODBOARD_BASE_URL ?? 'http://localhost:8081';
const maxResultsPerSite = parseInt(process.env.MAX_RESULTS_PER_SITE ?? '6', 10);
const maxTotalResults = 24;
const curatorMinScore    = parseFloat(process.env.CURATOR_MIN_SCORE    ?? '45');
const curatorMaxResults  = parseInt(process.env.CURATOR_MAX_RESULTS   ?? '12', 10);
const curatorMinFallback = parseInt(process.env.CURATOR_MIN_FALLBACK  ?? '3',  10);
const PUBLIC_DIR = '/app/public';

const queue = new Bull('inspiration-jobs', redisUrl);

async function updateJobInRedis(redis, jobId, updates) {
  const key = `job:${jobId}`;
  const raw = await redis.get(key);
  const existing = raw ? JSON.parse(raw) : {};
  const updated = { ...existing, ...updates };
  await redis.set(key, JSON.stringify(updated), { EX: 86400 });
  return updated;
}

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

function deduplicate(results) {
  const seen = new Set();
  return results.filter((r) => {
    const key = r.url_thumb ?? r.imageUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Monitor de seleção: gera ZIP quando seleção é salva ────────────────────

async function checkPendingZips() {
  let dirs = [];
  try {
    const entries = await fs.readdir(PUBLIC_DIR, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }

  if (dirs.length === 0) return;

  const redis = createClient({ url: redisUrl });
  redis.on('error', () => {});
  await redis.connect();

  try {
    for (const jobId of dirs) {
      const raw = await redis.get(`job:${jobId}`);
      if (!raw) continue;

      const job = JSON.parse(raw);
      if (!job.selected || job.selected.length === 0) continue;
      if (job.zip_generated) continue;

      console.log(`[worker] zip-monitor — gerando ZIP para job=${jobId}`);
      try {
        await packageSelection(jobId, job.selected, job.selected_at);
        const key = `job:${jobId}`;
        const rawAgain = await redis.get(key);
        const existing = rawAgain ? JSON.parse(rawAgain) : {};
        await redis.set(key, JSON.stringify({ ...existing, zip_generated: true }), { EX: 86400 });
        console.log(`[worker] zip-monitor — ZIP pronto para job=${jobId}`);
      } catch (err) {
        console.error(`[worker] zip-monitor — erro ao gerar ZIP para job=${jobId}: ${err.message}`);
      }
    }
  } finally {
    await redis.disconnect();
  }
}

// ── Curadoria reutilizável (Pass 1 e Pass 2) ──────────────────────────────

async function runCuration(candidates, brief) {
  const curatedResults = await curateResults(candidates, brief);

  let approved = curatedResults.filter(
    (r) => (r.scores?.score_total ?? 100) >= curatorMinScore,
  );

  if (approved.length < curatorMinFallback && curatedResults.length > 0) {
    const sorted = [...curatedResults].sort(
      (a, b) => (b.scores?.score_total ?? 0) - (a.scores?.score_total ?? 0),
    );
    approved = sorted.slice(0, Math.min(curatorMinFallback, sorted.length));
    console.warn(
      `[Curator] Threshold ${curatorMinScore} aprovou apenas ${approved.length < curatorMinFallback ? approved.length : 0} resultado(s). ` +
      `Fallback top-${approved.length} ativado. ` +
      `Score mais alto disponível: ${approved[0]?.scores?.score_total ?? 'N/A'}`,
    );
  }

  return approved.slice(0, curatorMaxResults);
}

// ── Processador da fila ────────────────────────────────────────────────────

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
    const scrapeQuery = [brief.component, brief.context]
      .filter(Boolean)
      .join(' ') || keywords[0] || query;

    const siteLimit = job.data.pass === 2 ? 15 : 5;
    const selectedSites = selectSites(brief, {
      maxTier: 3,
      limit: siteLimit,
      includeUnsplash: true,
      minPlaywright: 2,
    });

    // Tier 3 é executado à parte para não competir com o limite de seleção
    const tier3Sites = getTier3Sites();
    const tier3Active = tier3Sites.filter(
      (s) => s.id === 'mobbin' || s.id === 'pinterest',
    );
    console.log(
      `[worker] job=${jobId} — sites selecionados: ${selectedSites.map((s) => s.id).join(', ')}`,
    );
    console.log(
      `[worker] Tier 3: ${tier3Sites.length} sites configurados, ${tier3Active.length} ativos`,
    );

    const settledResults = await Promise.allSettled([
      ...selectedSites.map(async (site) => {
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
        console.log(`[worker] ${site.id} tier=${site.tier} — não suportado, pulando`);
        return [];
      }),
      // Tier 3 — scrapers autenticados (silenciosos se sem credenciais)
      ...tier3Active.map(async (site) => {
        if (site.id === 'mobbin') {
          const items = await mobbinScrape(site, keywords);
          console.log(`[worker] Mobbin (tier3) → ${items.length} resultados`);
          return items;
        }
        if (site.id === 'pinterest') {
          const items = await pinterestScrape(site, keywords);
          console.log(`[worker] Pinterest (tier3) → ${items.length} resultados`);
          return items;
        }
        return [];
      }),
    ]);

    const rawResults = settledResults.flatMap((r) =>
      r.status === 'fulfilled' ? r.value : [],
    );

    const normalized = rawResults.map(normalizeResult);
    const deduped = deduplicate(normalized);
    const precurator = deduped.slice(0, maxTotalResults);

    console.log(
      `[worker] job=${jobId} — total após dedup: ${deduped.length}, enviando ${precurator.length} para curadoria`,
    );

    // 4. Curar com Claude Vision (usa runCuration reutilizável)
    const results = await runCuration(precurator, brief);

    const avgScore = results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + (r.scores?.score_total ?? 0), 0) / results.length)
      : 0;

    console.log(
      `[worker] job=${jobId} — após curadoria: ${results.length} aprovados (pass=${job.data.pass ?? 1}), score médio: ${avgScore}`,
    );

    // 6. Baixar imagens para disco
    const enrichedResults = await downloadAssets(jobId, results);

    // ── Bifurcação Pass 1 / Pass 2 ──────────────────────────────────────────
    const isPass2 = job.data.pass === 2;

    if (!isPass2) {
      // ── FIM DO PASSE 1 ────────────────────────────────────────────────────
      // 7. Gerar moodboard do Passe 1
      const relativePath = await generateMoodboard(jobId, enrichedResults, brief);
      const boardUrl = `${moodboardBaseUrl}/${relativePath}`;

      // 8. Montar results_meta leve
      const resultsMeta = enrichedResults.map((r) => ({
        resultId: r.resultId,
        imageUrl: r.url_thumb ?? r.imageUrl ?? '',
        localImagePath: r.localImagePath ?? null,
        source: r.source,
        score_total: r.scores?.score_total ?? null,
      }));

      await updateJobInRedis(redis, jobId, {
        status: 'pass1_done',
        board_url: boardUrl,
        results_count: results.length,
        avg_score: avgScore,
        sources: [...new Set(results.map((r) => r.source))],
        created_at: new Date().toISOString(),
        zip_url: `${moodboardBaseUrl}/${jobId}/moodboard.zip`,
        results_meta: resultsMeta,
        pass1_results: resultsMeta,
      });

      // Enriquece brief com top-4 por score
      const topForEnrich = [...resultsMeta]
        .sort((a, b) => (b.score_total ?? 0) - (a.score_total ?? 0))
        .slice(0, 4);

      const enrichedBriefData = await enrichBrief(brief, topForEnrich);

      // Enfileira Passe 2 na mesma fila Bull
      await queue.add(
        {
          ...job.data,
          pass: 2,
          brief: enrichedBriefData,
          pass1_results: resultsMeta,
        },
        {
          attempts: 2,
          backoff: { type: 'fixed', delay: 3000 },
        },
      );

      console.log(`[Worker] Passe 1 concluído para job ${jobId}. Passe 2 enfileirado.`);

    } else {
      // ── FIM DO PASSE 2 ────────────────────────────────────────────────────
      const pass1Results = job.data.pass1_results || [];

      // Converte pass1_results (leve) para formato compatível com moodboard
      const pass1ForBoard = pass1Results.map((r) => ({
        resultId: r.resultId,
        url_thumb: r.imageUrl,
        url_full: r.imageUrl,
        source: r.source ?? 'Web',
        description: '',
        author: r.source ?? '',
        localImagePath: r.localImagePath ?? null,
        scores: r.score_total != null ? { score_total: r.score_total } : undefined,
      }));

      // Pool acumulado: Passe 1 (aprovados) + Passe 2 (novos aprovados)
      const allForMoodboard = [...pass1ForBoard, ...enrichedResults];

      // 7. Moodboard final com pool acumulado (sobrescreve board.html do Passe 1)
      const relativePath = await generateMoodboard(jobId, allForMoodboard, brief);
      const boardUrl = `${moodboardBaseUrl}/${relativePath}`;

      // 8. Montar results_meta do pool completo
      const allResultsMeta = allForMoodboard.map((r) => ({
        resultId: r.resultId,
        imageUrl: r.url_thumb ?? r.imageUrl ?? '',
        localImagePath: r.localImagePath ?? null,
        source: r.source,
        score_total: r.scores?.score_total ?? null,
      }));

      console.log(
        `[Worker] Passe 2 concluído para job ${jobId}. ` +
        `Pool total: ${allForMoodboard.length} ` +
        `(Passe 1: ${pass1Results.length}, Passe 2 novos: ${enrichedResults.length})`,
      );

      await updateJobInRedis(redis, jobId, {
        status: 'ready',
        board_url: boardUrl,
        results_count: allForMoodboard.length,
        avg_score: avgScore,
        sources: [...new Set(allForMoodboard.map((r) => r.source))],
        completed_at: new Date().toISOString(),
        zip_url: `${moodboardBaseUrl}/${jobId}/moodboard.zip`,
        results_meta: allResultsMeta,
        pass: 2,
        enriched: true,
      });
    }
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

// ── Agendamentos ───────────────────────────────────────────────────────────

setInterval(checkPendingZips, 5000);

cleanupExpiredJobs().catch((err) =>
  console.error('[worker] cleanup inicial falhou:', err.message),
);
setInterval(
  () => cleanupExpiredJobs().catch((err) => console.error('[worker] cleanup falhou:', err.message)),
  6 * 60 * 60 * 1000,
);

console.log('[worker] Aguardando jobs na fila inspiration-jobs…');
console.log('[worker] Monitor de ZIP ativo (intervalo: 5s)');
console.log('[worker] Limpeza automática agendada (intervalo: 6h)');
