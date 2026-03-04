import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const PORT = process.env.PORT ?? 3000;
const app = express();
app.use(cors());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mcp-server' });
});

app.get('/mcp', (_req, res) => {
  res.json({ status: 'ok', tools: [] });
});

app.listen(PORT, () => {
  console.log(`mcp-server rodando na porta ${PORT}`);
});
