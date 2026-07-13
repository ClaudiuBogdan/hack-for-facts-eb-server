import { readFileSync } from 'node:fs';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { buildProcurementPerformanceCorpus } from '../../../scripts/procurement-analysis-performance-corpus.js';

const ArtifactSchema = Type.Object(
  {
    combinations: Type.Array(
      Type.Object({
        grain: Type.String(),
        scopeDims: Type.Array(Type.String()),
        shape: Type.String(),
        measure: Type.Optional(Type.String()),
        breakdownDim: Type.Optional(Type.String()),
        serving: Type.Object({ kind: Type.String() }, { additionalProperties: true }),
      })
    ),
  },
  { additionalProperties: true }
);
const artifactBytes = readFileSync(
  new URL(
    '../../../src/modules/procurement/core/procurement-analysis-combinations-v2.json',
    import.meta.url
  ),
  'utf8'
);
// eslint-disable-next-line no-restricted-syntax -- hash-pinned fixture, TypeBox-validated below
const parsed: unknown = JSON.parse(artifactBytes);
if (!Value.Check(ArtifactSchema, parsed))
  throw new Error('performance corpus: invalid matrix artifact');

const corpus = buildProcurementPerformanceCorpus({
  authorityCui: 'authority-fixture',
  supplierCui: 'supplier-fixture',
});

const apiToArtifactDim: Readonly<Record<string, string>> = {
  authority: 'authorityCui',
  supplier: 'supplierCui',
  cpvDivision: 'cpvDivision',
  cpvCode: 'cpvCode',
  buyerRegion: 'buyerRegion',
  status: 'status',
  procedureType: 'procedureType',
};

describe('procurement performance corpus closure', () => {
  it('is the exact 29-case release corpus including controls and rejections', () => {
    const expected = [
      ...['month', 'quarter', 'year'].map(
        (bucket) => `platform-contract:distinctSuppliers:${bucket}`
      ),
      ...['month', 'quarter', 'year'].map(
        (bucket) => `platform-contract:distinctAuthorities:${bucket}`
      ),
      ...['month', 'quarter', 'year'].map(
        (bucket) => `authority-contract:distinctSuppliers:${bucket}`
      ),
      ...['month', 'quarter', 'year'].map(
        (bucket) => `supplier-contract:distinctAuthorities:${bucket}`
      ),
      ...['month', 'quarter', 'year'].map((bucket) => `authority-da:distinctSuppliers:${bucket}`),
      ...['month', 'quarter', 'year'].map((bucket) => `supplier-da:distinctAuthorities:${bucket}`),
      ...[
        'supplier',
        'authority',
        'cpvDivision',
        'cpvCode',
        'status',
        'procedureType',
        'buyerRegion',
      ].map((dimension) => `platform-breakdown:contract:${dimension}`),
      'bounded-authority-stats',
      'bounded-authority-supplier-breakdown',
      'rejected-unbounded-da-distinct',
      'rejected-supplier-fixed-concentration',
    ];

    expect(corpus.map((testCase) => testCase.label)).toEqual(expected);
    expect(new Set(corpus.map((testCase) => testCase.label)).size).toBe(29);
    expect(
      corpus
        .filter((testCase) => testCase.expectsInvalidInput === true)
        .map((testCase) => testCase.label)
    ).toEqual(['rejected-unbounded-da-distinct', 'rejected-supplier-fixed-concentration']);
  });

  it('contains every advertised distinct row and bucket exactly once', () => {
    const expected = parsed.combinations
      .filter(
        (row) =>
          row.serving.kind === 'rollup' &&
          row.shape === 'series' &&
          (row.measure === 'distinctSuppliers' || row.measure === 'distinctAuthorities')
      )
      .flatMap((row) =>
        ['month', 'quarter', 'year'].map(
          (bucket) => `${row.grain}|${row.scopeDims.join('+')}|${row.measure ?? ''}|${bucket}`
        )
      )
      .sort();
    const actual = corpus
      .filter((testCase) => testCase.distinct !== undefined)
      .map((testCase) => {
        const scope = testCase.variables?.['scope'] as Record<string, unknown>;
        const dims = Object.keys(scope)
          .filter((key) => key !== 'grain')
          .sort();
        return `${String(scope['grain'])}|${dims.join('+')}|${String(testCase.variables?.['measure'])}|${String(testCase.variables?.['bucket'])}`;
      })
      .sort();
    expect(actual).toEqual(expected);
  });

  it('contains every advertised platform contract breakdown dimension', () => {
    const expected = parsed.combinations
      .filter(
        (row) =>
          row.serving.kind === 'rollup' &&
          row.shape === 'breakdown' &&
          row.grain === 'contract' &&
          row.scopeDims.length === 0
      )
      .map((row) => row.breakdownDim)
      .sort();
    const actual = corpus
      .filter((testCase) => testCase.label.startsWith('platform-breakdown:contract:'))
      .map((testCase) => apiToArtifactDim[String(testCase.variables?.['dimension'])])
      .sort();
    expect(actual).toEqual(expected);
  });
});
