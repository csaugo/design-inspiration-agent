import Bull from 'bull';
import { createClient } from 'redis';
import { extractBrief } from '../agent/brief-skill.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const mcpBaseUrl = process.env.MCP_BASE_URL ?? 'http://31.97.21.86:3001';

function getRedisClient() {
  const client = createClient({ url: redisUrl });
  client.on('error', (err) => console.error('[Redis] erro de conexão:', err));
  return client;
}

function getQueue() {
  return new Bull('inspiration-jobs', redisUrl);
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

  const queue = getQueue();
  try {
    await queue.add({ job_id: jobId, brief, pass: 1 });
  } finally {
    await queue.close();
  }

  const pollUrl = `${mcpBaseUrl}/mcp/get_results/${jobId}`;

  return {
    job_id: jobId,
    status: 'queued',
    brief,
    message: 'Busca iniciada. Use get_results(job_id) para acompanhar o progresso.',
    clarification_questions: brief.questions ?? [],
    poll_url: pollUrl,
  };
}
