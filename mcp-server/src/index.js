import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { searchInspiration } from './tools/search.js';
import { getResults } from './tools/results.js';

const PORT = process.env.PORT ?? 3000;
const app = express();
app.use(cors());
app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`mcp-server rodando na porta ${PORT}`);
});
