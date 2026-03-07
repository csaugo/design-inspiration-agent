import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { searchInspiration } from './tools/search.js';
import { getResults } from './tools/results.js';

const PORT = process.env.PORT ?? 3000;
const app = express();
app.use(cors());
app.use(express.json());

// ── REST endpoints (mantidos para testes via curl) ────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mcp-server' });
});

app.get('/mcp', (_req, res) => {
  res.json({ status: 'ok', tools: ['search_inspiration', 'get_results'] });
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
    return res.status(500).json({ error: err.message ?? 'Erro interno ao processar a busca.' });
  }
});

app.get('/mcp/get_results/:jobId', async (req, res) => {
  const { jobId } = req.params;
  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    return res.status(400).json({ error: 'Parâmetro jobId é obrigatório.' });
  }
  try {
    const result = await getResults(jobId.trim());
    return res.json(result);
  } catch (err) {
    console.error('[get_results] erro:', err);
    return res.status(500).json({ error: err.message ?? 'Erro interno ao buscar resultados.' });
  }
});

// ── MCP Protocol via StreamableHTTP ──────────────────────────────────────────

const mcpTransports = {};

function createMcpServer() {
  const server = new McpServer({
    name: 'design-inspiration-agent',
    version: '1.0.0',
  });

  server.tool(
    'search_inspiration',
    'Busca referências visuais de design em sites especializados com base no seu pedido. Retorna um job_id e um link para visualizar o moodboard quando pronto.',
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
    'Verifica o status de uma busca e retorna a URL do moodboard quando pronto. Use o job_id retornado pelo search_inspiration.',
    {
      job_id: z.string().describe('O ID do job retornado pelo search_inspiration'),
    },
    async ({ job_id }) => {
      const result = await getResults(job_id.trim());
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

app.post('/mcp-protocol', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && mcpTransports[sessionId]) {
    await mcpTransports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        mcpTransports[id] = transport;
        console.log(`[mcp-protocol] sessão iniciada: ${id}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete mcpTransports[transport.sessionId];
        console.log(`[mcp-protocol] sessão encerrada: ${transport.sessionId}`);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Sessão inválida ou requisição não reconhecida.' },
    id: null,
  });
});

app.get('/mcp-protocol', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && mcpTransports[sessionId]) {
    await mcpTransports[sessionId].handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: 'Sessão não encontrada.' });
});

app.delete('/mcp-protocol', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && mcpTransports[sessionId]) {
    await mcpTransports[sessionId].handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: 'Sessão não encontrada.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`mcp-server rodando na porta ${PORT}`);
  console.log(`MCP Protocol disponível em /mcp-protocol`);
});
