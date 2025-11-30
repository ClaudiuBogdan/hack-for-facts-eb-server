import fs from 'node:fs/promises';
import path from 'node:path';

export interface DatasetFileEntry {
  id: string;
  absolutePath: string;
  relativePath: string;
}

const toPosixPath = (filePath: string): string => filePath.split(path.sep).join(path.posix.sep);

const walk = async (rootDir: string, currentDir: string): Promise<DatasetFileEntry[]> => {
  let entries;

  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const notFoundError = new Error(`Datasets directory not found at ${currentDir}`);
      (notFoundError as NodeJS.ErrnoException).code = 'ENOENT';
      throw notFoundError;
    }
    throw error;
  }

  const datasets: DatasetFileEntry[] = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      datasets.push(...(await walk(rootDir, fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.yaml')) {
      const id = entry.name.replace(/\.yaml$/, '');
      const relativePath = toPosixPath(path.relative(rootDir, fullPath));
      datasets.push({ id, absolutePath: fullPath, relativePath });
    }
  }

  return datasets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
};

export const listDatasetFiles = async (rootDir: string): Promise<DatasetFileEntry[]> => {
  const normalizedRoot = path.resolve(rootDir);
  return walk(normalizedRoot, normalizedRoot);
};
