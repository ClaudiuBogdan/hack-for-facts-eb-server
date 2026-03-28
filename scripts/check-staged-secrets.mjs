import { execFileSync } from 'node:child_process';
import path from 'node:path';

function getStagedFiles() {
  const output = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { encoding: 'utf8' }
  );

  return output
    .split('\0')
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
}

function isAllowedEnvExample(filePath) {
  const baseName = path.basename(filePath);
  return /^\.env(?:\.[^.]+)*\.example$/u.test(baseName);
}

function isBlockedSecretFile(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const baseName = path.basename(normalized);

  if (normalized.endsWith('.secret.yaml')) {
    return true;
  }

  if (baseName === '.env' || baseName.startsWith('.env.')) {
    return !isAllowedEnvExample(baseName);
  }

  return false;
}

function main() {
  const candidateFiles = process.argv.slice(2);
  const files = candidateFiles.length > 0 ? candidateFiles : getStagedFiles();
  const blockedFiles = files.filter(isBlockedSecretFile);

  if (blockedFiles.length === 0) {
    process.exit(0);
  }

  console.error('Blocked commit: secret files must stay local-only.');
  console.error('');
  console.error('Remove these files from the commit:');

  for (const file of blockedFiles) {
    console.error(`- ${file}`);
  }

  console.error('');
  console.error('Allowed patterns:');
  console.error('- `.env.example` and `.env.*.example` templates');
  console.error('- sealed secret manifests such as `sealed-*.yaml`');
  console.error('');
  console.error('Suggested fixes:');
  console.error('- Keep real `.env*` files local and ignored');
  console.error('- Keep `*.secret.yaml` files local and ignored');
  console.error('- Commit only templates or sealed secrets');

  process.exit(1);
}

main();
