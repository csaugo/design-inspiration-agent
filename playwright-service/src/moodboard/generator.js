import fs from 'fs/promises';
import path from 'path';

const PUBLIC_DIR = '/app/public';
const MCP_SERVER = 'http://31.97.21.86:3001';

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scoreBadgeColor(score) {
  if (score >= 75) return '#22c55e';
  if (score >= 55) return '#f59e0b';
  return '#ef4444';
}

function calcAvgScore(results) {
  const withScores = results.filter((r) => r.scores?.score_total != null);
  if (withScores.length === 0) return null;
  const sum = withScores.reduce((acc, r) => acc + r.scores.score_total, 0);
  return Math.round(sum / withScores.length);
}

function renderCard(img, index) {
  const desc = escapeHtml(truncate(img.description, 80));
  const author = escapeHtml(img.author);
  const source = escapeHtml(img.source);
  const urlFull = escapeHtml(img.url_full ?? img.imageUrl ?? '');
  const urlThumb = escapeHtml(img.url_thumb ?? img.imageUrl ?? '');
  const localImagePath = img.localImagePath ? escapeHtml(img.localImagePath) : '';
  const resultId = escapeHtml(img.resultId ?? `item_${index}`);

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

  const imgSrc = localImagePath ? localImagePath : urlThumb;
  const imgFallback = urlThumb !== imgSrc ? `onerror="this.onerror=null;this.src='${urlThumb}'"` : '';

  return `
    <div class="card" data-result-id="${resultId}" data-image-url="${urlThumb}" data-local-path="${localImagePath}" onclick="toggleCard('${resultId}')">
      <div class="card-image-wrap">
        <img
          src="${imgSrc}"
          alt="${desc || author}"
          title="${imgTitle}"
          loading="lazy"
          class="card-image"
          ${imgFallback}
        />
        <div class="card-overlay"></div>
        <div class="card-check">✓</div>
        <span class="card-source">${source}</span>
        ${scoreBadgeHtml}
      </div>
      <div class="card-body">
        <p class="card-title">${desc || author || '<em>Sem título</em>'}</p>
      </div>
    </div>`;
}

/**
 * Gera o HTML interativo do moodboard para um job.
 * @param {string} jobId
 * @param {Array} results - Array de imagens (enriquecido com localImagePath/resultId pelo asset-downloader)
 * @param {Object} brief - Brief estruturado
 * @returns {Promise<string>} Caminho relativo: "{jobId}/board.html"
 */
export async function generateMoodboard(jobId, results, brief) {
  const jobDir = path.join(PUBLIC_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const timestamp = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  });

  const component = escapeHtml(brief?.component ?? '');
  const context = escapeHtml(brief?.context ?? '');
  const styleList = Array.isArray(brief?.style)
    ? brief.style.map(escapeHtml).join(', ')
    : escapeHtml(brief?.style ?? '');

  const count = results.length;
  const sourcesSet = new Set(results.map((r) => r.source));
  const sourcesCount = sourcesSet.size;
  const sourcesLabel = [...sourcesSet].join(', ');
  const avgScore = calcAvgScore(results);

  const cardsHtml = results.map((r, i) => renderCard(r, i)).join('\n');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Design Moodboard — ${component}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0f0f0f;
      color: #e0e0e0;
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      padding-top: 70px;
      padding-bottom: 3rem;
    }

    /* ── Topbar ── */
    .topbar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 64px;
      background: #0f0f0f;
      border-bottom: 1px solid #2a2a2a;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 1.5rem;
      z-index: 100;
      gap: 1rem;
    }
    .topbar-left { display: flex; flex-direction: column; min-width: 0; }
    .topbar-title {
      font-size: 1rem;
      font-weight: 700;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .topbar-subtitle {
      font-size: 0.75rem;
      color: #666;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .topbar-center {
      font-size: 0.85rem;
      color: #888;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .topbar-center span {
      color: #6366f1;
      font-weight: 600;
    }
    .topbar-right {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-shrink: 0;
    }
    .btn-ghost {
      background: transparent;
      border: 1px solid #333;
      color: #aaa;
      padding: 0.4rem 0.9rem;
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-ghost:hover { border-color: #555; color: #ddd; }
    .btn-export {
      background: #6366f1;
      border: none;
      color: #fff;
      padding: 0.4rem 1.1rem;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-export:hover:not(:disabled) { background: #4f46e5; }
    .btn-export:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-export.success { background: #22c55e; }
    .btn-export.error { background: #ef4444; }

    .export-msg {
      display: none;
      position: fixed;
      top: 72px;
      right: 1.5rem;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-size: 0.8rem;
      color: #aaa;
      max-width: 300px;
      z-index: 99;
      line-height: 1.5;
    }
    .export-msg code {
      background: #2a2a2a;
      padding: 0.1rem 0.35rem;
      border-radius: 3px;
      color: #6366f1;
      font-family: monospace;
    }

    /* ── Grid ── */
    .grid-wrapper {
      max-width: 1400px;
      margin: 1.5rem auto 0;
      padding: 0 1.5rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1.25rem;
    }

    /* ── Card ── */
    .card {
      background: #1a1a1a;
      border: 2px solid #2a2a2a;
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;
    }
    .card:hover { filter: brightness(1.05); transform: scale(1.01); }
    .card.selected {
      border: 3px solid #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.3);
    }

    .card-image-wrap {
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
    .card:hover .card-image { transform: scale(1.04); }

    .card-overlay {
      position: absolute;
      inset: 0;
      background: rgba(99, 102, 241, 0.15);
      opacity: 0;
      transition: opacity 0.2s;
      pointer-events: none;
    }
    .card.selected .card-overlay { opacity: 1; }

    .card-check {
      position: absolute;
      top: 8px;
      left: 8px;
      width: 28px;
      height: 28px;
      background: #22c55e;
      border-radius: 50%;
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 2;
    }
    .card.selected .card-check { display: flex; }

    .card-source {
      position: absolute;
      bottom: 8px;
      right: 8px;
      background: rgba(0,0,0,0.65);
      color: #fff;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      pointer-events: none;
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

    .card-body { padding: 0.6rem 0.85rem; }
    .card-title {
      font-size: 12px;
      color: #888;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── Footer ── */
    .footer {
      max-width: 1400px;
      margin: 2.5rem auto 0;
      padding: 1rem 1.5rem 0;
      border-top: 1px solid #222;
      display: flex;
      flex-wrap: wrap;
      gap: 1.5rem;
      font-size: 0.75rem;
      color: #555;
    }
  </style>
</head>
<body>

  <div class="topbar">
    <div class="topbar-left">
      <span class="topbar-title">Design Moodboard — ${component}</span>
      <span class="topbar-subtitle">${context}${styleList ? ' · ' + styleList : ''}</span>
    </div>
    <div class="topbar-center">
      <span id="sel-count">0</span> de ${count} selecionadas
    </div>
    <div class="topbar-right">
      <button class="btn-ghost" onclick="selectAll()">Selecionar Todas</button>
      <button class="btn-export" id="btn-export" disabled onclick="exportToAgent()">Exportar para Cursor (0)</button>
    </div>
  </div>

  <div class="export-msg" id="export-msg"></div>

  <div class="grid-wrapper">
    <div class="grid">
      ${cardsHtml}
    </div>
  </div>

  <footer class="footer">
    <span>${count} referência${count !== 1 ? 's' : ''} de ${sourcesCount} fonte${sourcesCount !== 1 ? 's' : ''} (${sourcesLabel})</span>
    ${avgScore != null ? `<span>Score médio: ${avgScore}</span>` : ''}
    <span>Gerado em ${timestamp}</span>
    <span>Expira em 24h</span>
  </footer>

  <script>
    const JOB_ID = '${escapeHtml(jobId)}';
    const MCP_SERVER = '${MCP_SERVER}';
    const TOTAL = ${count};
    let selected = new Set();

    function updateUI() {
      const n = selected.size;
      document.getElementById('sel-count').textContent = n;
      const btn = document.getElementById('btn-export');
      btn.textContent = 'Exportar para Cursor (' + n + ')';
      btn.disabled = n === 0;
    }

    function toggleCard(resultId) {
      const card = document.querySelector('[data-result-id="' + resultId + '"]');
      if (!card) return;
      if (selected.has(resultId)) {
        selected.delete(resultId);
        card.classList.remove('selected');
      } else {
        selected.add(resultId);
        card.classList.add('selected');
      }
      updateUI();
    }

    function selectAll() {
      document.querySelectorAll('.card').forEach(function(card) {
        var id = card.dataset.resultId;
        if (id) {
          selected.add(id);
          card.classList.add('selected');
        }
      });
      updateUI();
    }

    function showMsg(html, autoHide) {
      var msg = document.getElementById('export-msg');
      msg.innerHTML = html;
      msg.style.display = 'block';
      if (autoHide) {
        setTimeout(function() { msg.style.display = 'none'; }, autoHide);
      }
    }

    async function exportToAgent() {
      if (selected.size === 0) {
        alert('Selecione ao menos uma imagem antes de exportar.');
        return;
      }
      var btn = document.getElementById('btn-export');
      var original = btn.textContent;
      btn.textContent = 'Exportando...';
      btn.disabled = true;
      btn.className = 'btn-export';

      try {
        var resp = await fetch(MCP_SERVER + '/mcp/select/' + JOB_ID, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selected: Array.from(selected) })
        });
        if (resp.ok) {
          btn.textContent = '✓ Pronto! Volte ao Cursor';
          btn.className = 'btn-export success';
          btn.disabled = false;
          showMsg(
            'Seleção salva (' + selected.size + ' imagens). No Cursor, use:<br><code>get_selection</code> com job_id <code>' + JOB_ID + '</code>',
            0
          );
        } else {
          throw new Error('HTTP ' + resp.status);
        }
      } catch (err) {
        btn.textContent = 'Erro ao exportar. Tente novamente.';
        btn.className = 'btn-export error';
        btn.disabled = false;
        showMsg('Falha na exportação: ' + err.message, 4000);
        setTimeout(function() {
          btn.textContent = original;
          btn.className = 'btn-export';
          btn.disabled = selected.size === 0;
        }, 3000);
      }
    }
  </script>

</body>
</html>`;

  const filePath = path.join(jobDir, 'board.html');
  await fs.writeFile(filePath, html, 'utf8');

  return `${jobId}/board.html`;
}
