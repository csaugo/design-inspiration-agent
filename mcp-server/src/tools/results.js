import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

function getRedisClient() {
  const client = createClient({ url: redisUrl });
  client.on('error', (err) => console.error('[Redis] erro de conexão:', err));
  return client;
}

export async function getResults(jobId) {
  const redis = getRedisClient();
  await redis.connect();

  let job;
  try {
    const raw = await redis.get(`job:${jobId}`);
    if (!raw) {
      return { error: 'Job não encontrado ou expirado' };
    }
    job = JSON.parse(raw);
  } finally {
    await redis.disconnect();
  }

  const { status } = job;

  if (status === 'queued' || status === 'processing') {
    return {
      job_id: jobId,
      status: 'processing',
      message: 'Busca em andamento. Tente novamente em alguns segundos.',
    };
  }

  if (status === 'pass1_done') {
    return {
      job_id: jobId,
      status: 'pass1_done',
      board_url: job.board_url,
      results_count: job.results_count,
      sources: job.sources ?? [],
      pass2_running: true,
      message: 'Passe 1 concluído. Passe 2 em execução — o moodboard será atualizado em breve.',
    };
  }

  if (status === 'ready') {
    return {
      job_id: jobId,
      status: 'ready',
      board_url: job.board_url,
      results_count: job.results_count,
      sources: job.sources ?? [],
      clarification_questions: job.brief?.questions ?? [],
      pass2_complete: job.pass === 2,
      enriched: job.enriched || false,
      message: 'Moodboard pronto! Acesse a URL para visualizar e selecionar as referências.',
    };
  }

  if (status === 'error') {
    return {
      job_id: jobId,
      status: 'error',
      message: job.error ?? 'Erro desconhecido',
    };
  }

  return {
    job_id: jobId,
    status: status ?? 'unknown',
    message: 'Status não reconhecido.',
  };
}
