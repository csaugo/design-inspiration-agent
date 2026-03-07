import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { searchInspiration } from './tools/search.js';

const PORT = process.env.PORT ?? 3000;
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mcp-server' });
});

app.get('/mcp', (_req, res) => {
  res.json({ status: 'ok', tools: ['search_inspiration'] });
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

app.listen(PORT, () => {
  console.log(`mcp-server rodando na porta ${PORT}`);
});
