import { readFileSync } from 'node:fs';

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Decimal } from 'decimal.js';
import { expect } from 'vitest';

import { policyFor } from '@/modules/procurement/core/policy.js';

import type { MeasureId } from '@/modules/procurement/core/constants.js';
import type { Pool } from 'pg';

const ARTIFACT_URL = new URL(
  '../../../src/modules/procurement/core/procurement-analysis-combinations-v2.json',
  import.meta.url
);

const CombinationSchema = Type.Object(
  {
    grain: Type.Union([
      Type.Literal('procedure'),
      Type.Literal('contract'),
      Type.Literal('direct_acquisition'),
    ]),
    scopeDims: Type.Array(Type.String()),
    shape: Type.Union([
      Type.Literal('stats'),
      Type.Literal('series'),
      Type.Literal('breakdown'),
      Type.Literal('concentration'),
    ]),
    measure: Type.Optional(Type.String()),
    breakdownDim: Type.Optional(Type.String()),
    serving: Type.Object(
      {
        kind: Type.Union([
          Type.Literal('rollup'),
          Type.Literal('rejected'),
          Type.Literal('bounded_fact_query'),
        ]),
        rollup: Type.Optional(Type.String()),
        missingCapability: Type.Optional(Type.String()),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
const ArtifactSchema = Type.Object(
  {
    version: Type.Literal('procurement-analysis-combinations-v2'),
    timeDims: Type.Tuple([Type.Literal('from'), Type.Literal('to'), Type.Literal('year')]),
    combinations: Type.Array(CombinationSchema),
  },
  { additionalProperties: false }
);

type Combination = Static<typeof CombinationSchema>;
type Gql = (
  query: string,
  variables?: Record<string, unknown>
) => Promise<{
  readonly data?: Record<string, unknown>;
  readonly errors?: readonly unknown[];
}>;
type McpCall = (
  name: string,
  args: Record<string, unknown>
) => Promise<{
  readonly ok: boolean;
  readonly error?: string;
  readonly items?: readonly Record<string, unknown>[];
}>;

const rawArtifact = readFileSync(ARTIFACT_URL, 'utf8');
// eslint-disable-next-line no-restricted-syntax -- hash-pinned bytes, immediately TypeBox-validated
const parsedArtifact: unknown = JSON.parse(rawArtifact);
if (!Value.Check(ArtifactSchema, parsedArtifact)) {
  throw new Error('procurement matrix golden: vendored artifact failed schema validation');
}
const artifact = parsedArtifact;

const ROLLUP_TABLE: Readonly<Record<string, string>> = {
  analysis_rollup_edge_monthly: 'procurement.analysis_rollup_edge_monthly',
  analysis_rollup_authority_dims_monthly: 'procurement.analysis_rollup_authority_dims_monthly',
  analysis_rollup_supplier_cpv_monthly: 'procurement.analysis_rollup_supplier_cpv_monthly',
  analysis_rollup_cpv_code_monthly: 'procurement.analysis_rollup_cpv_code_monthly',
  analysis_rollup_region_cpv_monthly: 'procurement.analysis_rollup_region_cpv_monthly',
};
const DIM_COLUMN: Readonly<Record<string, string>> = {
  authorityCui: 'authority_cui',
  supplierCui: 'supplier_cui',
  cpvDivision: 'cpv_division',
  cpvCode: 'cpv_code',
  buyerRegion: 'buyer_region',
  status: 'status',
  procedureType: 'procedure_type',
};
const BREAKDOWN_COLUMN: Readonly<Record<string, string>> = {
  authorityCui: 'authority_cui',
  supplierCui: 'supplier_cui',
  cpvDivision: 'cpv_division',
  cpvCode: 'cpv_code',
  buyerRegion: 'buyer_region',
  status: 'status',
  procedureType: 'procedure_type',
};
const BREAKDOWN_API_DIM: Readonly<Record<string, string>> = {
  authorityCui: 'authority',
  supplierCui: 'supplier',
  cpvDivision: 'cpvDivision',
  cpvCode: 'cpvCode',
  buyerRegion: 'buyerRegion',
  status: 'status',
  procedureType: 'procedureType',
};
const SERIES_BUCKETS = ['month', 'quarter', 'year'] as const;
const MONEY_MEASURES = new Set(['valueAwardedSum', 'valueEstimatedSum']);
const CANONICAL_SCOPE_FIELDS = [
  'authorityCui',
  'supplierCui',
  'cpvDivision',
  'cpvCode',
  'buyerCounty',
  'buyerRegion',
  'supplierCounty',
  'supplierRegion',
  'status',
  'procedureType',
  'grain',
  'from',
  'to',
  'year',
] as const;

const META_SELECTION = `meta {
  answerability reason policyKey grain valueBasis dateBasis population buildId
  counts { rows withValue } undatedInScope { count valueRon }
  provisional caveats canonicalScope
}`;

const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const array = (value: unknown): readonly unknown[] => value as readonly unknown[];

const combinationLabel = (combination: Combination, suffix = ''): string =>
  [
    combination.grain,
    combination.scopeDims.length === 0 ? 'platform' : combination.scopeDims.join('+'),
    combination.shape,
    combination.measure,
    combination.breakdownDim,
    suffix,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join(':');

const tableFor = (combination: Combination): string => {
  const rollup = combination.serving.rollup;
  const table = rollup === undefined ? undefined : ROLLUP_TABLE[rollup];
  if (table === undefined) {
    throw new Error(`matrix golden: unrecognized advertised rollup ${rollup ?? 'undefined'}`);
  }
  return table;
};

const dimensionExpression = (combination: Combination, dim: string): string => {
  const column = DIM_COLUMN[dim];
  if (column === undefined) throw new Error(`matrix golden: unsupported dimension ${dim}`);
  return dim === 'cpvDivision' && combination.serving.rollup === 'analysis_rollup_cpv_code_monthly'
    ? 'substring(cpv_code, 1, 2)'
    : column;
};

const scopeFor = async (
  pool: Pool,
  combination: Combination,
  buildId: string
): Promise<Record<string, unknown>> => {
  if (combination.scopeDims.length === 0) return { grain: combination.grain };
  const selections = combination.scopeDims.map(
    (dim) => `${dimensionExpression(combination, dim)} as "${dim}"`
  );
  const populated = combination.scopeDims.flatMap((dim) => {
    const expression = dimensionExpression(combination, dim);
    return [`${expression} is not null`, `${expression}::text <> ''`];
  });
  if (combination.shape === 'series') populated.push('month_start is not null');
  if (combination.shape === 'concentration') {
    populated.push('supplier_cui is not null', 'coalesce(value_awarded_sum, 0) > 0');
  }
  const fixture = await pool.query<Record<string, unknown>>(
    `select ${selections.join(', ')}
       from ${tableFor(combination)}
      where build_id = $1 and grain = $2 and ${populated.join(' and ')}
      order by record_count desc nulls last
      limit 1`,
    [buildId, combination.grain]
  );
  const row = fixture.rows[0];
  if (row === undefined) {
    throw new Error(
      `${combinationLabel(combination)}: advertised rollup has no populated fixture tuple`
    );
  }
  return {
    grain: combination.grain,
    ...Object.fromEntries(
      combination.scopeDims.map((dim) => {
        const value = row[dim];
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(`${combinationLabel(combination)}: fixture omitted ${dim}`);
        }
        return [dim, value];
      })
    ),
  };
};

interface WhereClause {
  readonly sql: string;
  readonly params: unknown[];
}

const whereFor = (
  combination: Combination,
  buildId: string,
  scope: Record<string, unknown>
): WhereClause => {
  const clauses = ['build_id = $1', 'grain = $2'];
  const params: unknown[] = [buildId, combination.grain];
  for (const dim of combination.scopeDims) {
    const value = scope[dim];
    if (typeof value !== 'string') {
      throw new Error(`matrix golden: unsupported SQL fixture dimension ${dim}`);
    }
    params.push(value);
    const parameter = `$${String(params.length)}`;
    clauses.push(`${dimensionExpression(combination, dim)} = ${parameter}`);
  }
  return { sql: clauses.join(' and '), params };
};

const normalizeMeta = (value: unknown): Record<string, unknown> => {
  const meta = record(value);
  return {
    answerability: meta['answerability'],
    reason: meta['reason'] ?? null,
    policyKey: meta['policyKey'],
    grain: meta['grain'],
    valueBasis: meta['valueBasis'] ?? null,
    dateBasis: meta['dateBasis'],
    population: meta['population'],
    buildId: meta['buildId'],
    counts: meta['counts'] ?? null,
    undatedInScope: meta['undatedInScope'] ?? null,
    provisional: meta['provisional'],
    caveats: meta['caveats'],
    canonicalScope: meta['canonicalScope'],
  };
};

type Answerability = 'served' | 'degraded' | 'abstained';
type GateState = 'allow' | 'degraded' | 'abstain';
interface EnvelopeExpectation {
  readonly answerability: Answerability;
  readonly valueBasis: 'estimated' | 'awarded' | null;
  readonly moneyAllowed: boolean;
}

const qualityClass = (
  quality: Record<string, unknown>,
  grain: Combination['grain'],
  gate: 'spend' | 'time' | 'geo'
): GateState => {
  const classes = record(record(quality[grain])['classes']);
  const value = classes[gate];
  if (value === 'allow' || value === 'degraded' || value === 'abstain') return value;
  return 'abstain';
};

const composeGate = (states: readonly GateState[]): GateState =>
  states.includes('abstain') ? 'abstain' : states.includes('degraded') ? 'degraded' : 'allow';

const expectedEnvelope = (
  combination: Combination,
  scope: Record<string, unknown>,
  quality: Record<string, unknown>,
  basis?: 'count' | 'value'
): EnvelopeExpectation => {
  const { grain, shape } = combination;
  const spend = qualityClass(quality, grain, 'spend');
  const shapeStates: GateState[] = [];
  if (
    shape === 'series' ||
    scope['from'] !== undefined ||
    scope['to'] !== undefined ||
    scope['year'] !== undefined
  ) {
    shapeStates.push(qualityClass(quality, grain, 'time'));
  }
  if (scope['buyerRegion'] !== undefined || combination.breakdownDim === 'buyerRegion') {
    shapeStates.push(qualityClass(quality, grain, 'geo'));
  }
  const shapeGate = composeGate(shapeStates);

  if (shape === 'series') {
    const measure = combination.measure as MeasureId | undefined;
    const policy = measure === undefined ? undefined : policyFor(grain, measure);
    if (policy === undefined) throw new Error(`${combinationLabel(combination)}: no policy`);
    const requested = composeGate([
      shapeGate,
      ...(policy.gateClass === 'spend' ? [spend] : []),
      ...(policy.blocked === undefined ? [] : ['abstain' as const]),
    ]);
    return {
      answerability:
        requested === 'abstain' ? 'abstained' : requested === 'degraded' ? 'degraded' : 'served',
      valueBasis: policy.valueBasis,
      moneyAllowed: spend === 'allow',
    };
  }

  if (shape === 'concentration') {
    const requested = composeGate([shapeGate, ...(basis === 'value' ? [spend] : [])]);
    return {
      answerability:
        requested === 'abstain' ? 'abstained' : requested === 'degraded' ? 'degraded' : 'served',
      valueBasis: basis === 'value' ? 'awarded' : null,
      moneyAllowed: basis === 'value' && spend === 'allow',
    };
  }

  if (shapeGate === 'abstain') {
    return {
      answerability: 'abstained',
      valueBasis: shape === 'breakdown' && spend !== 'allow' ? null : 'awarded',
      moneyAllowed: spend === 'allow',
    };
  }
  return {
    answerability: shapeGate === 'degraded' || spend !== 'allow' ? 'degraded' : 'served',
    valueBasis: shape === 'breakdown' && spend !== 'allow' ? null : 'awarded',
    moneyAllowed: spend === 'allow',
  };
};

const canonicalScopeFor = (scope: Record<string, unknown>): string =>
  CANONICAL_SCOPE_FIELDS.filter((field) => scope[field] !== undefined)
    .map((field) => `${field}=${encodeURIComponent(String(scope[field]))}`)
    .join('&');

const assertEnvelopeRaw = async (
  pool: Pool,
  combination: Combination,
  buildId: string,
  scope: Record<string, unknown>,
  graphBlock: Record<string, unknown>,
  label: string,
  quality: Record<string, unknown>,
  basis?: 'count' | 'value'
): Promise<EnvelopeExpectation> => {
  const meta = normalizeMeta(graphBlock['meta']);
  const expectedEnvelopeValue = expectedEnvelope(combination, scope, quality, basis);
  expect(meta['answerability'], `${label}: answerability follows generation quality`).toBe(
    expectedEnvelopeValue.answerability
  );
  expect(meta['valueBasis'], `${label}: value basis follows the requested policy`).toBe(
    expectedEnvelopeValue.valueBasis
  );
  expect(meta['buildId'], `${label}: envelope pins the requested build`).toBe(buildId);
  expect(meta['canonicalScope'], `${label}: canonical scope serialization`).toBe(
    canonicalScopeFor(scope)
  );

  const where = whereFor(combination, buildId, scope);
  const raw = await pool.query<{
    rows: string;
    with_value: string;
    dated_rows: string;
    dated_with_value: string;
    undated_rows: string;
    undated_with_value: string;
    undated_value: string | null;
  }>(
    `select coalesce(sum(record_count),0)::text rows,
            coalesce(sum(with_value_count),0)::text with_value,
            coalesce(sum(record_count) filter (where month_start is not null),0)::text dated_rows,
            coalesce(sum(with_value_count) filter (where month_start is not null),0)::text dated_with_value,
            coalesce(sum(record_count) filter (where month_start is null),0)::text undated_rows,
            coalesce(sum(with_value_count) filter (where month_start is null),0)::text undated_with_value,
            (sum(value_awarded_sum) filter (where month_start is null))::text undated_value
       from ${tableFor(combination)} where ${where.sql}`,
    where.params
  );
  const expected = raw.rows[0];
  const countsValue = meta['counts'];
  const undatedValue = meta['undatedInScope'];
  if (expectedEnvelopeValue.answerability === 'abstained') {
    expect(countsValue, `${label}: abstention has no fabricated counts`).toBeNull();
    expect(undatedValue, `${label}: blocked envelope has no fabricated undated totals`).toBeNull();
  } else {
    expect(countsValue, `${label}: served/degraded envelope exposes counts`).not.toBeNull();
    const counts = record(countsValue);
    expect(undatedValue, `${label}: read envelope exposes undated totals`).toBeDefined();
    expect(undatedValue, `${label}: read envelope exposes undated totals`).not.toBeNull();
    const undated = record(undatedValue ?? {});
    expect(counts['rows'], `${label}: envelope raw total rows`).toBe(expected?.rows);
    expect(counts['withValue'], `${label}: envelope raw valued rows`).toBe(expected?.with_value);
    expect(undated['count'], `${label}: envelope raw undated rows`).toBe(expected?.undated_rows);
    expect(
      new Decimal(String(counts['rows'])).minus(String(undated['count'])).toFixed(0),
      `${label}: envelope dated rows reconcile`
    ).toBe(expected?.dated_rows);
    expect(
      new Decimal(String(counts['withValue']))
        .minus(expected?.undated_with_value ?? '0')
        .toFixed(0),
      `${label}: envelope dated valued rows reconcile`
    ).toBe(expected?.dated_with_value);
    if (expectedEnvelopeValue.moneyAllowed) {
      expect(undated['valueRon'], `${label}: envelope raw undated money`).toBe(
        expected?.undated_value === null || expected?.undated_value === undefined
          ? null
          : new Decimal(expected.undated_value).toFixed(2)
      );
    } else {
      expect(undated['valueRon'], `${label}: gate-suppressed undated money is null`).toBeNull();
    }
  }

  if (!expectedEnvelopeValue.moneyAllowed && combination.shape === 'breakdown') {
    for (const bucket of array(graphBlock['buckets']).map(record)) {
      expect(
        bucket['valueAwardedSum'],
        `${label}: count-basis envelope suppresses money`
      ).toBeNull();
    }
  }
  if (!expectedEnvelopeValue.moneyAllowed && combination.shape === 'concentration') {
    expect(graphBlock['totalRon'], `${label}: count-basis envelope has no money total`).toBeNull();
  }
  if (combination.shape === 'breakdown') {
    expect(graphBlock['rankedBy'], `${label}: ranking basis follows the spend verdict`).toBe(
      expectedEnvelopeValue.moneyAllowed ? 'value' : 'count'
    );
  }
  return expectedEnvelopeValue;
};

const normalizeBlock = (shape: Combination['shape'], value: unknown): Record<string, unknown> => {
  const block = record(value);
  const common = { grain: block['grain'], meta: normalizeMeta(block['meta']) };
  if (shape === 'stats') {
    return {
      ...common,
      recordCount: block['recordCount'] ?? null,
      withValueCount: block['withValueCount'] ?? null,
      withEstimatedCount: block['withEstimatedCount'] ?? null,
      valueAwardedSum: block['valueAwardedSum'] ?? null,
      valueEstimatedSum: block['valueEstimatedSum'] ?? null,
      avgValueAwarded: block['avgValueAwarded'] ?? null,
      minMonth: block['minMonth'] ?? null,
      maxMonth: block['maxMonth'] ?? null,
    };
  }
  if (shape === 'series') {
    return {
      ...common,
      measure: block['measure'],
      bucket: block['bucket'],
      points: block['points'],
    };
  }
  if (shape === 'breakdown') {
    return {
      ...common,
      dimension: block['dimension'],
      rankedBy: block['rankedBy'],
      buckets: block['buckets'],
    };
  }
  return {
    ...common,
    basis: block['basis'],
    supplierCount: block['supplierCount'] ?? null,
    top1Share: block['top1Share'] ?? null,
    top5Share: block['top5Share'] ?? null,
    hhi: block['hhi'] ?? null,
    totalRon: block['totalRon'] ?? null,
  };
};

const assertMcpParity = async (
  mcpCall: McpCall,
  combination: Combination,
  scope: Record<string, unknown>,
  graphBlock: Record<string, unknown>,
  args: Record<string, unknown>,
  label: string
): Promise<void> => {
  const mcp = await mcpCall('aggregate_procurement', { shape: combination.shape, scope, ...args });
  expect(mcp.ok, `${label}: MCP error ${mcp.error ?? ''}`).toBe(true);
  expect(mcp.items, `${label}: MCP returned one explicit-grain block`).toHaveLength(1);
  expect(normalizeBlock(combination.shape, mcp.items?.[0]), `${label}: GraphQL = MCP`).toEqual(
    normalizeBlock(combination.shape, graphBlock)
  );
};

const statsGraph = async (
  gql: Gql,
  scope: Record<string, unknown>,
  label: string
): Promise<Record<string, unknown>> => {
  const response = await gql(
    `query($scope:ProcurementAnalysisScopeInput!){ procurementStats(scope:$scope){ blocks {
       grain recordCount withValueCount withEstimatedCount valueAwardedSum valueEstimatedSum
       avgValueAwarded minMonth maxMonth ${META_SELECTION}
     } } }`,
    { scope }
  );
  expect(response.errors, label).toBeUndefined();
  const blocks = array(record(response.data?.['procurementStats'])['blocks']).map(record);
  expect(blocks, `${label}: one explicit-grain block`).toHaveLength(1);
  return blocks[0] ?? {};
};

const assertStatsRaw = async (
  pool: Pool,
  combination: Combination,
  buildId: string,
  scope: Record<string, unknown>,
  graphBlock: Record<string, unknown>,
  label: string,
  expectation: EnvelopeExpectation
): Promise<void> => {
  const where = whereFor(combination, buildId, scope);
  const raw = await pool.query<{
    record_count: string;
    with_value_count: string;
    with_estimated_count: string;
    value_awarded_sum: string | null;
    value_estimated_sum: string | null;
    min_month: string | null;
    max_month: string | null;
  }>(
    `select coalesce(sum(record_count),0)::text record_count,
            coalesce(sum(with_value_count),0)::text with_value_count,
            coalesce(sum(with_estimated_count),0)::text with_estimated_count,
            sum(value_awarded_sum)::text value_awarded_sum,
            sum(value_estimated_sum)::text value_estimated_sum,
            to_char(min(month_start),'YYYY-MM') min_month,
            to_char(max(month_start),'YYYY-MM') max_month
       from ${tableFor(combination)} where ${where.sql}`,
    where.params
  );
  const expected = raw.rows[0];
  expect(
    new Decimal(expected?.record_count ?? '0').greaterThan(0),
    `${label}: fixture population is non-empty`
  ).toBe(true);
  if (expectation.answerability === 'abstained') {
    for (const field of [
      'recordCount',
      'withValueCount',
      'withEstimatedCount',
      'valueAwardedSum',
      'valueEstimatedSum',
      'avgValueAwarded',
      'minMonth',
      'maxMonth',
    ]) {
      expect(graphBlock[field], `${label}: full abstention clears ${field}`).toBeNull();
    }
    return;
  }
  expect(graphBlock['recordCount'], `${label}: raw recordCount`).toBe(expected?.record_count);
  expect(graphBlock['withValueCount'], `${label}: raw withValueCount`).toBe(
    expected?.with_value_count
  );
  expect(graphBlock['withEstimatedCount'], `${label}: raw withEstimatedCount`).toBe(
    expected?.with_estimated_count
  );
  expect(graphBlock['minMonth'], `${label}: raw minMonth`).toBe(expected?.min_month ?? null);
  expect(graphBlock['maxMonth'], `${label}: raw maxMonth`).toBe(expected?.max_month ?? null);
  const expectedAwarded =
    expectation.moneyAllowed && expected?.value_awarded_sum !== null
      ? new Decimal(expected?.value_awarded_sum ?? '0').toFixed(2)
      : null;
  const expectedEstimated =
    expectation.moneyAllowed && expected?.value_estimated_sum !== null
      ? new Decimal(expected?.value_estimated_sum ?? '0').toFixed(2)
      : null;
  expect(graphBlock['valueAwardedSum'], `${label}: raw/gated awarded value`).toBe(expectedAwarded);
  expect(graphBlock['valueEstimatedSum'], `${label}: raw/gated estimated value`).toBe(
    expectedEstimated
  );
  const withValue = new Decimal(expected?.with_value_count ?? '0');
  const expectedAverage =
    expectedAwarded !== null && withValue.greaterThan(0)
      ? new Decimal(expected?.value_awarded_sum ?? '0').div(withValue).toFixed(2)
      : null;
  expect(graphBlock['avgValueAwarded'], `${label}: raw/gated average awarded value`).toBe(
    expectedAverage
  );
};

const seriesGraph = async (
  gql: Gql,
  scope: Record<string, unknown>,
  measure: string,
  bucket: string,
  label: string
): Promise<Record<string, unknown>> => {
  const response = await gql(
    `query($scope:ProcurementAnalysisScopeInput!,$measure:ProcurementAnalysisMeasure!,$bucket:ProcurementSeriesBucket!){
       procurementSeries(scope:$scope,measure:$measure,bucket:$bucket){
         grain measure bucket points { bucket value } ${META_SELECTION}
       }
     }`,
    { scope, measure, bucket }
  );
  expect(response.errors, label).toBeUndefined();
  const blocks = array(response.data?.['procurementSeries']).map(record);
  expect(blocks, `${label}: one explicit-grain block`).toHaveLength(1);
  return blocks[0] ?? {};
};

const assertSeriesRaw = async (
  pool: Pool,
  combination: Combination,
  buildId: string,
  scope: Record<string, unknown>,
  bucket: (typeof SERIES_BUCKETS)[number],
  graphBlock: Record<string, unknown>,
  label: string,
  expectation: EnvelopeExpectation
): Promise<void> => {
  const measure = combination.measure;
  if (measure === undefined) throw new Error(`${label}: matrix series row has no measure`);
  const where = whereFor(combination, buildId, scope);
  const format = bucket === 'month' ? 'YYYY-MM' : bucket === 'quarter' ? 'YYYY-"Q"Q' : 'YYYY';
  const distinctColumn =
    measure === 'distinctSuppliers'
      ? 'supplier_cui'
      : measure === 'distinctAuthorities'
        ? 'authority_cui'
        : undefined;
  const additiveColumn: Readonly<Record<string, string>> = {
    recordCount: 'record_count',
    withValueCount: 'with_value_count',
    valueAwardedSum: 'value_awarded_sum',
    valueEstimatedSum: 'value_estimated_sum',
  };
  const expression =
    distinctColumn === undefined
      ? `sum(${additiveColumn[measure] ?? 'INVALID_MEASURE'})::text`
      : `count(distinct ${distinctColumn})::text`;
  const raw = await pool.query<{ bucket: string; value: string | null }>(
    `select to_char(date_trunc($${String(where.params.length + 1)}, month_start),
                    $${String(where.params.length + 2)}) bucket,
            ${expression} value
       from ${tableFor(combination)}
      where ${where.sql} and month_start is not null
      group by date_trunc($${String(where.params.length + 1)}, month_start)
      order by date_trunc($${String(where.params.length + 1)}, month_start)`,
    [...where.params, bucket, format]
  );
  expect(raw.rows.length, `${label}: fixture population is non-empty`).toBeGreaterThan(0);
  if (expectation.answerability === 'abstained') {
    expect(graphBlock['points'], `${label}: abstention has no fabricated points`).toEqual([]);
    return;
  }
  const expected = raw.rows.map((row) => ({
    bucket: row.bucket,
    value:
      row.value === null
        ? null
        : new Decimal(row.value).toFixed(MONEY_MEASURES.has(measure) ? 2 : 0),
  }));
  expect(graphBlock['points'], `${label}: raw series`).toEqual(expected);
};

interface PerKeyRow {
  readonly key: string | null;
  readonly record_count: string;
  readonly with_value_count: string;
  readonly value_awarded_sum: string | null;
}

const sumDecimal = (rows: readonly PerKeyRow[], field: 'record_count' | 'with_value_count') =>
  rows.reduce((sum, row) => sum.plus(row[field]), new Decimal(0));
const sumNullableMoney = (rows: readonly PerKeyRow[]): Decimal | null => {
  const observed = rows.filter((row) => row.value_awarded_sum !== null);
  return observed.length === 0
    ? null
    : observed.reduce((sum, row) => sum.plus(row.value_awarded_sum ?? '0'), new Decimal(0));
};

const breakdownGraph = async (
  gql: Gql,
  scope: Record<string, unknown>,
  dimension: string,
  label: string
): Promise<Record<string, unknown>> => {
  const response = await gql(
    `query($scope:ProcurementAnalysisScopeInput!,$dimension:ProcurementBreakdownDimension!){
       procurementBreakdown(scope:$scope,dimension:$dimension,topN:10){
         grain dimension rankedBy
         buckets { kind key recordCount withValueCount valueAwardedSum shareOfScope }
         ${META_SELECTION}
       }
     }`,
    { scope, dimension }
  );
  expect(response.errors, label).toBeUndefined();
  const blocks = array(response.data?.['procurementBreakdown']).map(record);
  expect(blocks, `${label}: one explicit-grain block`).toHaveLength(1);
  return blocks[0] ?? {};
};

const assertBreakdownRaw = async (
  pool: Pool,
  combination: Combination,
  buildId: string,
  scope: Record<string, unknown>,
  graphBlock: Record<string, unknown>,
  label: string,
  expectation: EnvelopeExpectation
): Promise<void> => {
  const dim = combination.breakdownDim;
  const column = dim === undefined ? undefined : BREAKDOWN_COLUMN[dim];
  if (column === undefined) throw new Error(`${label}: unknown breakdown dimension ${dim ?? ''}`);
  const where = whereFor(combination, buildId, scope);
  const rankedBy = graphBlock['rankedBy'];
  const rankExpression =
    rankedBy === 'value' ? 'sum(value_awarded_sum)' : 'coalesce(sum(record_count),0)';
  const raw = await pool.query<PerKeyRow>(
    `select ${column} key, coalesce(sum(record_count),0)::text record_count,
            coalesce(sum(with_value_count),0)::text with_value_count,
            sum(value_awarded_sum)::text value_awarded_sum
       from ${tableFor(combination)} where ${where.sql} group by ${column}
       order by ${rankExpression} desc nulls last, ${column} asc nulls last`,
    where.params
  );
  expect(
    sumDecimal(raw.rows, 'record_count').greaterThan(0),
    `${label}: fixture population is non-empty`
  ).toBe(true);
  if (expectation.answerability === 'abstained') {
    expect(graphBlock['buckets'], `${label}: abstention has no fabricated buckets`).toEqual([]);
    return;
  }
  const known = raw.rows.filter(
    (row) =>
      row.key !== null &&
      (new Decimal(row.record_count).greaterThan(0) ||
        !new Decimal(row.value_awarded_sum ?? '0').isZero())
  );
  const top = known.slice(0, 10);
  const otherRows = known.slice(10);
  const unknownRows = raw.rows.filter((row) => row.key === null);
  const totals = raw.rows;
  const basisTotal =
    rankedBy === 'value'
      ? (sumNullableMoney(totals) ?? new Decimal(0))
      : sumDecimal(totals, 'record_count');
  const bucket = (
    kind: 'top' | 'other' | 'unknown',
    key: string | null,
    rows: readonly PerKeyRow[]
  ) => {
    const count = sumDecimal(rows, 'record_count');
    const money = sumNullableMoney(rows);
    const basis = rankedBy === 'value' ? (money ?? new Decimal(0)) : count;
    return {
      kind,
      key,
      recordCount: count.toFixed(0),
      withValueCount: sumDecimal(rows, 'with_value_count').toFixed(0),
      valueAwardedSum: expectation.moneyAllowed && money !== null ? money.toFixed(2) : null,
      shareOfScope: basisTotal.greaterThan(0) ? basis.div(basisTotal).toFixed(4) : null,
    };
  };
  const expected = [
    ...top.map((row) => bucket('top', row.key, [row])),
    bucket('other', null, otherRows),
    bucket('unknown', null, unknownRows),
  ];
  expect(graphBlock['buckets'], `${label}: raw top + other + unknown`).toEqual(expected);
};

const concentrationGraph = async (
  gql: Gql,
  scope: Record<string, unknown>,
  basis: 'count' | 'value',
  label: string
): Promise<Record<string, unknown>> => {
  const response = await gql(
    `query($scope:ProcurementAnalysisScopeInput!,$basis:ProcurementConcentrationBasis!){
       procurementConcentration(scope:$scope,basis:$basis){
         grain basis supplierCount top1Share top5Share hhi totalRon ${META_SELECTION}
       }
     }`,
    { scope, basis }
  );
  expect(response.errors, label).toBeUndefined();
  const blocks = array(response.data?.['procurementConcentration']).map(record);
  expect(blocks, `${label}: one explicit-grain block`).toHaveLength(1);
  return blocks[0] ?? {};
};

const assertConcentrationRaw = async (
  pool: Pool,
  combination: Combination,
  buildId: string,
  scope: Record<string, unknown>,
  basis: 'count' | 'value',
  graphBlock: Record<string, unknown>,
  label: string,
  expectation: EnvelopeExpectation
): Promise<void> => {
  const where = whereFor(combination, buildId, scope);
  const measure = basis === 'count' ? 'record_count' : 'value_awarded_sum';
  const raw = await pool.query<{ supplier_cui: string; measure: string }>(
    `select supplier_cui, coalesce(sum(${measure}),0)::text measure
       from ${tableFor(combination)}
      where ${where.sql} and supplier_cui is not null
      group by supplier_cui`,
    where.params
  );
  expect(raw.rows.length, `${label}: fixture population has known suppliers`).toBeGreaterThan(0);
  if (expectation.answerability === 'abstained') {
    if (basis === 'value') {
      expect(
        raw.rows.reduce((sum, row) => sum.plus(row.measure), new Decimal(0)).greaterThan(0),
        `${label}: abstention withholds a positive raw value population`
      ).toBe(true);
    }
    for (const field of ['supplierCount', 'top1Share', 'top5Share', 'hhi', 'totalRon']) {
      expect(graphBlock[field], `${label}: abstention clears ${field}`).toBeNull();
    }
    return;
  }
  const measures = raw.rows
    .map((row) => new Decimal(row.measure))
    .filter((value) => value.greaterThan(0));
  const total = measures.reduce((sum, value) => sum.plus(value), new Decimal(0));
  const sorted = [...measures].sort((a, b) => b.comparedTo(a));
  const top1 = sorted[0] ?? new Decimal(0);
  const top5 = sorted.slice(0, 5).reduce((sum, value) => sum.plus(value), new Decimal(0));
  const hhi = total.greaterThan(0)
    ? measures.reduce((sum, value) => sum.plus(value.div(total).pow(2)), new Decimal(0))
    : null;
  expect(graphBlock['supplierCount'], `${label}: raw distinct suppliers`).toBe(raw.rows.length);
  expect(graphBlock['top1Share'], `${label}: raw top1`).toBe(
    total.greaterThan(0) ? top1.div(total).toFixed(4) : null
  );
  expect(graphBlock['top5Share'], `${label}: raw top5`).toBe(
    total.greaterThan(0) ? top5.div(total).toFixed(4) : null
  );
  expect(graphBlock['hhi'], `${label}: raw HHI`).toBe(hhi === null ? null : hhi.toFixed(4));
  expect(graphBlock['totalRon'], `${label}: raw positive supplier total`).toBe(
    basis === 'value' && measures.length > 0 ? total.toFixed(2) : null
  );
};

export const reconcileAdvertisedProcurementMatrix = async (options: {
  readonly pool: Pool;
  readonly buildId: string;
  readonly gql: Gql;
  readonly mcpCall: McpCall;
}): Promise<void> => {
  const accepted = artifact.combinations.filter(
    (combination) => combination.serving.kind === 'rollup'
  );
  const generation = await options.pool.query<{ quality: unknown }>(
    `select quality from procurement.analysis_generations where build_id = $1`,
    [options.buildId]
  );
  const qualityValue = generation.rows[0]?.quality;
  if (typeof qualityValue !== 'object' || qualityValue === null || Array.isArray(qualityValue)) {
    throw new Error(`matrix golden: build ${options.buildId} has no quality object`);
  }
  const quality = qualityValue as Record<string, unknown>;
  const executed = new Set<string>();

  for (const combination of accepted) {
    const scope = await scopeFor(options.pool, combination, options.buildId);
    if (combination.shape === 'stats') {
      const label = combinationLabel(combination);
      const graph = await statsGraph(options.gql, scope, label);
      const envelope = await assertEnvelopeRaw(
        options.pool,
        combination,
        options.buildId,
        scope,
        graph,
        label,
        quality
      );
      await assertMcpParity(options.mcpCall, combination, scope, graph, {}, label);
      await assertStatsRaw(
        options.pool,
        combination,
        options.buildId,
        scope,
        graph,
        label,
        envelope
      );
      executed.add(label);
      continue;
    }
    if (combination.shape === 'series') {
      const measure = combination.measure;
      if (measure === undefined) throw new Error('advertised series row has no measure');
      for (const bucket of SERIES_BUCKETS) {
        const label = combinationLabel(combination, bucket);
        const graph = await seriesGraph(options.gql, scope, measure, bucket, label);
        const envelope = await assertEnvelopeRaw(
          options.pool,
          combination,
          options.buildId,
          scope,
          graph,
          label,
          quality
        );
        await assertMcpParity(
          options.mcpCall,
          combination,
          scope,
          graph,
          { measure, bucket },
          label
        );
        await assertSeriesRaw(
          options.pool,
          combination,
          options.buildId,
          scope,
          bucket,
          graph,
          label,
          envelope
        );
        executed.add(label);
      }
      continue;
    }
    if (combination.shape === 'breakdown') {
      const dimension =
        combination.breakdownDim === undefined
          ? undefined
          : BREAKDOWN_API_DIM[combination.breakdownDim];
      if (dimension === undefined)
        throw new Error('advertised breakdown row has no known dimension');
      const label = combinationLabel(combination);
      const graph = await breakdownGraph(options.gql, scope, dimension, label);
      const envelope = await assertEnvelopeRaw(
        options.pool,
        combination,
        options.buildId,
        scope,
        graph,
        label,
        quality
      );
      await assertMcpParity(
        options.mcpCall,
        combination,
        scope,
        graph,
        { dimension, topN: 10 },
        label
      );
      await assertBreakdownRaw(
        options.pool,
        combination,
        options.buildId,
        scope,
        graph,
        label,
        envelope
      );
      executed.add(label);
      continue;
    }
    for (const basis of ['count', 'value'] as const) {
      const label = combinationLabel(combination, basis);
      const graph = await concentrationGraph(options.gql, scope, basis, label);
      const envelope = await assertEnvelopeRaw(
        options.pool,
        combination,
        options.buildId,
        scope,
        graph,
        label,
        quality,
        basis
      );
      await assertMcpParity(options.mcpCall, combination, scope, graph, { basis }, label);
      await assertConcentrationRaw(
        options.pool,
        combination,
        options.buildId,
        scope,
        basis,
        graph,
        label,
        envelope
      );
      executed.add(label);
    }
  }

  const expectedExecutions = accepted.reduce(
    (count, combination) =>
      count +
      (combination.shape === 'series'
        ? SERIES_BUCKETS.length
        : combination.shape === 'concentration'
          ? 2
          : 1),
    0
  );
  expect(accepted, 'the live corpus is sourced from the advertised matrix').toHaveLength(388);
  expect(executed.size, 'every advertised rollup case and series bucket/basis executed').toBe(
    expectedExecutions
  );
  console.info(
    `procurement exhaustive matrix golden buildId=${options.buildId} advertised=${String(accepted.length)} executions=${String(executed.size)}`
  );
};
