/**
 * National budget — execution lane reader over the MFin release relations.
 *
 * - Current leaves: `NOT EXISTS` a child selection (the chain is linear per
 *   month by the `(period_end, previous_selection_id)` unique constraint).
 * - Release chains: a bounded recursive walk over predecessor links (never
 *   timestamps); families come from the projected `family_contract` paths or,
 *   without a contract, from the whole-release input metadata. Gate artifacts,
 *   storage, raw origin/authority and parse IDs are never selected.
 * - Observations: physical node `(release, input, key)` per selection
 *   occurrence, one total order `(period_end, selection_id, input_id COLLATE
 *   "C", observation_key COLLATE "C")`. Facts use the flat `semantic_key`;
 *   single-selection reads add non-FACT cells whose sealed classification is a
 *   JSON object, plus the facts' sealed locator/label evidence.
 * - National series: ONE statement over the audited view for every requested
 *   item, the reviewed basis and the in-coverage period ends, with the BGC
 *   input's original hash/bytes joined by release.
 *
 * Every numeric leaves SQL as text before any JSON aggregation.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql } from 'kysely';

import {
  guardedRead,
  NationalSourceContractError,
  type NationalRun,
} from './national-read-port.js';
import { isCanonicalUuid } from '../../core/national/input-rules.js';
import { calendarBounds, isCalendarDate, isMonthEnd } from '../../core/national/periods.js';
import { parseSourceDecimal } from '../../core/national/values.js';
import {
  EXECUTION_INPUT_SOURCE,
  type CoverageKind,
  type ExecutionFamily,
  type ExecutionInput,
  type ExecutionMeasure,
  type ExecutionSection,
  type ExecutionStatus,
  type FamilyPresence,
  type Finality,
  type ObservationDisposition,
  type PeriodRole,
  type PeriodType,
  type SeriesBasis,
  type ValueBasis,
} from '../../core/national/vocabulary.js';

import type { ExecutionObservationsQuery } from '../../core/national/execution-inputs.js';
import type {
  CellEvidence,
  DateInterval,
  ExecutionChain,
  ExecutionFamilyStatus,
  ExecutionItem,
  ExecutionLeafRow,
  ExecutionRelease,
  ExecutionSelection,
  NationalSeriesViewRow,
  ObservationOccurrence,
  SeriesOperand,
  SourceDocument,
} from '../../core/national/models.js';
import type {
  NationalExecutionReader,
  NationalSeriesRows,
  ObservationPageRequest,
  ResolvedSelection,
  SeriesRowsRequest,
} from '../../core/national/ports.js';

// ── reviewed source vocabulary (stored lowercase literal → public enum) ──────

const map = <T extends string>(entries: Readonly<Record<string, T>>): ReadonlyMap<string, T> =>
  new Map(Object.entries(entries));

const INPUTS = map<ExecutionInput>({ bgc: 'BGC', sinteza: 'SINTEZA' });
const FAMILIES = map<ExecutionFamily>({ bgc: 'BGC', sinteza: 'SINTEZA', nota: 'NOTA' });
const PRESENCES = map<FamilyPresence>({
  present: 'PRESENT',
  not_listed_in_captured_packet: 'NOT_LISTED_IN_CAPTURED_PACKET',
  listed_original_unavailable: 'LISTED_ORIGINAL_UNAVAILABLE',
  family_unresolved: 'FAMILY_UNRESOLVED',
});
const SECTIONS = map<ExecutionSection>({
  revenue: 'REVENUE',
  expenditure: 'EXPENDITURE',
  balance: 'BALANCE',
});
const PERIOD_ROLES = map<PeriodRole>({
  current: 'CURRENT',
  comparison: 'COMPARISON',
  difference: 'DIFFERENCE',
});
const MEASURES = map<ExecutionMeasure>({
  amount: 'AMOUNT',
  gdp_share: 'GDP_SHARE',
  published_total_share: 'PUBLISHED_TOTAL_SHARE',
  amount_difference: 'AMOUNT_DIFFERENCE',
  relative_change: 'RELATIVE_CHANGE',
  gdp_denominator: 'GDP_DENOMINATOR',
});
const COVERAGE_KINDS = map<CoverageKind>({
  report_period: 'REPORT_PERIOD',
  component_interval: 'COMPONENT_INTERVAL',
  not_applicable: 'NOT_APPLICABLE',
});
const EXECUTION_STATUSES = map<ExecutionStatus>({ actual: 'ACTUAL', estimate: 'ESTIMATE' });
const FINALITIES = map<Finality>({ final: 'FINAL', operative: 'OPERATIVE', unknown: 'UNKNOWN' });
const DISPOSITIONS = map<ObservationDisposition>({
  fact: 'FACT',
  blank: 'BLANK',
  unresolved: 'UNRESOLVED',
  nonfinancial: 'NONFINANCIAL',
});
const UNITS = map<'RON' | 'FRACTION'>({ RON: 'RON', fraction: 'FRACTION' });
const VALUE_BASES = map<ValueBasis>({
  reported_cumulative: 'REPORTED_CUMULATIVE',
  reported_cumulative_first_period: 'REPORTED_CUMULATIVE_FIRST_PERIOD',
  derived_change_between_selected_reports: 'DERIVED_DIFFERENCE_BETWEEN_REPORTS',
});

const inverse = <T extends string>(entries: ReadonlyMap<string, T>): ReadonlyMap<T, string> =>
  new Map([...entries.entries()].map(([literal, value]) => [value, literal]));

const SECTION_LITERAL = inverse(SECTIONS);
const PERIOD_ROLE_LITERAL = inverse(PERIOD_ROLES);
const MEASURE_LITERAL = inverse(MEASURES);
const DISPOSITION_LITERAL = inverse(DISPOSITIONS);

/** The reviewed view (local migration 20260921T040000) pins these constants. */
export const NATIONAL_SERIES_DERIVATION_VERSION = 'bgc-selected-cumulative-difference-v1';
export const NATIONAL_SERIES_COMPONENT = 'general_consolidated_budget';

/** View `period_basis` of each reviewed grid. */
export const VIEW_BASIS: Readonly<Record<SeriesBasis, Partial<Record<PeriodType, string>>>> = {
  YTD: { MONTH: 'ytd', QUARTER: 'ytd' },
  PERIOD_DIFFERENCE: { MONTH: 'month', QUARTER: 'quarter' },
  FULL_YEAR: { YEAR: 'full_year' },
};

/** Defensive bound on a month's predecessor walk (real chains are a few links). */
export const MAX_CHAIN_LENGTH = 1000;

const contract = (message: string): NationalSourceContractError =>
  new NationalSourceContractError(message);

const required = <T>(entries: ReadonlyMap<string, T>, value: string | null, what: string): T => {
  const mapped = value === null ? undefined : entries.get(value);
  if (mapped === undefined) throw contract(`unknown ${what} '${String(value)}'`);
  return mapped;
};

const optional = <T>(
  entries: ReadonlyMap<string, T>,
  value: string | null,
  what: string
): T | null => (value === null ? null : required(entries, value, what));

const literals = <T extends string>(
  entries: ReadonlyMap<T, string>,
  values: readonly T[]
): string[] => values.map((value) => entries.get(value) ?? '');

const interval = (start: string | null, end: string | null): DateInterval | null =>
  start === null && end === null ? null : { start, end };

const bytesOf = (text: string | null): number | null => {
  if (text === null) return null;
  const bytes = Number.parseInt(text, 10);
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 2_147_483_647 ? bytes : null;
};

const document = (
  url: string | null,
  sha256: string | null,
  bytes: string | null
): SourceDocument | null =>
  url === null || sha256 === null ? null : { url, sha256, bytes: bytesOf(bytes) };

const canonicalUuid = (value: string, what: string): string => {
  if (!isCanonicalUuid(value)) throw contract(`${what} '${value}' is not a canonical uuid`);
  return value;
};

const monthOf = (periodEnd: string): string => {
  if (!isMonthEnd(periodEnd)) throw contract(`period end '${periodEnd}' is not a month end`);
  return periodEnd.slice(0, 7);
};

const EvidenceSchema = Type.Object({
  sheet: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cell: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  text: Type.String(),
});
const HeadersSchema = Type.Array(EvidenceSchema);

const evidenceOf = (value: unknown): CellEvidence | null => {
  if (value === null || value === undefined) return null;
  if (!Value.Check(EvidenceSchema, value)) throw contract('cell evidence is malformed');
  return { sheet: value.sheet ?? null, cell: value.cell ?? null, text: value.text };
};

// ── current leaves, items, explicit selections ───────────────────────────────

interface LeafRow {
  selection_id: string;
  period_end: string;
  release_id: string;
}

export const currentLeavesSql = sql<LeafRow>`
  /* budget.national:execution_current_leaves */
  select s.selection_id::text as selection_id, s.period_end::text as period_end,
    s.release_id::text as release_id
  from budget.execution_release_selections s
  where not exists (
    select 1 from budget.execution_release_selections n
    where n.period_end = s.period_end and n.previous_selection_id = s.selection_id)
  order by s.period_end, s.selection_id
`;

interface ItemRow {
  mapping_version: string;
  item_id: string;
  section: string;
  source_label: string;
  related_scope_item_id: string | null;
}

export const catalogItemsSql = sql<ItemRow>`
  /* budget.national:execution_catalog_items */
  select c.mapping_version, c.item_id, c.section, c.source_label, c.related_scope_item_id
  from budget.execution_bgc_item_catalog_v1 c
  order by c.item_id
`;

export const selectionsSql = (selectionIds: readonly string[]) => sql<LeafRow>`
  /* budget.national:execution_selections */
  select s.selection_id::text as selection_id, s.period_end::text as period_end,
    s.release_id::text as release_id
  from budget.execution_release_selections s
  where s.selection_id = any(${[...selectionIds]}::uuid[])
  order by s.period_end, s.selection_id
`;

const resolved = (row: LeafRow): ResolvedSelection => ({
  selectionId: canonicalUuid(row.selection_id, 'selection'),
  periodEnd: row.period_end,
  releaseId: canonicalUuid(row.release_id, 'release'),
});

// ── release chains ───────────────────────────────────────────────────────────

const FamilyRowSchema = Type.Object({
  family: Type.Union([Type.String(), Type.Null()]),
  presence: Type.Union([Type.String(), Type.Null()]),
  role: Type.Union([Type.String(), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  sourceUrl: Type.Union([Type.String(), Type.Null()]),
  sourceFormat: Type.Union([Type.String(), Type.Null()]),
  originalSha256: Type.Union([Type.String(), Type.Null()]),
  reportStart: Type.Union([Type.String(), Type.Null()]),
  reportEnd: Type.Union([Type.String(), Type.Null()]),
});
const InputRowSchema = Type.Object({
  inputId: Type.String(),
  sourceUrl: Type.String(),
  sha256: Type.String(),
  bytes: Type.String(),
});
const FamiliesSchema = Type.Array(FamilyRowSchema);
const InputsSchema = Type.Array(InputRowSchema);

interface ChainRow {
  period_end: string;
  selection_id: string;
  previous_selection_id: string | null;
  release_id: string;
  reason: string;
  seal_sha256: string;
  depth: number;
  chain_length: number;
  overflow: boolean;
  release_start: string;
  release_end: string;
  policy_version: string;
  publication_scope: string | null;
  has_contract: boolean;
  contract_families: unknown;
  inputs: unknown;
  fact_count: number;
}

export const releaseChainsSql = (periodEnds: readonly string[], revisionsPerMonth: number) =>
  sql<ChainRow>`
  /* budget.national:execution_release_chains */
  with recursive leaf as (
    select s.selection_id, s.period_end
    from budget.execution_release_selections s
    where s.period_end = any(${[...periodEnds]}::date[])
      and not exists (
        select 1 from budget.execution_release_selections n
        where n.period_end = s.period_end and n.previous_selection_id = s.selection_id)
  ), walk as (
    select l.period_end, s.selection_id, s.previous_selection_id, s.release_id,
      s.reason, s.seal_sha256, 1 as depth
    from leaf l
    join budget.execution_release_selections s on s.selection_id = l.selection_id
    union all
    select w.period_end, p.selection_id, p.previous_selection_id, p.release_id,
      p.reason, p.seal_sha256, w.depth + 1
    from walk w
    join budget.execution_release_selections p
      on p.selection_id = w.previous_selection_id and p.period_end = w.period_end
    where w.depth < ${MAX_CHAIN_LENGTH}
  ), measured as (
    select w.*,
      (count(*) over (partition by w.period_end))::int as chain_length,
      bool_or(w.depth = ${MAX_CHAIN_LENGTH} and w.previous_selection_id is not null)
        over (partition by w.period_end) as overflow
    from walk w
  )
  select m.period_end::text as period_end, m.selection_id::text as selection_id,
    m.previous_selection_id::text as previous_selection_id, m.release_id::text as release_id,
    m.reason, m.seal_sha256, m.depth, m.chain_length, m.overflow,
    r.period_start::text as release_start, r.period_end::text as release_end, r.policy_version,
    r.family_contract->>'publicationScope' as publication_scope,
    r.family_contract is not null as has_contract,
    (select coalesce(jsonb_agg(jsonb_build_object(
        'family', f.value->>'family', 'presence', f.value->>'presence',
        'role', f.value->>'role', 'reason', f.value->>'reason',
        'sourceUrl', f.value->>'sourceUrl', 'sourceFormat', f.value->>'sourceFormat',
        'originalSha256', f.value->>'originalSha256',
        'reportStart', f.value->'reportCoverage'->>'start',
        'reportEnd', f.value->'reportCoverage'->>'end') order by f.ordinality), '[]'::jsonb)
      from jsonb_array_elements(case when jsonb_typeof(r.family_contract->'families') = 'array'
        then r.family_contract->'families' else '[]'::jsonb end) with ordinality as f(value, ordinality)
    ) as contract_families,
    (select coalesce(jsonb_agg(jsonb_build_object(
        'inputId', i.input_id, 'sourceUrl', i.source_url,
        'sha256', i.original_sha256, 'bytes', i.original_bytes::text) order by i.input_id), '[]'::jsonb)
      from budget.execution_release_inputs i where i.release_id = m.release_id
    ) as inputs,
    (select count(*)::int from budget.execution_release_facts f where f.release_id = m.release_id)
      as fact_count
  from measured m
  join budget.execution_releases r on r.release_id = m.release_id
  where m.depth <= ${revisionsPerMonth}
  order by m.period_end, m.depth
`;

type InputRow = Static<typeof InputRowSchema>;

const familiesOf = (row: ChainRow): ExecutionFamilyStatus[] => {
  if (!Value.Check(InputsSchema, row.inputs)) throw contract('release inputs are malformed');
  const inputs: readonly InputRow[] = row.inputs;
  if (!row.has_contract) {
    // No family contract: the release's own inputs are its (present) families.
    return inputs.map((input) => ({
      family: required(FAMILIES, input.inputId, 'family'),
      presence: 'PRESENT',
      role: null,
      reason: null,
      sourceFormat: null,
      document: { url: input.sourceUrl, sha256: input.sha256, bytes: bytesOf(input.bytes) },
      reportCoverage: null,
    }));
  }
  if (!Value.Check(FamiliesSchema, row.contract_families)) {
    throw contract('release family contract is malformed');
  }
  return row.contract_families.map((family) => {
    const sameOriginal = inputs.find(
      (input) => input.inputId === family.family && input.sha256 === family.originalSha256
    );
    return {
      family: required(FAMILIES, family.family, 'family'),
      presence: required(PRESENCES, family.presence, 'family presence'),
      role: family.role,
      reason: family.reason,
      sourceFormat: family.sourceFormat,
      document:
        family.sourceUrl === null || family.originalSha256 === null
          ? null
          : {
              url: family.sourceUrl,
              sha256: family.originalSha256,
              bytes: sameOriginal === undefined ? null : bytesOf(sameOriginal.bytes),
            },
      reportCoverage: interval(family.reportStart, family.reportEnd),
    };
  });
};

export const chainsFromRows = (rows: readonly ChainRow[]): ExecutionChain[] => {
  const byMonth = new Map<string, { length: number; newest: ExecutionSelection[] }>();
  for (const row of rows) {
    if (row.overflow)
      throw contract(`selection chain of ${row.period_end} exceeds ${String(MAX_CHAIN_LENGTH)}`);
    const month = monthOf(row.period_end);
    const release: ExecutionRelease = {
      releaseId: canonicalUuid(row.release_id, 'release'),
      month: monthOf(row.release_end),
      calendarPeriod: { start: row.release_start, end: row.release_end },
      policyVersion: row.policy_version,
      publicationScope: row.publication_scope,
      families: familiesOf(row),
      factCount: row.fact_count,
    };
    const entry = byMonth.get(month) ?? { length: row.chain_length, newest: [] };
    entry.newest.push({
      selectionId: canonicalUuid(row.selection_id, 'selection'),
      previousSelectionId:
        row.previous_selection_id === null
          ? null
          : canonicalUuid(row.previous_selection_id, 'selection'),
      chainPosition: row.chain_length - row.depth + 1,
      reason: row.reason,
      sealSha256: row.seal_sha256,
      release,
    });
    byMonth.set(month, entry);
  }
  return [...byMonth.entries()].map(([month, entry]) => ({ month, ...entry }));
};

// ── observations ─────────────────────────────────────────────────────────────

interface ObservationRow {
  period_end: string;
  selection_id: string;
  release_id: string;
  input_id: string;
  observation_key: string;
  disposition: string;
  section: string | null;
  line_item: string | null;
  component: string | null;
  period_role: string | null;
  measure: string | null;
  coverage_kind: string | null;
  fiscal_start: string | null;
  fiscal_end: string | null;
  comparison_start: string | null;
  comparison_end: string | null;
  report_start: string | null;
  report_end: string | null;
  reference_year: string | null;
  execution_status: string | null;
  finality: string | null;
  source_token: string | null;
  value_text: string | null;
  unit: string | null;
  source_state: string | null;
  reason: string | null;
  locator_kind: string | null;
  locator_sheet: string | null;
  locator_cell: string | null;
  locator_page: string | null;
  locator_table: string | null;
  locator_row: string | null;
  locator_column: string | null;
  label_sheet: string | null;
  label_cell: string | null;
  label_text: string | null;
  source_url: string;
  original_sha256: string;
  original_bytes: string;
  item_mapping_version: string | null;
  item_id: string | null;
  item_section: string | null;
  item_source_label: string | null;
  item_related_scope_item_id: string | null;
}

/**
 * The reviewed BGC catalog predicate (the audited view's own mapping) over a
 * row's flat (fact) or classified (cell) dimensions; Sinteza never matches.
 */
const CATALOG_MATCH_U = sql`u.input_id = 'bgc' and u.component = 'general_consolidated_budget'
  and u.period_role = 'current' and u.measure = 'amount'
  and ci.section = u.section and ci.source_label = u.line_item`;
const CATALOG_MATCH_P = sql`p.input_id = 'bgc' and p.component = 'general_consolidated_budget'
  and p.period_role = 'current' and p.measure = 'amount'
  and c.section = p.section and c.source_label = p.line_item`;

const FACT_EVIDENCE = sql`
  o.obj->>'sourceState' as source_state, o.obj->>'reason' as reason,
  o.obj->'locator'->>'kind' as locator_kind, o.obj->'locator'->>'sheet' as locator_sheet,
  o.obj->'locator'->>'cell' as locator_cell, o.obj->'locator'->>'page' as locator_page,
  o.obj->'locator'->>'table' as locator_table, o.obj->'locator'->>'row' as locator_row,
  o.obj->'locator'->>'column' as locator_column,
  o.obj->'evidence'->'semantic'->'classification'->'labelEvidence'->>'sheet' as label_sheet,
  o.obj->'evidence'->'semantic'->'classification'->'labelEvidence'->>'cell' as label_cell,
  o.obj->'evidence'->'semantic'->'classification'->'labelEvidence'->>'text' as label_text`;

/** Multi-selection facts: the seal guarantees fact entries are `number` cells. */
const NO_EVIDENCE = sql`
  'number'::text as source_state, null::text as reason,
  null::text as locator_kind, null::text as locator_sheet, null::text as locator_cell,
  null::text as locator_page, null::text as locator_table, null::text as locator_row,
  null::text as locator_column, null::text as label_sheet, null::text as label_cell,
  null::text as label_text`;

export const observationsSql = (request: ObservationPageRequest) => {
  const query: ExecutionObservationsQuery = request.query;
  const single = request.singleSelection;
  const inputs = (query.inputs ?? (['BGC', 'SINTEZA'] as const)).map(
    (input) => EXECUTION_INPUT_SOURCE[input]
  );
  const wantsFacts = query.dispositions.includes('FACT');
  const nonFacts = query.dispositions.filter((disposition) => disposition !== 'FACT');
  const branches = [];
  if (wantsFacts) {
    branches.push(sql`
      select s.period_end, s.selection_id, f.release_id, f.input_id, f.observation_key,
        'fact'::text as disposition,
        f.semantic_key->>'section' as section, f.semantic_key->>'lineItem' as line_item,
        f.semantic_key->>'component' as component, f.semantic_key->>'periodRole' as period_role,
        f.semantic_key->>'measure' as measure, f.semantic_key->>'coverageKind' as coverage_kind,
        f.semantic_key->>'fiscalStart' as fiscal_start, f.semantic_key->>'fiscalEnd' as fiscal_end,
        f.semantic_key->>'comparisonStart' as comparison_start,
        f.semantic_key->>'comparisonEnd' as comparison_end,
        f.semantic_key->>'reportStart' as report_start, f.semantic_key->>'reportEnd' as report_end,
        f.semantic_key->>'referenceYear' as reference_year,
        f.semantic_key->>'executionStatus' as execution_status,
        f.semantic_key->>'finality' as finality,
        f.source_token, f.normalized_value::text as value_text, f.normalized_unit as unit,
        ${single ? FACT_EVIDENCE : NO_EVIDENCE}
      from sel s
      join budget.execution_release_facts f on f.release_id = s.release_id
      ${single ? sql`left join obs o on o.release_id = f.release_id and o.input_id = f.input_id and o.key = f.observation_key` : sql``}
      where f.input_id = any(${inputs}::text[])`);
  }
  if (single && nonFacts.length > 0) {
    branches.push(sql`
      select s.period_end, s.selection_id, o.release_id, o.input_id, o.key as observation_key,
        o.obj->>'disposition' as disposition,
        k.c->>'section' as section, k.c->>'lineItem' as line_item,
        k.c->>'component' as component, k.c->>'periodRole' as period_role,
        k.c->>'measure' as measure, k.c->'coverage'->>'kind' as coverage_kind,
        k.c->'period'->>'start' as fiscal_start, k.c->'period'->>'end' as fiscal_end,
        k.c->'comparisonPeriod'->>'start' as comparison_start,
        k.c->'comparisonPeriod'->>'end' as comparison_end,
        null::text as report_start, null::text as report_end,
        k.c->>'referenceYear' as reference_year,
        k.c->'period'->>'executionStatus' as execution_status,
        k.c->'period'->>'finality' as finality,
        o.obj->>'sourceToken' as source_token, null::text as value_text,
        k.c->'unit'->>'normalizedUnit' as unit,
        o.obj->>'sourceState' as source_state, o.obj->>'reason' as reason,
        o.obj->'locator'->>'kind' as locator_kind, o.obj->'locator'->>'sheet' as locator_sheet,
        o.obj->'locator'->>'cell' as locator_cell, o.obj->'locator'->>'page' as locator_page,
        o.obj->'locator'->>'table' as locator_table, o.obj->'locator'->>'row' as locator_row,
        o.obj->'locator'->>'column' as locator_column,
        k.c->'labelEvidence'->>'sheet' as label_sheet, k.c->'labelEvidence'->>'cell' as label_cell,
        k.c->'labelEvidence'->>'text' as label_text
      from sel s
      join obs o on o.release_id = s.release_id
      cross join lateral (select o.obj->'evidence'->'semantic'->'classification' as c) k
      where o.obj->>'disposition' = any(${literals(DISPOSITION_LITERAL, nonFacts)}::text[])
        and jsonb_typeof(k.c) = 'object'`);
  }
  const filters = [sql`true`];
  if (query.components !== null)
    filters.push(sql`u.component = any(${[...query.components]}::text[])`);
  if (query.sections !== null) {
    filters.push(sql`u.section = any(${literals(SECTION_LITERAL, query.sections)}::text[])`);
  }
  if (query.lineItems !== null)
    filters.push(sql`u.line_item = any(${[...query.lineItems]}::text[])`);
  if (query.measures !== null) {
    filters.push(sql`u.measure = any(${literals(MEASURE_LITERAL, query.measures)}::text[])`);
  }
  if (query.periodRoles !== null) {
    filters.push(
      sql`u.period_role = any(${literals(PERIOD_ROLE_LITERAL, query.periodRoles)}::text[])`
    );
  }
  if (query.itemIds !== null) {
    filters.push(sql`exists (select 1 from budget.execution_bgc_item_catalog_v1 ci
      where ci.item_id = any(${[...query.itemIds]}::text[]) and ${CATALOG_MATCH_U})`);
  }
  const after = request.after;
  if (after !== null) {
    filters.push(sql`(u.period_end > ${after.periodEnd}::date
      or (u.period_end = ${after.periodEnd}::date and (u.selection_id > ${after.selectionId}::uuid
      or (u.selection_id = ${after.selectionId}::uuid and (u.input_id collate "C" > ${after.inputSourceId}
      or (u.input_id = ${after.inputSourceId} and u.observation_key collate "C" > ${after.observationKey}))))))`);
  }
  const selections = request.selections;
  return sql<ObservationRow>`
    /* budget.national:execution_observations_page */
    with sel as (
      select * from unnest(
        ${selections.map((s) => s.selectionId)}::uuid[],
        ${selections.map((s) => s.periodEnd)}::date[],
        ${selections.map((s) => s.releaseId)}::uuid[]) as sel(selection_id, period_end, release_id)
    )${
      single
        ? sql`, obs as (
      select i.release_id, i.input_id, x.obj->>'key' as key, x.obj
      from sel s
      join budget.execution_release_inputs i
        on i.release_id = s.release_id and i.input_id = any(${inputs}::text[])
      cross join lateral jsonb_array_elements(i.observations) as x(obj)
    )`
        : sql``
    }, u as (
      ${sql.join(branches, sql` union all `)}
    ), page as (
      select * from u
      where ${sql.join(filters, sql` and `)}
      order by u.period_end, u.selection_id, u.input_id collate "C", u.observation_key collate "C"
      limit ${request.limit}
    )
    select p.period_end::text as period_end, p.selection_id::text as selection_id,
      p.release_id::text as release_id, p.input_id, p.observation_key, p.disposition,
      p.section, p.line_item, p.component, p.period_role, p.measure, p.coverage_kind,
      p.fiscal_start, p.fiscal_end, p.comparison_start, p.comparison_end,
      p.report_start, p.report_end, p.reference_year, p.execution_status, p.finality,
      p.source_token, p.value_text, p.unit, p.source_state, p.reason,
      p.locator_kind, p.locator_sheet, p.locator_cell, p.locator_page,
      p.locator_table, p.locator_row, p.locator_column,
      p.label_sheet, p.label_cell, p.label_text,
      i.source_url, i.original_sha256, i.original_bytes::text as original_bytes,
      c.mapping_version as item_mapping_version, c.item_id, c.section as item_section,
      c.source_label as item_source_label, c.related_scope_item_id as item_related_scope_item_id
    from page p
    join budget.execution_release_inputs i on i.release_id = p.release_id and i.input_id = p.input_id
    left join budget.execution_bgc_item_catalog_v1 c on ${CATALOG_MATCH_P}
    order by p.period_end, p.selection_id, p.input_id collate "C", p.observation_key collate "C"
  `;
};

/**
 * A sealed locator coordinate: absent → null; a non-negative integer (zero is
 * a real first column) → that number; anything else violates the source shape.
 */
const coordinate = (text: string | null, what: string, key: string): number | null => {
  if (text === null) return null;
  const value = /^(0|[1-9]\d{0,8})$/u.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  if (!Number.isSafeInteger(value))
    throw contract(`locator ${what} '${text}' of ${key} is not an integer`);
  return value;
};

const yearOf = (text: string | null): number | null => {
  if (text === null) return null;
  if (!/^\d{4}$/u.test(text)) throw contract(`reference year '${text}' is not a year`);
  return Number.parseInt(text, 10);
};

export const occurrenceFromRow = (row: ObservationRow): ObservationOccurrence => {
  const input = required(INPUTS, row.input_id, 'input');
  const disposition = required(DISPOSITIONS, row.disposition, 'disposition');
  const releaseId = canonicalUuid(row.release_id, 'release');
  let value = null;
  if (row.value_text !== null) {
    const parsed = parseSourceDecimal(row.value_text);
    if (parsed.isErr()) throw contract(`value of ${row.observation_key} is not numeric text`);
    value = parsed.value;
  }
  if (row.source_state === null)
    throw contract(`observation ${row.observation_key} has no source state`);
  const selectionId = canonicalUuid(row.selection_id, 'selection');
  const nodeId = `${releaseId}:${row.input_id}:${row.observation_key}`;
  return {
    occurrenceId: `${selectionId}:${nodeId}`,
    selectionId,
    periodEnd: row.period_end,
    inputSourceId: EXECUTION_INPUT_SOURCE[input],
    node: {
      id: nodeId,
      releaseId,
      month: monthOf(row.period_end),
      input,
      observationKey: row.observation_key,
      disposition,
      sourceState: row.source_state,
      catalogItem:
        row.item_id === null ||
        row.item_mapping_version === null ||
        row.item_section === null ||
        row.item_source_label === null
          ? null
          : {
              itemId: row.item_id,
              section: required(SECTIONS, row.item_section, 'item section'),
              sourceLabel: row.item_source_label,
              relatedScopeItemId: row.item_related_scope_item_id,
              mappingVersion: row.item_mapping_version,
            },
      section: optional(SECTIONS, row.section, 'section'),
      lineItem: row.line_item,
      component: row.component,
      periodRole: optional(PERIOD_ROLES, row.period_role, 'period role'),
      measure: optional(MEASURES, row.measure, 'measure'),
      coverageKind: optional(COVERAGE_KINDS, row.coverage_kind, 'coverage kind'),
      fiscalPeriod: interval(row.fiscal_start, row.fiscal_end),
      comparisonPeriod: interval(row.comparison_start, row.comparison_end),
      reportPeriod: interval(row.report_start, row.report_end),
      referenceYear: yearOf(row.reference_year),
      executionStatus: optional(EXECUTION_STATUSES, row.execution_status, 'execution status'),
      finality: optional(FINALITIES, row.finality, 'finality'),
      value,
      unit: optional(UNITS, row.unit, 'unit'),
      sourceToken: row.source_token,
      reason: row.reason,
      locator:
        row.locator_kind === null
          ? null
          : {
              kind: row.locator_kind,
              sheet: row.locator_sheet,
              cell: row.locator_cell,
              page: coordinate(row.locator_page, 'page', row.observation_key),
              table: row.locator_table,
              row: coordinate(row.locator_row, 'row', row.observation_key),
              column: coordinate(row.locator_column, 'column', row.observation_key),
            },
      labelEvidence:
        row.label_text === null
          ? null
          : { sheet: row.label_sheet, cell: row.label_cell, text: row.label_text },
      document: {
        url: row.source_url,
        sha256: row.original_sha256,
        bytes: bytesOf(row.original_bytes),
      },
    },
  };
};

// ── national series view ─────────────────────────────────────────────────────

interface SeriesRow {
  item_id: string;
  period_basis: string;
  period_start: string;
  period_end: string;
  predecessor_end: string | null;
  value_ron: string | null;
  availability_reason: string | null;
  value_basis: string | null;
  derivation_version: string;
  component: string;
  endpoint_selection_id: string | null;
  endpoint_release_id: string | null;
  endpoint_observation_key: string | null;
  endpoint_source_url: string | null;
  endpoint_source_state: string | null;
  endpoint_coverage_start: string | null;
  endpoint_coverage_end: string | null;
  endpoint_execution_status: string | null;
  endpoint_finality: string | null;
  endpoint_label: unknown;
  endpoint_headers: unknown;
  endpoint_sha256: string | null;
  endpoint_bytes: string | null;
  predecessor_selection_id: string | null;
  predecessor_release_id: string | null;
  predecessor_observation_key: string | null;
  predecessor_source_url: string | null;
  predecessor_source_state: string | null;
  predecessor_coverage_start: string | null;
  predecessor_coverage_end: string | null;
  predecessor_execution_status: string | null;
  predecessor_finality: string | null;
  predecessor_label: unknown;
  predecessor_headers: unknown;
  predecessor_sha256: string | null;
  predecessor_bytes: string | null;
}

const ENDPOINT_COLUMNS = sql`
  v.endpoint_selection_id::text as endpoint_selection_id,
  v.endpoint_release_id::text as endpoint_release_id,
  v.endpoint_observation_key, v.endpoint_source_url, v.endpoint_source_state,
  v.endpoint_qualifiers->'period'->>'start' as endpoint_coverage_start,
  v.endpoint_qualifiers->'period'->>'end' as endpoint_coverage_end,
  v.endpoint_qualifiers->'period'->>'executionStatus' as endpoint_execution_status,
  v.endpoint_qualifiers->'period'->>'finality' as endpoint_finality,
  v.endpoint_qualifiers->'labelEvidence' as endpoint_label,
  v.endpoint_qualifiers->'headerEvidence' as endpoint_headers,
  ei.original_sha256 as endpoint_sha256, ei.original_bytes::text as endpoint_bytes`;

const PREDECESSOR_COLUMNS = sql`
  v.predecessor_selection_id::text as predecessor_selection_id,
  v.predecessor_release_id::text as predecessor_release_id,
  v.predecessor_observation_key, v.predecessor_source_url, v.predecessor_source_state,
  v.predecessor_qualifiers->'period'->>'start' as predecessor_coverage_start,
  v.predecessor_qualifiers->'period'->>'end' as predecessor_coverage_end,
  v.predecessor_qualifiers->'period'->>'executionStatus' as predecessor_execution_status,
  v.predecessor_qualifiers->'period'->>'finality' as predecessor_finality,
  v.predecessor_qualifiers->'labelEvidence' as predecessor_label,
  v.predecessor_qualifiers->'headerEvidence' as predecessor_headers,
  pi.original_sha256 as predecessor_sha256, pi.original_bytes::text as predecessor_bytes`;

export const seriesPeriodEnd = (type: PeriodType, label: string): string => {
  const bounds = calendarBounds(type, label);
  if (bounds === null) throw contract(`invalid series label '${label}'`);
  return bounds.end;
};

const labelOf = (type: PeriodType, periodEnd: string): string => {
  if (type === 'MONTH') return periodEnd.slice(0, 7);
  if (type === 'QUARTER') {
    return `${periodEnd.slice(0, 4)}-Q${String(Number.parseInt(periodEnd.slice(5, 7), 10) / 3)}`;
  }
  return periodEnd.slice(0, 4);
};

export const seriesRowsSql = (request: SeriesRowsRequest) => {
  const basis = VIEW_BASIS[request.basis][request.type];
  if (basis === undefined)
    throw contract(`no reviewed view basis for ${request.type} × ${request.basis}`);
  const ends = request.labels.map((label) => seriesPeriodEnd(request.type, label));
  return sql<SeriesRow>`
    /* budget.national:execution_national_series */
    select v.item_id, v.period_basis, v.period_start::text as period_start,
      v.period_end::text as period_end, v.predecessor_end::text as predecessor_end,
      v.value_ron::text as value_ron, v.availability_reason, v.value_basis,
      v.derivation_version, v.component,
      ${ENDPOINT_COLUMNS},
      ${PREDECESSOR_COLUMNS}
    from budget.execution_national_budget_series_v1 v
    left join budget.execution_release_inputs ei
      on ei.release_id = v.endpoint_release_id and ei.input_id = 'bgc'
    left join budget.execution_release_inputs pi
      on pi.release_id = v.predecessor_release_id and pi.input_id = 'bgc'
    where v.item_id = any(${[...request.itemIds]}::text[])
      and v.period_basis = ${basis}
      and v.period_end = any(${ends}::date[])
    order by v.item_id, v.period_end
  `;
};

interface OperandColumns {
  readonly selectionId: string | null;
  readonly releaseId: string | null;
  readonly observationKey: string | null;
  readonly sourceUrl: string | null;
  readonly sourceState: string | null;
  readonly coverageStart: string | null;
  readonly coverageEnd: string | null;
  readonly executionStatus: string | null;
  readonly finality: string | null;
  readonly label: unknown;
  readonly headers: unknown;
  readonly sha256: string | null;
  readonly bytes: string | null;
}

const endpointColumns = (row: SeriesRow): OperandColumns => ({
  selectionId: row.endpoint_selection_id,
  releaseId: row.endpoint_release_id,
  observationKey: row.endpoint_observation_key,
  sourceUrl: row.endpoint_source_url,
  sourceState: row.endpoint_source_state,
  coverageStart: row.endpoint_coverage_start,
  coverageEnd: row.endpoint_coverage_end,
  executionStatus: row.endpoint_execution_status,
  finality: row.endpoint_finality,
  label: row.endpoint_label,
  headers: row.endpoint_headers,
  sha256: row.endpoint_sha256,
  bytes: row.endpoint_bytes,
});

const predecessorColumns = (row: SeriesRow): OperandColumns => ({
  selectionId: row.predecessor_selection_id,
  releaseId: row.predecessor_release_id,
  observationKey: row.predecessor_observation_key,
  sourceUrl: row.predecessor_source_url,
  sourceState: row.predecessor_source_state,
  coverageStart: row.predecessor_coverage_start,
  coverageEnd: row.predecessor_coverage_end,
  executionStatus: row.predecessor_execution_status,
  finality: row.predecessor_finality,
  label: row.predecessor_label,
  headers: row.predecessor_headers,
  sha256: row.predecessor_sha256,
  bytes: row.predecessor_bytes,
});

const headersOf = (value: unknown): CellEvidence[] => {
  if (value === null || value === undefined) return [];
  if (!Value.Check(HeadersSchema, value)) throw contract('operand header evidence is malformed');
  return value.map((header) => ({
    sheet: header.sheet ?? null,
    cell: header.cell ?? null,
    text: header.text,
  }));
};

/** An operand of the audited view: its month, IDs, sealed qualifiers and evidence. */
const operandOf = (columns: OperandColumns, month: string): SeriesOperand => ({
  month,
  selectionId:
    columns.selectionId === null ? null : canonicalUuid(columns.selectionId, 'selection'),
  releaseId: columns.releaseId === null ? null : canonicalUuid(columns.releaseId, 'release'),
  observationKey: columns.observationKey,
  sourceState: columns.sourceState,
  document: document(columns.sourceUrl, columns.sha256, columns.bytes),
  coverage: interval(columns.coverageStart, columns.coverageEnd),
  executionStatus: optional(EXECUTION_STATUSES, columns.executionStatus, 'execution status'),
  finality: optional(FINALITIES, columns.finality, 'finality'),
  label: evidenceOf(columns.label),
  headers: headersOf(columns.headers),
});

export const seriesFromRows = (
  type: PeriodType,
  rows: readonly SeriesRow[]
): NationalSeriesRows => ({
  derivationVersion: NATIONAL_SERIES_DERIVATION_VERSION,
  component: NATIONAL_SERIES_COMPONENT,
  rows: rows.map((row): NationalSeriesViewRow => {
    if (row.derivation_version !== NATIONAL_SERIES_DERIVATION_VERSION) {
      throw contract(`unexpected derivation version '${row.derivation_version}'`);
    }
    if (row.component !== NATIONAL_SERIES_COMPONENT) {
      throw contract(`unexpected series component '${row.component}'`);
    }
    if (row.availability_reason === null) throw contract(`series row ${row.item_id} has no reason`);
    if (!isCalendarDate(row.period_end)) throw contract(`series period end '${row.period_end}'`);
    let value = null;
    if (row.value_ron !== null) {
      const parsed = parseSourceDecimal(row.value_ron);
      if (parsed.isErr()) throw contract(`series value of ${row.item_id} is not numeric text`);
      value = parsed.value;
    }
    return {
      itemId: row.item_id,
      date: labelOf(type, row.period_end),
      periodStart: row.period_start,
      periodEnd: row.period_end,
      reason: row.availability_reason,
      value,
      valueBasis: optional(VALUE_BASES, row.value_basis, 'value basis'),
      endpoint: operandOf(endpointColumns(row), row.period_end.slice(0, 7)),
      predecessor:
        row.predecessor_end === null
          ? null
          : operandOf(predecessorColumns(row), row.predecessor_end.slice(0, 7)),
    };
  }),
});

// ── reader ───────────────────────────────────────────────────────────────────

export const makeNationalExecutionReader = (run: NationalRun): NationalExecutionReader => ({
  currentLeaves: () =>
    guardedRead('execution current leaves', async () => {
      const { rows } = await run(currentLeavesSql);
      return rows.map((row): ExecutionLeafRow => ({
        ...resolved(row),
        month: monthOf(row.period_end),
      }));
    }),

  catalogItems: () =>
    guardedRead('execution catalog items', async () => {
      const { rows } = await run(catalogItemsSql);
      return rows.map((row): ExecutionItem => ({
        itemId: row.item_id,
        section: required(SECTIONS, row.section, 'item section'),
        sourceLabel: row.source_label,
        relatedScopeItemId: row.related_scope_item_id,
        mappingVersion: row.mapping_version,
      }));
    }),

  releaseChains: (periodEnds, revisionsPerMonth) =>
    guardedRead('execution release chains', async () => {
      const { rows } = await run(releaseChainsSql(periodEnds, revisionsPerMonth));
      return chainsFromRows(rows);
    }),

  selections: (selectionIds) =>
    guardedRead('execution selections', async () => {
      const { rows } = await run(selectionsSql(selectionIds));
      return rows.map(resolved);
    }),

  observations: (request) =>
    guardedRead('execution observations page', async () => {
      // Non-FACT cells are single-selection only (validated); nothing else to read.
      if (!request.query.dispositions.includes('FACT') && !request.singleSelection) return [];
      const { rows } = await run(observationsSql(request));
      return rows.map(occurrenceFromRow);
    }),

  seriesRows: (request) =>
    guardedRead('national execution series', async () => {
      if (request.labels.length === 0) return seriesFromRows(request.type, []);
      const { rows } = await run(seriesRowsSql(request));
      return seriesFromRows(request.type, rows);
    }),
});
