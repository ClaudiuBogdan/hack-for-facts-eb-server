import * as fs from 'fs-extra';
import * as path from 'path';
import { parseDataset, type Dataset } from '../../db/datasets';

const DATASETS_DIR = path.join(process.cwd(), 'datasets');

async function readJsonFile(filePath: string): Promise<any> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export const staticDatasetsRepository = {
  async getDatasetById(datasetId: string): Promise<Dataset> {
    // Try exact file match first
    const directPath = path.join(DATASETS_DIR, `${datasetId}.json`);
    if (await fs.pathExists(directPath)) {
      const candidate = await readJsonFile(directPath);
      return parseDataset(`datasets/${datasetId}.json`, candidate);
    }

    // Fallback: scan directory and match by embedded id field
    const files = await fs.readdir(DATASETS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fullPath = path.join(DATASETS_DIR, file);
      try {
        const candidate = await readJsonFile(fullPath);
        if (candidate && candidate.id === datasetId) {
          return parseDataset(`datasets/${file}`, candidate);
        }
      } catch {
        // ignore file parse errors, continue scanning
      }
    }

    throw new Error(`Static dataset not found: ${datasetId}`);
  },
};


