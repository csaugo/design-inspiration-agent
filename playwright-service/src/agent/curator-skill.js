import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const BATCH_SIZE = 8;
const FETCH_TIMEOUT_MS = 8000;

const DEFAULT_SCORES = {
  relevancia: 50,
  estilo: 50,
  qualidade: 50,
  aplicabilidade: 50,
  score_total: 50,
  motivo: 'score estimado (erro de avaliação)',
};

/**
 * Infere o media_type da imagem pela extensão da URL.
 */
function inferMediaType(url) {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

/**
 * Sanitiza markdown code fences antes do JSON.parse().
 */
function sanitizeJson(text) {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

/**
 * Verifica se uma URL de imagem é válida para avaliação.
 */
function isValidImageUrl(url) {
  if (!url) return false;
  if (!url.startsWith('http')) return false;
  if (url.startsWith('data:')) return false;
  // Rejeita imagens 1x1 (tracking pixels)
  if (url.includes('1x1') || url.includes('pixel')) return false;
  return true;
}

/**
 * Avalia uma imagem com Claude Vision e retorna scores estruturados.
 * @param {string} imageUrl - URL da imagem a avaliar
 * @param {Object} brief - Brief do projeto
 * @returns {Promise<Object>} Objeto de scores
 */
export async function scoreImage(imageUrl, brief) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(imageUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return { ...DEFAULT_SCORES };
    }

    const contentType = response.headers.get('content-type') ?? '';
    let mediaType;
    if (contentType.includes('image/png')) mediaType = 'image/png';
    else if (contentType.includes('image/webp')) mediaType = 'image/webp';
    else if (contentType.includes('image/gif')) mediaType = 'image/gif';
    else if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) mediaType = 'image/jpeg';
    else mediaType = inferMediaType(imageUrl);

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    const styleStr = Array.isArray(brief.style) ? brief.style.join(', ') : (brief.style ?? '');
    const keywordsStr = Array.isArray(brief.keywords) ? brief.keywords.join(', ') : '';
    const antiPrefsStr = Array.isArray(brief.anti_preferences) && brief.anti_preferences.length > 0
      ? brief.anti_preferences.join(', ')
      : 'nenhuma';

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 512,
      system: `Você é um curador de design especialista.
Avalie imagens de referência visual com base em um brief específico. Responda APENAS com JSON válido, sem texto adicional, sem markdown.`,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64,
              },
            },
            {
              type: 'text',
              text: `Brief do projeto:
- Componente: ${brief.component ?? ''}
- Contexto: ${brief.context ?? ''}
- Estilo: ${styleStr}
- Palavras-chave: ${keywordsStr}
- Anti-preferências: ${antiPrefsStr}

Avalie esta imagem em 4 dimensões (0-100 cada) e retorne APENAS este JSON:
{
  "relevancia": <0-100>,
  "estilo": <0-100>,
  "qualidade": <0-100>,
  "aplicabilidade": <0-100>,
  "score_total": <média ponderada: relevancia*0.35 + estilo*0.25 + qualidade*0.20 + aplicabilidade*0.20>,
  "motivo": "<1 frase explicando a avaliação principal>"
}`,
            },
          ],
        },
      ],
    });

    const rawText = message.content[0]?.text ?? '';
    const cleaned = sanitizeJson(rawText);
    const parsed = JSON.parse(cleaned);

    return {
      relevancia: Number(parsed.relevancia ?? 50),
      estilo: Number(parsed.estilo ?? 50),
      qualidade: Number(parsed.qualidade ?? 50),
      aplicabilidade: Number(parsed.aplicabilidade ?? 50),
      score_total: Number(parsed.score_total ?? 50),
      motivo: String(parsed.motivo ?? ''),
    };
  } catch (err) {
    console.error(`[curator] scoreImage erro para ${imageUrl}: ${err.message}`);
    return { ...DEFAULT_SCORES };
  }
}

/**
 * Avalia um array de resultados com Claude Vision e retorna com scores,
 * ordenado por score_total decrescente.
 * @param {Array} results - Array de resultados normalizados
 * @param {Object} brief - Brief do projeto
 * @returns {Promise<Array>} Array com campo `scores` adicionado, ordenado por score
 */
export async function curateResults(results, brief) {
  // Filtrar apenas resultados com imageUrl válida
  const imageKey = (r) => r.url_thumb ?? r.imageUrl ?? '';

  const valid = results.filter((r) => isValidImageUrl(imageKey(r)));
  const invalid = results.filter((r) => !isValidImageUrl(imageKey(r)));

  console.log(`[curator] ${valid.length} imagens válidas para avaliação, ${invalid.length} ignoradas`);

  const scored = [];

  // Processar em batches de BATCH_SIZE
  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const batch = valid.slice(i, i + BATCH_SIZE);
    console.log(`[curator] avaliando batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(valid.length / BATCH_SIZE)} (${batch.length} imagens)`);

    const batchResults = await Promise.allSettled(
      batch.map(async (item) => {
        const url = imageKey(item);
        const scores = await scoreImage(url, brief);
        console.log(`[curator] score_total=${scores.score_total} — ${url.slice(0, 60)}…`);
        return { ...item, scores };
      }),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        scored.push(result.value);
      } else {
        // Se a promessa falhou, usar item original com scores padrão
        const idx = batchResults.indexOf(result);
        scored.push({ ...batch[idx], scores: { ...DEFAULT_SCORES } });
      }
    }
  }

  // Adicionar inválidos com scores padrão
  const invalidWithScores = invalid.map((r) => ({ ...r, scores: { ...DEFAULT_SCORES } }));

  const all = [...scored, ...invalidWithScores];

  // Ordenar por score_total decrescente
  all.sort((a, b) => (b.scores?.score_total ?? 0) - (a.scores?.score_total ?? 0));

  return all;
}
