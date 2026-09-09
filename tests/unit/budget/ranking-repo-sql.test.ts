import { describe, expect, it } from 'vitest';

import { makeBudgetRepo } from '@/modules/budget/shell/repo/budget-repo.js';

import { makeCapturingDb } from '../../fixtures/capturing-db.js';

interface CapturedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const flat = (value: string): string => value.replace(/\s+/gu, ' ').trim();

describe('budget ranking repository filters', () => {
  it('uses the requested MV and parameterizes entity scope filters', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'QUARTER',
      quarter: 3,
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      entityCuis: ['111', '222'],
      mainCreditorCui: '999',
      excludeEntityCuis: ['999'],
      limit: 5,
    });

    expect(result.isOk()).toBe(true);
    const query = captured[0];
    expect(query).toBeDefined();
    const sql = flat(query!.sql);
    expect(sql).toContain('from "budget"."mv_execution_summary_quarterly" as "mv"');
    expect(sql).toContain('"mv"."quarter" =');
    expect(sql).toContain('mv.entity_cui in');
    expect(sql).toContain('mv.main_creditor_cui =');
    expect(sql).toContain('mv.entity_cui not in');
    expect(sql).toContain('sum(coalesce(mv."total_expense",0))');
    expect(sql).toContain('group by mv.entity_cui, mv.year, e.name');
    expect(query!.parameters).toEqual(expect.arrayContaining([2025, 3, '111', '222', '999']));
  });

  it('ranks commitments by the coalesced sum it selects', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankCommitmentEntities({
      year: 2024,
      reportType: 'COMMITMENT_AGG_PRINCIPAL',
      metric: 'credite_angajament',
      limit: 10,
    });

    expect(result.isOk()).toBe(true);
    const query = captured[0];
    expect(query).toBeDefined();
    const sql = flat(query!.sql);
    expect(sql).toContain('sum(coalesce(mv."credite_angajament",0))::text');
    // The ORDER BY uses the same coalesced expression as the SELECT: an
    // all-null scope is zero, not a "nulls last" row below negative amounts.
    expect(sql).toContain(
      'order by sum(coalesce(mv."credite_angajament",0)) desc, "mv"."entity_cui" asc'
    );
    expect(sql).not.toContain('nulls last');
    expect(query!.parameters).toEqual(expect.arrayContaining([2024, 10]));
  });

  it.each([
    { name: 'a non-positive year', q: { year: 0, limit: 10 }, field: 'year' },
    { name: 'a fractional year', q: { year: 2024.5, limit: 10 }, field: 'year' },
    { name: 'a zero limit', q: { year: 2024, limit: 0 }, field: 'limit' },
    { name: 'a limit above the maximum', q: { year: 2024, limit: 101 }, field: 'limit' },
  ])('rejects $name for commitment rankings before executing SQL', async ({ q, field }) => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankCommitmentEntities({
      reportType: 'COMMITMENT_AGG_PRINCIPAL',
      metric: 'credite_angajament',
      ...q,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field });
    expect(captured).toHaveLength(0);
  });

  it('rejects an incompatible period tuple before executing SQL', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'YEAR',
      month: 5,
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      limit: 5,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'frequency',
    });
    expect(captured).toHaveLength(0);
  });

  it.each([
    ['MONTH', 'month'],
    ['QUARTER', 'quarter'],
  ] as const)('requires the period selected by %s frequency', async (frequency, field) => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency,
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      limit: 5,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field,
    });
    expect(captured).toHaveLength(0);
  });

  it('rejects a custom limit in complete classification mode', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.aggregateByClassification({
      filter: {
        reportingYear: { eq: 2025 },
        reportType: { eq: 'EXECUTION_DETAILED' },
        accountCategory: { eq: 'EXPENSE' },
        frequency: { eq: 'YEAR' },
      },
      normalization: 'TOTAL',
      limit: 51,
      complete: true,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'limit' });
    expect(captured).toHaveLength(0);
  });

  it('applies valid row-level amount bounds to classification facts', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.aggregateByClassification({
      filter: {
        reportingYear: { eq: 2025 },
        reportType: { eq: 'EXECUTION_DETAILED' },
        accountCategory: { eq: 'EXPENSE' },
        frequency: { eq: 'YEAR' },
        minAmount: { gte: '10.50' },
      },
      normalization: 'TOTAL',
      limit: 50,
    });

    expect(result.isOk()).toBe(true);
    const aggregateSql = captured
      .map((query) => flat(query.sql))
      .find((sql) => sql.includes('group by'));
    expect(aggregateSql).toContain('"eli"."ytd_amount"::numeric >=');
    expect(captured.some((query) => query.parameters.includes('10.50'))).toBe(true);
  });

  it('rejects invalid row-level amount bounds before SQL', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.aggregateByClassification({
      filter: {
        reportingYear: { eq: 2025 },
        reportType: { eq: 'EXECUTION_DETAILED' },
        accountCategory: { eq: 'EXPENSE' },
        frequency: { eq: 'YEAR' },
        minAmount: { gte: '1,25' },
      },
      normalization: 'TOTAL',
      limit: 50,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'filter.minAmount',
    });
    expect(captured).toHaveLength(0);
  });

  it.each([
    [{ year: 0 }, 'year'],
    [{ mainCreditorCui: '' }, 'mainCreditorCui'],
  ] as const)('rejects invalid core ranking input before SQL', async (override, field) => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      limit: 5,
      ...override,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field,
    });
    expect(captured).toHaveLength(0);
  });

  it('compiles explicit empty inclusion filters to false', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      entityCuis: [],
      countyCodes: [],
      regions: [],
      limit: 5,
    });

    expect(result.isOk()).toBe(true);
    const sql = flat(captured[0]!.sql);
    expect(sql.match(/\bfalse\b/gu)).toHaveLength(3);
  });

  it('aggregates unscoped creditor rows and groups territory columns for per-capita rank', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'PER_CAPITA',
      isUat: true,
      minPopulation: 1_000,
      limit: 50,
    });

    expect(result.isOk()).toBe(true);
    const query = captured[0];
    expect(query).toBeDefined();
    const sql = flat(query!.sql);
    expect(sql).toContain('sum(coalesce(mv."total_expense",0))');
    expect(sql).not.toContain('mv.main_creditor_cui =');
    expect(sql).toContain('left join "core"."territories" as "t"');
    expect(sql).toContain(
      'group by mv.entity_cui, mv.year, e.name, e.entity_type, e.is_territorial_executive, t.id, t.population, t.county_code, t.county_name'
    );
    expect(sql).toContain('when e.is_territorial_executive then t.population else null end');
    expect(sql).not.toContain('county_population');
    expect(sql).not.toContain('candidate.county_code = t.county_code');
    expect(sql).toContain('where r.population > 0');
    expect(sql).toContain('> 0');
    expect(sql).not.toContain('t.population >=');
    expect(query!.parameters).toContain(1_000);
  });

  it('collapses creditor-grain rows to one execution series point per period', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.executionTimeseries({
      entityCui: '4270740',
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      metric: 'EXPENSE',
      frequency: 'YEAR',
      normalization: 'TOTAL',
      yearFrom: 2024,
      yearTo: 2025,
    });

    expect(result.isOk()).toBe(true);
    expect(captured).toHaveLength(1);
    const sql = flat(captured[0]!.sql);
    expect(sql).toContain('sum(coalesce(mv."total_expense",0))');
    expect(sql).toContain('group by "mv"."year", null::int');
    expect(sql).not.toContain('coalesce(mv."total_expense",0) *');
  });

  it('treats a missing per-capita denominator as no data, not zero', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.executionTimeseries({
      entityCui: '4270740',
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      metric: 'EXPENSE',
      frequency: 'YEAR',
      normalization: 'PER_CAPITA',
      yearFrom: 2025,
      yearTo: 2025,
    });

    expect(result.isOk()).toBe(true);
    const sql = flat(captured[0]!.sql);
    expect(sql).toMatch(/having .* > 0/u);
    expect(sql).not.toContain('else 0::numeric');
  });

  it('rolls county heatmaps up from UAT CUIs with canonical population', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.countyHeatmap({
      year: 2025,
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      metric: 'EXPENSE',
      normalization: 'PER_CAPITA',
    });

    expect(result.isOk()).toBe(true);
    expect(captured).toHaveLength(1);
    const sql = flat(captured[0]!.sql);
    expect(sql).toContain('mv.entity_cui = territory.uat_code');
    expect(captured[0]!.parameters).toEqual(expect.arrayContaining(['B', '179132']));
    expect(sql).toContain('/ county.population)::text');
    expect(sql).toContain('having count(mv.entity_cui) > 0');
    expect(sql).not.toContain('sum(distinct');
    expect(sql).toContain('executive.territory_id = candidate.id');
    expect(sql).toContain('executive.is_territorial_executive');
    expect(sql).toContain('case when count(*) = 1 then min(executive.cui) else null end');
  });

  it('returns the complete UAT grain without a top-N limit', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.uatHeatmap({
      year: 2025,
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      metric: 'EXPENSE',
      normalization: 'TOTAL',
    });

    expect(result.isOk()).toBe(true);
    expect(captured).toHaveLength(1);
    const sql = flat(captured[0]!.sql);
    expect(sql).toContain('mv.entity_cui = territory.uat_code');
    expect(sql).toContain('sum(coalesce(mv."total_expense",0))');
    expect(sql).toContain('group by territory.id, territory.uat_code');
    expect(sql).not.toMatch(/\blimit\b/u);
  });

  it.each([
    ['minAmount', { minAmount: 'not-money' }],
    ['maxAmount', { maxAmount: '1,25' }],
  ] as const)('rejects an invalid classification %s before SQL', async (field, amount) => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.aggregateByClassification({
      filter: {
        reportingYear: { eq: 2025 },
        reportType: { eq: 'EXECUTION_DETAILED' },
        accountCategory: { eq: 'EXPENSE' },
        frequency: { eq: 'YEAR' },
      },
      normalization: 'TOTAL',
      limit: 50,
      ...amount,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field });
    expect(captured).toHaveLength(0);
  });

  it('groups an aggregate execution series across creditor-grain MV rows', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.aggregateTimeseries({
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      metric: 'EXPENSE',
      frequency: 'YEAR',
      normalization: 'TOTAL',
      yearFrom: 2016,
      yearTo: 2025,
    });

    expect(result.isOk()).toBe(true);
    expect(captured).toHaveLength(1);
    const sql = flat(captured[0]!.sql);
    expect(sql).toContain('sum(coalesce(mv."total_expense",0))');
    expect(sql).toContain('group by "mv"."year", null::int');
    expect(sql).not.toContain('mv.entity_cui =');
  });

  it('keeps the year lookup only for normalizations that need per-year factors', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.aggregateTimeseries({
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      metric: 'EXPENSE',
      frequency: 'YEAR',
      normalization: 'TOTAL_EURO',
      yearFrom: 2020,
      yearTo: 2025,
    });

    expect(result.isOk()).toBe(true);
    expect(captured).toHaveLength(2);
    expect(flat(captured[0]!.sql)).toContain('distinct mv.year');
  });

  it('rejects aggregate time windows wider than 25 inclusive years', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.aggregateTimeseries({
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      metric: 'EXPENSE',
      frequency: 'YEAR',
      normalization: 'TOTAL',
      yearFrom: 2000,
      yearTo: 2025,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'year' });
    expect(captured).toHaveLength(0);
  });

  it('rejects per-capita aggregate series before SQL', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.aggregateTimeseries({
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      metric: 'EXPENSE',
      frequency: 'YEAR',
      normalization: 'PER_CAPITA',
      yearFrom: 2025,
      yearTo: 2025,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'normalization',
    });
    expect(captured).toHaveLength(0);
  });

  it('applies the UAT scope to the aggregate-series MV query', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.aggregateTimeseries({
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      metric: 'EXPENSE',
      frequency: 'YEAR',
      normalization: 'TOTAL',
      yearFrom: 2025,
      yearTo: 2025,
      isUat: true,
    });

    expect(result.isOk()).toBe(true);
    expect(captured).toHaveLength(1);
    for (const query of captured) {
      const sql = flat(query.sql);
      expect(sql).toContain('left join "core"."public_entities" as "e"');
      expect(sql).toContain('e.is_uat =');
      expect(query.parameters).toContain(true);
    }
  });

  it('preserves an explicit non-UAT aggregate scope', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.aggregateTimeseries({
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      metric: 'EXPENSE',
      frequency: 'YEAR',
      normalization: 'TOTAL',
      yearFrom: 2025,
      yearTo: 2025,
      isUat: false,
    });

    expect(result.isOk()).toBe(true);
    expect(captured).toHaveLength(1);
    expect(flat(captured[0]!.sql)).toContain('e.is_uat =');
    expect(captured[0]!.parameters).toContain(false);
  });

  it('rejects ranking page limits above the explicit export cap', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntitiesPage({
      year: 2025,
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      limit: 501,
      offset: 0,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'limit' });
    expect(captured).toHaveLength(0);
  });

  it('keeps the legacy top-N ranking cap at 100', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      limit: 101,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'limit' });
    expect(captured).toHaveLength(0);
  });

  it('uses the requested stable entity sort before the CUI tiebreak', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntitiesPage({
      year: 2025,
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      sort: 'ENTITY_NAME',
      ascending: true,
      limit: 25,
      offset: 0,
    });

    expect(result.isOk()).toBe(true);
    const sql = flat(captured[0]!.sql);
    expect(sql).toContain('order by "r"."entity_name" asc nulls last, r.entity_cui asc');
  });

  it.each([
    ['ENTITY_TYPE', '"r"."entity_type"'],
    ['COUNTY', '"r"."county_name"'],
  ] as const)('sorts %s by the metadata returned to the client', async (sort, expectedSql) => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntitiesPage({
      year: 2025,
      reportType: 'EXECUTION_AGG_PRINCIPAL',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      sort,
      ascending: true,
      limit: 25,
      offset: 0,
    });

    expect(result.isOk()).toBe(true);
    expect(flat(captured[0]!.sql)).toContain(`order by ${expectedSql} asc nulls last`);
  });
});

describe('entity identity gate on rankings and report reads (review B/F5)', () => {
  // The grouped entityAnalytics path requires a servable identifier and a
  // public-or-absent organization. Rankings and report listings name entities
  // too and used to emit core.public_entities names ungated; one rule now.
  const ORG_JOIN = 'left join "core"."organizations" as "o" on "o"."cui" = ';
  const GATE = /\(o\.org_id is null or "o"\."privacy_class" = \$\d+\)/u;
  const SERVABLE = /length\("(mv|r)"\."entity_cui"\) <= 10/u;

  const expectGated = (captured: CapturedQuery[], cuiColumn: string): void => {
    expect(captured.length).toBeGreaterThanOrEqual(1);
    for (const q of captured) {
      const s = flat(q.sql);
      expect(s).toContain(ORG_JOIN + cuiColumn);
      expect(s).toMatch(GATE);
      expect(s).toMatch(SERVABLE);
      expect(q.parameters).toContain('public');
    }
  };

  it('rankEntities joins the organization row and gates on it', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));
    const result = await repo.rankEntities({
      year: 2024,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      limit: 10,
    });
    expect(result.isOk()).toBe(true);
    expectGated(captured, '"mv"."entity_cui"');
  });

  it('rankCommitmentEntities joins the organization row and gates on it', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));
    const result = await repo.rankCommitmentEntities({
      year: 2024,
      reportType: 'COMMITMENT_AGG_PRINCIPAL',
      metric: 'credite_angajament',
      limit: 10,
    });
    expect(result.isOk()).toBe(true);
    expectGated(captured, '"mv"."entity_cui"');
  });

  it('listReports gates the page AND the total with the same predicate', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));
    const result = await repo.listReports({
      filter: { reportingYear: { eq: 2024 } },
      page: 1,
      pageSize: 10,
    });
    expect(result.isOk()).toBe(true);
    expect(captured).toHaveLength(2);
    expectGated(captured, '"r"."entity_cui"');
  });

  it('getReport is absent, not named, for a restricted organization', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));
    const result = await repo.getReport('123');
    expect(result.isOk()).toBe(true);
    expectGated(captured, '"r"."entity_cui"');
  });
});
