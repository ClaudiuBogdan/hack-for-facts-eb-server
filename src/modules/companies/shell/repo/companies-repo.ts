/**
 * Companies module — repository over the live `companies_v2.*` + allowed `core.*`
 * schema (plan §3). The ONLY place that reads `companies_v2.*`. Reads through the
 * kernel's typed Kysely instance (`Kysely<ProdDatabase>` augmented by
 * `shell/db/schema.ts`).
 *
 * Contracts enforced here:
 *  - **link-not-merge** (§2.1): a company is addressed by normalized CUI; per-CUI
 *    seeks hit `organizations_cui_uq`; `org_id` is projected for identity only and
 *    NEVER used as a cross-source key or reassigned.
 *  - **`is_active` dropped** (§13-R1): v2 has no `fiscal_status.is_active`;
 *    no method recreates it.
 *  - **ONRC registry edition** (scrapper 20261003T172000): every registry read
 *    goes through the public `onrc_published_*` views bound to the pinned
 *    scope's `edition_id` (`registry-sql.ts`). The legacy registry projection
 *    (registrations, registration history/identifiers, status flags, CAEN
 *    profile, EU branches, source snapshots) is not read: no fallback when
 *    the registry is unpublished, withdrawn or unreadable.
 *  - **directory population**: public `company` spines of `core.organizations`
 *    (no rekey, rename, re-kind or privacy write; a spine without an edition
 *    profile is `not_in_edition`, never legally unregistered).
 *  - **no-unaccent name search** (§15.7): the pg fallback folds diacritics in TS
 *    and is hard-capped; the default path is Meili. The repo never calls `unaccent()`.
 *  - **money/bigint as strings** (§14.1): cast `::text` at the SQL boundary;
 *    `employees` never coerced to a JS number.
 *  - **NOT flows** (§4.3): this repo never reads `flows.money_flows`.
 *  - **privacy allowlist on every `companies_v2` table read**: each consumed
 *    table carries `privacy_class`, and every read, join, filter, count and
 *    existence probe pins it to `public`. On a LEFT JOIN the predicate sits
 *    in the ON clause, so a public organization whose auxiliary row is
 *    non-public reads exactly like one with no auxiliary row. The ONRC views
 *    apply their own public, parent and row predicates.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { buildEntitiesFilter } from '@/modules/shared/core/filters/index.js';
import {
  MAX_SERVED_CUI_DIGITS,
  databaseError,
  invalidInput,
  isCountyTerritory,
  normalizeCui,
  offsetFor,
  organizationRowIsPublic,
  readGenerationControl,
  toConditionBuilders,
  witnessGeneration,
  type ApiError,
  type FilterInput,
  type MeiliClient,
  type OffsetParams,
} from '@/modules/shared/index.js';
import { foldDiacritics } from '@/modules/shared/shell/repo/fold.js';

import {
  fieldOf,
  isNullValue,
  normalizeCountyNeedle,
  requireAggregateDriver,
  splitVirtual,
} from './filter-helpers.js';
import {
  caenActivitiesOf,
  mapCountyDisplayName,
  mapFinancialYear,
  mapQualityFlag,
  mapFiscal,
  statusFlagsOf,
  territoryOf,
  type FinancialRow,
} from './mappers.js';
import {
  FOLD_FROM,
  FOLD_TO,
  captureRegistryScope,
  confirmRegistryScope,
  countyNameOf,
  editionParam,
  inTextList,
  noProfileColumns,
  profileColumns,
  profileFromRow,
  profileJoin,
  readActiveCuis,
  readCaenObservations,
  readDiffSides,
  readPublishedEditions,
  readQualifiedNames,
  readRegistryEvidence,
  registryConditions,
  type ProfileColumnsRow,
} from './registry-sql.js';
import { COMPANY_AGGREGATE_DRIVING_FIELDS, companiesFilterSpec } from '../../core/filters.js';
import {
  compatStatus,
  displayName,
  isOnrcQualifiedCui,
  isPublished,
  onrcCaenKey,
  onrcIdentifierKey,
  registryCapabilityLost,
  registryNotPublished,
  registryScopeKey,
  singleIdentifierKey,
  usesRegistryFilters,
  type CompanyRegistryEnvelope,
} from '../../core/registry.js';
import {
  COMPANY_FINANCIAL_METRICS,
  COMPANY_TERRITORY_COVERAGE_NOTE,
  type CaenCodeHit,
  type CompanyEntitySlice,
  type CompanyFinancialQualityAssessment,
  type CompanyRegistrationDiffData,
  type CompanyFinancialYear,
  type CompanyGroupBy,
  type CompanyGroupCount,
  type CompanyListRow,
  type CompanyNameHit,
  type CompanySort,
} from '../../core/types.js';

import type {
  CompaniesRepository,
  CompanyCountByResult,
  CompanyListResult,
  CompanyPresenceCounts,
  CompanyProfileData,
} from '../../core/ports.js';

type Db = Kysely<import('@/modules/shared/index.js').ProdDatabase>;

const LIST_TOTAL_CAP = 10_000;
const NAME_FALLBACK_SCAN = 200;

/**
 * Per-statement budget for the `groupBy=caenDivision` aggregate ONLY. Measured at
 * 23.6s on prod for the broadest realistic driver (`status.eq='1048'`, 1.72M
 * companies) — over the 15s pool default, so the leg always aborted. 45s leaves
 * headroom for a cold buffer cache. Callers must treat this grouping as an
 * offline/cached answer, never an interactive one (see `companyHubStats`).
 */
const CAEN_DIVISION_TIMEOUT_MS = 45_000;

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/**
 * The kernel's positive `privacy_class = 'public'` allowlist for the RAW-SQL
 * legs (list, count and aggregate statements). Kysely-built queries pin the
 * same class through checked column references.
 */
const publicRow = organizationRowIsPublic;

/** The ANAF fiscal row every list/aggregate/slice reads beside the spine `o` (public in ON). */
const FISCAL_JOIN = sql`left join companies_v2.fiscal_status f on f.cui = o.cui and ${publicRow('f.privacy_class')}`;

/** The pinned profile join (published) or nothing (any other state: views untouched). */
const registryJoin = (scope: CompanyRegistryEnvelope): RawBuilder<unknown> =>
  isPublished(scope) ? profileJoin(scope.editionId) : sql``;

/** The profile columns (published) or the same names as NULLs. */
const registryColumns = (scope: CompanyRegistryEnvelope): RawBuilder<unknown> =>
  isPublished(scope) ? profileColumns : noProfileColumns;

/** ANAF's main-activity label by its OWN reported revision (none when unknown). */
const fiscalMainLabel = sql<string | null>`(select cc.label from core.classification_codes cc
  where cc.system = 'caen_' || nullif(f.main_caen_rev, '') and cc.code = f.main_caen_code limit 1)`;

/**
 * Standalone financial history by CUI (CD-08, user decision 2026-10-03) is a
 * set of attributed SOURCE OBSERVATIONS, not company membership: a public
 * statement stays readable when the CUI has no core organization (13,151 MFP
 * statements for 2,449 CUIs) or a public non-company one (1,107 statements on
 * 360 NGO/public/unknown CUIs). No kind or existence gate. It is denied only
 * when a KNOWN core organization for the CUI is not public — a NULL class
 * fails closed (`is distinct from`). Zero current rows are affected (census:
 * 0 non-public parents); it keeps a later withdrawal of an organization from
 * leaking through its statements. Used inside a correlated NOT EXISTS.
 */
const PARENT_PRIVACY_ALLOWED = 'public';

/**
 * Source as-of dates (CD-13), never write or fetch times:
 *  - ONRC: the pinned edition's source publication date (the envelope's
 *    `sourcePublishedAt`); null unless an edition is published.
 *  - ANAF: `f.status_date`, the state date ANAF answered for (the dimension the
 *    analytics release exports as `anaf_status_date`), never the retrieval or
 *    write time. NULL stays unknown.
 */
const onrcAsOf = (scope: CompanyRegistryEnvelope): string | null =>
  isPublished(scope) ? scope.sourcePublishedAt : null;

/**
 * The full financials column list of `companies_v2.financials as fin` (cast
 * money/bigint → text): the exact ORIGINAL source values, never qualified or
 * rewritten here.
 */
const financialColumns = () =>
  [
    'fin.year',
    'fin.source_system',
    'fin.statement_profile_hash',
    'fin.metric_rule_version',
    'fin.source_url',
    sql<string | null>`fin.turnover::text`.as('turnover'),
    sql<string | null>`fin.net_profit::text`.as('net_profit'),
    sql<string | null>`fin.net_loss::text`.as('net_loss'),
    sql<string | null>`fin.employees::text`.as('employees'),
    sql<string | null>`fin.total_revenue::text`.as('total_revenue'),
    sql<string | null>`fin.total_expenses::text`.as('total_expenses'),
    sql<string | null>`fin.gross_profit::text`.as('gross_profit'),
    sql<string | null>`fin.gross_loss::text`.as('gross_loss'),
    sql<string | null>`fin.receivables::text`.as('receivables'),
    sql<string | null>`fin.current_assets::text`.as('current_assets'),
    sql<string | null>`fin.fixed_assets::text`.as('fixed_assets'),
    sql<string | null>`fin.cash_and_bank::text`.as('cash_and_bank'),
    sql<string | null>`fin.prepaid_expenses::text`.as('prepaid_expenses'),
    sql<string | null>`fin.deferred_income::text`.as('deferred_income'),
    sql<string | null>`fin.subscribed_capital::text`.as('subscribed_capital'),
    sql<string | null>`fin.inventories::text`.as('inventories'),
    sql<string | null>`fin.debts::text`.as('debts'),
    sql<string | null>`fin.provisions::text`.as('provisions'),
    sql<string | null>`fin.total_equity::text`.as('total_equity'),
    sql<string | null>`fin.patrimony_regie::text`.as('patrimony_regie'),
    // v2 keeps the canonical full statement in financial_indicators, not as the
    // old financials.lines jsonb. Keep the public nullable field stable.
    sql<Record<string, unknown> | null>`null::jsonb`.as('lines'),
  ] as const;

/**
 * The evaluator columns of `financial_qualification_active as q` (scraper
 * migration 20261003T170000, sql-v1). The 21 statuses travel as ONE text[] in
 * `COMPANY_FINANCIAL_METRICS` order; NULL when the LEFT JOIN found no row.
 */
const qualificationColumns = () =>
  [
    sql<string | null>`q.release_id::text`.as('q_release_id'),
    'q.policy_sha256 as q_policy_sha256',
    'q.policy_version as q_policy_version',
    'q.policy_approved_on as q_policy_approved_on',
    'q.evaluator_version as q_evaluator_version',
    'q.assessment as q_assessment',
    'q.assessment_reason as q_assessment_reason',
    sql<(string | null)[] | null>`case when q.cui is null then null else array[${sql.join(
      COMPANY_FINANCIAL_METRICS.map((metric) => sql.ref(`q.${metric}_status`))
    )}]::text[] end`.as('q_statuses'),
    sql<string | null>`q.net_result_value::text`.as('q_net_result_value'),
    'q.hold_reason as q_hold_reason',
    'q.hold_drift as q_hold_drift',
  ] as const;

/**
 * What this runtime's PostgreSQL lets the financial reads join: the sql-v1
 * qualification view and the MFP resource dimension. Each is optional by
 * design: a database without the migration or the grant still serves every
 * source financial, with `not_assessed / qualification_unavailable` and no
 * MFP URL — never an invented `reported`.
 */
interface ServingCapabilities {
  readonly qualification: boolean;
  readonly resources: boolean;
}

/** A missing or ungranted capability is re-probed this long after it was seen. */
const CAPABILITY_RETRY_MS = 10 * 60 * 1000;

/** A syntactically valid CUI no statement carries: the probe reads its plan, not data. */
const PROBE_CUI = '0';

/**
 * SQLSTATEs that mean "this runtime cannot read the capability" (undefined
 * table/column/function/schema/object, insufficient privilege). Anything else
 * is a real error and is never masked by the fallback.
 */
const CAPABILITY_SQLSTATES = new Set(['42P01', '42703', '42883', '3F000', '42704', '42501']);

const isCapabilityError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CAPABILITY_SQLSTATES.has(code);
};

interface ListConditions {
  readonly conds: RawBuilder<unknown>[];
  /** The same-identifier predicate (alias `i`) for the CAEN facet; null without one. */
  readonly identifierPredicate: RawBuilder<boolean> | null;
}

/**
 * Compile the physical (kernel-composable) filter into SQL, then add the
 * edition-bound registry predicates (`registry-sql.ts`) and `hasFinancials`.
 * Aliases: o organizations, p the pinned edition profile, f fiscal_status.
 * A registry field without a published edition is refused, never empty.
 */
const buildListConditions = (
  input: FilterInput,
  scope: CompanyRegistryEnvelope
): Result<ListConditions, ApiError> => {
  const { physical, virtual } = splitVirtual(input);
  const built = toConditionBuilders(companiesFilterSpec, physical);
  if (built.isErr()) return err(built.error);
  // P0 containment on the LIST path. `o.kind = 'company'` does not exclude
  // natural persons: all 117,688 CNP-shaped identifiers carry kind='company'
  // (they arrive via the ONRC company registry) and every one of them is a
  // PF/AF/PFA/II/IF legal form. Without this, paging the public list reached a
  // natural person's name at offset 698 — 2.95% of the table is PF, so deep
  // paging returns them steadily. Filtering the INPUT cui filter was not enough;
  // an unfiltered browse never passes a cui at all.
  //
  // Placed here so the rows query and the bounded-total subquery, which share
  // this `where`, can never disagree about the population.
  const conds: RawBuilder<unknown>[] = [
    sql`o.kind = 'company'`,
    sql`(o.cui is null or length(o.cui) <= ${sql.lit(MAX_SERVED_CUI_DIGITS)})`,
    // Same identity gate as the kernel identity repo: every row is public today,
    // the platform gates on class, not distribution (review M/M02).
    organizationRowIsPublic('o.privacy_class'),
    ...built.value,
  ];

  let identifierPredicate: RawBuilder<boolean> | null = null;
  if (usesRegistryFilters(input)) {
    if (!isPublished(scope)) return err(registryNotPublished(scope, 'registry filters'));
    const registry = registryConditions(input, scope.editionId);
    if (registry.isErr()) return err(registry.error);
    conds.push(...registry.value.conds);
    identifierPredicate = registry.value.identifierPredicate;
  }

  const hasFin = isNullValue(fieldOf(virtual, 'hasFinancials'));
  if (hasFin !== undefined) {
    // hasFinancials isNull:false → "has at least one financial row" (NOT NULL presence).
    const wantPresent = !hasFin;
    // Presence is a read too: a company whose only financial rows are
    // non-public must answer "absent", the same allowlist the row reads apply.
    conds.push(
      wantPresent
        ? sql`exists (select 1 from companies_v2.financials fz where fz.cui = o.cui and fz.privacy_class = 'public')`
        : sql`not exists (select 1 from companies_v2.financials fz where fz.cui = o.cui and fz.privacy_class = 'public')`
    );
  }

  return ok({ conds, identifierPredicate });
};

/**
 * Sorts. `name` is the directory spine's name (the core organization label,
 * not an edition observation); `registrationDate` is the pinned edition's
 * qualified RECORDED date, NULL last, CUI tie-break (refused without one).
 */
const orderByFor = (
  sort: CompanySort,
  scope: CompanyRegistryEnvelope
): Result<RawBuilder<unknown>, ApiError> => {
  switch (sort) {
    case 'registrationDate':
      if (!isPublished(scope)) return err(registryNotPublished(scope, 'recorded-date sorting'));
      return ok(sql`p.recorded_date desc nulls last, o.cui asc`);
    case 'cui':
      return ok(sql`o.cui asc`);
    case 'name':
    default:
      return ok(sql`o.name asc, o.cui asc`);
  }
};

/** One spine row with the pinned profile (or its NULL columns) and the ANAF flags. */
interface SpineRow extends ProfileColumnsRow {
  cui: string;
  org_id: string;
  core_name: string;
  is_vat_payer: boolean | null;
  is_inactive: boolean | null;
}

const spineColumns = (scope: CompanyRegistryEnvelope) => sql`
  o.cui, o.org_id::text as org_id, o.name as core_name, ${registryColumns(scope)},
  f.is_vat_payer, f.is_inactive`;

const cuiStateOf = (
  scope: CompanyRegistryEnvelope,
  inEdition: boolean
): CompanyListRow['registryCuiState'] => {
  if (isPublished(scope)) return inEdition ? 'in_edition' : 'not_in_edition';
  // A published state always carries its edition id; this arm is unreachable.
  return scope.state === 'published' ? 'not_in_edition' : scope.state;
};

const mapListRow = (
  row: SpineRow,
  scope: CompanyRegistryEnvelope,
  active: ReadonlySet<string>
): CompanyListRow => {
  const profile = profileFromRow(row);
  const { name, nameSource } = displayName(row.core_name, profile);
  const status = profile?.statusCode.value ?? null;
  return {
    cui: row.cui,
    orgId: row.org_id,
    name,
    nameSource,
    legalForm: profile?.legalForm.value ?? null,
    headlineStatus: status === null ? null : compatStatus(status),
    county: profile === null ? null : mapCountyDisplayName(profile.countyName),
    vatPayer: row.is_vat_payer,
    declaredFiscallyInactive: row.is_inactive,
    registrationDate: profile?.recordedDate.value ?? null,
    registrationDatePresent: (profile?.recordedDate.value ?? null) !== null,
    registryCuiState: cuiStateOf(scope, profile !== null),
    hasActiveObservation: profile === null ? null : active.has(row.cui),
    statusBasis: profile?.statusCode.basis ?? null,
    countyBasis: profile?.countyCode.basis ?? null,
    recordedDateBasis: profile?.recordedDate.basis ?? null,
  };
};

/**
 * Status / county facet key: the consensus value, else an explicit basis
 * bucket; a spine without a profile is `(not_in_edition)`. Each CUI lands
 * in exactly one bucket.
 */
const facetKey = (value: string, basis: string) => sql`case
  when p.cui is null then '(not_in_edition)'
  when ${sql.ref(value)} is not null then ${sql.ref(value)}
  else '(' || ${sql.ref(basis)} || ')' end`;
const facetBasis = (value: string, basis: string) => sql`case
  when p.cui is null then 'not_in_edition'
  when ${sql.ref(value)} is null then ${sql.ref(basis)} end`;

interface FlagCoverage {
  readonly years: readonly number[];
  readonly assessed_at: string | null;
}

export interface CompaniesRepoOptions {
  /**
   * The Meili index for name resolution — the kernel-configured palette index
   * (`PROD_MEILI_INDEXES[0]`, default `entities`). The previous hardcoded
   * `['organizations','companies']` pair named indexes retired with the
   * palette cutover; multiSearch answered ok-with-empty-hits on their absence,
   * so every resolve silently took the pg fallback with no log and no
   * degraded signal (SEARCH_LAYER_REVIEW_2026-08-25.md F11).
   */
  readonly meiliEntitiesIndex?: string;
}

export const makeCompaniesRepo = (
  db: Db,
  repoOptions: CompaniesRepoOptions = {}
): CompaniesRepository => {
  const meiliEntitiesIndex = repoOptions.meiliEntitiesIndex ?? 'entities';
  // The quality-flag coverage triple is CUI-invariant (a corpus-wide constant),
  // so recomputing it per request would heap-scan the whole flags table on every
  // profile view — and that table grows on the next derive run. Memoized with a
  // short TTL; the only cost of staleness is the range widening a few minutes
  // late after a lane re-run.
  const COVERAGE_TTL_MS = 10 * 60 * 1000;
  // Singleflight: the PROMISE is cached, so concurrent misses share one scan
  // instead of dogpiling at TTL expiry; a rejected promise is evicted so an
  // error is never served from cache.
  let coverageCache: { at: number; promise: Promise<FlagCoverage> } | null = null;
  const getFlagCoverage = (): Promise<FlagCoverage> => {
    if (coverageCache !== null && Date.now() - coverageCache.at < COVERAGE_TTL_MS) {
      return coverageCache.promise;
    }
    const promise = (async (): Promise<FlagCoverage> => {
      const row = await db
        .selectFrom('companies_v2.financial_quality_flags as qf')
        .select([
          // The SET of flagged years, not min/max: FY2020 has zero flags while
          // its neighbours have tens of thousands (measured 2026-08-25), and a
          // range would invent coverage for that interior gap. Even inside the
          // set, a missing flag is not an assessment of a statement.
          sql<number[] | null>`array_agg(distinct year order by year)`.as('years'),
          sql<string | null>`max(created_at)::date::text`.as('assessed_at'),
        ])
        // Same allowlists as the per-CUI read: neither a non-public flag row nor
        // a flag under a non-public organization may move the coverage set
        // every public caller sees.
        .where('qf.privacy_class', '=', 'public')
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('core.organizations as parent')
                .select('parent.org_id')
                .whereRef('parent.cui', '=', 'qf.cui')
                .where('parent.privacy_class', 'is distinct from', PARENT_PRIVACY_ALLOWED)
            )
          )
        )
        .executeTakeFirst();
      return { years: row?.years ?? [], assessed_at: row?.assessed_at ?? null };
    })();
    coverageCache = { at: Date.now(), promise };
    promise.catch(() => {
      if (coverageCache?.promise === promise) coverageCache = null;
    });
    return promise;
  };

  // ── financial statements: originals + source + sql-v1 qualification ─────────
  //
  // Probed lazily before the first financial read, then cached (singleflight):
  // a complete answer is kept, a missing or ungranted capability is re-probed
  // after CAPABILITY_RETRY_MS. The probes read the exact columns the reads
  // select, so a stale view (a renamed column) degrades instead of failing.
  // Only a capability SQLSTATE degrades: any other probe error (a timeout, a
  // lost connection) fails the read, and the next read probes again.
  const probeCapability = async (run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run();
      return true;
    } catch (error) {
      if (isCapabilityError(error)) return false;
      throw error;
    }
  };
  const probeCapabilities = async (): Promise<ServingCapabilities> => {
    const [qualification, resources] = await Promise.all([
      probeCapability(() =>
        db
          .selectFrom('companies_v2.financial_qualification_active as q')
          .select(qualificationColumns())
          .where('q.cui', '=', PROBE_CUI)
          .where('q.privacy_class', '=', 'public')
          .limit(1)
          .execute()
      ),
      probeCapability(() =>
        db
          .selectFrom('companies_v2.financial_source_resources as res')
          .select('res.captured_source_url')
          .where('res.privacy_class', '=', 'public')
          .limit(1)
          .execute()
      ),
    ]);
    return { qualification, resources };
  };
  let capabilityCache: { at: number; promise: Promise<ServingCapabilities> } | null = null;
  const servingCapabilities = async (): Promise<ServingCapabilities> => {
    if (capabilityCache !== null) {
      const cached = capabilityCache;
      const known = await cached.promise;
      if (
        (known.qualification && known.resources) ||
        Date.now() - cached.at < CAPABILITY_RETRY_MS
      ) {
        return known;
      }
    }
    const promise = probeCapabilities();
    capabilityCache = { at: Date.now(), promise };
    promise.catch(() => {
      if (capabilityCache?.promise === promise) capabilityCache = null;
    });
    return promise;
  };

  /**
   * ONE statement per read (one snapshot): the public financials rows, the
   * MFP resource URL and the active publication's qualification, both LEFT
   * JOINed with their own public gate in ON, so a statement is never dropped
   * or duplicated by them (resource and view are keyed one-to-one).
   */
  const financialStatements = (capabilities: ServingCapabilities) =>
    db
      .selectFrom('companies_v2.financials as fin')
      .$if(capabilities.resources, (qb) =>
        qb
          .leftJoin('companies_v2.financial_source_resources as res', (join) =>
            join
              .onRef('res.source_system', '=', 'fin.source_system')
              .onRef('res.source_snapshot_id', '=', 'fin.source_snapshot_id')
              .on('res.privacy_class', '=', 'public')
          )
          .select('res.captured_source_url as resource_url')
      )
      .$if(capabilities.qualification, (qb) =>
        qb
          .leftJoin('companies_v2.financial_qualification_active as q', (join) =>
            join
              .onRef('q.cui', '=', 'fin.cui')
              .onRef('q.year', '=', 'fin.year')
              .on('q.privacy_class', '=', 'public')
          )
          .select(qualificationColumns())
      )
      .select(financialColumns());

  /**
   * Run a financial read with the capabilities this runtime has. If a
   * capability disappears between the probe and the read (a revoked grant, a
   * dropped view), the read is retried once WITHOUT the optional joins and the
   * capability is re-probed later: source financials never fail because the
   * qualification layer is unavailable.
   */
  const readStatements = async <T>(
    run: (capabilities: ServingCapabilities) => Promise<T>
  ): Promise<{ rows: T; qualificationReadable: boolean }> => {
    const capabilities = await servingCapabilities();
    try {
      return { rows: await run(capabilities), qualificationReadable: capabilities.qualification };
    } catch (error) {
      if (!(capabilities.qualification || capabilities.resources) || !isCapabilityError(error)) {
        throw error;
      }
      const degraded: ServingCapabilities = { qualification: false, resources: false };
      capabilityCache = { at: Date.now(), promise: Promise.resolve(degraded) };
      return { rows: await run(degraded), qualificationReadable: false };
    }
  };

  /**
   * ANAF fiscal row of one CUI (mandatory: its own public gate), with the main
   * activity's catalog label by its own revision (optional). The catalog is
   * presentation data: a catalog this runtime cannot read (a capability
   * SQLSTATE) re-reads the row without it, so the label is null (never a
   * label of another revision) and every fiscal fact stays. An unreadable
   * fiscal row still fails: the re-read cannot reach it either.
   */
  const fiscalRow = (cui: string, withLabel: boolean) =>
    db
      .selectFrom('companies_v2.fiscal_status as f')
      .select([
        'f.is_vat_payer',
        'f.is_inactive',
        'f.main_caen_code',
        'f.main_caen_rev',
        'f.registered_name',
        'f.status_date',
        (withLabel ? fiscalMainLabel : sql<string | null>`null::text`).as('main_caen_label'),
      ])
      .where('f.cui', '=', cui)
      .where('f.privacy_class', '=', 'public')
      .limit(1)
      .executeTakeFirst();
  const readFiscal = async (cui: string) => {
    try {
      return await fiscalRow(cui, true);
    } catch (error) {
      if (!isCapabilityError(error)) throw error;
      return fiscalRow(cui, false);
    }
  };

  // ── detail (per-CUI fan-out) ────────────────────────────────────────────────
  const getProfileData = async (
    rawCui: string,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyProfileData | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      // Presence first via the cheap org seek (organizations_cui_uq).
      const org = await db
        .selectFrom('core.organizations')
        .select(['org_id', 'cui', 'name'])
        .where('cui', '=', cui)
        .where('kind', '=', 'company')
        .where(organizationRowIsPublic('privacy_class'))
        .limit(1)
        .executeTakeFirst();
      if (org === undefined) return ok(null);

      // ONRC evidence of the pinned edition (or the envelope state alone),
      // ANAF fiscal and the financial statements: independent reads, so the
      // safe fiscal/financial content stays available when ONRC is not (the
      // capture pins `unavailable` when the registry footprint is unreadable).
      // An evidence read that loses the registry capability AFTER the capture
      // is not a database failure: the whole attempt, partial evidence
      // included, is discarded as a moved scope and re-pinned.
      const [fiscal, fin, registry] = await Promise.all([
        readFiscal(cui),
        readStatements((capabilities) =>
          financialStatements(capabilities)
            .where('fin.cui', '=', cui)
            // The CHECK admits 'personal_moderate'/'restricted'; all rows are
            // public today, but the platform gates on class, not distribution.
            .where('fin.privacy_class', '=', 'public')
            .orderBy('fin.year', 'desc')
            .execute()
        ),
        readRegistryEvidence(db, scope, cui, isOnrcQualifiedCui(cui)).then(
          (evidence) => ({ evidence, lost: false as const }),
          (error: unknown) => {
            if (isPublished(scope) && isCapabilityError(error)) {
              return { evidence: null, lost: true as const };
            }
            throw error;
          }
        ),
      ]);
      if (registry.lost) return err(registryCapabilityLost());

      const evidence = registry.evidence;
      const profile = evidence.profile;
      const { name, nameSource } = displayName(org.name, profile);
      const status = profile?.statusCode.value ?? null;
      const territory = territoryOf(profile);

      const data: CompanyProfileData = {
        cui,
        orgId: org.org_id,
        name,
        nameSource,
        legalForm: profile?.legalForm.value ?? null,
        codInmatriculare: singleIdentifierKey(evidence),
        registrationDate: profile?.recordedDate.value ?? null,
        registrationDatePresent: (profile?.recordedDate.value ?? null) !== null,
        headlineStatus: status === null ? null : compatStatus(status),
        statusFlags: statusFlagsOf(evidence.statusObservations),
        territory,
        // Never an address: the edition exposes derived geography only.
        address: { display: '', county: territory?.countyName ?? null, locality: null },
        fiscal: mapFiscal(fiscal),
        caenActivities: caenActivitiesOf(evidence.caenObservations, fiscal),
        // v2 person/role tables are privacy_class='restricted'. Keep the public
        // field stable but do not leak representative names without an API gate.
        representatives: [],
        financials: fin.rows.map((r) => mapFinancialYear(r, fin.qualificationReadable)),
        // Not part of the ONRC edition contract; the legacy projection is not read.
        euBranches: [],
        registry: evidence,
        asOf: { onrc: onrcAsOf(scope), anaf: fiscal?.status_date ?? null },
      };
      return ok(data);
    } catch (error) {
      return err(databaseError('getProfileData failed', error));
    }
  };

  const getFinancials = async (
    rawCui: string
  ): Promise<Result<readonly CompanyFinancialYear[], ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      // Source observations by CUI (CD-08): public rows, unless a KNOWN core
      // organization for the CUI is non-public. No kind or existence gate.
      // Each statement carries its sql-v1 qualification from the same read.
      const { rows, qualificationReadable } = await readStatements((capabilities) =>
        financialStatements(capabilities)
          .where('fin.cui', '=', cui)
          .where('fin.privacy_class', '=', 'public')
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('core.organizations as parent')
                  .select('parent.org_id')
                  .whereRef('parent.cui', '=', 'fin.cui')
                  .where('parent.privacy_class', 'is distinct from', PARENT_PRIVACY_ALLOWED)
              )
            )
          )
          .orderBy('fin.year', 'desc')
          .execute()
      );
      return ok(rows.map((r) => mapFinancialYear(r, qualificationReadable)));
    } catch (error) {
      return err(databaseError('getFinancials failed', error));
    }
  };

  /**
   * The CUI's public identity values in the pinned edition and in the newest
   * accessible published edition with an earlier source date. Not published,
   * or a CUI outside the qualified namespace: no edition side is read.
   */
  const getRegistrationDiffData = async (
    rawCui: string,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyRegistrationDiffData, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    if (!isPublished(scope)) return ok({ registry: scope, later: null, earlier: null });
    try {
      if (!isOnrcQualifiedCui(cui)) {
        // Outside the edition namespace: never linked to edition evidence.
        const absent = {
          editionId: scope.editionId,
          sourcePublishedAt: scope.sourcePublishedAt,
          inEdition: false,
          values: { legalName: [], legalForm: [], county: [], locality: [] },
          valuesComplete: true,
        };
        return ok({ registry: scope, later: absent, earlier: null });
      }
      const sides = await readDiffSides(db, scope, cui);
      return ok({ registry: scope, later: sides.later, earlier: sides.earlier });
    } catch (error) {
      // Edition views and territory names only: a capability failure here is
      // the registry footprint lost under the pin (a moved scope).
      if (isCapabilityError(error)) return err(registryCapabilityLost());
      return err(databaseError('getRegistrationDiffData failed', error));
    }
  };

  const getFinancialQualityAssessment = async (
    rawCui: string
  ): Promise<Result<CompanyFinancialQualityAssessment, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      // Defence-in-depth: the table measures 100% public today, but the platform
      // rule gates on class, not on today's distribution — positive allowlist.
      const [rows, coverage] = await Promise.all([
        db
          .selectFrom('companies_v2.financial_quality_flags as qf')
          .select([
            'year',
            'flag_code',
            'metric_name',
            'severity',
            sql<string | null>`numeric_value::text`.as('numeric_value'),
            sql<string | null>`threshold_value::text`.as('threshold_value'),
          ])
          .where('qf.cui', '=', cui)
          .where('qf.privacy_class', '=', 'public')
          // The same parent rule as the statements they qualify (CD-08).
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('core.organizations as parent')
                  .select('parent.org_id')
                  .whereRef('parent.cui', '=', 'qf.cui')
                  .where('parent.privacy_class', 'is distinct from', PARENT_PRIVACY_ALLOWED)
              )
            )
          )
          .orderBy('qf.year', 'desc')
          .orderBy('qf.flag_code', 'asc')
          .execute(),
        // Corpus-wide context, MEASURED not hardcoded: the years holding at
        // least one flag. The table stores dated anomalies only and is not
        // tied to a statement revision (flags 25 Aug, facts rebuilt 27 Sep), so
        // a CUI-year without a flag is UNASSESSED, never checked-and-clean.
        getFlagCoverage(),
      ]);
      return ok({
        assessedYears: coverage.years,
        assessedAt: coverage.assessed_at,
        flags: rows.map(mapQualityFlag),
      });
    } catch (error) {
      return err(databaseError('getFinancialQualityAssessment failed', error));
    }
  };

  // ── list / filter ───────────────────────────────────────────────────────────
  /**
   * Rows and the bounded total share ONE WHERE over the same spine population
   * and the same pinned edition: every spine row joins at most one profile
   * (primary key) and the registry criteria are semijoins, so a CUI is listed
   * and counted once.
   */
  const listCompanies = async (
    filter: FilterInput,
    sort: CompanySort,
    page: OffsetParams,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyListResult, ApiError>> => {
    const condsRes = buildListConditions(filter, scope);
    if (condsRes.isErr()) return err(condsRes.error);
    const order = orderByFor(sort, scope);
    if (order.isErr()) return err(order.error);
    const where = composeWhere(condsRes.value.conds);
    try {
      const rows = await sql<SpineRow>`
        select ${spineColumns(scope)}
        from core.organizations o
        ${registryJoin(scope)}
        ${FISCAL_JOIN}
        where ${where}
        order by ${order.value}
        limit ${page.pageSize} offset ${offsetFor(page)}`.execute(db);

      // Bounded total (§14.4): count over a LIMIT cap+1 subquery so a large
      // unfiltered list never scans 3.99M rows — `estimated` flags the cap.
      const countRow = await sql<{ cnt: string }>`
        select count(*)::text as cnt from (
          select 1 from core.organizations o
          ${registryJoin(scope)}
          ${FISCAL_JOIN}
          where ${where}
          limit ${LIST_TOTAL_CAP + 1}
        ) capped`.execute(db);
      const rawCount = Number(countRow.rows[0]?.cnt ?? 0);
      const estimated = rawCount > LIST_TOTAL_CAP;
      const total = estimated ? LIST_TOTAL_CAP : rawCount;

      const active = isPublished(scope)
        ? await readActiveCuis(
            db,
            scope.editionId,
            rows.rows.filter((r) => r.p_cui !== null).map((r) => r.cui)
          )
        : new Set<string>();
      return ok({ rows: rows.rows.map((r) => mapListRow(r, scope, active)), total, estimated });
    } catch (error) {
      return err(databaseError('listCompanies failed', error));
    }
  };

  /** Exact population count (no cap) for the cached hub; same predicates as the list. */
  const countCompanies = async (
    filter: FilterInput,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<number, ApiError>> => {
    const condsRes = buildListConditions(filter, scope);
    if (condsRes.isErr()) return err(condsRes.error);
    const where = composeWhere(condsRes.value.conds);
    try {
      const result = await sql<{ cnt: string }>`
        select count(*)::text as cnt
        from core.organizations o
        ${registryJoin(scope)}
        ${FISCAL_JOIN}
        where ${where}`.execute(db);
      return ok(Number(result.rows[0]?.cnt ?? 0));
    } catch (error) {
      return err(databaseError('countCompanies failed', error));
    }
  };

  // ── resolution / discovery ──────────────────────────────────────────────────
  /**
   * Labels for spine-validated candidates: the pinned edition's qualified name
   * when it has one, else the core organization name, attributed either way.
   * Search-index text is never a label and never presence evidence.
   */
  const labelHits = async (
    candidates: readonly { cui: string; coreName: string; score: number | null }[],
    scope: CompanyRegistryEnvelope
  ): Promise<CompanyNameHit[]> => {
    const onrcNames = isPublished(scope)
      ? await readQualifiedNames(
          db,
          scope.editionId,
          candidates.map((c) => c.cui).filter(isOnrcQualifiedCui)
        )
      : new Map<string, string>();
    return candidates.map((c): CompanyNameHit => {
      const onrc = onrcNames.get(c.cui);
      return {
        dim: 'name',
        value: c.cui,
        label: onrc ?? c.coreName,
        cui: c.cui,
        confidence: c.score,
        labelSource: onrc === undefined ? 'core_organization' : 'onrc_edition',
      };
    });
  };

  const resolveByName = async (
    q: string,
    limit: number,
    meili: MeiliClient | null,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<{ hits: readonly CompanyNameHit[]; degraded: boolean }, ApiError>> => {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    // PRIMARY: the palette index, filtered to identities that play the
    // `company` ROLE. `roles` rather than `doc_type`: the palette collapses
    // one document per identity, so a CUI that is also a public entity
    // presents as `organization` — the role filter still finds it, and the
    // kind='company' validation below keeps the §link-not-merge contract.
    // The filter builder always pins privacy_class = "public".
    // `degraded` reports that the engine's company contribution could not be
    // used, not an empty answer (M42): the engine was unavailable, OR the
    // palette generation was not witnessed current for THIS pinned scope (its
    // control read before and after the fetch missing, unreadable, of another
    // version, malformed, changed between the reads, or built for another
    // scope). Then neither its candidates nor its zero are accepted and the
    // existing bounded fallback answers. A witnessed engine with no
    // company-role hit falls through to that fallback as a plain (healthy)
    // fallback, never reported as degraded.
    let engineNotCurrent = meili === null;
    if (meili !== null) {
      const before = await readGenerationControl(meili, meiliEntitiesIndex);
      const m = await meili.searchEntities(q, meiliEntitiesIndex, {
        policy: 'baseline',
        filter: buildEntitiesFilter({ roles: ['company'] }),
        limit: capped,
      });
      const witness = m.isOk()
        ? witnessGeneration(before, await readGenerationControl(meili, meiliEntitiesIndex))
        : null;
      const current =
        witness?.witnessed === true &&
        isPublished(scope) &&
        witness.control.registryScopeKey === registryScopeKey(scope);
      if (!current) engineNotCurrent = true;
      if (m.isOk() && current) {
        // Collect candidate CUIs (ordered by Meili score), then VALIDATE them
        // against core.organizations(kind='company').
        // Search-index titles are never kept: labels come from the spine/edition.
        const ordered: { cui: string; score: number | null }[] = [];
        const seen = new Set<string>();
        for (const hit of m.value.hits) {
          // Palette docs key CUI identities by doc_key (= the CUI); `cuis` is
          // the mapper-derived all-numeric identifier subset. No `attrs.cui`
          // exists on palette docs — that was the retired per-source shape.
          const raw = hit.docKey ?? hit.cuis?.[0];
          const cui = typeof raw === 'string' ? normalizeCui(raw) : null;
          if (cui === null || seen.has(cui)) continue;
          seen.add(cui);
          ordered.push({ cui, score: hit.score });
        }
        if (ordered.length > 0) {
          try {
            const valid = await db
              .selectFrom('core.organizations')
              .select(['cui', 'name'])
              .where('kind', '=', 'company')
              .where(organizationRowIsPublic('privacy_class'))
              .where(
                'cui',
                'in',
                ordered.map((o) => o.cui)
              )
              .execute();
            const nameByCui = new Map(
              valid
                .filter((v): v is { cui: string; name: string } => v.cui !== null)
                .map((v) => [v.cui, v.name])
            );
            const candidates = ordered.flatMap((o) => {
              const coreName = nameByCui.get(o.cui);
              return coreName === undefined ? [] : [{ cui: o.cui, coreName, score: o.score }];
            });
            const hits = await labelHits(candidates.slice(0, capped), scope);
            if (hits.length > 0) return ok({ hits, degraded: false });
          } catch (error) {
            return err(databaseError('resolveByName validation failed', error));
          }
        }
        // A witnessed engine with no company-role hit for this query → pg fallback.
      }
    }
    // pg fallback (degraded when the engine's contribution was not usable): capped,
    // kind='company'-scoped, TS diacritic fold. No unaccent,
    // no trigram-index reliance; the LIMIT bounds the parallel seq scan (§15.7).
    const folded = foldDiacritics(q);
    if (folded === '') return ok({ hits: [], degraded: engineNotCurrent });
    try {
      const needle = '%' + folded.replace(/[%_\\]/gu, '\\$&') + '%';
      const rows = await db
        .selectFrom('core.organizations')
        .select(['cui', 'name', 'normalized_name', 'county_name'])
        .where('kind', '=', 'company')
        .where(organizationRowIsPublic('privacy_class'))
        .where('cui', 'is not', null)
        // Same containment as the list path, in SQL rather than after the scan:
        // the callers already drop withheld hits from the OUTPUT, but a scan
        // capped at NAME_FALLBACK_SCAN would let natural persons consume the cap
        // and silently starve real company matches for a common surname.
        .where(sql<boolean>`length(cui) <= ${sql.lit(MAX_SERVED_CUI_DIGITS)}`)
        .where(sql<boolean>`coalesce(normalized_name, name) ilike ${needle} escape '\\'`)
        .limit(NAME_FALLBACK_SCAN)
        .execute();
      const ranked = rows
        .flatMap((r) => (r.cui === null ? [] : [{ r, cui: r.cui }]))
        .map(({ r, cui }) => {
          const hay = foldDiacritics(r.normalized_name ?? r.name);
          const idx = hay.indexOf(folded);
          // Clamp to ≤1.0: an exact prefix match on a short name would otherwise
          // exceed 1.0 (e.g. 1.125) and break the [0,1] confidence contract (M10).
          const score = idx < 0 ? 0 : Math.min(1, 1 / (1 + idx) + 1 / (1 + hay.length));
          return { cui, coreName: r.name, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, capped);
      return ok({ hits: await labelHits(ranked, scope), degraded: engineNotCurrent });
    } catch (error) {
      return err(databaseError('resolveByName fallback failed', error));
    }
  };

  /**
   * The edition's identifier lookup: the input normalized exactly as the
   * edition normalizes identifier tokens (`onrcIdentifierKey`), an exact key
   * match in the pinned edition's PUBLIC RESOLVED identifier groups, then the
   * public `company` spine. No old/new number inference, no ambiguous or held
   * group (those are not in the public view), one hit per CUI. Refused while
   * no edition is published (never answered from the legacy identifiers).
   */
  const findByRegistrationNumber = async (
    cod: string,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<readonly CompanyNameHit[], ApiError>> => {
    const key = onrcIdentifierKey(cod);
    if (key === null) return ok([]);
    if (!isPublished(scope)) return err(registryNotPublished(scope, 'registration-number lookup'));
    try {
      const rows = await sql<{ cui: string; core_name: string; onrc_name: string | null }>`
        select i.cui, o.name as core_name, p.name as onrc_name
        from companies_v2.onrc_published_identifier_profiles i
        join core.organizations o
          on o.cui = i.cui and o.kind = 'company' and ${organizationRowIsPublic('o.privacy_class')}
            and length(o.cui) <= ${sql.lit(MAX_SERVED_CUI_DIGITS)}
        left join companies_v2.onrc_published_profiles p
          on p.edition_id = i.edition_id and p.cui = i.cui
        where i.edition_id = ${editionParam(scope.editionId)} and i.identifier_key = ${key}
        order by i.cui
        limit 50`.execute(db);
      const seen = new Set<string>();
      const hits: CompanyNameHit[] = [];
      for (const r of rows.rows) {
        if (seen.has(r.cui)) continue;
        seen.add(r.cui);
        hits.push({
          dim: 'regnum',
          value: r.cui,
          label: r.onrc_name ?? r.core_name,
          cui: r.cui,
          confidence: null,
          labelSource: r.onrc_name === null ? 'core_organization' : 'onrc_edition',
        });
      }
      return ok(hits);
    } catch (error) {
      return err(databaseError('findByRegistrationNumber failed', error));
    }
  };

  /**
   * Resolve a CAEN query to codes. The dim is "prefix/division resolution", so a
   * numeric/code-like query resolves by CODE (exact, then prefix) — NOT only by
   * label text (audit C4: previously `q:"6201"` did a label ILIKE and returned 0).
   * A free-text query still matches the Romanian label. Exact-code hits rank
   * first, then code-prefix, then label matches.
   */
  const resolveCaen = async (
    label: string,
    limit: number
  ): Promise<Result<readonly CaenCodeHit[], ApiError>> => {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    const q = label.trim();
    if (q === '') return ok([]);
    const esc = (s: string): string => s.replace(/[\\%_]/gu, (m) => `\\${m}`);
    const codePrefix = esc(q) + '%';
    const labelPattern = '%' + esc(q) + '%';
    try {
      const rows = await db
        .selectFrom('core.classification_codes')
        .select(['code', 'system', 'label'])
        .where(sql<boolean>`system like 'caen\\_%' escape '\\'`)
        .where(
          sql<boolean>`(code = ${q} or code like ${codePrefix} escape '\\' or label ilike ${labelPattern} escape '\\')`
        )
        // exact code first, then code-prefix, then shortest code (broadest division) — label-only matches fall to the end.
        .orderBy(sql`(code = ${q}) desc`)
        .orderBy(sql`(code like ${codePrefix} escape '\\') desc`)
        .orderBy(sql`length(code) asc`)
        .orderBy('code', 'asc')
        .limit(capped)
        .execute();
      return ok(
        rows.map((r) => {
          const rev = r.system.replace(/^caen_/u, '');
          return { code: r.code, rev, key: onrcCaenKey(rev, r.code), label: r.label };
        })
      );
    } catch (error) {
      return err(databaseError('resolveCaen failed', error));
    }
  };

  const resolveCounty = async (q: string): Promise<Result<readonly string[], ApiError>> => {
    const folded = normalizeCountyNeedle(q);
    try {
      // Canonical county names of PUBLIC county territories (the territory hub):
      // a county name is a county, never a coerced multiple/unknown state.
      const result = await sql<{ county_name: string | null }>`
        select distinct t.county_name from core.territories t
        where t.privacy_class = 'public' and t.county_name is not null and ${isCountyTerritory('t')}
          and regexp_replace(lower(translate(t.county_name, ${FOLD_FROM}, ${FOLD_TO})), '^(judetul|municipiul) ', '')
            like ${'%' + folded.replace(/[%_\\]/gu, '\\$&') + '%'} escape '\\'
        order by t.county_name
        limit 50`.execute(db);
      const names = result.rows
        .map((r) => mapCountyDisplayName(r.county_name))
        .filter((c): c is string => c !== null);
      return ok([...new Set(names)]);
    } catch (error) {
      return err(databaseError('resolveCounty failed', error));
    }
  };

  // ── aggregates (count-ranked) ───────────────────────────────────────────────
  interface CountRow {
    key: string;
    basis: string | null;
    label: string | null;
    cnt: string;
    matched: string;
    unmatched: string;
  }
  /**
   * Facets over EXACTLY the list's predicates (same compiler, same pinned
   * edition). County/status: each CUI once, under its consensus value or an
   * explicit basis bucket; denominator = the population. CAEN division:
   * (revision, division) buckets of the public observations on identifiers
   * that satisfy the filter's same-identifier criteria, distinct CUIs per
   * bucket, overlapping; denominator = the population, counted separately.
   * Every grouping needs a published edition (never an empty facet).
   */
  const countBy = async (
    groupBy: CompanyGroupBy,
    filter: FilterInput,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyCountByResult, ApiError>> => {
    // groupBy=county still needs a selective predicate; avoid broad county scans.
    if (groupBy === 'county') {
      const gate = requireAggregateDriver(
        filter,
        COMPANY_AGGREGATE_DRIVING_FIELDS,
        'county / status / caenCode / onrcCaen'
      );
      if (gate.isErr()) return err(gate.error);
    }
    if (!isPublished(scope)) return err(registryNotPublished(scope, `the ${groupBy} grouping`));
    const editionId = scope.editionId;
    const condsRes = buildListConditions(filter, scope);
    if (condsRes.isErr()) return err(condsRes.error);
    const where = composeWhere(condsRes.value.conds);
    const identifierPredicate = condsRes.value.identifierPredicate ?? sql<boolean>`true`;

    try {
      if (groupBy === 'caenDivision') {
        // The filtered population first (materialized), then its identifiers
        // that satisfy the same-identifier criteria, then their public CAEN
        // observations. The leg keeps its own statement budget (precedent:
        // the former caen_profile leg measured 23.6s); the pool default is
        // never raised. Cost on the edition views is unmeasured.
        const rows = await db.transaction().execute(async (trx) => {
          await sql`set local statement_timeout = ${sql.lit(CAEN_DIVISION_TIMEOUT_MS)}`.execute(
            trx
          );
          const r = await sql<{
            key: string;
            revision: string | null;
            cnt: string;
            population: string;
          }>`
            with filtered as materialized (
              select o.cui as cui
              from core.organizations o
              ${registryJoin(scope)}
              ${FISCAL_JOIN}
              where ${where}
            ),
            population as (select count(*)::text as n from filtered)
            select coalesce(c.caen_revision, 'unknown') || ':' || left(c.caen_code, 2) as key,
                   c.caen_revision as revision,
                   count(distinct fil.cui)::text as cnt,
                   (select n from population) as population
            from filtered fil
            join companies_v2.onrc_published_identifier_profiles i
              on i.edition_id = ${editionParam(editionId)} and i.cui = fil.cui
             and ${identifierPredicate}
            join companies_v2.onrc_published_caen_observations c
              on c.edition_id = i.edition_id and c.identifier_key = i.identifier_key and c.cui = i.cui
            where c.caen_code is not null
            group by 1, 2
            order by count(distinct fil.cui) desc, 1
            limit 500
          `.execute(trx);
          const population = await sql<{ n: string }>`
            select count(*)::text as n from core.organizations o
            ${registryJoin(scope)} ${FISCAL_JOIN} where ${where}`.execute(trx);
          return { rows: r.rows, population: Number(population.rows[0]?.n ?? 0) };
        });
        const groups: CompanyGroupCount[] = rows.rows.map((r) => ({
          key: r.key,
          label: null,
          count: Number(r.cnt),
          basis: r.revision === null ? 'unknown_revision' : null,
        }));
        return ok({
          groups,
          denominator: rows.population,
          coverage: {
            territoryMatched: null,
            territoryUnmatched: null,
            note: COMPANY_TERRITORY_COVERAGE_NOTE,
          },
        });
      }
      const value = groupBy === 'status' ? 'p.status_code' : 'p.county_code';
      const basis = groupBy === 'status' ? 'p.status_basis' : 'p.county_basis';
      // Territory coverage rides as two FILTER columns in the same grouped
      // scan; each CUI lands in exactly one bucket, so the sums are exact.
      // County names are looked up once per bucket, after grouping.
      const result = await sql<CountRow>`
        select g.key, g.basis,
          ${groupBy === 'county' ? sql`case when g.basis is null then ${countyNameOf(sql`g.key`)} end` : sql`null::text`} as label,
          g.cnt, g.matched, g.unmatched
        from (
          select ${facetKey(value, basis)} as key, ${facetBasis(value, basis)} as basis,
            count(*) as n,
            count(*)::text as cnt,
            count(*) filter (where p.uat_siruta_code is not null)::text as matched,
            count(*) filter (where p.uat_siruta_code is null)::text as unmatched
          from core.organizations o
          ${registryJoin(scope)}
          ${FISCAL_JOIN}
          where ${where}
          group by 1, 2
        ) g
        order by g.n desc, g.key limit 500
      `.execute(db);
      const groups: CompanyGroupCount[] = result.rows.map((r) => ({
        key: r.key,
        label:
          groupBy === 'status'
            ? r.basis === null
              ? compatStatus(r.key).label
              : null
            : mapCountyDisplayName(r.label),
        count: Number(r.cnt),
        basis: r.basis,
      }));
      return ok({
        groups,
        // Every CUI is in exactly one bucket (≤ ~90 buckets, under the cap).
        denominator: groups.reduce((s, g) => s + g.count, 0),
        coverage: {
          territoryMatched: result.rows.reduce((s, r) => s + Number(r.matched), 0),
          territoryUnmatched: result.rows.reduce((s, r) => s + Number(r.unmatched), 0),
          note: COMPANY_TERRITORY_COVERAGE_NOTE,
        },
      });
    } catch (error) {
      return err(databaseError('countBy failed', error));
    }
  };

  // ── contributor support ─────────────────────────────────────────────────────
  interface SliceRow extends SpineRow {
    anaf_as_of: string | null;
  }

  /** The public `company` spine rows of these CUIs with their pinned profile and ANAF flags. */
  const readSpineRows = (cuis: readonly string[], scope: CompanyRegistryEnvelope) =>
    sql<SliceRow>`
      select ${spineColumns(scope)}, f.status_date::text as anaf_as_of
      from core.organizations o
      ${registryJoin(scope)}
      ${FISCAL_JOIN}
      where ${inTextList(sql`o.cui`, cuis)} and o.kind = 'company'
        and ${organizationRowIsPublic('o.privacy_class')}
        and length(o.cui) <= ${sql.lit(MAX_SERVED_CUI_DIGITS)}`.execute(db);

  /** Pure assembly: the latest financial is fetched separately and passed in. */
  const sliceFromRow = (
    row: SliceRow,
    scope: CompanyRegistryEnvelope,
    latestFin: FinancialRow | null,
    qualificationReadable: boolean
  ): CompanyEntitySlice => {
    const profile = profileFromRow(row);
    const { name, nameSource } = displayName(row.core_name, profile);
    const status = profile?.statusCode.value ?? null;
    return {
      cui: row.cui,
      name,
      nameSource,
      legalForm: profile?.legalForm.value ?? null,
      headlineStatus: status === null ? null : compatStatus(status),
      vatPayer: row.is_vat_payer,
      declaredFiscallyInactive: row.is_inactive,
      registrationDate: profile?.recordedDate.value ?? null,
      registrationDatePresent: (profile?.recordedDate.value ?? null) !== null,
      territory: territoryOf(profile),
      latestFinancial:
        latestFin !== null ? mapFinancialYear(latestFin, qualificationReadable) : null,
      registryCuiState: cuiStateOf(scope, profile !== null),
      registry: scope,
      asOf: { onrc: onrcAsOf(scope), anaf: row.anaf_as_of },
    };
  };

  /**
   * Latest financial year per CUI in ONE query (DISTINCT ON walks
   * financials_pkey), with the same source and qualification as the profile.
   */
  const latestFinancialsByCui = async (
    cuis: readonly string[]
  ): Promise<{ rows: Map<string, FinancialRow>; qualificationReadable: boolean }> => {
    if (cuis.length === 0) return { qualificationReadable: false, rows: new Map() };
    const { rows, qualificationReadable } = await readStatements((capabilities) =>
      financialStatements(capabilities)
        .select('fin.cui')
        .where('fin.cui', 'in', [...cuis])
        .where('fin.privacy_class', '=', 'public')
        .distinctOn('fin.cui')
        .orderBy('fin.cui')
        .orderBy('fin.year', 'desc')
        .execute()
    );
    const out = new Map<string, FinancialRow>();
    for (const r of rows) out.set(r.cui, r);
    return { qualificationReadable, rows: out };
  };

  const profileSlicesForCuis = async (
    cuis: readonly string[],
    scope: CompanyRegistryEnvelope
  ): Promise<Result<ReadonlyMap<string, CompanyEntitySlice>, ApiError>> => {
    const normalized = [
      ...new Set(cuis.map((c) => normalizeCui(c)).filter((c): c is string => c !== null)),
    ];
    if (normalized.length === 0) return ok(new Map());
    try {
      const [rows, latest] = await Promise.all([
        readSpineRows(normalized, scope),
        latestFinancialsByCui(normalized),
      ]);
      const out = new Map<string, CompanyEntitySlice>();
      for (const row of rows.rows) {
        out.set(
          row.cui,
          sliceFromRow(row, scope, latest.rows.get(row.cui) ?? null, latest.qualificationReadable)
        );
      }
      return ok(out);
    } catch (error) {
      return err(databaseError('profileSlicesForCuis failed', error));
    }
  };

  const presenceCounts = async (
    rawCui: string,
    scope: CompanyRegistryEnvelope
  ): Promise<Result<CompanyPresenceCounts | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const spine = await readSpineRows([cui], scope);
      const row = spine.rows[0];
      if (row === undefined) return ok(null);
      const profile = profileFromRow(row);
      // The badge counts exactly what the profile lists: the same caen
      // observations and the same ANAF main activity through the same builder.
      const [fin, fiscal, caen] = await Promise.all([
        db
          .selectFrom('companies_v2.financials')
          .select(sql<string>`count(*)`.as('cnt'))
          .where('cui', '=', cui)
          .where('privacy_class', '=', 'public')
          .executeTakeFirst(),
        readFiscal(cui),
        isPublished(scope) && profile !== null
          ? readCaenObservations(db, scope.editionId, cui)
          : Promise.resolve({ rows: [], truncated: false }),
      ]);
      const { name, nameSource } = displayName(row.core_name, profile);
      const status = profile?.statusCode.value ?? null;
      return ok({
        cui,
        name,
        nameSource,
        registryCuiState: cuiStateOf(scope, profile !== null),
        headlineStatus: status === null ? null : compatStatus(status).label,
        financials: Number(fin?.cnt ?? 0),
        caenActivities: caenActivitiesOf(caen.rows, fiscal).length,
        representatives: 0,
        onrcAsOf: onrcAsOf(scope),
        anafAsOf: row.anaf_as_of,
      });
    } catch (error) {
      return err(databaseError('presenceCounts failed', error));
    }
  };

  const publishedEditions = async (scope: CompanyRegistryEnvelope) => {
    try {
      return ok(await readPublishedEditions(db, scope));
    } catch (error) {
      return err(databaseError('publishedEditions failed', error));
    }
  };

  return {
    captureRegistryScope: () => captureRegistryScope(db),
    confirmRegistryScope: (scope, cuis) => confirmRegistryScope(db, scope, cuis),
    getProfileData,
    getFinancials,
    getFinancialQualityAssessment,
    getRegistrationDiffData,
    listCompanies,
    countCompanies,
    resolveByName,
    findByRegistrationNumber,
    resolveCaen,
    resolveCounty,
    countBy,
    presenceCounts,
    profileSlicesForCuis,
    publishedEditions,
  };
};
