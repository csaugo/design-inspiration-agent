import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

const PUBLIC_DIR = '/app/public';

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

async function findAssetFile(jobId, resultId) {
  const assetsDir = path.join(PUBLIC_DIR, jobId, 'assets');
  try {
    const files = await fs.readdir(assetsDir);
    const match = files.find((f) => {
      const base = path.basename(f, path.extname(f));
      return base === resultId;
    });
    if (!match) return null;
    return path.join(assetsDir, match);
  } catch {
    return null;
  }
}

async function loadImageAsBase64(jobId, resultId, fallbackUrl) {
  const filePath = await findAssetFile(jobId, resultId);

  if (filePath) {
    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = EXT_TO_MIME[ext] ?? 'image/jpeg';
      return { data: data.toString('base64'), mimeType };
    } catch (err) {
      console.warn(`[refine-skill] erro ao ler asset local ${filePath}: ${err.message}`);
    }
  }

  if (fallbackUrl && fallbackUrl.startsWith('http')) {
    try {
      const resp = await axios.get(fallbackUrl, {
        responseType: 'arraybuffer',
        timeout: 8000,
        maxRedirects: 5,
      });
      const ct = resp.headers['content-type'] ?? 'image/jpeg';
      const mimeType = ct.split(';')[0].trim();
      return { data: Buffer.from(resp.data).toString('base64'), mimeType };
    } catch (err) {
      console.warn(`[refine-skill] fallback fetch falhou para ${fallbackUrl}: ${err.message}`);
    }
  }

  return null;
}

/**
 * Usa Claude Vision para gerar um brief enriquecido a partir das
 * imagens selecionadas e do feedback textual do designer.
 *
 * @param {Object} parentJob - Objeto completo do Redis: { job_id, brief, results_meta, selected, board_url }
 * @param {string} feedback - Feedback em linguagem natural, ex: "mais escuro, menos colorido"
 * @returns {Promise<Object>} Brief refinado com parent_job_id
 */
export async function refineBrief(parentJob, feedback) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY não definida no ambiente');
  }

  const client = new Anthropic({ apiKey });

  const jobId = parentJob.job_id;
  const resultsMeta = parentJob.results_meta ?? [];

  // Ordenar selecionados por score_total decrescente e limitar a 4
  const metaMap = Object.fromEntries(resultsMeta.map((m) => [m.resultId, m]));
  const selected = (parentJob.selected ?? [])
    .slice()
    .sort((a, b) => {
      const scoreA = metaMap[a]?.scores?.score_total ?? metaMap[a]?.score_total ?? 0;
      const scoreB = metaMap[b]?.scores?.score_total ?? metaMap[b]?.score_total ?? 0;
      return scoreB - scoreA;
    })
    .slice(0, 4);

  console.log(`[refine-skill] Carregando ${selected.length} imagem(ns) para análise Vision...`);

  // Carregar imagens como base64, rastreando quais resultIds obtiveram imagem
  const imageBlocks = [];
  const resultIdsComImagem = new Set();
  for (const resultId of selected) {
    const meta = metaMap[resultId];
    const fallbackUrl = meta?.imageUrl ?? null;
    const img = await loadImageAsBase64(jobId, resultId, fallbackUrl);
    if (img) {
      imageBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimeType,
          data: img.data,
        },
      });
      resultIdsComImagem.add(resultId);
    }
  }

  console.log(`[refine-skill] ${imageBlocks.length} imagem(ns) carregada(s) para análise.`);

  // Nível 3: fallback textual para anchors sem imagem
  const anchorsSemImagem = selected
    .filter((resultId) => !resultIdsComImagem.has(resultId))
    .map((resultId) => metaMap[resultId])
    .filter(Boolean);

  let textualFallback = '';
  if (anchorsSemImagem.length > 0) {
    if (anchorsSemImagem.length === selected.length) {
      console.warn('[refine-skill] Refinando apenas por metadados — nenhuma imagem disponível.');
    } else {
      console.warn(
        `[refine-skill] ${anchorsSemImagem.length} anchor(s) sem imagem — usando metadados como fallback.`
      );
    }
    textualFallback =
      '\n\nReferências adicionais (sem imagem disponível):\n' +
      anchorsSemImagem
        .map(
          (m) =>
            `- resultId: ${m.resultId} (fonte: ${m.source}, score: ${m.score_total ?? 'N/A'})`
        )
        .join('\n');
  }

  // Montar o content do usuário: texto + blocos de imagem
  const userContent = [
    {
      type: 'text',
      text: `Brief original do projeto:\n${JSON.stringify(parentJob.brief, null, 2)}\n\nFeedback do designer sobre as referências atuais:\n"${feedback}"${textualFallback}\n\nAbaixo estão as imagens selecionadas pelo designer como referência visual. Com base nelas e no feedback, gere um brief refinado em JSON com exatamente este formato:\n{\n  "component": string (igual ao original),\n  "context": string (igual ao original),\n  "style": string (refinado com base nas imagens e no feedback),\n  "keywords": array de strings (expandido — adicione termos visuais específicos que você observou nas imagens),\n  "anti_preferences": array de strings (o que evitar — inferido do feedback),\n  "refinement_notes": string (1 parágrafo explicando o que mudou e por quê),\n  "visual_anchors": array de strings com descrições de 1 frase de cada imagem selecionada\n}`,
    },
    ...imageBlocks,
  ];

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2048,
      system:
        'Você é um especialista em design que analisa referências visuais e gera briefs estruturados. Responda APENAS com JSON válido, sem markdown, sem backticks, sem texto adicional.',
      messages: [{ role: 'user', content: userContent }],
    });
  } catch (err) {
    throw new Error(`Erro ao chamar a API da Anthropic (refine): ${err.message}`);
  }

  const rawText = response.content?.[0]?.text ?? '';

  // Sanitizar markdown code fences antes de JSON.parse()
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let briefRefinado;
  try {
    briefRefinado = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Falha ao fazer parse do JSON retornado pelo Claude (refine). Resposta: ${rawText.slice(0, 400)}`
    );
  }

  const required = ['component', 'context', 'style', 'keywords', 'anti_preferences', 'refinement_notes', 'visual_anchors'];
  for (const field of required) {
    if (!(field in briefRefinado)) {
      throw new Error(`Campo obrigatório ausente no brief refinado: "${field}"`);
    }
  }

  briefRefinado.parent_job_id = jobId;

  console.log(`[refine-skill] Brief refinado gerado. Notes: ${briefRefinado.refinement_notes?.slice(0, 100)}...`);

  return briefRefinado;
}
