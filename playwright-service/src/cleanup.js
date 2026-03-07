import fs from 'fs/promises';
import path from 'path';
import { createClient } from 'redis';

const PUBLIC_DIR = '/app/public';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Remove diretórios de jobs cujas chaves no Redis já expiraram.
 * @returns {Promise<{cleaned: number}>}
 */
export async function cleanupExpiredJobs() {
  let entries = [];
  try {
    entries = await fs.readdir(PUBLIC_DIR, { withFileTypes: true });
  } catch (err) {
    console.warn(`[cleanup] não foi possível listar ${PUBLIC_DIR}: ${err.message}`);
    return { cleaned: 0 };
  }

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length === 0) return { cleaned: 0 };

  const redis = createClient({ url: REDIS_URL });
  redis.on('error', (err) => console.error('[cleanup] Redis erro:', err));
  await redis.connect();

  let cleaned = 0;
  try {
    for (const jobId of dirs) {
      const exists = await redis.exists(`job:${jobId}`);
      if (!exists) {
        const dirPath = path.join(PUBLIC_DIR, jobId);
        try {
          await fs.rm(dirPath, { recursive: true, force: true });
          console.log(`[cleanup] Limpando job expirado: ${jobId}`);
          cleaned++;
        } catch (err) {
          console.warn(`[cleanup] falha ao remover ${dirPath}: ${err.message}`);
        }
      }
    }
  } finally {
    await redis.disconnect();
  }

  if (cleaned > 0) {
    console.log(`[cleanup] ${cleaned} job(s) expirado(s) removidos`);
  }

  return { cleaned };
}
