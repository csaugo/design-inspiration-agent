import 'dotenv/config';
import Bull from 'bull';
import { createClient } from 'redis';
import { searchUnsplash } from './scrapers/api-scraper.js';
import { generateMoodboard } from './moodboard/generator.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const moodboardBaseUrl = process.env.MOODBOARD_BASE_URL ?? 'http://localhost:8081';
const maxResults = parseInt(process.env.MAX_RESULTS_PER_SITE ?? '6', 10);

const queue = new Bull('inspiration-jobs', redisUrl);

async function updateJobInRedis(redis, jobId, updates) {
  const key = `job:${jobId}`;
  const raw = await redis.get(key);
  const existing = raw ? JSON.parse(raw) : {};
  const updated = { ...existing, ...updates };
  await redis.set(key, JSON.stringify(updated), { EX: 86400 });
}

queue.process(async (job) => {
  const { job_id: jobId, brief } = job.data;

  console.log(`Job ${jobId} recebido`);

  const redis = createClient({ url: redisUrl });
  await redis.connect();

  try {
    const keywords = Array.isArray(brief?.keywords) ? brief.keywords : [];

    if (keywords.length === 0) {
      throw new Error('Brief não contém keywords válidas');
    }

    console.log(`Buscando ${maxResults} imagens no Unsplash para: ${keywords.join(', ')}...`);
    const results = await searchUnsplash(keywords, maxResults);

    const relativePath = await generateMoodboard(jobId, brief, results);
    const boardUrl = `${moodboardBaseUrl}/${relativePath}`;

    console.log(`Moodboard gerado: ${boardUrl}`);

    await updateJobInRedis(redis, jobId, {
      status: 'pass1_done',
      board_url: boardUrl,
      results_count: results.length,
      completed_at: new Date().toISOString(),
    });

    console.log(`Job ${jobId} concluído`);
  } catch (err) {
    console.error(`Erro no job ${jobId}:`, err.message);
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

console.log(`playwright-service conectado ao Redis: ${redisUrl}`);
