import Bull from 'bull';
import { createClient } from 'redis';
import { extractBrief } from '../agent/brief-skill.js';
import { refineBrief } from '../agent/refine-skill.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const mcpBaseUrl = process.env.MCP_BASE_URL ?? 'http://31.97.21.86:3001';
const MOODBOARD_EXPIRY_HOURS = Number(process.env.MOODBOARD_EXPIRY_HOURS ?? 24);

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

export async function refineSearch(jobId, feedback) {
  // 1. Ler job pai do Redis
  const redis = getRedisClient();
  await redis.connect();
  let parentJob;
  try {
    const raw = await redis.get(`job:${jobId}`);
    if (!raw) throw new Error('Job não encontrado ou expirado.');
    parentJob = JSON.parse(raw);
  } finally {
    await redis.disconnect();
  }

  // 2. Resolver seleção: usa selected salvo no Redis ou fallback top-3 por score
  let selectedIds = parentJob.selected ?? [];
  if (selectedIds.length === 0) {
    console.warn(
      `[Refine] Nenhuma seleção encontrada para job ${jobId}. Usando top-3 por score como proxy.`
    );
    const resultsMeta = parentJob.results_meta ?? [];
    const top3 = [...resultsMeta]
      .sort((a, b) => (b.score_total ?? 0) - (a.score_total ?? 0))
      .slice(0, 3);
    selectedIds = top3.map((r) => r.resultId);
    if (selectedIds.length === 0) {
      throw new Error(
        'Job pai não possui resultados. Execute get_results primeiro e aguarde o status "ready".'
      );
    }
  }
  parentJob.selected = selectedIds;

  // 3. Gerar brief refinado via Claude Vision
  const briefRefinado = await refineBrief(parentJob, feedback);

  // 4. Gerar job filho
  const jobIdFilho = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const ttl = MOODBOARD_EXPIRY_HOURS * 3600;

  const jobFilho = {
    job_id: jobIdFilho,
    status: 'queued',
    parent_job_id: jobId,
    brief: briefRefinado,
    query: feedback,
    board_url: null,
    created_at: createdAt,
    pass: 1,
  };

  // 5. Salvar job filho no Redis
  const redis2 = getRedisClient();
  await redis2.connect();
  try {
    await redis2.set(`job:${jobIdFilho}`, JSON.stringify(jobFilho), { EX: ttl });
  } finally {
    await redis2.disconnect();
  }

  // 6. Publicar na fila Bull
  const queue = getQueue();
  try {
    await queue.add({
      job_id: jobIdFilho,
      query: feedback,
      brief: briefRefinado,
      isRefinement: true,
      pass: 1,
    });
  } finally {
    await queue.close();
  }

  const pollUrl = `${mcpBaseUrl}/mcp/get_results/${jobIdFilho}`;

  return {
    job_id: jobIdFilho,
    parent_job_id: jobId,
    poll_url: pollUrl,
    refinement_notes: briefRefinado.refinement_notes,
    visual_anchors: briefRefinado.visual_anchors,
    message: 'Refinamento em andamento. Use get_results com o novo job_id para acompanhar.',
  };
}
