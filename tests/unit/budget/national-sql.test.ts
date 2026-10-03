import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { validateApprovedRecordsInput } from '@/modules/budget/core/national/approved-inputs.js';
import { validateExecutionObservationsInput } from '@/modules/budget/core/national/execution-inputs.js';
import {
  descriptorCandidatesSql,
  descriptorGroupsJson,
  recordsPageSql,
} from '@/modules/budget/shell/repo/national-approved-repo.js';
import {
  catalogItemsSql,
  currentLeavesSql,
  observationsSql,
  releaseChainsSql,
  selectionsSql,
  seriesRowsSql,
} from '@/modules/budget/shell/repo/national-execution-repo.js';
import { makeNationalReadPort } from '@/modules/budget/shell/repo/national-read-port.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { DescriptorGroup } from '@/modules/budget/core/national/approved-plan.js';
import type { NationalReadTx } from '@/modules/budget/core/national/ports.js';
import type { TransactionSettings } from 'kysely';

const db = makeCapturingDb([]);
const E2025 = '2025:law_2025_as_sent_to_monitorul_oficial';
const S1 = '0cda5d3a-09d1-4c3a-b794-455670ae0ec2';

/** Columns that must never be read by a national statement. */
const INTERNAL = [
  'object_key',
  'object_version_id',
  'run_id',
  'loaded_at',
  'storage',
  'raw_origin',
  'raw_authority',
  'lexical_',
  'semantic_parse',
  'semantic_output',
  'expected_inventory',
  'gate_artifact',
  'gate_sha256',
  'load_run_id',
  'input_manifest',
  'selected_at',
  'created_at',
  "'evidence'->'locator'",
];

const relationsOf = (sql: string): string[] =>
  [...sql.matchAll(/(?<!distinct\s)\b(?:from|join)\s+([a-z_."]+)/giu)].map(
    (match) => match[1] ?? ''
  );

const LOCAL = new Set([
  'groups',
  'candidates',
  'page',
  'sel',
  'obs',
  'u',
  'leaf',
  'walk',
  'measured',
  'unnest',
  'jsonb_to_recordset',
  'jsonb_array_elements',
  'lateral',
]);

const expectQualified = (sql: string): void => {
  for (const relation of relationsOf(sql)) {
    if (LOCAL.has(relation)) continue;
    expect(relation, `unqualified relation in: ${sql.slice(0, 80)}`).toMatch(/^budget\./u);
  }
};

const expectNoInternal = (sql: string): void => {
  for (const column of INTERNAL) expect(sql, column).not.toContain(column);
};

const groups: DescriptorGroup[] = [
  {
    editionId: E2025,
    form: 'STATE_BUDGET_SYNTHESIS',
    total: 'EXPENDITURE_5001_STATE_BUDGET',
    creditType: 'BUDGET_CREDITS',
    authorityCode: null,
  },
  {
    editionId: E2025,
    form: 'HEALTH_INSURANCE_SYNTHESIS',
    total: 'REVENUE_TOTAL',
    creditType: null,
    authorityCode: null,
  },
  {
    editionId: E2025,
    form: 'STATE_BUDGET_AUTHORITY_DETAIL',
    total: 'AUTHORITY_EXPENDITURE_5001',
    creditType: 'COMMITMENT_CREDITS',
    authorityCode: '01',
  },
];

describe('approved law statements', () => {
  it('reads every requested descriptor group in one parameterised statement', () => {
    const json = descriptorGroupsJson(groups);
    const compiled = descriptorCandidatesSql(json).compile(db);
    expect(compiled.parameters).toEqual([json]);
    expect(compiled.sql).toContain('jsonb_to_recordset($1::jsonb)');
    // Rules travel as data (core registry), never as interpolated literals.
    expect(compiled.sql).not.toContain('5001');
    expect(compiled.sql).not.toContain('CHELTUIELI');
    for (const fragment of [
      '"budget_year":2025',
      '"publication":"law_2025_as_sent_to_monitorul_oficial"',
      '"fund":"state_budget","form":"state_budget_synthesis","row_role":"credit","capitol":"5001","label":"CHELTUIELI - BUGET DE STAT","credit_type":"budget_credits","authority_code":null',
      '"fund":"health_insurance","form":"health_insurance_synthesis","row_role":"descriptor","capitol":"0001","label":"VENITURI - TOTAL","credit_type":null',
      '"form":"state_budget_authority_detail","row_role":"credit","capitol":"5001","label":"CHELTUIELI - BUGET DE STAT","credit_type":"commitment_credits","authority_code":"01"',
    ]) {
      expect(json).toContain(fragment);
    }
    expectQualified(compiled.sql);
    expectNoInternal(compiled.sql);
  });

  it('chooses candidate records first, then returns ALL their stored slots exactly', () => {
    const { sql } = descriptorCandidatesSql(descriptorGroupsJson(groups)).compile(db);
    // The candidate join back is by primary-key identity only — no target-year filter.
    expect(sql).toMatch(
      /on l\.interpretation_id = c\.interpretation_id and l\.record_index = c\.record_index/u
    );
    expect(sql).not.toMatch(/measure_year\s*=/u);
    expect(sql).not.toMatch(/field\s*=/u);
    expect(sql).toContain('l.amount::text as amount');
    // Native thousand lei: no unit conversion in SQL.
    expect(sql).not.toMatch(/\*\s*1000|1000\s*\*/u);
    // The reviewed match: trimmed codes/labels, empty lower codes, credit type.
    expect(sql).toContain(
      "btrim(case when l.row_role = 'credit' then l.context_label else l.label end) = g.label"
    );
    expect(sql).toContain("btrim(l.paragraf) = '' and btrim(coalesce(l.grupa, l.titlu)) = ''");
    expect(sql).toContain("(l.row_role = 'descriptor' or btrim(l.subcapitol) = '')");
    expect(sql).toContain('l.credit_type is not distinct from g.credit_type');
  });

  it('pages records by source-order keyset with every filter as a parameter', () => {
    const query = validateApprovedRecordsInput({
      source: { edition: { editionId: E2025, form: 'STATE_BUDGET_AUTHORITY_DETAIL' } },
      authorityCode: '01',
      rowRoles: ['CREDIT'],
      creditTypes: ['BUDGET_CREDITS'],
      capitols: ['5001'],
    })._unsafeUnwrap();
    const compiled = recordsPageSql({
      query,
      interpretationIds: ['budget-law-approved:x'],
      after: { interpretationId: 'budget-law-approved:x', recordIndex: 41 },
      limit: 51,
    }).compile(db);
    expect(compiled.parameters).toEqual([
      ['budget-law-approved:x'],
      '01',
      ['credit'],
      ['budget_credits'],
      ['5001'],
      'budget-law-approved:x',
      'budget-law-approved:x',
      41,
      51,
    ]);
    expect(compiled.sql).toContain('order by l.interpretation_id collate "C", l.record_index');
    expect(compiled.sql).toContain('l.interpretation_id collate "C" > $6');
    expect(compiled.sql).toContain('l.record_index > $8::int');
    expect(compiled.sql).toContain('btrim(l.capitol) = any($5::text[])');
    expect(compiled.sql).toContain('l.amount::text as amount');
    expectQualified(compiled.sql);
    expectNoInternal(compiled.sql);
  });
});

describe('execution statements', () => {
  it('derives current leaves and chains from predecessor links, never clock time', () => {
    const leaves = currentLeavesSql.compile(db).sql;
    expect(leaves).toContain('where not exists');
    // Same period end: served by the (period_end, previous_selection_id) unique index.
    expect(leaves).toContain(
      'n.period_end = s.period_end and n.previous_selection_id = s.selection_id'
    );
    const chains = releaseChainsSql(['2025-06-30'], 3).compile(db);
    expect(chains.sql).toContain('with recursive');
    expect(chains.sql).toContain(
      'p.selection_id = w.previous_selection_id and p.period_end = w.period_end'
    );
    expect(chains.parameters).toEqual([['2025-06-30'], 1000, 1000, 3]);
    // Only projected family paths; never the evidence object or storage.
    expect(chains.sql).toContain("'family', f.value->>'family'");
    expect(chains.sql).not.toContain("f.value->'evidence'");
    expect(chains.sql).toContain('i.original_bytes::text');
    for (const sql of [
      leaves,
      chains.sql,
      catalogItemsSql.compile(db).sql,
      selectionsSql([S1]).compile(db).sql,
    ]) {
      expectQualified(sql);
      expectNoInternal(sql);
    }
  });

  it('orders observation occurrences totally with C collation and validated keys as parameters', () => {
    const query = validateExecutionObservationsInput({
      source: { selectionIds: [S1] },
      dispositions: ['FACT', 'BLANK'],
      itemIds: ['mfin.bgc.revenue.total'],
    })._unsafeUnwrap();
    const compiled = observationsSql({
      query,
      selections: [
        {
          selectionId: S1,
          periodEnd: '2025-12-31',
          releaseId: 'e0251200-0000-4000-8000-000000000001',
        },
      ],
      singleSelection: true,
      after: {
        periodEnd: '2025-12-31',
        selectionId: S1,
        inputSourceId: 'bgc',
        observationKey: 'k',
      },
      limit: 51,
    }).compile(db);
    expect(compiled.sql).toContain(
      'order by u.period_end, u.selection_id, u.input_id collate "C", u.observation_key collate "C"'
    );
    expect(compiled.sql).toContain('u.observation_key collate "C" >');
    expect(compiled.sql).toContain('$');
    expect(compiled.parameters).toContain('k');
    expect(compiled.parameters.at(-1)).toBe(51);
    // Facts: flat semantic_key; cells: classification JSON objects only.
    expect(compiled.sql).toContain("f.semantic_key->>'fiscalStart'");
    expect(compiled.sql).not.toContain("f.semantic_key->'period'");
    expect(compiled.sql).toContain("jsonb_typeof(k.c) = 'object'");
    // Every stored locator coordinate, in BOTH single-selection branches.
    for (const path of [
      "'table' as locator_table",
      "'row' as locator_row",
      "'column' as locator_column",
    ]) {
      expect(compiled.sql.split(path).length - 1, path).toBe(2);
    }
    expect(compiled.sql).toContain('f.normalized_value::text as value_text');
    // BGC-only catalog mapping with the full reviewed predicate.
    expect(compiled.sql).toContain(
      "p.input_id = 'bgc' and p.component = 'general_consolidated_budget'"
    );
    expect(compiled.sql).toContain("p.period_role = 'current' and p.measure = 'amount'");
    expectQualified(compiled.sql);
    expectNoInternal(compiled.sql);
  });

  it('reads multi-selection facts without the observation JSON', () => {
    const query = validateExecutionObservationsInput({
      source: { months: { type: 'MONTH', selection: { dates: ['2025-06', '2025-12'] } } },
    })._unsafeUnwrap();
    const { sql } = observationsSql({
      query,
      selections: [
        {
          selectionId: S1,
          periodEnd: '2025-06-30',
          releaseId: 'e0250600-0000-4000-8000-000000000001',
        },
        {
          selectionId: '6110a784-1f51-4bee-8add-cf8bacf8455a',
          periodEnd: '2025-12-31',
          releaseId: 'e0251200-0000-4000-8000-000000000001',
        },
      ],
      singleSelection: false,
      after: null,
      limit: 51,
    }).compile(db);
    expect(sql).not.toContain('jsonb_array_elements(i.observations)');
    expect(sql).toContain("'number'::text as source_state");
  });

  it('reads every requested series item in one view statement over in-coverage period ends', () => {
    const compiled = seriesRowsSql({
      itemIds: ['mfin.bgc.revenue.total', 'mfin.bgc.expenditure.total'],
      basis: 'YTD',
      type: 'QUARTER',
      labels: ['2025-Q1', '2025-Q2'],
    }).compile(db);
    expect(compiled.parameters).toEqual([
      ['mfin.bgc.revenue.total', 'mfin.bgc.expenditure.total'],
      'ytd',
      ['2025-03-31', '2025-06-30'],
    ]);
    expect(compiled.sql).toContain('from budget.execution_national_budget_series_v1 v');
    expect(compiled.sql).toContain('v.period_start::text as period_start');
    expect(compiled.sql).toContain('v.value_ron::text as value_ron');
    expect(compiled.sql).toContain("ei.release_id = v.endpoint_release_id and ei.input_id = 'bgc'");
    expectQualified(compiled.sql);
    expectNoInternal(compiled.sql);
    const grids = [
      ['YTD', 'MONTH', 'ytd'],
      ['PERIOD_DIFFERENCE', 'MONTH', 'month'],
      ['PERIOD_DIFFERENCE', 'QUARTER', 'quarter'],
      ['FULL_YEAR', 'YEAR', 'full_year'],
    ] as const;
    for (const [basis, type, viewBasis] of grids) {
      const label = type === 'MONTH' ? '2025-06' : type === 'QUARTER' ? '2025-Q2' : '2025';
      expect(
        seriesRowsSql({ itemIds: ['i'], basis, type, labels: [label] }).compile(db).parameters[1]
      ).toBe(viewBasis);
    }
  });
});

describe('the read port', () => {
  it('runs one read-only repeatable-read transaction pinned to ISO dates', async () => {
    const captured: CapturedQuery[] = [];
    const settings: TransactionSettings[] = [];
    const capturing = makeCapturingDb(captured, {
      onBeginTransaction: (s) => settings.push(s),
      respond: (sql) =>
        sql.includes('pg_catalog.pg_settings') ? [{ setting: '0', unit: 'ms' }] : [],
    });
    const port = makeNationalReadPort(capturing, () => ({}) as NationalReadTx);
    const result = await port.read(() => Promise.resolve(ok('done')), {
      deadlineMs: 15_000,
      operation: 'test',
    });
    expect(result._unsafeUnwrap()).toBe('done');
    expect(settings).toEqual([{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);
    // The inherited timeout is read, the backstop reset and re-armed (strictly
    // positive), then ISO dates are pinned, before any source read.
    expect(captured.map((query) => query.sql)).toEqual([
      expect.stringContaining('budget.national:inherited_transaction_timeout'),
      'set local transaction_timeout = 0',
      expect.stringMatching(/^set local transaction_timeout = 1[56]\d{3}$/u),
      "set local DateStyle = 'ISO, YMD'",
    ]);
  });

  it('maps a statement timeout, a missing relation and other failures', async () => {
    const failing = (code: string, message = 'boom') =>
      makeNationalReadPort(
        makeCapturingDb([], {
          respond: () => {
            throw Object.assign(new Error(message), { code });
          },
        }),
        () => ({}) as NationalReadTx
      );
    const run = (port: ReturnType<typeof failing>) =>
      port.read(() => Promise.resolve(ok(1)), {
        deadlineMs: 5000,
        operation: 'budgetNationalCatalog',
      });
    expect((await run(failing('57014')))._unsafeUnwrapErr().type).toBe('Timeout');
    expect((await run(failing('42P01')))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    const other = (await run(failing('XX000', 'driver detail')))._unsafeUnwrapErr();
    expect(other.type).toBe('Database');
    expect(other.message).not.toContain('driver detail');
  });
});
