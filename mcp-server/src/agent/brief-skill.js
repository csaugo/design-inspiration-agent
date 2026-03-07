import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `Você é um especialista em design visual com profundo conhecimento de padrões de UI/UX. Sua função é analisar pedidos de inspiração de design e transformá-los em um brief estruturado preciso.

Dado um pedido em linguagem natural, extraia e estruture:

1. COMPONENTE: Qual elemento de UI está sendo buscado (ex: hero section, pricing table, nav bar, card, modal)

2. CONTEXTO: Setor/nicho do projeto (ex: SaaS B2B, fintech, saúde, e-commerce, portfolio)

3. ESTILO: Preferências estéticas detectadas ou inferidas (ex: minimalista, bold, glassmorphism, flat, dark mode)

4. REFERÊNCIAS: Marcas mencionadas como referência (ex: "estilo Linear", "como Notion", "similar ao Stripe")

5. RESTRIÇÕES: O que definitivamente NÃO usar (ex: sem gradientes, sem animações, sem stock photos)

6. KEYWORDS: 3 a 5 palavras-chave em inglês para usar como query de busca em sites de design

7. PERGUNTAS: Máximo 3 perguntas curtas e diretas que, se respondidas, melhorariam os resultados.

Retorne APENAS um JSON válido, sem texto adicional, sem markdown, sem backticks:
{
  "component": "string",
  "context": "string",
  "style": ["string"],
  "references": ["string"],
  "anti_preferences": ["string"],
  "keywords": ["string"],
  "questions": ["string"]
}`;

export async function extractBrief(userQuery) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY não definida no ambiente');
  }

  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userQuery },
      ],
    });
  } catch (err) {
    throw new Error(`Erro ao chamar a API da Anthropic: ${err.message}`);
  }

  const rawText = response.content?.[0]?.text ?? '';

  let brief;
  try {
    brief = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Falha ao fazer parse do JSON retornado pela API. Resposta recebida: ${rawText.slice(0, 200)}`
    );
  }

  const required = ['component', 'context', 'style', 'references', 'anti_preferences', 'keywords', 'questions'];
  for (const field of required) {
    if (!(field in brief)) {
      throw new Error(`Campo obrigatório ausente no brief: "${field}"`);
    }
  }

  return brief;
}
