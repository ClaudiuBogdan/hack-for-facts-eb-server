import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('ESLint architecture boundaries', () => {
  it('rejects resolved alias and external I/O imports from core', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const fixturePath = path.join(
      REPO_ROOT,
      'src/modules/shared/core/boundaries-regression-fixture.ts'
    );
    await writeFile(
      fixturePath,
      "import { sql } from 'kysely';\nimport type { EmailSender } from '@/infra/email/client.js';\nexport const invalidCoreSql = sql`select 1`;\nexport type InvalidCorePort = EmailSender;\n",
      { flag: 'wx' }
    );

    try {
      const [result] = await eslint.lintFiles([fixturePath]);
      const boundaryMessages = result?.messages.filter(
        (message) => message.ruleId === 'boundaries/dependencies'
      );

      expect(boundaryMessages).toEqual([
        expect.objectContaining({
          severity: 2,
          message: 'Core modules must not import I/O libraries.',
        }),
        expect.objectContaining({
          severity: 2,
          message: 'Core must be pure.',
        }),
      ]);
    } finally {
      await unlink(fixturePath);
    }
  }, 15_000);
});
