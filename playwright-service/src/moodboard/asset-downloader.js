import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

const PUBLIC_DIR = '/app/public';

const CONTENT_TYPE_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
};

function inferExt(contentType) {
  if (!contentType) return '.jpg';
  const base = contentType.split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_TO_EXT[base] ?? '.jpg';
}

function sanitizeSource(source) {
  return String(source ?? 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20) || 'unknown';
}

async function downloadSingle(result, index, assetsDir) {
  const imageUrl = result.url_thumb ?? result.imageUrl;

  if (!imageUrl || typeof imageUrl !== 'string') return result;
  if (!imageUrl.startsWith('http')) return result;
  if (imageUrl.startsWith('data:image')) return result;

  const source = sanitizeSource(result.source);
  const indexStr = String(index + 1).padStart(2, '0');
  const resultId = `${indexStr}_${source}`;

  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 12000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DesignInspiration/1.0)',
      },
    });

    const ext = inferExt(response.headers['content-type']);
    const fileName = `${resultId}${ext}`;
    const filePath = path.join(assetsDir, fileName);

    await fs.writeFile(filePath, response.data);

    return {
      ...result,
      localImagePath: `assets/${fileName}`,
      resultId,
    };
  } catch (err) {
    console.warn(`[asset-downloader] falha ao baixar ${imageUrl}: ${err.message}`);
    return { ...result, resultId };
  }
}

/**
 * Baixa as imagens originais de cada resultado para o disco local.
 * @param {string} jobId
 * @param {Array} results - Array normalizado de resultados
 * @returns {Promise<Array>} Results enriquecidos com localImagePath e resultId
 */
export async function downloadAssets(jobId, results) {
  const assetsDir = path.join(PUBLIC_DIR, jobId, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const CONCURRENCY = 6;
  const enriched = new Array(results.length);

  for (let i = 0; i < results.length; i += CONCURRENCY) {
    const chunk = results.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((result, offset) => downloadSingle(result, i + offset, assetsDir)),
    );

    settled.forEach((outcome, offset) => {
      if (outcome.status === 'fulfilled') {
        enriched[i + offset] = outcome.value;
      } else {
        console.warn(`[asset-downloader] erro inesperado no índice ${i + offset}: ${outcome.reason}`);
        enriched[i + offset] = { ...results[i + offset], resultId: `${String(i + offset + 1).padStart(2, '0')}_${sanitizeSource(results[i + offset].source)}` };
      }
    });
  }

  const downloaded = enriched.filter((r) => r.localImagePath).length;
  console.log(`[asset-downloader] job=${jobId} — ${downloaded}/${results.length} imagens baixadas`);

  return enriched;
}
