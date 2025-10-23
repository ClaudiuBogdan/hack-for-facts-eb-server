import { validateDatasetsDirectory } from '../src/db/datasets/validation';

async function main() {
  try {
    const result = validateDatasetsDirectory();
    console.log(
      `Validated ${result.datasetCount} dataset file${result.datasetCount === 1 ? '' : 's'}.`,
    );
  } catch (error) {
    console.error('[datasets:validate] Dataset validation failed:', error);
    process.exitCode = 1;
  }
}

void main();
