import 'dotenv/config';
import Bull from 'bull';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const queue = new Bull('inspiration-jobs', redisUrl);

queue.process(async (job) => {
  console.log('Job recebido:', job.id, job.data);
});

console.log(`playwright-service conectado ao Redis: ${redisUrl}`);
