import { describe, expect, it } from 'vitest';

import { extractUploadedDatasetSeriesVector } from '@/modules/advanced-map-analytics/grouped-series/shell/providers/extract-uploaded-dataset-series.js';

import type { AdvancedMapDatasetRow } from '@/modules/advanced-map-datasets/index.js';

function makeDataset(rows: AdvancedMapDatasetRow[]) {
  return {
    id: 'dataset-1',
    publicId: '11111111-1111-4111-8111-111111111111',
    userId: 'user-1',
    title: 'Dataset',
    description: null,
    markdown: null,
    unit: 'RON',
    visibility: 'public' as const,
    rowCount: rows.length,
    replacedAt: null,
    createdAt: new Date('2026-04-09T07:00:00.000Z'),
    updatedAt: new Date('2026-04-09T07:00:00.000Z'),
    rows,
  };
}

describe('extractUploadedDatasetSeriesVector', () => {
  it('resolves numeric dataset rows into a sparse siruta vector', async () => {
    const dataset = makeDataset([
      { sirutaCode: '1001', valueNumber: '1.25', valueJson: null },
      { sirutaCode: '9999', valueNumber: '4.50', valueJson: null },
    ]);

    const result = await extractUploadedDatasetSeriesVector(dataset, new Set(['1001', '1002']));

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.valuesBySirutaCode.get('1001')).toBe(1.25);
    expect(result.value.valuesBySirutaCode.has('9999')).toBe(false);
  });

  it('returns undefined values for json-only rows', async () => {
    const dataset = makeDataset([
      {
        sirutaCode: '1001',
        valueNumber: null,
        valueJson: {
          type: 'text',
          value: {
            text: 'abc',
          },
        },
      },
    ]);

    const result = await extractUploadedDatasetSeriesVector(dataset, new Set(['1001']));

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.valuesBySirutaCode.get('1001')).toBeUndefined();
  });

  it('returns numbers when both valueNumber and valueJson are present', async () => {
    const dataset = makeDataset([
      {
        sirutaCode: '1001',
        valueNumber: '42',
        valueJson: {
          type: 'text',
          value: {
            text: 'comment',
          },
        },
      },
    ]);

    const result = await extractUploadedDatasetSeriesVector(dataset, new Set(['1001']));

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.valuesBySirutaCode.get('1001')).toBe(42);
  });

  it('treats values that exceed grouped-series precision as missing values', async () => {
    const dataset = makeDataset([
      {
        sirutaCode: '1001',
        valueNumber: '9007199254740992.1',
        valueJson: null,
      },
    ]);

    const result = await extractUploadedDatasetSeriesVector(dataset, new Set(['1001']));

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.valuesBySirutaCode.get('1001')).toBeUndefined();
  });
});
