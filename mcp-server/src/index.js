import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import express from 'express';
import cors from 'cors';
import { createClient } from 'redis';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { searchInspiration, refineSearch } from './tools/search.js';
import { getResults } from './tools/results.js';

const PORT = process.env.PORT ?? 3000;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const MOODBOARD_BASE_URL = process.env.MOODBOARD_BASE_URL ?? 'http://localhost:8081';
const PUBLIC_DIR = '/app/public';

const app = express();
app.use(cors());

// Apply express.json() ONLY to the /api routes and Moodboard endpoints, NOT globally
// because the MCP SDK requires the raw stream on /mcp/messages
const jsonParser = express.json();

// ── Helpers ────────────────────────────────────────────────────────────────

function getRedisClient() {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err) => console.error('[Redis] erro:', err));
  return client;
}

async function readJobFromRedis(jobId) {
  const redis = getRedisClient();
  await redis.connect();
  try {
    const raw = await redis.get(`job:${jobId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } finally {
    await redis.disconnect();
  }
}

async function updateJobInRedis(jobId, updates) {
  const redis = getRedisClient();
  await redis.connect();
  try {
    const raw = await redis.get(`job:${jobId}`);
    const existing = raw ? JSON.parse(raw) : {};
    const updated = { ...existing, ...updates };
    const ttl = await redis.ttl(`job:${jobId}`);
    const ex = ttl > 0 ? ttl : 86400;
    await redis.set(`job:${jobId}`, JSON.stringify(updated), { EX: ex });
    return updated;
  } finally {
    await redis.disconnect();
  }
}

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

async function imageToBase64Block(jobId, resultId, fallbackUrl) {
  const filePath = await findAssetFile(jobId, resultId);

  if (filePath) {
    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = EXT_TO_MIME[ext] ?? 'image/jpeg';
      return {
        type: 'image',
        data: data.toString('base64'),
        mimeType,
      };
    } catch (err) {
      console.warn(`[get_selection] erro ao ler ${filePath}: ${err.message}`);
    }
  }

  if (fallbackUrl && fallbackUrl.startsWith('http')) {
    try {
      const resp = await axios.get(fallbackUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        maxRedirects: 5,
      });
      const ct = resp.headers['content-type'] ?? 'image/jpeg';
      const mimeType = ct.split(';')[0].trim();
      return {
        type: 'image',
        data: Buffer.from(resp.data).toString('base64'),
        mimeType,
      };
    } catch (err) {
      console.warn(`[get_selection] fallback fetch falhou para ${fallbackUrl}: ${err.message}`);
    }
  }

  return null;
}

// ── REST endpoints ─────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mcp-server' });
});

// ── API Routes (User interaction -> passes) ────────────────────────────────

app.post('/api/discover', jsonParser, async (req, res) => {
  res.json({ status: 'ok', service: 'mcp-server' });
});

app.get('/mcp', (_req, res) => {
  res.json({ status: 'ok', tools: ['search_inspiration', 'get_results', 'get_selection', 'download_moodboard', 'refine_search'] });
});

app.post('/mcp/search_inspiration', async (req, res) => {
  const { query } = req.body ?? {};
  if (!query || typeof query !== 'string' || query.trim() === '') {
    return res.status(400).json({ error: 'Campo "query" é obrigatório e deve ser uma string não vazia.' });
  }
  try {
    const result = await searchInspiration(query.trim());
    return res.json(result);
  } catch (err) {
    console.error('[search_inspiration] erro:', err);
    return res.status(500).json({ error: err.message ?? 'Erro interno.' });
  }
});

app.get('/mcp/get_results/:jobId', async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório.' });
  try {
    const result = await getResults(jobId.trim());
    return res.json(result);
  } catch (err) {
    console.error('[get_results] erro:', err);
    return res.status(500).json({ error: err.message ?? 'Erro interno.' });
  }
});

// endpoint do moodboard antigo (retrocompatibilidade opcional)
app.post('/api/moodboard', jsonParser, async (req, res) => {
  const { job_id: jobId, selected } = req.body ?? {}; // Assuming job_id comes from body for /api/moodboard

  if (!Array.isArray(selected) || selected.length === 0) {
    return res.status(400).json({ error: '"selected" deve ser um array não vazio de resultIds.' });
  }

  const job = await readJobFromRedis(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado ou expirado.' });
  }
  if (job.status !== 'ready') {
    return res.status(400).json({ error: `Job ainda não está pronto (status: ${job.status}).` });
  }

  await updateJobInRedis(jobId, {
    selected,
    selected_at: new Date().toISOString(),
  });

  console.log(`[select] job=${jobId} — ${selected.length} imagens selecionadas: ${selected.join(', ')}`);

  return res.json({
    job_id: jobId,
    selected_count: selected.length,
    message: `Seleção salva. Use get_selection no Cursor para receber as imagens.`,
  });
});

// POST /mcp/select/:jobId — salva seleção do moodboard no Redis
app.post('/mcp/select/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { selected } = req.body ?? {};

  if (!Array.isArray(selected) || selected.length === 0) {
    return res.status(400).json({ error: '"selected" deve ser um array não vazio de resultIds.' });
  }

  const job = await readJobFromRedis(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado ou expirado.' });
  }
  if (job.status !== 'ready') {
    return res.status(400).json({ error: `Job ainda não está pronto (status: ${job.status}).` });
  }

  await updateJobInRedis(jobId, {
    selected,
    selected_at: new Date().toISOString(),
  });

  console.log(`[select] job=${jobId} — ${selected.length} imagens selecionadas: ${selected.join(', ')}`);

  return res.json({
    job_id: jobId,
    selected_count: selected.length,
    message: `Seleção salva. Use get_selection no Cursor para receber as imagens.`,
  });
});

// GET /mcp/download/:jobId — redireciona para o ZIP gerado
app.get('/mcp/download/:jobId', async (req, res) => {
  const { jobId } = req.params;

  const job = await readJobFromRedis(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado ou expirado.' });
  }
  if (!job.selected || job.selected.length === 0) {
    return res.status(400).json({
      error: 'Nenhuma seleção feita ainda. Abra o moodboard e selecione as referências.',
    });
  }

  const zipUrl = `${MOODBOARD_BASE_URL}/${jobId}/moodboard.zip`;
  return res.redirect(302, zipUrl);
});

// GET /mcp/get_selection/:jobId — retorna imagens selecionadas como base64
app.get('/mcp/get_selection/:jobId', async (req, res) => {
  const { jobId } = req.params;

  const job = await readJobFromRedis(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado ou expirado.' });
  }
  if (!job.selected || job.selected.length === 0) {
    return res.json({
      status: 'pending_selection',
      message: 'Abra o moodboard e selecione as referências antes de usar esta tool.',
      board_url: job.board_url,
    });
  }

  const resultsMeta = job.results_meta ?? [];
  const metaMap = Object.fromEntries(resultsMeta.map((m) => [m.resultId, m]));

  const blocks = [];
  for (const resultId of job.selected) {
    const meta = metaMap[resultId];
    const fallbackUrl = meta?.imageUrl ?? null;
    const block = await imageToBase64Block(jobId, resultId, fallbackUrl);
    if (block) blocks.push(block);
  }

  return res.json({ job_id: jobId, selected_count: job.selected.length, images: blocks });
});

// Rota para o Passe 2 Completo (Agrupa Feedback)
app.post('/api/refine-board', jsonParser, async (req, res) => {
  const { job_id, feedback } = req.body ?? {};

  if (!job_id || typeof job_id !== 'string' || job_id.trim() === '') {
    return res.status(400).json({ error: 'Campo "job_id" é obrigatório.' });
  }
  if (!feedback || typeof feedback !== 'string' || feedback.trim().length < 5) {
    return res.status(400).json({ error: 'Campo "feedback" é obrigatório e deve ter ao menos 5 caracteres.' });
  }

  try {
    const result = await refineSearch(job_id.trim(), feedback.trim());
    return res.json(result);
  } catch (err) {
    console.error('[refine_search] erro:', err);
    return res.status(500).json({ error: err.message ?? 'Erro interno.' });
  }
});

// POST /mcp/refine_search — refina busca com Vision usando seleção como âncora
app.post('/mcp/refine_search', async (req, res) => {
  const { job_id, feedback } = req.body ?? {};

  if (!job_id || typeof job_id !== 'string' || job_id.trim() === '') {
    return res.status(400).json({ error: 'Campo "job_id" é obrigatório.' });
  }
  if (!feedback || typeof feedback !== 'string' || feedback.trim().length < 5) {
    return res.status(400).json({ error: 'Campo "feedback" é obrigatório e deve ter ao menos 5 caracteres.' });
  }

  try {
    const result = await refineSearch(job_id.trim(), feedback.trim());
    return res.json(result);
  } catch (err) {
    console.error('[refine_search] erro:', err);
    return res.status(500).json({ error: err.message ?? 'Erro interno.' });
  }
});

// GET /mcp/get_board_url/:jobId — polling até board_url disponível → redirect 302
app.get('/mcp/get_board_url/:jobId', async (req, res) => {
  const { jobId } = req.params;
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório.' });

  const TIMEOUT_MS = 90_000;
  const INTERVAL_MS = 3_000;
  const deadline = Date.now() + TIMEOUT_MS;

  const poll = async () => {
    const job = await readJobFromRedis(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job não encontrado ou expirado.' });
    }
    if (job.status === 'ready' && job.board_url) {
      return res.redirect(302, job.board_url);
    }
    if (job.status === 'error') {
      return res.status(500).json({ error: job.error ?? 'Erro no processamento do job.' });
    }
    if (Date.now() >= deadline) {
      return res.status(504).json({ error: 'Timeout aguardando moodboard. Tente get_results manualmente.' });
    }
    setTimeout(poll, INTERVAL_MS);
  };

  await poll();
});

// ── MCP Protocol ───────────────────────────────────────────────────────────

const mcpTransports = {};

function createMcpServer() {
  const server = new McpServer({
    name: 'design-inspiration-agent',
    version: '2.0.0',
  });

  server.tool(
    'search_inspiration',
    'Busca referências visuais de design em sites especializados com base no seu pedido. Retorna um job_id e um link para visualizar o moodboard interativo quando pronto. No moodboard, o designer seleciona as imagens e clica em "Exportar para Cursor" antes de usar get_selection.',
    {
      query: z.string().describe(
        "Descreva em linguagem natural o que você precisa. Ex: 'hero section para fintech com visual clean e moderno'"
      ),
    },
    async ({ query }) => {
      const result = await searchInspiration(query.trim());
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_results',
    'Verifica o status de uma busca e retorna a URL do moodboard interativo quando pronto. Use o job_id retornado pelo search_inspiration.',
    {
      job_id: z.string().describe('O ID do job retornado pelo search_inspiration'),
    },
    async ({ job_id }) => {
      const result = await getResults(job_id.trim());
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_selection',
    'Retorna as imagens selecionadas no moodboard como conteúdo visual nativo. Use após abrir o board_url no browser e clicar em "Exportar para Cursor". As imagens chegam diretamente no contexto do Cursor, prontas para usar em prompts do Figma Make ou qualquer outra ferramenta.',
    {
      job_id: z.string().describe('O ID do job retornado pelo search_inspiration'),
    },
    async ({ job_id }) => {
      const jobId = job_id.trim();
      const job = await readJobFromRedis(jobId);

      if (!job) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Job não encontrado ou expirado.' }),
          }],
        };
      }

      if (!job.selected || job.selected.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'pending_selection',
              message: 'Abra o moodboard e selecione as referências antes de usar esta tool.',
              board_url: job.board_url,
            }),
          }],
        };
      }

      const resultsMeta = job.results_meta ?? [];
      const metaMap = Object.fromEntries(resultsMeta.map((m) => [m.resultId, m]));

      const content = [];
      let loaded = 0;

      content.push({
        type: 'text',
        text: `Carregando ${job.selected.length} imagem(ns) selecionada(s) do moodboard (job: ${jobId})...`,
      });

      for (const resultId of job.selected) {
        const meta = metaMap[resultId];
        const fallbackUrl = meta?.imageUrl ?? null;
        const block = await imageToBase64Block(jobId, resultId, fallbackUrl);
        if (block) {
          content.push(block);
          loaded++;
        }
      }

      content.push({
        type: 'text',
        text: `${loaded} de ${job.selected.length} imagens carregadas como contexto visual.`,
      });

      return { content };
    }
  );

  server.tool(
    'download_moodboard',
    'Retorna o link para download do moodboard como ZIP com as imagens selecionadas em alta resolução. Disponível após selecionar imagens no moodboard.',
    {
      job_id: z.string().describe('O ID do job retornado pelo search_inspiration'),
    },
    async ({ job_id }) => {
      const jobId = job_id.trim();
      const job = await readJobFromRedis(jobId);

      if (!job) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Job não encontrado ou expirado.' }),
          }],
        };
      }

      if (!job.selected || job.selected.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'pending_selection',
              message: 'Nenhuma seleção feita ainda. Abra o moodboard e selecione as referências.',
              board_url: job.board_url,
            }),
          }],
        };
      }

      const zipUrl = `${MOODBOARD_BASE_URL}/${jobId}/moodboard.zip`;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            zip_url: zipUrl,
            selected_count: job.selected.length,
            message: 'ZIP disponível com as imagens selecionadas.',
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'refine_search',
    'Refina a busca usando as referências que você selecionou no moodboard como âncora visual. Descreva em linguagem natural o que quer ajustar: "mais escuro", "menos colorido", "mais minimalista", etc. Retorna um novo job_id com um moodboard refinado baseado no seu feedback e nas imagens selecionadas.',
    {
      job_id: z.string().describe('O job_id do moodboard atual (com seleção feita)'),
      feedback: z.string().min(5).describe('O que você quer ajustar nas referências. Ex: "mais escuro e minimalista, sem ícones coloridos"'),
    },
    async ({ job_id, feedback }) => {
      try {
        const result = await refineSearch(job_id.trim(), feedback.trim());
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  return server;
}
app.get('/mcp/sse', async (req, res) => {
  const transport = new SSEServerTransport('/mcp/messages', res);
  const server = createMcpServer();
  
  await server.connect(transport);
  
  mcpTransports[transport.sessionId] = transport;
  console.log(`[mcp-protocol] sessão SSE iniciada: ${transport.sessionId}`);

  transport.onclose = () => {
    delete mcpTransports[transport.sessionId];
    console.log(`[mcp-protocol] sessão SSE encerrada: ${transport.sessionId}`);
  };
});

// POST /mcp/messages — recebe requisições JSON-RPC de clientes (Cursor, vscode)
// Importante: NÃO pode haver middleware consumindo o body (ex: express.json, express.raw) antes desta rota
app.post('/mcp/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = mcpTransports[sessionId];

  if (!transport) {
    return res.status(404).json({ error: 'Sessão não encontrada ou expirada.' });
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch(e) {
    console.error("Transport error:", e);
    res.status(500).json({error: e.message});
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`mcp-server rodando na porta ${PORT}`);
  console.log(`MCP Protocol disponível em /mcp-protocol`);
  console.log(`Tools: search_inspiration, get_results, get_selection, download_moodboard, refine_search`);
});
