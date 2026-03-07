import fs from 'fs/promises';
import path from 'path';

const PUBLIC_DIR = '/app/public';

/**
 * Trunca um texto para um máximo de caracteres, adicionando "..." se necessário.
 * @param {string} text
 * @param {number} max
 */
function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '...' : text;
}

/**
 * Escapa caracteres especiais de HTML.
 * @param {string} text
 */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Retorna a cor de fundo do badge baseada no score_total.
 */
function scoreBadgeColor(score) {
  if (score >= 75) return '#22c55e';
  if (score >= 55) return '#f59e0b';
  return '#ef4444';
}

/**
 * Gera o HTML de um card de imagem.
 * @param {Object} img
 */
function renderCard(img) {
  const desc = escapeHtml(truncate(img.description, 80));
  const author = escapeHtml(img.author);
  const source = escapeHtml(img.source);
  const urlFull = escapeHtml(img.url_full);
  const urlThumb = escapeHtml(img.url_thumb);

  const scores = img.scores;
  let scoreBadgeHtml = '';
  let imgTitle = desc || author;

  if (scores) {
    const total = Math.round(scores.score_total ?? 0);
    const color = scoreBadgeColor(total);
    scoreBadgeHtml = `<span class="score-badge" style="background:${color}">${total}</span>`;
    imgTitle = escapeHtml(
      `Relevância: ${scores.relevancia ?? '?'} | Estilo: ${scores.estilo ?? '?'} | Qualidade: ${scores.qualidade ?? '?'} | Aplicabilidade: ${scores.aplicabilidade ?? '?'}`,
    );
  }

  return `
    <div class="card">
      <a href="${urlFull}" target="_blank" rel="noopener noreferrer" class="card-image-link">
        <img
          src="${urlThumb}"
          alt="${desc || author}"
          title="${imgTitle}"
          loading="lazy"
          class="card-image"
        />
        <span class="card-source">${source}</span>
        ${scoreBadgeHtml}
      </a>
      <div class="card-body">
        <p class="card-author">${author}</p>
        <p class="card-desc">${desc || '<em>Sem descrição</em>'}</p>
        ${scores?.motivo ? `<p class="card-motivo">${escapeHtml(scores.motivo)}</p>` : ''}
      </div>
    </div>`;
}

/**
 * Calcula o score médio do array de resultados (apenas os que têm scores).
 */
function calcAvgScore(results) {
  const withScores = results.filter((r) => r.scores?.score_total != null);
  if (withScores.length === 0) return null;
  const sum = withScores.reduce((acc, r) => acc + r.scores.score_total, 0);
  return Math.round(sum / withScores.length);
}

/**
 * Gera o HTML de um moodboard completo para um job.
 * @param {string} jobId - UUID do job
 * @param {Object} brief - Brief estruturado com component, context, style, questions, keywords
 * @param {Array} results - Array de imagens retornado pelo scraper
 * @returns {Promise<string>} Caminho relativo do arquivo gerado: "{jobId}/board.html"
 */
export async function generateMoodboard(jobId, brief, results) {
  const jobDir = path.join(PUBLIC_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const timestamp = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  });

  const component = escapeHtml(brief.component ?? '');
  const context = escapeHtml(brief.context ?? '');
  const styleList = Array.isArray(brief.style)
    ? brief.style.map(escapeHtml).join(', ')
    : escapeHtml(brief.style ?? '');
  const questions = Array.isArray(brief.questions) ? brief.questions : [];
  const count = results.length;
  const sourcesCount = new Set(results.map((r) => r.source)).size;
  const avgScore = calcAvgScore(results);

  const cardsHtml = results.map(renderCard).join('\n');

  const questionsHtml =
    questions.length > 0
      ? `
  <section class="questions">
    <h2 class="questions-title">Perguntas de Clarificação</h2>
    <ul class="questions-list">
      ${questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('\n      ')}
    </ul>
  </section>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Design Inspiration — ${component}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0f0f0f;
      color: #e0e0e0;
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      padding: 0 0 3rem;
    }

    /* ── Header ── */
    .header {
      background: #1a1a1a;
      border-bottom: 1px solid #2a2a2a;
      padding: 2rem 2rem 1.5rem;
    }
    .header-inner {
      max-width: 1400px;
      margin: 0 auto;
      display: flex;
      align-items: flex-start;
      gap: 1.5rem;
      flex-wrap: wrap;
    }
    .header-text { flex: 1; min-width: 200px; }
    .header-title {
      font-size: 1.75rem;
      font-weight: 700;
      color: #ffffff;
      line-height: 1.2;
    }
    .header-subtitle {
      margin-top: 0.4rem;
      font-size: 0.95rem;
      color: #9a9a9a;
    }
    .badge-count {
      display: inline-flex;
      align-items: center;
      background: #2563eb;
      color: #fff;
      font-size: 0.8rem;
      font-weight: 600;
      padding: 0.25rem 0.75rem;
      border-radius: 999px;
      white-space: nowrap;
      align-self: flex-start;
      margin-top: 0.2rem;
    }

    /* ── Questions ── */
    .questions {
      max-width: 1400px;
      margin: 1.5rem auto 0;
      padding: 1.25rem 1.5rem;
      background: #1e2a3a;
      border: 1px solid #2a4060;
      border-radius: 8px;
    }
    .questions-title {
      font-size: 0.85rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #60a5fa;
      margin-bottom: 0.75rem;
    }
    .questions-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .questions-list li {
      font-size: 0.9rem;
      color: #c0d4f0;
      padding-left: 1.25rem;
      position: relative;
    }
    .questions-list li::before {
      content: "?";
      position: absolute;
      left: 0;
      color: #3b82f6;
      font-weight: 700;
    }

    /* ── Grid ── */
    .grid-wrapper {
      max-width: 1400px;
      margin: 2rem auto 0;
      padding: 0 1.5rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.25rem;
    }
    @media (max-width: 900px) {
      .grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 560px) {
      .grid { grid-template-columns: 1fr; }
    }

    /* ── Card ── */
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      overflow: hidden;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .card:hover {
      transform: translateY(-3px);
      border-color: #444;
    }
    .card-image-link {
      display: block;
      position: relative;
      overflow: hidden;
      aspect-ratio: 16/9;
    }
    .card-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.3s ease;
    }
    .card-image-link:hover .card-image {
      transform: scale(1.04);
    }
    .card-source {
      position: absolute;
      bottom: 8px;
      right: 8px;
      background: rgba(0,0,0,0.6);
      color: #fff;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .score-badge {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      color: #fff;
      font-size: 14px;
      font-weight: bold;
      line-height: 36px;
      text-align: center;
      pointer-events: none;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    }
    .card-body {
      padding: 0.75rem 1rem;
    }
    .card-author {
      font-size: 0.8rem;
      font-weight: 600;
      color: #9a9a9a;
      margin-bottom: 0.3rem;
    }
    .card-desc {
      font-size: 0.8rem;
      color: #666;
      line-height: 1.4;
    }
    .card-motivo {
      font-size: 0.75rem;
      color: #555;
      font-style: italic;
      margin-top: 0.3rem;
      line-height: 1.3;
    }

    /* ── Footer ── */
    .footer {
      max-width: 1400px;
      margin: 2.5rem auto 0;
      padding: 0 1.5rem;
      border-top: 1px solid #222;
      padding-top: 1rem;
      display: flex;
      gap: 1.5rem;
      font-size: 0.75rem;
      color: #555;
    }
  </style>
</head>
<body>

  <header class="header">
    <div class="header-inner">
      <div class="header-text">
        <h1 class="header-title">Design Inspiration &mdash; ${component}</h1>
        <p class="header-subtitle">${context}${styleList ? ' &middot; ' + styleList : ''}</p>
      </div>
      <span class="badge-count">${count} resultado${count !== 1 ? 's' : ''}</span>
    </div>
    ${questionsHtml}
  </header>

  <div class="grid-wrapper">
    <div class="grid">
      ${cardsHtml}
    </div>
  </div>

  <footer class="footer">
    <span>Gerado em ${timestamp}</span>
    <span>Expira em 24 horas</span>
    <span>${count} referência${count !== 1 ? 's' : ''} de ${sourcesCount} fonte${sourcesCount !== 1 ? 's' : ''}${avgScore != null ? ' &middot; Score médio: ' + avgScore : ''}</span>
  </footer>

</body>
</html>`;

  const filePath = path.join(jobDir, 'board.html');
  await fs.writeFile(filePath, html, 'utf8');

  return `${jobId}/board.html`;
}
