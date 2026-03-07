import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import archiver from 'archiver';

const PUBLIC_DIR = '/app/public';

/**
 * Gera um ZIP com o board.html e os assets selecionados.
 * @param {string} jobId
 * @param {string[]} selectedIds - Array de resultIds selecionados (ex: ['01_unsplash', '02_landbook'])
 * @param {string|null} selectedAt - ISO timestamp de quando a seleção foi feita
 * @returns {Promise<string>} Caminho absoluto do ZIP gerado
 */
export async function packageSelection(jobId, selectedIds, selectedAt) {
  const jobDir = path.join(PUBLIC_DIR, jobId);
  const assetsDir = path.join(jobDir, 'assets');
  const zipPath = path.join(jobDir, 'moodboard.zip');

  // Verificar se ZIP já existe e seleção não mudou
  if (selectedAt) {
    try {
      const stat = await fsPromises.stat(zipPath);
      const zipMtime = stat.mtimeMs;
      const selectionTime = new Date(selectedAt).getTime();
      if (zipMtime >= selectionTime) {
        console.log(`[zip-packager] job=${jobId} — ZIP já atualizado, reutilizando`);
        return zipPath;
      }
    } catch {
      // ZIP não existe ainda, continuar
    }
  }

  // Listar assets disponíveis
  let availableFiles = [];
  try {
    availableFiles = await fsPromises.readdir(assetsDir);
  } catch {
    console.warn(`[zip-packager] job=${jobId} — diretório de assets não encontrado`);
  }

  // Filtrar apenas os assets selecionados (match por prefixo = resultId)
  const selectedFiles = availableFiles.filter((fileName) => {
    const base = path.basename(fileName, path.extname(fileName));
    return selectedIds.includes(base);
  });

  console.log(`[zip-packager] job=${jobId} — empacotando ${selectedFiles.length}/${selectedIds.length} assets selecionados`);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => {
      console.log(`[zip-packager] job=${jobId} — ZIP gerado: ${archive.pointer()} bytes`);
      resolve(zipPath);
    });

    archive.on('error', (err) => {
      console.error(`[zip-packager] job=${jobId} — erro ao criar ZIP: ${err.message}`);
      reject(err);
    });

    archive.pipe(output);

    // Adicionar board.html na raiz
    const boardPath = path.join(jobDir, 'board.html');
    try {
      if (fs.existsSync(boardPath)) {
        archive.file(boardPath, { name: 'board.html' });
      }
    } catch {
      // ignorar se não existir
    }

    // Adicionar apenas os assets selecionados em assets/
    for (const fileName of selectedFiles) {
      const filePath = path.join(assetsDir, fileName);
      archive.file(filePath, { name: `assets/${fileName}` });
    }

    archive.finalize();
  });
}
