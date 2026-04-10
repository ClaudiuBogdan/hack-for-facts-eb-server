import { describe, expect, it } from 'vitest';

import { parseUploadedDatasetCsv } from '@/modules/advanced-map-datasets/shell/utils/parse-uploaded-dataset-csv.js';

import type { BudgetDbClient } from '@/infra/database/client.js';

function makeBudgetDb(sirutaCodes: string[]): BudgetDbClient {
  const query = {
    select: () => ({
      where: () => ({
        orderBy: () => ({
          execute: async () =>
            sirutaCodes.map((sirutaCode) => ({
              siruta_code: sirutaCode,
            })),
        }),
      }),
    }),
  };

  return {
    selectFrom: () => query,
  } as unknown as BudgetDbClient;
}

describe('parseUploadedDatasetCsv', () => {
  it('parses numeric CSV rows into valueNumber values', async () => {
    const result = await parseUploadedDatasetCsv(
      makeBudgetDb(['1001']),
      'siruta_code,value\n1001,1.5'
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.rows).toEqual([
      {
        sirutaCode: '1001',
        valueNumber: '1.5',
        valueJson: null,
      },
    ]);
  });

  it('canonicalizes integer-looking numeric values', async () => {
    const result = await parseUploadedDatasetCsv(
      makeBudgetDb(['1001']),
      'siruta_code,value\n1001,+001'
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.rows).toEqual([
      {
        sirutaCode: '1001',
        valueNumber: '1',
        valueJson: null,
      },
    ]);
  });

  it('accepts large numeric values for dataset storage', async () => {
    const result = await parseUploadedDatasetCsv(
      makeBudgetDb(['1001']),
      'siruta_code,value\n1001,9007199254740993'
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.rows[0]?.valueNumber).toBe('9007199254740993');
  });

  it('rejects malformed headers', async () => {
    const result = await parseUploadedDatasetCsv(
      makeBudgetDb(['1001']),
      'siruta_code,url\n1001,https://example.com'
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error.rows[0]?.message).toContain('Header must');
  });

  it('rejects non-numeric values', async () => {
    const result = await parseUploadedDatasetCsv(
      makeBudgetDb(['1001']),
      'siruta_code,value\n1001,hello'
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error.rows[0]?.message).toContain('Invalid numeric value');
  });
});
