import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SITES_JSON_PATH = path.resolve(__dirname, '..', 'config/sites.json');

let _sitesCache = null;

function loadSites() {
  if (_sitesCache) return _sitesCache;
  try {
    _sitesCache = require(SITES_JSON_PATH);
  } catch {
    _sitesCache = { tier1: [], tier2_simple: [], tier2_playwright: [], tier3: [], disabled: [] };
  }
  return _sitesCache;
}

const TIER_BONUS = {
  tier1: 5,
  tier2_simple: 3,
  tier2_playwright: 3,
  tier3: 0,
};

const MAX_TIER_MAP = {
  1: ['tier1'],
  2: ['tier1', 'tier2_simple'],
  3: ['tier1', 'tier2_simple', 'tier2_playwright'],
  4: ['tier1', 'tier2_simple', 'tier2_playwright', 'tier3'],
};

const UNSPLASH_VIRTUAL = {
  id: 'unsplash',
  nome: 'Unsplash',
  tier: 'unsplash',
  score: 99,
  url_busca: null,
  seletor_resultados: null,
  extrai: [],
};

/**
 * Calcula score de relevância de um site para um dado brief.
 * Regra: +3 por categoria do site que bater com component/context/style do brief.
 *        +1 por tag do site que aparecer em keywords do brief.
 *        Bônus por tier já incluso via TIER_BONUS.
 * @param {Object} site - Objeto de site do sites.json
 * @param {Object} brief - Brief estruturado com component, context, style, keywords
 * @returns {number} score
 */
function calcScore(site, brief) {
  let score = TIER_BONUS[site.tier] ?? 0;

  const briefTerms = [
    brief.component,
    brief.context,
    ...(Array.isArray(brief.style) ? brief.style : [brief.style]),
  ]
    .filter(Boolean)
    .map((t) => t.toLowerCase());

  const keywords = Array.isArray(brief.keywords)
    ? brief.keywords.map((k) => k.toLowerCase())
    : [];

  const categorias = (site.categorias ?? []).map((c) => c.toLowerCase());
  const tags = (site.tags ?? []).map((t) => t.toLowerCase());

  // +3 por cada categoria do site que bater com component/context/style
  for (const cat of categorias) {
    const matches = briefTerms.some((term) => term.includes(cat) || cat.includes(term));
    if (matches) score += 3;
  }

  // +1 por cada tag do site que aparecer em qualquer keyword
  for (const tag of tags) {
    const matches = keywords.some((kw) => kw.includes(tag) || tag.includes(kw));
    if (matches) score += 1;
  }

  return score;
}

/**
 * Seleciona e ranqueia sites com base no brief e opções fornecidas.
 *
 * @param {Object} brief - Brief estruturado: { component, context, style, keywords, ... }
 * @param {Object} [options]
 * @param {number} [options.maxTier=2] - Máximo tier a incluir: 1=tier1, 2=+tier2_simple, 3=+tier2_pw, 4=+tier3
 * @param {number} [options.limit=5] - Máximo de sites retornados (excluindo Unsplash)
 * @param {boolean} [options.includeUnsplash=true] - Adicionar Unsplash virtual sempre no topo
 * @returns {Array<{id, nome, tier, score, url_busca, seletor_resultados, extrai, api_info?}>}
 */
export function selectSites(brief = {}, options = {}) {
  const { maxTier = 2, limit = 5, includeUnsplash = true } = options;

  const allowedTiers = MAX_TIER_MAP[maxTier] ?? MAX_TIER_MAP[2];
  const data = loadSites();

  const allSites = allowedTiers.flatMap((tier) => data[tier] ?? []);

  const scored = allSites
    .map((site) => ({
      id: site.id,
      nome: site.nome,
      tier: site.tier,
      score: calcScore(site, brief),
      url_base: site.url_base ?? null,
      url_busca: site.url_busca ?? null,
      seletor_resultados: site.seletor_resultados ?? null,
      extrai: site.extrai ?? [],
      ...(site.api_info ? { api_info: site.api_info } : {}),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (includeUnsplash) {
    return [UNSPLASH_VIRTUAL, ...scored];
  }

  return scored;
}
