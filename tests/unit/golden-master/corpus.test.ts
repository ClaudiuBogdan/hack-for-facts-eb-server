import { parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';

import { buildLegacySchema } from './legacy-schema.js';
import {
  computeCaseKey,
  CorpusValidationError,
  DEFAULT_CORPUS_PATH,
  loadCorpus,
  readCorpusFile,
  sha256Hex,
  validateCorpus,
} from '../../golden-master/corpus.js';

const DOCUMENT = `
  query EntitySearch($filter: EntityFilter, $limit: Int) {
    entities(filter: $filter, limit: $limit) {
      nodes { name cui }
    }
  }
`;

const META = { generator: 'scripts/gm/gen-client-corpus.mts', clientCommit: 'f'.repeat(40) };

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'entity-search',
    document: DOCUMENT,
    variables: { filter: { search: 'Cluj' }, limit: 8 },
    source: 'src/lib/api/entities.ts:312-331',
    status: 'live',
    ...overrides,
  };
}

function file(entries: Record<string, unknown>[], meta: Record<string, unknown> = META) {
  return { meta, entries };
}

describe('golden-master corpus loader', () => {
  it('accepts a well-formed entry and computes sha256(document):sha256(canonical variables)', () => {
    const [entryCase] = validateCorpus(file([entry()]));
    expect(entryCase?.operationName).toBe('EntitySearch');
    expect(entryCase?.documentHash).toBe(sha256Hex(DOCUMENT));
    // Canonical = sorted keys, so key order in the JSON must not change the key.
    const reordered = computeCaseKey(DOCUMENT, { limit: 8, filter: { search: 'Cluj' } });
    expect(entryCase?.key).toBe(reordered.key);
    expect(entryCase?.key).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
  });

  it('requires the meta block with a generator and a client commit pin', () => {
    expect(() => validateCorpus({ entries: [entry()] })).toThrow(CorpusValidationError);
    expect(() => validateCorpus(file([entry()], { generator: 'x' }))).toThrow(
      CorpusValidationError
    );
    expect(() => validateCorpus(file([entry()], { ...META, clientCommit: 'abc' }))).toThrow(
      CorpusValidationError
    );
    expect(
      validateCorpus(file([entry()], { ...META, clientCommit: `${'f'.repeat(40)}+dirty` }))
    ).toHaveLength(1);
    expect(() => validateCorpus(file([entry()], { ...META, extra: 1 }))).toThrow(
      CorpusValidationError
    );
  });

  it('rejects entries missing document, variables, source or status', () => {
    for (const field of ['document', 'variables', 'source', 'status']) {
      const broken = Object.fromEntries(Object.entries(entry()).filter(([key]) => key !== field));
      expect(() => validateCorpus(file([broken])), field).toThrow(CorpusValidationError);
    }
  });

  it('rejects a bad status, a non file:line source and a non-kebab id', () => {
    expect(() => validateCorpus(file([entry({ status: 'maybe' })]))).toThrow(CorpusValidationError);
    expect(() => validateCorpus(file([entry({ source: 'entities.ts' })]))).toThrow(
      CorpusValidationError
    );
    expect(() => validateCorpus(file([entry({ id: 'Entity Search' })]))).toThrow(
      CorpusValidationError
    );
  });

  it('rejects documents that do not parse with graphql parse', () => {
    expect(() => validateCorpus(file([entry({ document: 'query { entities( }' })]))).toThrow(
      /does not parse/
    );
  });

  it('rejects documents with more than one operation', () => {
    const two = `${DOCUMENT}\nquery Other { entities { nodes { cui } } }`;
    expect(() => validateCorpus(file([entry({ document: two })]))).toThrow(/exactly one operation/);
  });

  it('rejects an undeclared variable (would otherwise fail identically on both endpoints)', () => {
    expect(() =>
      validateCorpus(file([entry({ variables: { filtre: { search: 'x' }, limit: 8 } })]))
    ).toThrow(/"filtre" is supplied but not declared/);
  });

  it('rejects a missing non-null variable and accepts a missing nullable one', () => {
    const required = `
      query Uats($search: String!, $limit: Int!, $offset: Int!) {
        uats(filter: { search: $search }, limit: $limit, offset: $offset) { nodes { id } }
      }
    `;
    expect(() =>
      validateCorpus(file([entry({ document: required, variables: { search: '', limit: 100 } })]))
    ).toThrow(/non-null variable "\$offset" is not supplied/);

    const nullable = validateCorpus(file([entry({ variables: { limit: 8 } })]));
    expect(nullable).toHaveLength(1);
  });

  it('rejects duplicate ids and duplicate document+variables', () => {
    expect(() => validateCorpus(file([entry(), entry()]))).toThrow(/duplicate corpus id/);
    expect(() => validateCorpus(file([entry(), entry({ id: 'entity-search-2' })]))).toThrow(
      /same document and variables/
    );
    const different = validateCorpus(
      file([entry(), entry({ id: 'entity-search-2', variables: { limit: 9 } })])
    );
    expect(different).toHaveLength(2);
  });

  it('rejects unknown fields on an entry', () => {
    expect(() => validateCorpus(file([entry({ notes: 'x' })]))).toThrow(CorpusValidationError);
  });

  describe('the real corpus file', () => {
    const cases = loadCorpus(DEFAULT_CORPUS_PATH);

    it('pins the generator and a client commit', () => {
      const raw = readCorpusFile(DEFAULT_CORPUS_PATH);
      expect(raw.meta.generator).toBe('scripts/gm/gen-client-corpus.mts');
      expect(raw.meta.clientCommit).toMatch(/^[0-9a-f]{40}$/);
    });

    it('covers the 51 distinct legacy documents, 4 invalid-today, 5 dead', () => {
      expect(new Set(cases.map((c) => c.document)).size).toBe(51);
      expect(cases.filter((c) => c.status === 'invalid-today').map((c) => c.operationName)).toEqual(
        expect.arrayContaining([
          'GetDatasets',
          'UatNames',
          'BudgetSectorNames',
          'FundingSourceNames',
        ])
      );
      expect(cases.filter((c) => c.status === 'dead').map((c) => c.operationName)).toEqual(
        expect.arrayContaining([
          'CommitmentsLineItems',
          'CommitmentVsExecution',
          'CampaignUatDirectory',
          'InsUatDashboard',
          'InsDatasetsByCodes',
        ])
      );
    });

    it('names every operation the client sends over /graphql', () => {
      const names = new Set(cases.map((c) => c.operationName));
      for (const expected of [
        'GetExecutionLineItemsAnalytics',
        'GetStaticChartAnalytics',
        'Datasets',
        'GetHeatmapCountyData',
        'GetHeatmapUATData',
        'EntityAnalytics',
        'AggregatedLineItems',
        'BudgetSectors',
        'NationalBudgetFundingSources',
        'EntitySearch',
        'CommitmentsSummary',
        'CommitmentsAggregated',
        'CommitmentsAnalytics',
        'EntityNames',
        'FunctionalClassificationNames',
        'EconomicClassificationNames',
        'AllFunctionalClassifications',
        'AllEconomicClassifications',
        'Counties',
        'EconomicClassifications',
        'Entities',
        'FunctionalClassifications',
        'FundingSources',
        'Uats',
        'InsTerritories',
        'InsDatasetsExplorer',
        'StatisticsLandingData',
        'StatisticsLandingCatalog',
        'StatisticsUatSnapshot',
        'StatisticsDatasetTier0',
        'StatisticsDatasetSeries',
        'StatisticsTerritoryHub',
        'StatisticsTerritoryHubContext',
        'InsContexts',
        'InsDatasets',
        'InsDatasetDetails',
        'InsDatasetDimensionValues',
        'InsObservations',
        'InsDatasetHistory',
        'InsDatasetDimensions',
        'InsObservationsBatch',
      ]) {
        expect(names.has(expected), expected).toBe(true);
      }
    });

    it('keeps the client aliases verbatim in the documents', () => {
      const aggregated = cases.find((c) => c.operationName === 'AggregatedLineItems');
      expect(aggregated?.document).toContain('fn_c: functional_code');
      const batch = cases.find((c) => c.operationName === 'InsObservationsBatch');
      expect(batch?.document).toContain('d0: insObservations(datasetCode: "POP107D"');
      expect(batch?.document).toContain('d3: insObservations(datasetCode: "LOC101B"');
      const catalog = cases.find((c) => c.operationName === 'StatisticsLandingCatalog');
      expect(catalog?.document).toContain(
        't8: insDatasets(filter: { rootContextCode: "8" }, limit: 1)'
      );
    });

    it('sources every entry to a client file:line', () => {
      for (const c of cases) {
        expect(c.source, c.id).toMatch(/^src\/[^:]+\.tsx?:\d+-\d+$/);
      }
    });

    it('carries the builder-derived variables the reviews asked for', () => {
      const chart = cases.find((c) => c.id === 'execution-analytics-entity-income-expense');
      const inputs = (chart?.variables['inputs'] ?? []) as {
        seriesId: string;
        filter: Record<string, unknown>;
      }[];
      expect(inputs.map((i) => i.seriesId)).toEqual(['4b42c976', '35fd44fc']);
      expect(inputs[0]?.filter['report_period']).toEqual({
        type: 'YEAR',
        selection: { interval: { start: '2016', end: '2026' } },
      });

      // Commitments.tsx: the base filter omits show_period_growth; the trend filter sends it.
      const summary = cases.find((c) => c.id === 'commitments-summary-entity-2025');
      expect(summary?.variables['filter']).not.toHaveProperty('show_period_growth');
      const trend = cases.find((c) => c.id === 'commitments-analytics-entity-trend');
      const trendInputs = (trend?.variables['inputs'] ?? []) as {
        filter: Record<string, unknown>;
      }[];
      expect(trendInputs[0]?.filter['show_period_growth']).toBe(false);
    });

    describe('against the legacy schema built offline from the 18 SDL constants', () => {
      const schema = buildLegacySchema();
      const messages = new Map(
        cases.map((c) => [c.id, validate(schema, parse(c.document)).map((e) => e.message)] as const)
      );

      it('validates every live and dead document', () => {
        for (const c of cases) {
          if (c.status === 'invalid-today') continue;
          expect(messages.get(c.id), c.id).toEqual([]);
        }
      });

      it('rejects exactly the four invalid-today documents with the inventory messages', () => {
        const invalid = [...messages.entries()].filter(([, errors]) => errors.length > 0);
        expect(Object.fromEntries(invalid)).toEqual({
          'get-datasets-invalid': ['Cannot query field "data" on type "Dataset".'],
          'uat-names-invalid': [
            'Variable "$uatIds" of type "[String!]!" used in position expecting type "[ID!]".',
          ],
          'budget-sector-names-invalid': [
            'Variable "$ids" of type "[String!]" used in position expecting type "[ID!]".',
          ],
          'funding-source-names-invalid': [
            'Variable "$ids" of type "[String!]" used in position expecting type "[ID!]".',
          ],
        });
        for (const [id] of invalid) {
          expect(cases.find((c) => c.id === id)?.status, id).toBe('invalid-today');
        }
      });
    });
  });
});
