const UNSPLASH_API_URL = 'https://api.unsplash.com/search/photos';

/**
 * Busca imagens na API do Unsplash.
 * @param {string[]} keywords - Array de palavras-chave
 * @param {number} [maxResults] - Número máximo de resultados (fallback: MAX_RESULTS_PER_SITE ou 6)
 * @returns {Promise<Array>} Array de objetos com dados das fotos
 */
export async function searchUnsplash(keywords, maxResults) {
  const max = maxResults ?? parseInt(process.env.MAX_RESULTS_PER_SITE ?? '6', 10);
  const query = keywords.join(' ');
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;

  if (!accessKey) {
    throw new Error('UNSPLASH_ACCESS_KEY não configurado');
  }

  const params = new URLSearchParams({
    query,
    per_page: String(max),
    orientation: 'landscape',
  });

  const response = await fetch(`${UNSPLASH_API_URL}?${params}`, {
    headers: {
      Authorization: `Client-ID ${accessKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Unsplash API retornou status ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();

  return (data.results ?? []).map((foto) => ({
    id: foto.id,
    url_thumb: foto.urls.small,
    url_full: foto.urls.full,
    url_page: foto.links.html,
    description: foto.description || foto.alt_description || 'Sem descrição',
    author: foto.user.name,
    source: 'Unsplash',
  }));
}
