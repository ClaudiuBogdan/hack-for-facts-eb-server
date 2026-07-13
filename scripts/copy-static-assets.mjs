import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const source = path.resolve(
  'src/modules/procurement/core/procurement-analysis-combinations-v2.json'
);
const destination = path.resolve(
  'dist/modules/procurement/core/procurement-analysis-combinations-v2.json'
);

mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(source, destination);

const [{ ANALYSIS_MATRIX_SHA256 }, sourceBytes, destinationBytes] = await Promise.all([
  import('../dist/modules/procurement/core/combinations.js'),
  Promise.resolve(readFileSync(source)),
  Promise.resolve(readFileSync(destination)),
]);
const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
const destinationHash = createHash('sha256').update(destinationBytes).digest('hex');
if (sourceHash !== ANALYSIS_MATRIX_SHA256 || destinationHash !== ANALYSIS_MATRIX_SHA256) {
  throw new Error(
    `procurement matrix build copy mismatch: source ${sourceHash}, dist ${destinationHash}, pinned ${ANALYSIS_MATRIX_SHA256}`
  );
}
