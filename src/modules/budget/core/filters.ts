/**
 * Budget module — filter specs (plan §7). One `CollectionFilterSpec` per
 * collection; the kernel derives TypeBox / GraphQL input / SQL conditions + the
 * stable `fhash` from these. The module only DECLARES specs (no DSL).
 *
 * Three DISTINCT specs by path (plan §0.3/§0.4), so the fact-vs-MV split is
 * encoded structurally (the C1/C2 review fix):
 *   - `budgetFactFilterSpec`        → execution_line_items (FACT path; the §0.3
 *     pruning triple year+report_type+account_category is DEFAULT-ed + the repo
 *     refuses to emit a query missing it).
 *   - `budgetCommitmentFactFilterSpec` → commitment_line_items (FACT path; pruning
 *     pair year+report_type, NO account_category).
 *   - `budgetRankingFilterSpec`     → the execution MVs (MV path; NO fact-only
 *     field; `accountCategory` is a column-SELECTOR via `metric`, not a predicate).
 *
 * Column `alias` MUST match the repo's FROM alias: `eli` execution fact, `cli`
 * commitment fact, `mv` execution MV, `e` core.public_entities, `t`
 * core.territories. Money/amount ranges use the kernel `money` filter type
 * (precision-safe `::numeric`).
 *
 * VIRTUAL fields (no physical column, intercepted by the repo): `frequency`,
 * `months`, `quarters`, `excludeTransfers`, and on the MV spec
 * `year`/`reportType`. They appear in the spec (so they surface in GraphQL/TypeBox
 * and the fhash) but the repo compiles them itself.
 */

import {
  ACCOUNT_CATEGORIES,
  BUDGET_FREQUENCIES,
  COMMITMENT_REPORT_TYPES,
  EXECUTION_REPORT_TYPES,
} from './constants.js';

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

// ── execution fact-collection spec (the §0.3 pruning triple is non-removable) ──

export const budgetFactFilterSpec: CollectionFilterSpec = {
  collection: 'budget_fact',
  fields: [
    // ── the pruning triple (mandatory; defaults fill it; repo refuses without it)
    {
      name: 'reportingYear',
      type: 'int',
      ops: ['eq', 'between', 'in'],
      column: { alias: 'eli', column: 'reporting_year' },
      description: 'RANGE L1 partition prune (mandatory). Defaults to the latest complete year.',
    },
    {
      name: 'reportType',
      type: 'enum',
      ops: ['eq'],
      enumValues: EXECUTION_REPORT_TYPES,
      column: { alias: 'eli', column: 'report_type' },
      default: 'EXECUTION_DETAILED',
      description: 'LIST L2 partition prune (mandatory; mapped to the partition literal).',
    },
    {
      name: 'accountCategory',
      type: 'enum',
      ops: ['eq'],
      enumValues: ACCOUNT_CATEGORIES,
      column: { alias: 'eli', column: 'account_category' },
      default: 'EXPENSE',
      description: 'LIST L3 partition prune (mandatory for execution; INCOME=vn, EXPENSE=ch).',
    },
    // ── period scope (virtual: selects the partial scope index + amount column)
    {
      name: 'frequency',
      type: 'enum',
      ops: ['eq'],
      enumValues: BUDGET_FREQUENCIES,
      column: { alias: 'eli', column: 'frequency_virtual' },
      default: 'YEAR',
      description: 'Selects is_monthly/quarterly/yearly + the amount column.',
    },
    {
      name: 'months',
      type: 'int',
      ops: ['in'],
      array: true,
      column: { alias: 'eli', column: 'reporting_month' },
      description: 'Month tuple within the year (frequency=MONTH).',
    },
    {
      name: 'quarters',
      type: 'int',
      ops: ['in'],
      array: true,
      column: { alias: 'eli', column: 'quarter' },
      description: 'Quarter tuple within the year (frequency=QUARTER).',
    },
    // ── entity / creditor (ride the leading columns of the scope index)
    {
      name: 'entityCuis',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'eli', column: 'entity_cui' },
    },
    {
      name: 'mainCreditorCui',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'eli', column: 'main_creditor_cui' },
    },
    // ── classification / dimensions (identity index + text_pattern_ops)
    {
      name: 'budgetSectorIds',
      type: 'int',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'eli', column: 'budget_sector_id' },
    },
    // NUMERIC funding filter serves the legacy phoenix convention: the repo
    // translates these PUBLIC ids to the stored `funding_source_id` before SQL (A1).
    {
      name: 'fundingSourceIds',
      type: 'int',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'eli', column: 'funding_source_id' },
    },
    // DURABLE funding filter: the ANAF letter code (A..J), matched on the inline
    // `funding_source` column — no id translation, the stable public key (A1/C).
    {
      name: 'fundingSourceCodes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'eli', column: 'funding_source' },
    },
    {
      name: 'expenseTypes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      exclude: true,
      column: { alias: 'eli', column: 'expense_type' },
    },
    {
      name: 'functionalCodes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      exclude: true,
      column: { alias: 'eli', column: 'functional_code' },
    },
    {
      name: 'functionalPrefix',
      type: 'string',
      ops: ['prefix'],
      exclude: true,
      column: { alias: 'eli', column: 'functional_code' },
      description: 'LIKE prefix% on the text_pattern_ops btree.',
    },
    {
      name: 'economicCodes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      exclude: true,
      column: { alias: 'eli', column: 'economic_code' },
    },
    {
      name: 'economicPrefix',
      type: 'string',
      ops: ['prefix'],
      exclude: true,
      column: { alias: 'eli', column: 'economic_code' },
      description: 'LIKE prefix% on the text_pattern_ops btree.',
    },
    {
      name: 'programCodes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      exclude: true,
      column: { alias: 'eli', column: 'program_code' },
    },
    // ── amount (row-level; money type → exact ::numeric compare on the freq column)
    {
      name: 'minAmount',
      type: 'money',
      ops: ['gte'],
      column: { alias: 'eli', column: 'amount_virtual' },
      description: 'Lower bound on the frequency amount column (NULL-excluding).',
    },
    {
      name: 'maxAmount',
      type: 'money',
      ops: ['lte'],
      column: { alias: 'eli', column: 'amount_virtual' },
      description: 'Upper bound on the frequency amount column.',
    },
    // ── transfer exclusion (virtual; opt-in; fact path only — MVs pre-exclude)
    {
      name: 'excludeTransfers',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'eli', column: 'exclude_transfers_virtual' },
      description: 'Exclude transfer codes (the exact set the MVs bake in).',
    },
    // ── core-join filters (entity / territory; need the LEFT JOINs)
    {
      name: 'entityTypes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'e', column: 'entity_type' },
      description: 'core.public_entities.entity_type (needs entity join).',
    },
    { name: 'isUat', type: 'bool', ops: ['eq'], column: { alias: 'e', column: 'is_uat' } },
    {
      name: 'isTerritorialExecutive',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'e', column: 'is_territorial_executive' },
    },
    {
      name: 'countyCodes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      exclude: true,
      column: { alias: 't', column: 'county_code' },
      description: 'Resolves via the territory join.',
    },
    {
      name: 'regions',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      exclude: true,
      column: { alias: 't', column: 'region' },
    },
    {
      name: 'minPopulation',
      type: 'int',
      ops: ['gte'],
      column: { alias: 't', column: 'population' },
    },
    {
      name: 'maxPopulation',
      type: 'int',
      ops: ['lte'],
      column: { alias: 't', column: 'population' },
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'e', column: 'name' },
      description: 'Entity-name trigram (Postgres pg_trgm; not Meili/OS on this collection).',
    },
    // ── exclusion-only fields
    {
      name: 'reportIds',
      type: 'string',
      ops: ['in'],
      array: true,
      exclude: true,
      column: { alias: 'eli', column: 'report_id' },
      description: 'Exclusion only.',
    },
    {
      name: 'excludeEntityCuis',
      type: 'string',
      ops: ['in'],
      array: true,
      exclude: true,
      column: { alias: 'eli', column: 'entity_cui' },
      description: 'Exclusion only.',
    },
  ],
  sort: { default: 'LINE_ORDER', allowed: ['LINE_ORDER', 'AMOUNT_DESC', 'AMOUNT_ASC'] },
};

// ── commitment fact spec (pruning PAIR year+report_type; NO account_category) ──

export const budgetCommitmentFactFilterSpec: CollectionFilterSpec = {
  collection: 'budget_commitment_fact',
  fields: [
    {
      name: 'reportingYear',
      type: 'int',
      ops: ['eq', 'between', 'in'],
      column: { alias: 'cli', column: 'reporting_year' },
      description: 'RANGE L1 partition prune (mandatory).',
    },
    {
      name: 'reportType',
      type: 'enum',
      ops: ['eq'],
      enumValues: COMMITMENT_REPORT_TYPES,
      column: { alias: 'cli', column: 'report_type' },
      default: 'COMMITMENT_AGG_PRINCIPAL',
      description:
        'LIST L2 partition prune (mandatory; commitment partition literal; repo-intercepted).',
    },
    {
      name: 'frequency',
      type: 'enum',
      ops: ['eq'],
      enumValues: BUDGET_FREQUENCIES,
      column: { alias: 'cli', column: 'frequency_virtual' },
      default: 'YEAR',
      description: 'Selects is_monthly/quarterly/yearly.',
    },
    {
      name: 'months',
      type: 'int',
      ops: ['in'],
      array: true,
      column: { alias: 'cli', column: 'reporting_month' },
    },
    {
      name: 'quarters',
      type: 'int',
      ops: ['in'],
      array: true,
      column: { alias: 'cli', column: 'quarter' },
    },
    {
      name: 'entityCuis',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'cli', column: 'entity_cui' },
    },
    {
      name: 'mainCreditorCui',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'cli', column: 'main_creditor_cui' },
    },
    {
      name: 'budgetSectorIds',
      type: 'int',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'cli', column: 'budget_sector_id' },
    },
    // NUMERIC funding filter (legacy convention; repo translates PUBLIC→stored, A1).
    {
      name: 'fundingSourceIds',
      type: 'int',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'cli', column: 'funding_source_id' },
    },
    // DURABLE funding filter: ANAF letter code (A..J) on the inline column (A1/C).
    {
      name: 'fundingSourceCodes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'cli', column: 'funding_source' },
    },
    {
      name: 'functionalCodes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      exclude: true,
      column: { alias: 'cli', column: 'functional_code' },
    },
    {
      name: 'functionalPrefix',
      type: 'string',
      ops: ['prefix'],
      exclude: true,
      column: { alias: 'cli', column: 'functional_code' },
    },
    {
      name: 'economicCodes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      exclude: true,
      column: { alias: 'cli', column: 'economic_code' },
    },
    {
      name: 'economicPrefix',
      type: 'string',
      ops: ['prefix'],
      exclude: true,
      column: { alias: 'cli', column: 'economic_code' },
    },
    // ── core-join filters (commitment rows carry entity_cui; R2 review fix) ──
    {
      name: 'entityTypes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'e', column: 'entity_type' },
    },
    { name: 'isUat', type: 'bool', ops: ['eq'], column: { alias: 'e', column: 'is_uat' } },
    {
      name: 'isTerritorialExecutive',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'e', column: 'is_territorial_executive' },
    },
    {
      name: 'countyCodes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      exclude: true,
      column: { alias: 't', column: 'county_code' },
    },
    {
      name: 'regions',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      exclude: true,
      column: { alias: 't', column: 'region' },
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'e', column: 'name' },
      description: 'Entity-name trigram.',
    },
    {
      name: 'excludeEntityCuis',
      type: 'string',
      ops: ['in'],
      array: true,
      exclude: true,
      column: { alias: 'cli', column: 'entity_cui' },
      description: 'Exclusion only.',
    },
  ],
  sort: { default: 'LINE_ORDER', allowed: ['LINE_ORDER', 'AMOUNT_DESC', 'AMOUNT_ASC'] },
};

// ── ranking / summary / heatmap spec (MV path; NO fact-only field accepted) ──

export const budgetRankingFilterSpec: CollectionFilterSpec = {
  collection: 'budget_ranking',
  fields: [
    {
      name: 'year',
      type: 'int',
      ops: ['eq'],
      column: { alias: 'mv', column: 'year' },
      description: 'MV year filter (mandatory for rankings).',
    },
    {
      name: 'reportType',
      type: 'enum',
      ops: ['eq'],
      enumValues: EXECUTION_REPORT_TYPES,
      column: { alias: 'mv', column: 'report_type' },
      default: 'EXECUTION_DETAILED',
    },
    {
      name: 'frequency',
      type: 'enum',
      ops: ['eq'],
      enumValues: BUDGET_FREQUENCIES,
      column: { alias: 'mv', column: 'frequency_virtual' },
      default: 'YEAR',
      description: 'Selects the annual, quarterly, or monthly execution MV.',
    },
    {
      name: 'month',
      type: 'int',
      ops: ['eq'],
      column: { alias: 'mv', column: 'month' },
    },
    {
      name: 'quarter',
      type: 'int',
      ops: ['eq'],
      column: { alias: 'mv', column: 'quarter' },
    },
    {
      name: 'entityCuis',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'mv', column: 'entity_cui' },
    },
    {
      name: 'mainCreditorCui',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'mv', column: 'main_creditor_cui' },
    },
    {
      name: 'excludeEntityCuis',
      type: 'string',
      ops: ['in'],
      array: true,
      exclude: true,
      column: { alias: 'mv', column: 'entity_cui' },
      description: 'Exclusion only.',
    },
    // ── geo / entity filters resolve via the core join (entity + territory)
    {
      name: 'countyCodes',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 't', column: 'county_code' },
    },
    {
      name: 'regions',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 't', column: 'region' },
    },
    { name: 'isUat', type: 'bool', ops: ['eq'], column: { alias: 'e', column: 'is_uat' } },
    {
      name: 'isTerritorialExecutive',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'e', column: 'is_territorial_executive' },
    },
    {
      name: 'minPopulation',
      type: 'int',
      ops: ['gte'],
      column: { alias: 't', column: 'population' },
    },
    {
      name: 'maxPopulation',
      type: 'int',
      ops: ['lte'],
      column: { alias: 't', column: 'population' },
    },
  ],
  sort: {
    default: 'EXPENSE',
    allowed: ['INCOME', 'EXPENSE', 'BALANCE', 'PER_CAPITA', 'ENTITY_NAME', 'POPULATION', 'COUNTY'],
  },
};

// ── report metadata spec (≥1 of entity/year/report_type required — §7.4) ──────

export const budgetReportFilterSpec: CollectionFilterSpec = {
  collection: 'budget_report',
  fields: [
    {
      name: 'entityCui',
      type: 'string',
      ops: ['eq', 'in'],
      array: true,
      column: { alias: 'r', column: 'entity_cui' },
    },
    {
      name: 'reportingYear',
      type: 'int',
      ops: ['eq', 'in', 'between'],
      column: { alias: 'r', column: 'reporting_year' },
    },
    {
      name: 'reportType',
      type: 'string',
      ops: ['eq', 'in'],
      array: true,
      column: { alias: 'r', column: 'report_type' },
    },
    {
      name: 'mainCreditorCui',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'r', column: 'main_creditor_cui' },
    },
    {
      name: 'reportingPeriod',
      type: 'string',
      ops: ['eq', 'in'],
      array: true,
      column: { alias: 'r', column: 'reporting_period' },
    },
    {
      name: 'reportDate',
      type: 'date',
      ops: ['between'],
      column: { alias: 'r', column: 'report_date' },
    },
  ],
  sort: { default: 'report_date', allowed: ['report_date', 'reporting_year'] },
};

// ── approved-fact spec (budget-official; capability-gated) ─────────────────────

export const budgetApprovedFactFilterSpec: CollectionFilterSpec = {
  collection: 'budget_approved_fact',
  fields: [
    {
      name: 'budgetYear',
      type: 'int',
      ops: ['eq', 'in', 'between'],
      column: { alias: 'af', column: 'budget_year' },
    },
    {
      name: 'measureYear',
      type: 'int',
      ops: ['eq'],
      column: { alias: 'af', column: 'measure_year' },
    },
    {
      name: 'measureKind',
      type: 'string',
      ops: ['eq', 'in'],
      array: true,
      column: { alias: 'af', column: 'measure_kind' },
    },
    {
      name: 'budgetComponent',
      type: 'string',
      ops: ['eq', 'in'],
      array: true,
      column: { alias: 'af', column: 'budget_component' },
    },
    {
      name: 'functionalCode',
      type: 'string',
      ops: ['eq', 'prefix'],
      column: { alias: 'af', column: 'functional_code' },
    },
    {
      name: 'economicCode',
      type: 'string',
      ops: ['eq', 'prefix'],
      column: { alias: 'af', column: 'economic_code' },
    },
  ],
  sort: { default: 'budget_year', allowed: ['budget_year', 'amount_value'] },
};

export const BUDGET_FILTER_SPECS = {
  fact: budgetFactFilterSpec,
  commitmentFact: budgetCommitmentFactFilterSpec,
  ranking: budgetRankingFilterSpec,
  report: budgetReportFilterSpec,
  approvedFact: budgetApprovedFactFilterSpec,
} as const;

/**
 * Fields the FACT-spec declares but the repo intercepts — the kernel composer
 * must NOT compile these (R1 review fix). This INCLUDES the gate fields
 * `reportingYear`/`reportType`/`accountCategory`: their spec `enumValues` are the
 * CLEAN enums but the columns store partition LITERALS, so a kernel-compiled
 * `report_type = 'EXECUTION_DETAILED'` would match zero rows and break pruning.
 * `gatePredicates` maps enum→literal and emits the prune predicates instead.
 */
export const BUDGET_FACT_VIRTUAL_FIELDS = [
  'reportingYear',
  'reportType',
  'accountCategory',
  'frequency',
  'months',
  'quarters',
  'minAmount',
  'maxAmount',
  'excludeTransfers',
] as const;

/** Commitment-spec fields the repo intercepts (gate + frequency + period tuple). */
export const BUDGET_COMMITMENT_VIRTUAL_FIELDS = [
  'reportingYear',
  'reportType',
  'frequency',
  'months',
  'quarters',
] as const;

/** Ranking/MV-spec fields the repo intercepts (year/reportType mapped to MV cols). */
export const BUDGET_RANKING_VIRTUAL_FIELDS = [
  'year',
  'reportType',
  'frequency',
  'month',
  'quarter',
] as const;

/** The §0.3 pruning-triple field names (fact path) — non-removable. */
export const BUDGET_FACT_GATE_FIELDS = ['reportingYear', 'reportType', 'accountCategory'] as const;
export const BUDGET_COMMITMENT_GATE_FIELDS = ['reportingYear', 'reportType'] as const;

/**
 * Derive a kernel-composer spec by DROPPING the repo-intercepted fields. The
 * kernel `toConditionBuilders` applies `spec.default` for ANY declared field
 * absent from the input — so a virtual/gate field left in the spec would compile
 * its default (e.g. `frequency_virtual = 'YEAR'`, a non-existent column, or
 * `report_type = 'EXECUTION_DETAILED'`, the clean enum). Stripping them from the
 * spec the kernel sees is what makes the repo the SOLE compiler of those fields
 * (the full spec is still used for GraphQL/TypeBox generation + the fhash).
 */
const dropFields = (spec: CollectionFilterSpec, drop: readonly string[]): CollectionFilterSpec => {
  const set = new Set(drop);
  return { ...spec, fields: spec.fields.filter((f) => !set.has(f.name)) };
};

/** The execution FACT spec the kernel composer sees (virtual/gate fields removed). */
export const budgetFactKernelSpec: CollectionFilterSpec = dropFields(
  budgetFactFilterSpec,
  BUDGET_FACT_VIRTUAL_FIELDS
);

/** The commitment FACT spec the kernel composer sees. */
export const budgetCommitmentFactKernelSpec: CollectionFilterSpec = dropFields(
  budgetCommitmentFactFilterSpec,
  BUDGET_COMMITMENT_VIRTUAL_FIELDS
);

/** The ranking/MV spec the kernel composer sees (MV-selector fields intercepted). */
export const budgetRankingKernelSpec: CollectionFilterSpec = dropFields(
  budgetRankingFilterSpec,
  BUDGET_RANKING_VIRTUAL_FIELDS
);
