import { describe, expect, it } from 'vitest';

import { parseUploadedDatasetCsv } from '@/modules/advanced-map-datasets/shell/utils/parse-uploaded-dataset-csv.js';

describe('parseUploadedDatasetCsv', () => {
  it('parses numeric CSV rows into valueNumber values', () => {
    const result = parseUploadedDatasetCsv(new Set(['1001']), 'siruta_code,value\n1001,1.5');

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

  it('canonicalizes integer-looking numeric values', () => {
    const result = parseUploadedDatasetCsv(new Set(['1001']), 'siruta_code,value\n1001,+001');

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

  it('accepts large numeric values for dataset storage', () => {
    const result = parseUploadedDatasetCsv(
      new Set(['1001']),
      'siruta_code,value\n1001,9007199254740993'
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.rows[0]?.valueNumber).toBe('9007199254740993');
  });

  it('rejects malformed headers', () => {
    const result = parseUploadedDatasetCsv(
      new Set(['1001']),
      'siruta_code,url\n1001,https://example.com'
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error.rows[0]?.message).toContain('Header must');
  });

  it('rejects non-numeric values', () => {
    const result = parseUploadedDatasetCsv(new Set(['1001']), 'siruta_code,value\n1001,hello');

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error.rows[0]?.message).toContain('Invalid numeric value');
  });
  it('preserves zero and rejects unknown or duplicate territory rows', () => {
    const valid = new Set(['1001']);
    const zero = parseUploadedDatasetCsv(valid, 'siruta_code,value\n1001,0');
    expect(zero.isOk() && zero.value.rows[0]?.valueNumber).toBe('0');
    const unknown = parseUploadedDatasetCsv(valid, 'siruta_code,value\n1002,5');
    expect(unknown.isErr() && unknown.error.rows[0]?.rowNumber).toBe(2);
    const duplicate = parseUploadedDatasetCsv(valid, 'siruta_code,value\n1001,0\n1001,5');
    expect(duplicate.isErr() && duplicate.error.rows[0]).toEqual({
      rowNumber: 3,
      message: 'Duplicate siruta_code: 1001',
    });
  });
});
