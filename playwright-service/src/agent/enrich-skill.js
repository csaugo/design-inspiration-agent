import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Enriquece o brief original analisando os top resultados aprovados do Passe 1
 * via Claude Vision, expandindo keywords, estilo e termos de busca.
 *
 * @param {Object} originalBrief - Brief estruturado original
 * @param {Array}  topResults    - Resultados aprovados do Passe 1 (com base64 ou metadados)
 * @returns {Object} Brief expandido com campos adicionais
 */
export async function enrichBrief(originalBrief, topResults) {
  const anchors = (topResults || []).slice(0, 4);

  if (!anchors.length) {
    console.warn('[EnrichSkill] Nenhum resultado para enriquecer. Usando brief original.');
    return originalBrief;
  }

  const contentBlocks = [];

  contentBlocks.push({
    type: 'text',
    text: `Você é um especialista em design. Analise as referências visuais abaixo e o brief original para gerar keywords e termos de busca mais específicos para uma segunda rodada de busca de inspiração.

Brief original:
- Componente: ${originalBrief.component ?? ''}
- Contexto: ${originalBrief.context ?? ''}
- Estilo: ${(originalBrief.style || []).join(', ')}
- Keywords: ${(originalBrief.keywords || []).join(', ')}
- Anti-preferências: ${(originalBrief.anti_preferences || []).join(', ')}

Referências aprovadas no Passe 1:`,
  });

  for (const result of anchors) {
    if (result.base64 && result.mediaType) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: result.mediaType || 'image/jpeg',
          data: result.base64,
        },
      });
    }
    contentBlocks.push({
      type: 'text',
      text: `[${result.source ?? 'Web'}] "${result.title ?? result.description ?? ''}" — score: ${result.scores?.score_total ?? result.score_total ?? 'N/A'}, tags: ${(result.tags || []).join(', ')}`,
    });
  }

  contentBlocks.push({
    type: 'text',
    text: `Com base nessas referências, retorne APENAS um JSON válido (sem markdown, sem explicações) com esta estrutura exata:
{
  "keywords_expanded": ["termo1", "termo2", ...],
  "style_refined":     ["estilo1", "estilo2", ...],
  "anti_preferences_expanded": ["evitar1", "evitar2", ...],
  "search_terms":      ["frase de busca 1", "frase de busca 2", ...]
}

- keywords_expanded: 8-12 termos visuais específicos derivados das referências
- style_refined: 3-5 descritores de estilo mais precisos que o brief original
- anti_preferences_expanded: padrões visuais a evitar identificados nas referências
- search_terms: 3-5 frases de busca otimizadas para encontrar mais conteúdo similar`,
  });

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
    max_tokens: 1000,
    messages: [{ role: 'user', content: contentBlocks }],
  });

  const raw = response.content.find((b) => b.type === 'text')?.text || '{}';
  const clean = raw.replace(/```json|```/g, '').trim();

  let enriched = {};
  try {
    enriched = JSON.parse(clean);
  } catch (err) {
    console.warn('[EnrichSkill] Falha ao parsear resposta, usando brief original:', err.message);
  }

  console.log(
    `[EnrichSkill] Brief enriquecido — keywords expandidas: ${(enriched.keywords_expanded || []).length}, ` +
    `search_terms: ${(enriched.search_terms || []).length}`,
  );

  return {
    ...originalBrief,
    keywords: [
      ...(originalBrief.keywords || []),
      ...(enriched.keywords_expanded || []),
    ],
    style: [
      ...(originalBrief.style || []),
      ...(enriched.style_refined || []),
    ],
    anti_preferences: [
      ...(originalBrief.anti_preferences || []),
      ...(enriched.anti_preferences_expanded || []),
    ],
    search_terms_pass2: enriched.search_terms || originalBrief.keywords || [],
    enriched: true,
  };
}
