import { createClient } from 'redis';
import { extractBrief } from '../agent/brief-skill.js';

function getRedisClient() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const client = createClient({ url });
  client.on('error', (err) => console.error('[Redis] erro de conexão:', err));
  return client;
}

export async function searchInspiration(query) {
  const brief = await extractBrief(query);

  const jobId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const job = {
    job_id: jobId,
    status: 'queued',
    brief,
    created_at: createdAt,
    pass: 1,
  };

  const redis = getRedisClient();
  await redis.connect();
  try {
    await redis.set(`job:${jobId}`, JSON.stringify(job), { EX: 86400 });
  } finally {
    await redis.disconnect();
  }

  return {
    job_id: jobId,
    status: 'queued',
    brief,
    message: 'Busca iniciada. Use get_results(job_id) para acompanhar o progresso.',
    clarification_questions: brief.questions ?? [],
  };
}
