/**
 * PNRR module — repository over the live `pnrr.*` schema (plan §3).
 *
 * The ONLY place that reads `pnrr.*`. Reads through the kernel's typed Kysely
 * instance (`Kysely<ProdDatabase>` augmented by `shell/db/schema.ts`). Money is
 * cast `::text` at the SQL boundary (precision-safe strings, never floats); ids
 * stay strings. Cursor lists use the kernel envelope keyed on the collection's
 * sort tuple; the `fhash` binds the cursor to the active filter set (§14.3).
 *
 * Grain gate (§14.6): these are the authoritative PNRR-native facts (payments,
 * commitments, awards). They are NEVER summed across grains; cross-source flow
 * totals go through the kernel FlowsRepo, not here. PII (§8.2): no method selects
 * `announcement_contacts_private`, `is_personal_recipient`, `attrs`, or `*_raw`.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CollectionFilterSpec,
  type CursorPage,
  type FilterInput,
  type ProdDatabase,
  buildNextCursor,
  databaseError,
  decodeCursor,
  filterHash,
  fhashFor,
  invalidInput,
  isWithheldOrganizationIdentifier,
  normalizeCui,
  toConditionBuilders,
} from '@/modules/shared/index.js';

import {
  boolEq,
  eqValue,
  fieldOf,
  hasField,
  inValues,
  intEq,
  omitFields,
  requireDrivingPredicate,
  validateVirtualFilters,
} from './filter-helpers.js';
import {
  mapAcquisition,
  mapAnnouncement,
  mapCommitment,
  mapComponent,
  mapContractor,
  mapEntity,
  mapLot,
  mapMeasure,
  mapPayment,
  mapProgramIndicator,
  mapSnapshot,
  num,
  publicOrganizationIdentity,
  type CommitmentRow,
  type SnapshotRow,
} from './mappers.js';
import {
  pnrrAcquisitionsFilterSpec,
  pnrrCommitmentsFilterSpec,
  pnrrContractorsFilterSpec,
  pnrrEntitiesFilterSpec,
  pnrrMeasuresFilterSpec,
  pnrrPaymentsFilterSpec,
  pnrrProjectsFilterSpec,
  normalizePnrrFilter,
} from '../../core/filters.js';
import {
  PNRR_GRAIN_NOTE,
  type PnrrAcquisition,
  type PnrrAcquisitionDetail,
  type PnrrCommitment,
  type PnrrCommitmentSnapshot,
  type PnrrComponent,
  type PnrrContractor,
  type PnrrContractorRankBy,
  type PnrrContractorRankRow,
  type PnrrEntity,
  type PnrrEntityProfile,
  type PnrrFundingApplicationListing,
  type PnrrFundingCall,
  type PnrrCatalogResource,
  type PnrrDocumentReference,
  type PnrrMeasure,
  type PnrrAnalysisScope,
  type PnrrAnswerState,
  type PnrrAnswerMeta,
  type PnrrCapability,
  type PnrrLaneFreshness,
  type PnrrOverview,
  type PnrrPlaceProfile,
  type PnrrPlaceSummary,
  type PnrrProject,
  type PnrrProjectFacets,
  type PnrrRelease,
  type PnrrVerificationSummary,
  type PnrrPayment,
  type PnrrPaymentAggRow,
  type PnrrPaymentGroupBy,
  type PnrrProgramIndicator,
  type PnrrProgramRevision,
  type PnrrResolveDim,
  type PnrrResolveHit,
} from '../../core/types.js';

import type { CursorPageRequest, PnrrRepository } from '../../core/ports.js';
import type { PnrrProgressObservationsTable } from '../db/schema.js';

type Db = Kysely<ProdDatabase>;

const PROCUREMENT_VALUE_REASON = 'participant_allocation_unresolved';
const PNRR_CAPABILITY_IDS = [
  'overview',
  'projects',
  'organizations',
  'places',
  'verification',
  'program_revision',
  'procurement_money',
  'documents',
] as const;

const clampFirst = (first: number): number => Math.min(Math.max(Math.floor(first), 1), 100);

const releaseBoundFhash = (base: string, releaseId: string | undefined): string =>
  filterHash(JSON.stringify({ base, releaseId: releaseId ?? null }));

const sourcePageSetup = (
  page: CursorPageRequest,
  lane: string,
  releaseId: string | undefined
): Result<{ limit: number; fhash: string; after: string | null }, ApiError> => {
  const limit = clampFirst(page.first);
  const fhash = releaseBoundFhash(filterHash(lane), releaseId);
  if (page.after === undefined) return ok({ limit, fhash, after: null });
  const decoded = decodeCursor(page.after, { sort: 'source_key', dir: 'asc', fhash });
  if (decoded.isErr()) return err(decoded.error);
  return ok({ limit, fhash, after: decoded.value.keys[0] ?? null });
};

const finishSourcePage = <T>(
  rows: readonly T[],
  limit: number,
  fhash: string,
  keyOf: (row: T) => string
): CursorPage<T> => {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    next:
      hasMore && last !== undefined
        ? buildNextCursor({
            sort: 'source_key',
            dir: 'asc',
            fhash,
            lastKeys: [keyOf(last)],
          })
        : null,
  };
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

const projectSource = (useProjectV1: boolean) =>
  sql<PnrrProgressObservationsTable>`${sql.table(
    useProjectV1 ? 'pnrr.api_projects_v1' : 'pnrr.api_progress_current'
  )}`.as('p');

const MIPE_ENGAGEMENT_LOOKUP_PREFIX = 'mipe-engagement:';

const engagementIdFromProjectLookup = (key: string): string | null => {
  if (!key.startsWith(MIPE_ENGAGEMENT_LOOKUP_PREFIX)) return null;
  const engagementId = key.slice(MIPE_ENGAGEMENT_LOOKUP_PREFIX.length).trim();
  return engagementId.length > 0 && engagementId.length <= 128 ? engagementId : null;
};

/**
 * Keyset cursor predicate for `ORDER BY <dateCol> DESC NULLS LAST, <keyCol> DESC`.
 * The last row's date is encoded as `''` when NULL (the cursor null-section
 * sentinel). NULL-dated rows sort AFTER all dated rows, so:
 *  - non-null cursor (`cVal !== ''`): keep rows strictly after it, INCLUDING the
 *    trailing null-dated rows (`col IS NULL`), so the null section is reachable;
 *  - null cursor (`cVal === ''`): we are already inside the null section — keep
 *    only further null-dated rows by the key tiebreak.
 * `keyCol`/`dateCol` are trusted internal identifiers (not user input).
 */
const descNullsLastCursor = (
  dateCol: string,
  keyCol: string,
  cVal: string,
  cKey: string
): RawBuilder<unknown> => {
  const dc = sql.ref(dateCol);
  const kc = sql.ref(keyCol);
  if (cVal === '') return sql`(${dc} is null and ${kc} < ${cKey})`;
  return sql`(${dc} < ${cVal}::date or ${dc} is null or (${dc} = ${cVal}::date and ${kc} < ${cKey}))`;
};

/**
 * Build the kernel-composed conditions for the spec, after the repo has stripped
 * any virtual fields it handles itself. Returns the SQL fragment (TRUE if none).
 */
const kernelConditions = (
  spec: CollectionFilterSpec,
  input: FilterInput
): Result<RawBuilder<SqlBool>, ApiError> => {
  const built = toConditionBuilders(spec, input);
  if (built.isErr()) return err(built.error);
  return ok(composeWhere(built.value));
};

export const makePnrrRepo = (db: Db): PnrrRepository => {
  let projectV1Availability: Promise<boolean> | undefined;
  const hasProjectV1 = (): Promise<boolean> => {
    projectV1Availability ??= sql<{ available: boolean }>`
      select to_regclass('pnrr.api_projects_v1') is not null as available
    `
      .execute(db)
      .then((result) => result.rows[0]?.available === true)
      .catch(() => false);
    return projectV1Availability;
  };

  // ── identity spine ──────────────────────────────────────────────────────────

  /** Resolve `role`/`hub`/`hasNoHub` virtual entity filters into SQL fragments. */
  const entityVirtualConditions = (input: FilterInput): RawBuilder<unknown>[] => {
    const conds: RawBuilder<unknown>[] = [];
    const role = eqValue(fieldOf(input, 'role'));
    if (role !== undefined) {
      const col = {
        beneficiary: sql`e.is_beneficiary`,
        applicant: sql`e.is_applicant`,
        winner: sql`e.is_winner`,
        subcontractor: sql`e.is_subcontractor`,
      }[role];
      if (col !== undefined) conds.push(sql`${col} = true`);
    }
    const hubEq = eqValue(fieldOf(input, 'hub'));
    const hubIn = inValues(fieldOf(input, 'hub'));
    const hubs = hubIn ?? (hubEq !== undefined ? [hubEq] : undefined);
    if (hubs !== undefined && hubs.length > 0) {
      conds.push(
        sql`exists (select 1 from pnrr.entity_registry_links l where l.cui = e.cui and l.registry in (${sql.join(
          hubs.map((h) => sql`${h}`),
          sql`, `
        )}))`
      );
    }
    const hasNoHub = boolEq(fieldOf(input, 'hasNoHub'));
    if (hasNoHub === true) {
      conds.push(sql`not exists (select 1 from pnrr.entity_registry_links l where l.cui = e.cui)`);
    } else if (hasNoHub === false) {
      conds.push(sql`exists (select 1 from pnrr.entity_registry_links l where l.cui = e.cui)`);
    }
    return conds;
  };

  const listEntities = async (
    rawFilter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrEntity>, ApiError>> => {
    const normalized = normalizePnrrFilter(rawFilter);
    if (normalized.isErr()) return err(normalized.error);
    const f = normalized.value;
    // The directory is intentionally browsable unfiltered (cursor on the PK
    // `cui`, an index-ordered scan); we do NOT force a driving predicate here.
    // But virtual filters must still validate (a bad role/hub silently no-ops).
    const vv = validateVirtualFilters(f);
    if (vv.isErr()) return err(vv.error);
    const limit = clampFirst(page.first);
    const fhash = releaseBoundFhash(fhashFor(pnrrEntitiesFilterSpec, f), page.releaseId);
    const sortField = 'cui';
    let cursorKey: string | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: sortField, dir: 'asc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKey = decoded.value.keys[0];
    }

    // Virtual fields are intercepted; the rest go through the kernel composer.
    const physical = omitFields(f, ['role', 'hub', 'hasNoHub']);
    const kernel = kernelConditions(pnrrEntitiesFilterSpec, physical);
    if (kernel.isErr()) return err(kernel.error);
    const conds = [kernel.value, ...entityVirtualConditions(f), sql`e.cui ~ '^[0-9]{2,10}$'`];
    if (cursorKey !== undefined && cursorKey !== '') conds.push(sql`e.cui > ${cursorKey}`);

    try {
      const rows = await db
        .selectFrom('pnrr.entities as e')
        .select([
          'e.cui',
          'e.resolved_name',
          'e.name_source',
          'e.caen_code',
          'e.is_active',
          'e.is_vat_payer',
          'e.is_beneficiary',
          'e.is_applicant',
          'e.is_winner',
          'e.is_subcontractor',
          'e.first_seen_source',
          sql<
            string[]
          >`coalesce((select array_agg(distinct l.registry) from pnrr.entity_registry_links l where l.cui = e.cui), '{}')`.as(
            'hubs'
          ),
        ])
        .where(composeWhere(conds))
        .orderBy('e.cui', 'asc')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map(mapEntity);
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({ sort: sortField, dir: 'asc', fhash, lastKeys: [last.cui] });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listEntities failed', error));
    }
  };

  const getEntity = async (rawCui: string): Promise<Result<PnrrEntity | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    if (isWithheldOrganizationIdentifier(cui)) {
      return err(invalidInput('organization identifier is not publicly served', 'cui'));
    }
    try {
      const row = await db
        .selectFrom('pnrr.entities as e')
        .select([
          'e.cui',
          'e.resolved_name',
          'e.name_source',
          'e.caen_code',
          'e.is_active',
          'e.is_vat_payer',
          'e.is_beneficiary',
          'e.is_applicant',
          'e.is_winner',
          'e.is_subcontractor',
          'e.first_seen_source',
          sql<
            string[]
          >`coalesce((select array_agg(distinct l.registry) from pnrr.entity_registry_links l where l.cui = e.cui), '{}')`.as(
            'hubs'
          ),
        ])
        .where('e.cui', '=', cui)
        .limit(1)
        .executeTakeFirst();
      return ok(row !== undefined ? mapEntity(row) : null);
    } catch (error) {
      return err(databaseError('getEntity failed', error));
    }
  };

  const getEntityProfile = async (
    rawCui: string
  ): Promise<Result<PnrrEntityProfile | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    if (isWithheldOrganizationIdentifier(cui)) {
      return err(invalidInput('organization identifier is not publicly served', 'cui'));
    }
    try {
      const exists = await db
        .selectFrom('pnrr.entities as e')
        .select('e.cui')
        .where('e.cui', '=', cui)
        .limit(1)
        .executeTakeFirst();
      if (exists === undefined) return ok(null);

      const [pay, byComp, commit, acq, won] = await Promise.all([
        db
          .selectFrom('pnrr.api_payments as p')
          .select([
            sql<string>`count(*)`.as('cnt'),
            sql<string | null>`sum(p.amount_lei)::text`.as('total_lei'),
            sql<string | null>`sum(p.amount_eur)::text`.as('total_eur'),
            sql<
              string | null
            >`sum(p.amount_lei) filter (where p.payment_direction = 'disbursement')::text`.as(
              'gross_lei'
            ),
            sql<
              string | null
            >`(-sum(p.amount_lei) filter (where p.payment_direction = 'reversal'))::text`.as(
              'reversal_lei'
            ),
            sql<string>`count(*) filter (where p.payment_direction = 'zero_adjustment')`.as(
              'zero_cnt'
            ),
            sql<string | null>`min(p.payment_date)::text`.as('first_date'),
            sql<string | null>`max(p.payment_date)::text`.as('last_date'),
            sql<string | null>`max(p.retrieved_at)::text`.as('as_of'),
          ])
          .where('p.beneficiary_cui', '=', cui)
          .executeTakeFirst(),
        db
          .selectFrom('pnrr.api_payments as p')
          .select([
            'p.component_code',
            sql<string>`count(*)`.as('cnt'),
            sql<string | null>`sum(p.amount_lei)::text`.as('total_lei'),
          ])
          .where('p.beneficiary_cui', '=', cui)
          .groupBy('p.component_code')
          .orderBy(sql`sum(p.amount_lei) desc nulls last`)
          .execute(),
        db
          .selectFrom('pnrr.api_commitments as c')
          .select([
            sql<string>`count(*)`.as('cnt'),
            sql<string | null>`sum(c.total_value)::text`.as('total_value'),
            sql<string | null>`sum(c.eu_value)::text`.as('eu_value'),
            // Unresolved envelopes carry NULL money by the envelope law; the
            // count tells the consumer how much of `cnt` the sums do not cover.
            sql<string>`count(*) filter (where c.total_value is null)`.as('unresolved_cnt'),
            sql<string | null>`avg(c.financial_progress)::text`.as('avg_fin'),
            sql<string | null>`avg(c.physical_progress)::text`.as('avg_phy'),
          ])
          .where('c.beneficiary_cui', '=', cui)
          .executeTakeFirst(),
        db
          .selectFrom('pnrr.api_procurement_acquisitions as a')
          .select(sql<string>`count(*)`.as('cnt'))
          .where('a.beneficiary_cui', '=', cui)
          .executeTakeFirst(),
        db
          .selectFrom('pnrr.api_procurement_participants as ct')
          .select([
            sql<string>`count(*)`.as('cnt'),
            sql<string>`count(*) filter (where ct.role not in ('winning_bidder', 'foreign_winning_bidder', 'subcontractor', 'association_leader', 'third_party_support'))`.as(
              'unknown_cnt'
            ),
          ])
          .where('ct.contractor_cui', '=', cui)
          .executeTakeFirst(),
      ]);

      return ok({
        cui,
        payments: {
          count: Number(pay?.cnt ?? 0),
          totalLei: pay?.total_lei ?? null,
          totalEur: pay?.total_eur ?? null,
          grossLei: pay?.gross_lei ?? null,
          reversalLei: pay?.reversal_lei ?? null,
          zeroAdjustmentCount: Number(pay?.zero_cnt ?? 0),
          firstDate: pay?.first_date ?? null,
          lastDate: pay?.last_date ?? null,
          byComponent: byComp.map((r) => ({
            componentCode: r.component_code,
            count: Number(r.cnt),
            totalLei: r.total_lei,
          })),
        },
        commitments: {
          count: Number(commit?.cnt ?? 0),
          totalValue: commit?.total_value ?? null,
          euValue: commit?.eu_value ?? null,
          unresolvedCount: Number(commit?.unresolved_cnt ?? 0),
          avgFinancialProgress: num(commit?.avg_fin ?? null),
          avgPhysicalProgress: num(commit?.avg_phy ?? null),
        },
        procurement: {
          acquisitionsAsBeneficiary: Number(acq?.cnt ?? 0),
          acquisitionsValue: null,
          wonAsContractor: Number(won?.cnt ?? 0),
          wonValue: null,
          participantRelationCount: Number(won?.cnt ?? 0),
          unknownRelationshipCount: Number(won?.unknown_cnt ?? 0),
          participantValue: null,
          valueAggregationState: 'unavailable',
          valueReason: PROCUREMENT_VALUE_REASON,
        },
        grainNote: PNRR_GRAIN_NOTE,
        dataAsOf: pay?.as_of ?? null,
      });
    } catch (error) {
      return err(databaseError('getEntityProfile failed', error));
    }
  };

  // ── ledger ──────────────────────────────────────────────────────────────────

  /** Compile the `year` virtual field into a payment_date range condition. */
  const yearCondition = (input: FilterInput, col: string): RawBuilder<unknown> | undefined => {
    const year = intEq(fieldOf(input, 'year'));
    if (year === undefined) return undefined;
    const y = String(year);
    return sql`${sql.ref(col)} between ${`${y}-01-01`}::date and ${`${y}-12-31`}::date`;
  };

  const listPayments = async (
    rawFilter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrPayment>, ApiError>> => {
    const normalized = normalizePnrrFilter(rawFilter);
    if (normalized.isErr()) return err(normalized.error);
    const f = normalized.value;
    const vv = validateVirtualFilters(f);
    if (vv.isErr()) return err(vv.error);
    const driving = requireDrivingPredicate(
      f,
      ['beneficiaryCui', 'componentCode', 'measureFenix', 'paymentDate', 'year'],
      'beneficiaryCui / componentCode / measureFenix / paymentDate / year'
    );
    if (driving.isErr()) return err(driving.error);

    const limit = clampFirst(page.first);
    const fhash = releaseBoundFhash(fhashFor(pnrrPaymentsFilterSpec, f), page.releaseId);
    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'payment_date', dir: 'desc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const physical = omitFields(f, ['year']);
    const kernel = kernelConditions(pnrrPaymentsFilterSpec, physical);
    if (kernel.isErr()) return err(kernel.error);
    const conds: RawBuilder<unknown>[] = [kernel.value];
    const yc = yearCondition(f, 'p.payment_date');
    if (yc !== undefined) conds.push(yc);
    if (cursorKeys?.length === 2) {
      conds.push(
        descNullsLastCursor(
          'p.payment_date',
          'p.payment_key',
          cursorKeys[0] ?? '',
          cursorKeys[1] ?? ''
        )
      );
    }

    try {
      const rows = await db
        .selectFrom('pnrr.api_payments as p')
        .select([
          'p.payment_key',
          'p.beneficiary_cui',
          'p.beneficiary_name',
          'p.component_code',
          'p.measure_fenix',
          'p.measure_raw',
          sql<string | null>`p.amount_lei::text`.as('amount_lei'),
          sql<string | null>`p.amount_eur::text`.as('amount_eur'),
          'p.payment_direction',
          sql<string | null>`p.payment_date::text`.as('payment_date'),
          'p.county_name',
          'p.county_siruta',
          'p.locality_name',
          'p.caen_division',
          'p.financing_source',
          'p.source_system',
          sql<string | null>`p.retrieved_at::text`.as('retrieved_at'),
        ])
        .where(composeWhere(conds))
        .orderBy(sql`p.payment_date desc nulls last`)
        .orderBy('p.payment_key', 'desc')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map(mapPayment);
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: 'payment_date',
            dir: 'desc',
            fhash,
            lastKeys: [last.payment_date ?? '', last.payment_key],
          });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listPayments failed', error));
    }
  };

  const aggregatePayments = async (
    rawFilter: FilterInput,
    by: PnrrPaymentGroupBy
  ): Promise<Result<readonly PnrrPaymentAggRow[], ApiError>> => {
    const normalized = normalizePnrrFilter(rawFilter);
    if (normalized.isErr()) return err(normalized.error);
    const f = normalized.value;
    const vv = validateVirtualFilters(f);
    if (vv.isErr()) return err(vv.error);
    // Bounded: either an indexed driving predicate, or a paymentDate/year window.
    // `hasField` rejects empty `in: []` / `between: {}`, so a no-op filter can no
    // longer masquerade as a bound (review finding).
    const hasWindow = hasField(f, 'paymentDate') || hasField(f, 'year');
    const hasDriving =
      hasField(f, 'beneficiaryCui') || hasField(f, 'componentCode') || hasField(f, 'measureFenix');
    if (!hasWindow && !hasDriving) {
      return err(
        invalidInput(
          'aggregate needs a bounded window (paymentDate/year) or a driving predicate (beneficiaryCui/componentCode/measureFenix)',
          'filter'
        )
      );
    }

    const physical = omitFields(f, ['year']);
    const kernel = kernelConditions(pnrrPaymentsFilterSpec, physical);
    if (kernel.isErr()) return err(kernel.error);
    const conds: RawBuilder<unknown>[] = [kernel.value];
    const yc = yearCondition(f, 'p.payment_date');
    if (yc !== undefined) conds.push(yc);

    const groupExpr: RawBuilder<unknown> =
      by === 'component'
        ? sql`p.component_code`
        : by === 'measure'
          ? sql`p.measure_fenix`
          : by === 'county'
            ? sql`p.county_siruta`
            : sql`extract(year from p.payment_date)::int::text`;

    try {
      const rows = await db
        .selectFrom('pnrr.api_payments as p')
        .select([
          sql<string | null>`${groupExpr}`.as('key'),
          sql<string>`count(*)`.as('cnt'),
          sql<string | null>`sum(p.amount_lei)::text`.as('total_lei'),
          sql<string | null>`sum(p.amount_eur)::text`.as('total_eur'),
          sql<
            string | null
          >`sum(p.amount_lei) filter (where p.payment_direction = 'disbursement')::text`.as(
            'gross_lei'
          ),
          sql<
            string | null
          >`(-sum(p.amount_lei) filter (where p.payment_direction = 'reversal'))::text`.as(
            'reversal_lei'
          ),
          sql<string>`count(*) filter (where p.payment_direction = 'zero_adjustment')`.as(
            'zero_cnt'
          ),
        ])
        .where(composeWhere(conds))
        .groupBy(() => groupExpr)
        .orderBy(sql`sum(p.amount_lei) desc nulls last`)
        .limit(500)
        .execute();

      // Resolve a friendly label for component/county groups (cheap lookups).
      const labels = await resolveAggLabels(
        db,
        by,
        rows.map((r) => r.key)
      );
      return ok(
        rows.map((r) => ({
          key: r.key ?? '(none)',
          label: r.key !== null ? (labels.get(r.key) ?? null) : null,
          count: Number(r.cnt),
          totalLei: r.total_lei,
          totalEur: r.total_eur,
          grossLei: r.gross_lei,
          reversalLei: r.reversal_lei,
          zeroAdjustmentCount: Number(r.zero_cnt),
        }))
      );
    } catch (error) {
      return err(databaseError('aggregatePayments failed', error));
    }
  };

  // ── commitments ───────────────────────────────────────────────────────────────

  const listCommitments = async (
    rawFilter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrCommitment>, ApiError>> => {
    const normalized = normalizePnrrFilter(rawFilter);
    if (normalized.isErr()) return err(normalized.error);
    const f = normalized.value;

    const limit = clampFirst(page.first);
    const fhash = releaseBoundFhash(fhashFor(pnrrCommitmentsFilterSpec, f), page.releaseId);
    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'commitment_date', dir: 'desc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const kernel = kernelConditions(pnrrCommitmentsFilterSpec, f);
    if (kernel.isErr()) return err(kernel.error);
    const conds: RawBuilder<unknown>[] = [kernel.value];
    if (cursorKeys?.length === 2) {
      conds.push(
        descNullsLastCursor(
          'c.commitment_date',
          'c.commitment_key',
          cursorKeys[0] ?? '',
          cursorKeys[1] ?? ''
        )
      );
    }

    try {
      const rows = await db
        .selectFrom('pnrr.api_commitments as c')
        .select([
          'c.commitment_key',
          'c.beneficiary_cui',
          'c.beneficiary_name',
          'c.id_angajament',
          'c.contract_number',
          'c.contract_title',
          'c.component_code',
          'c.measure_code',
          sql<string | null>`c.total_value::text`.as('total_value'),
          sql<string | null>`c.eu_value::text`.as('eu_value'),
          sql<string | null>`c.national_public_value::text`.as('national_public_value'),
          sql<string | null>`c.vat_value::text`.as('vat_value'),
          sql<string | null>`c.ineligible_value::text`.as('ineligible_value'),
          sql<string | null>`c.financial_progress::text`.as('financial_progress'),
          sql<string | null>`c.physical_progress::text`.as('physical_progress'),
          sql<string | null>`c.commitment_date::text`.as('commitment_date'),
          sql<string | null>`c.start_date::text`.as('start_date'),
          sql<string | null>`c.end_date::text`.as('end_date'),
          'c.status',
          'c.county_name',
          'c.county_siruta',
          'c.locality_name',
          'c.source_system',
          'c.source_url',
          'c.aggregation_state',
          'c.envelope_observation_count',
          'c.quality_issues',
          'c.date_quality',
          sql<string | null>`c.reported_total_value::text`.as('reported_total_value'),
          sql<string | null>`c.reported_eu_value::text`.as('reported_eu_value'),
          sql<string | null>`c.retrieved_at::text`.as('retrieved_at'),
          sql<string>`(select count(*) from pnrr.api_commitment_snapshots s where s.commitment_key = c.commitment_key)`.as(
            'progress_count'
          ),
          sql<SnapshotRow | null>`(
            select jsonb_build_object(
              'snapshot_id', s.snapshot_id,
              'source_record_id', s.source_record_id,
              'snapshot_date', s.snapshot_date::text,
              'beneficiary_cui', s.beneficiary_cui,
              'contract_number', s.contract_number,
              'commitment_key', s.commitment_key,
              'link_confidence', s.link_confidence,
              'financial_progress', s.financial_progress::text,
              'physical_progress', s.physical_progress::text,
              'stage', s.stage,
              'received_eur', s.received_eur::text,
              'paid_eur', s.paid_eur::text,
              'allocated_eur', s.allocated_eur::text
            )
            from pnrr.api_commitment_snapshots s
            where s.commitment_key = c.commitment_key
            order by s.snapshot_date desc, s.snapshot_id desc, s.source_record_id desc
            limit 1
          )`.as('latest_progress'),
        ])
        .where(composeWhere(conds))
        .orderBy(sql`c.commitment_date desc nulls last`)
        .orderBy('c.commitment_key', 'desc')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((r) =>
        mapCommitment(r, r.latest_progress === null ? null : mapSnapshot(r.latest_progress))
      );
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: 'commitment_date',
            dir: 'desc',
            fhash,
            lastKeys: [last.commitment_date ?? '', last.commitment_key],
          });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listCommitments failed', error));
    }
  };

  const getCommitment = async (
    commitmentKey: string
  ): Promise<Result<PnrrCommitment | null, ApiError>> => {
    try {
      const result = await sql<CommitmentRow & { latest_progress: SnapshotRow | null }>`
        select
          c.commitment_key, c.beneficiary_cui, c.beneficiary_name,
          c.id_angajament, c.contract_number, c.contract_title,
          c.component_code, c.measure_code,
          c.total_value::text as total_value,
          c.eu_value::text as eu_value,
          c.national_public_value::text as national_public_value,
          c.vat_value::text as vat_value,
          c.ineligible_value::text as ineligible_value,
          c.financial_progress::text as financial_progress,
          c.physical_progress::text as physical_progress,
          c.commitment_date::text as commitment_date,
          c.start_date::text as start_date,
          c.end_date::text as end_date,
          c.status, c.county_name, c.county_siruta, c.locality_name,
          c.source_system, c.source_url, c.aggregation_state,
          c.envelope_observation_count, c.quality_issues, c.date_quality,
          c.reported_total_value::text as reported_total_value,
          c.reported_eu_value::text as reported_eu_value,
          c.retrieved_at::text as retrieved_at,
          (
            select count(*)::text
            from pnrr.api_commitment_snapshots s
            where s.commitment_key = c.commitment_key
          ) as progress_count,
          (
            select jsonb_build_object(
              'snapshot_id', s.snapshot_id,
              'source_record_id', s.source_record_id,
              'snapshot_date', s.snapshot_date::text,
              'beneficiary_cui', s.beneficiary_cui,
              'contract_number', s.contract_number,
              'commitment_key', s.commitment_key,
              'link_confidence', s.link_confidence,
              'financial_progress', s.financial_progress::text,
              'physical_progress', s.physical_progress::text,
              'stage', s.stage,
              'received_eur', s.received_eur::text,
              'paid_eur', s.paid_eur::text,
              'allocated_eur', s.allocated_eur::text
            )
            from pnrr.api_commitment_snapshots s
            where s.commitment_key = c.commitment_key
            order by s.snapshot_date desc, s.snapshot_id desc, s.source_record_id desc
            limit 1
          ) as latest_progress
        from pnrr.api_commitments c
        where c.commitment_key = ${commitmentKey}
        limit 1
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined) return ok(null);
      return ok(
        mapCommitment(row, row.latest_progress === null ? null : mapSnapshot(row.latest_progress))
      );
    } catch (error) {
      return err(databaseError('getCommitment failed', error));
    }
  };

  /** Resolve commitmentKey → bounded snapshots explicitly linked to that commitment. */
  const getCommitmentProgress = async (
    commitmentKey: string
  ): Promise<Result<readonly PnrrCommitmentSnapshot[], ApiError>> => {
    try {
      const commit = await db
        .selectFrom('pnrr.api_commitments as c')
        .select('c.commitment_key')
        .where('c.commitment_key', '=', commitmentKey)
        .limit(1)
        .executeTakeFirst();
      if (commit === undefined) return err(notFoundCommitment(commitmentKey));

      const rows = await db
        .selectFrom('pnrr.api_commitment_snapshots as s')
        .select(snapshotColumns())
        .where('s.commitment_key', '=', commit.commitment_key)
        .orderBy('s.snapshot_date', 'asc')
        .orderBy('s.snapshot_id', 'asc')
        .orderBy('s.source_record_id', 'asc')
        .limit(2000)
        .execute();
      return ok(rows.map(mapSnapshot));
    } catch (error) {
      return err(databaseError('getCommitmentProgress failed', error));
    }
  };

  interface ProjectRow {
    project_key_v1: string | null;
    project_key_version: string | null;
    observation_id: string;
    snapshot_id: string;
    snapshot_date: string;
    endpoint_name: string;
    item_key: string | null;
    commitment_business_id: string | null;
    contract_number: string | null;
    contract_title: string | null;
    beneficiary_cui: string | null;
    beneficiary_name: string | null;
    beneficiary_type: string | null;
    component_code: string | null;
    measure_raw: string | null;
    submeasure_raw: string | null;
    responsible_institution_code: string | null;
    responsible_institution_name: string | null;
    financing_source: string | null;
    commitment_date: string | null;
    start_date: string | null;
    end_date: string | null;
    last_funding_date: string | null;
    total_value: string | null;
    eu_value: string | null;
    national_public_value: string | null;
    vat_value: string | null;
    ineligible_value: string | null;
    received_amount_lei: string | null;
    allocated_eur: string | null;
    paid_eur: string | null;
    received_eur: string | null;
    prefinancing_eur: string | null;
    suspended_eur: string | null;
    revoked_eur: string | null;
    project_count: string | null;
    contract_beneficiary_count: string | null;
    payment_beneficiary_count: string | null;
    national_impact_project_count: string | null;
    payment_count: string | null;
    beneficiary_count: string | null;
    total_eur: string | null;
    total_ron: string | null;
    financial_progress: string | null;
    physical_progress: string | null;
    county_name: string | null;
    county_siruta: string | null;
    locality_name: string | null;
    impact_raw: string | null;
    timeline_month: string | null;
    timeline_label: string | null;
    status_raw: string | null;
    source_system: string;
    source_url: string;
    retrieved_at: string;
    linked_commitment_key: string | null;
    commitment_aggregation_state: string | null;
  }

  const projectSelect = [
    sql<string | null>`to_jsonb(p) ->> 'project_key_v1'`.as('project_key_v1'),
    sql<string | null>`to_jsonb(p) ->> 'project_key_version'`.as('project_key_version'),
    'p.observation_id',
    'p.snapshot_id',
    sql<string>`p.snapshot_date::text`.as('snapshot_date'),
    'p.endpoint_name',
    'p.item_key',
    'p.commitment_business_id',
    'p.contract_number',
    sql<string | null>`to_jsonb(p) ->> 'contract_title'`.as('contract_title'),
    'p.beneficiary_cui',
    'p.beneficiary_name',
    sql<string | null>`to_jsonb(p) ->> 'beneficiary_type'`.as('beneficiary_type'),
    'p.component_code',
    'p.measure_raw',
    'p.submeasure_raw',
    'p.responsible_institution_code',
    'p.responsible_institution_name',
    'p.financing_source',
    sql<string | null>`to_jsonb(p) ->> 'commitment_date'`.as('commitment_date'),
    sql<string | null>`to_jsonb(p) ->> 'start_date'`.as('start_date'),
    sql<string | null>`to_jsonb(p) ->> 'end_date'`.as('end_date'),
    sql<string | null>`to_jsonb(p) ->> 'last_funding_date'`.as('last_funding_date'),
    sql<string | null>`p.total_value::text`.as('total_value'),
    sql<string | null>`p.eu_value::text`.as('eu_value'),
    sql<string | null>`p.national_public_value::text`.as('national_public_value'),
    sql<string | null>`p.vat_value::text`.as('vat_value'),
    sql<string | null>`p.ineligible_value::text`.as('ineligible_value'),
    sql<string | null>`p.received_amount_lei::text`.as('received_amount_lei'),
    sql<string | null>`p.allocated_eur::text`.as('allocated_eur'),
    sql<string | null>`p.paid_eur::text`.as('paid_eur'),
    sql<string | null>`p.received_eur::text`.as('received_eur'),
    sql<string | null>`p.prefinancing_eur::text`.as('prefinancing_eur'),
    sql<string | null>`p.suspended_eur::text`.as('suspended_eur'),
    sql<string | null>`p.revoked_eur::text`.as('revoked_eur'),
    sql<string | null>`p.project_count::text`.as('project_count'),
    sql<string | null>`to_jsonb(p) ->> 'contract_beneficiary_count'`.as(
      'contract_beneficiary_count'
    ),
    sql<string | null>`to_jsonb(p) ->> 'payment_beneficiary_count'`.as('payment_beneficiary_count'),
    sql<string | null>`to_jsonb(p) ->> 'national_impact_project_count'`.as(
      'national_impact_project_count'
    ),
    sql<string | null>`to_jsonb(p) ->> 'payment_count'`.as('payment_count'),
    sql<string | null>`to_jsonb(p) ->> 'beneficiary_count'`.as('beneficiary_count'),
    sql<string | null>`to_jsonb(p) ->> 'total_eur'`.as('total_eur'),
    sql<string | null>`to_jsonb(p) ->> 'total_ron'`.as('total_ron'),
    sql<string | null>`p.financial_progress::text`.as('financial_progress'),
    sql<string | null>`p.physical_progress::text`.as('physical_progress'),
    'p.county_name',
    'p.county_siruta',
    'p.locality_name',
    sql<string | null>`to_jsonb(p) ->> 'impact_raw'`.as('impact_raw'),
    sql<string | null>`to_jsonb(p) ->> 'timeline_month'`.as('timeline_month'),
    sql<string | null>`to_jsonb(p) ->> 'timeline_label'`.as('timeline_label'),
    'p.status_raw',
    'p.source_system',
    'p.source_url',
    sql<string>`p.retrieved_at::text`.as('retrieved_at'),
    'c.commitment_key as linked_commitment_key',
    'c.aggregation_state as commitment_aggregation_state',
  ] as const;

  const mapProject = (row: ProjectRow): PnrrProject => {
    const beneficiary = publicOrganizationIdentity(row.beneficiary_cui, row.beneficiary_name);
    return {
      projectKey: row.project_key_v1 ?? row.observation_id,
      projectKeyVersion:
        row.project_key_version === 'project_key_v1' ? 'project_key_v1' : 'mipe_observation_v1',
      sourceObservationId: row.observation_id,
      snapshotId: row.snapshot_id,
      snapshotDate: row.snapshot_date,
      endpointName: row.endpoint_name,
      itemKey: row.item_key,
      commitmentBusinessId: row.commitment_business_id,
      contractNumber: row.contract_number,
      contractTitle: row.contract_title,
      beneficiaryCui: beneficiary.cui,
      beneficiaryName: beneficiary.name,
      beneficiaryType: row.beneficiary_type,
      componentCode: row.component_code,
      measureCode: row.measure_raw,
      submeasureCode: row.submeasure_raw,
      responsibleInstitutionCode: row.responsible_institution_code,
      responsibleInstitutionName: row.responsible_institution_name,
      financingSource: row.financing_source,
      commitmentDate: row.commitment_date,
      startDate: row.start_date,
      endDate: row.end_date,
      lastFundingDate: row.last_funding_date,
      totalValueRon: row.total_value,
      euContributionRon: row.eu_value,
      nationalPublicValueRon: row.national_public_value,
      vatRon: row.vat_value,
      ineligibleValueRon: row.ineligible_value,
      receivedAmountRon: row.received_amount_lei,
      allocatedEur: row.allocated_eur,
      paidEur: row.paid_eur,
      receivedEur: row.received_eur,
      prefinancingEur: row.prefinancing_eur,
      suspendedEur: row.suspended_eur,
      revokedEur: row.revoked_eur,
      projectCount: num(row.project_count),
      contractBeneficiaryCount: num(row.contract_beneficiary_count),
      paymentBeneficiaryCount: num(row.payment_beneficiary_count),
      nationalImpactProjectCount: num(row.national_impact_project_count),
      paymentCount: num(row.payment_count),
      beneficiaryCount: num(row.beneficiary_count),
      totalEur: row.total_eur,
      totalRon: row.total_ron,
      financialProgressRatio: num(row.financial_progress),
      physicalProgressRatio: num(row.physical_progress),
      countyName: row.county_name,
      countySiruta: row.county_siruta,
      localityName: row.locality_name,
      impact: row.impact_raw,
      timelineMonth: row.timeline_month,
      timelineLabel: row.timeline_label,
      status: row.status_raw,
      sourceSystem: row.source_system,
      sourceUrl: row.source_url,
      retrievedAt: row.retrieved_at,
      linkedCommitmentKey: row.linked_commitment_key,
      commitmentRelationship: row.linked_commitment_key === null ? null : 'candidate_project',
      commitmentAggregationState: row.commitment_aggregation_state,
    };
  };

  const listProjects = async (
    rawFilter: FilterInput,
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrProject>, ApiError>> => {
    const normalized = normalizePnrrFilter(rawFilter);
    if (normalized.isErr()) return err(normalized.error);
    const f = normalized.value;
    const limit = clampFirst(page.first);
    const fhash = releaseBoundFhash(
      fhashFor(pnrrProjectsFilterSpec, f),
      page.releaseId ?? releaseId
    );
    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'snapshot_date', dir: 'desc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }
    const kernel = kernelConditions(pnrrProjectsFilterSpec, f);
    if (kernel.isErr()) return err(kernel.error);
    const conds: RawBuilder<unknown>[] = [kernel.value, sql`p.record_kind = 'project_progress'`];
    if (cursorKeys?.length === 2) {
      conds.push(
        descNullsLastCursor(
          'p.snapshot_date',
          'p.observation_id',
          cursorKeys[0] ?? '',
          cursorKeys[1] ?? ''
        )
      );
    }
    try {
      const source = projectSource(await hasProjectV1());
      const rows = (await db
        .selectFrom(source)
        .leftJoin(
          'pnrr.api_commitments as c',
          'c.envelope_candidate_key_v1',
          'p.commitment_envelope_key_v1'
        )
        .select(projectSelect)
        .where(composeWhere(conds))
        .orderBy('p.snapshot_date', 'desc')
        .orderBy('p.observation_id', 'desc')
        .limit(limit + 1)
        .execute()) as readonly ProjectRow[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];
      return ok({
        items: pageRows.map(mapProject),
        next:
          hasMore && last !== undefined
            ? buildNextCursor({
                sort: 'snapshot_date',
                dir: 'desc',
                fhash,
                lastKeys: [last.snapshot_date, last.observation_id],
              })
            : null,
      });
    } catch (error) {
      return err(databaseError('listProjects failed', error));
    }
  };

  const getProject = async (key: string): Promise<Result<PnrrProject | null, ApiError>> => {
    try {
      const useProjectV1 = await hasProjectV1();
      const source = projectSource(useProjectV1);
      const engagementId = engagementIdFromProjectLookup(key);
      let query = db
        .selectFrom(source)
        .leftJoin(
          'pnrr.api_commitments as c',
          'c.envelope_candidate_key_v1',
          'p.commitment_envelope_key_v1'
        )
        .select(projectSelect)
        .where('p.record_kind', '=', 'project_progress');
      query =
        engagementId !== null
          ? query.where('p.commitment_business_id', '=', engagementId)
          : useProjectV1
            ? query.where(sql<boolean>`(p.project_key_v1 = ${key} or p.observation_id = ${key})`)
            : query.where('p.observation_id', '=', key);
      const row = (await query
        .orderBy('p.snapshot_date', 'desc')
        .orderBy('p.observation_id', 'asc')
        .limit(1)
        .executeTakeFirst()) as ProjectRow | undefined;
      return ok(row === undefined ? null : mapProject(row));
    } catch (error) {
      return err(databaseError('getProject failed', error));
    }
  };

  const getProjectFacets = async (
    rawFilter: FilterInput
  ): Promise<Result<PnrrProjectFacets, ApiError>> => {
    const normalized = normalizePnrrFilter(rawFilter);
    if (normalized.isErr()) return err(normalized.error);
    const kernel = kernelConditions(pnrrProjectsFilterSpec, normalized.value);
    if (kernel.isErr()) return err(kernel.error);
    const relation = (await hasProjectV1()) ? 'pnrr.api_projects_v1' : 'pnrr.api_progress_current';
    const where = sql`${kernel.value} and p.record_kind = 'project_progress'`;
    interface FacetRow {
      value: string;
      label: string | null;
      count: string;
    }
    try {
      const [total, components, measures, statuses, counties] = await Promise.all([
        sql<{ count: string }>`
          select count(*)::text as count
          from ${sql.table(relation)} p
          where ${where}
        `.execute(db),
        sql<FacetRow>`
          select p.component_code as value,
            max(cp.component_name) as label, count(*)::text as count
          from ${sql.table(relation)} p
          left join pnrr.components cp
            on cp.component_code = p.component_code
          where ${where} and p.component_code is not null
          group by p.component_code
          order by count(*) desc, p.component_code
        `.execute(db),
        sql<FacetRow>`
          select p.measure_raw as value, null::text as label,
            count(*)::text as count
          from ${sql.table(relation)} p
          where ${where} and p.measure_raw is not null
          group by p.measure_raw
          order by count(*) desc, p.measure_raw
        `.execute(db),
        sql<FacetRow>`
          select p.status_raw as value, p.status_raw as label,
            count(*)::text as count
          from ${sql.table(relation)} p
          where ${where} and p.status_raw is not null
          group by p.status_raw
          order by count(*) desc, p.status_raw
        `.execute(db),
        sql<FacetRow>`
          select p.county_siruta as value, max(p.county_name) as label,
            count(*)::text as count
          from ${sql.table(relation)} p
          where ${where} and p.county_siruta is not null
          group by p.county_siruta
          order by count(*) desc, p.county_siruta
        `.execute(db),
      ]);
      const mapFacet = (row: FacetRow) => ({
        value: row.value,
        label: row.label,
        count: Number(row.count),
      });
      return ok({
        totalCount: Number(total.rows[0]?.count ?? 0),
        components: components.rows.map(mapFacet),
        measures: measures.rows.map(mapFacet),
        statuses: statuses.rows.map(mapFacet),
        counties: counties.rows.map(mapFacet),
      });
    } catch (error) {
      return err(databaseError('getProjectFacets failed', error));
    }
  };

  const getProjectHistory = async (
    key: string
  ): Promise<Result<readonly PnrrProject[], ApiError>> => {
    try {
      const useProjectV1 = await hasProjectV1();
      const source = projectSource(useProjectV1);
      const engagementId = engagementIdFromProjectLookup(key);
      let currentQuery = db
        .selectFrom(source)
        .select([
          'p.endpoint_name',
          'p.item_key',
          'p.beneficiary_cui',
          'p.commitment_business_id',
          sql<string | null>`to_jsonb(p) ->> 'project_key_v1'`.as('project_key_v1'),
          sql<string | null>`to_jsonb(p) ->> 'project_key_version'`.as('project_key_version'),
        ])
        .where('p.record_kind', '=', 'project_progress');
      currentQuery =
        engagementId !== null
          ? currentQuery.where('p.commitment_business_id', '=', engagementId)
          : useProjectV1
            ? currentQuery.where(
                sql<boolean>`(p.project_key_v1 = ${key} or p.observation_id = ${key})`
              )
            : currentQuery.where('p.observation_id', '=', key);
      const current = await currentQuery
        .orderBy('p.snapshot_date', 'desc')
        .orderBy('p.observation_id', 'asc')
        .limit(1)
        .executeTakeFirst();
      if (current === undefined) return ok([]);
      if (current.item_key === null) {
        const project = await getProject(key);
        return project.isErr()
          ? err(project.error)
          : ok(project.value === null ? [] : [project.value]);
      }
      const rows = (await db
        .selectFrom('pnrr.progress_observations as p')
        .leftJoin(
          'pnrr.api_commitments as c',
          'c.envelope_candidate_key_v1',
          'p.commitment_envelope_key_v1'
        )
        .select(projectSelect)
        .where('p.privacy_class', '=', 'public')
        .where('p.record_kind', '=', 'project_progress')
        .where('p.endpoint_name', '=', current.endpoint_name)
        .where('p.item_key', '=', current.item_key)
        .where(sql<boolean>`p.beneficiary_cui is not distinct from ${current.beneficiary_cui}`)
        .where(
          sql<boolean>`p.commitment_business_id is not distinct from ${current.commitment_business_id}`
        )
        .orderBy('p.snapshot_date', 'asc')
        .orderBy('p.observation_id', 'asc')
        .limit(2000)
        .execute()) as readonly ProjectRow[];
      return ok(
        rows.map((row) =>
          mapProject({
            ...row,
            project_key_v1: current.project_key_v1,
            project_key_version: current.project_key_version,
          })
        )
      );
    } catch (error) {
      return err(databaseError('getProjectHistory failed', error));
    }
  };

  const listProgramIndicators = async (): Promise<
    Result<readonly PnrrProgramIndicator[], ApiError>
  > => {
    try {
      const rows = await db
        .selectFrom('pnrr.program_indicators as pi')
        .select([
          'pi.snapshot_id',
          sql<string>`pi.snapshot_date::text`.as('snapshot_date'),
          'pi.nr_projects',
          sql<string | null>`pi.allocated_eur::text`.as('allocated_eur'),
          sql<string | null>`pi.received_eur::text`.as('received_eur'),
          sql<string | null>`pi.paid_eur::text`.as('paid_eur'),
        ])
        .orderBy('pi.snapshot_date', 'asc')
        .execute();
      return ok(rows.map(mapProgramIndicator));
    } catch (error) {
      return err(databaseError('listProgramIndicators failed', error));
    }
  };

  const listFundingCalls = async (
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrFundingCall>, ApiError>> => {
    const setup = sourcePageSetup(page, 'funding_calls', page.releaseId ?? releaseId);
    if (setup.isErr()) return err(setup.error);
    const { limit, fhash, after } = setup.value;
    try {
      const result = await sql<{
        call_id: string;
        call_title: string;
        budget_ron: string | null;
        total_eligible_value_ron: string | null;
        source_system: string;
        source_url: string;
        retrieved_at: string;
      }>`
        select call_id, call_title,
          budget_lei::text as budget_ron,
          total_eligible_value_lei::text as total_eligible_value_ron,
          source_system, source_url, retrieved_at::text
        from pnrr.api_funding_calls
        where (${after}::text is null or call_id > ${after})
        order by call_id
        limit ${limit + 1}
      `.execute(db);
      return ok(
        finishSourcePage(
          result.rows.map((row) => ({
            callId: row.call_id,
            title: row.call_title,
            budgetRon: row.budget_ron,
            totalEligibleValueRon: row.total_eligible_value_ron,
            sourceSystem: row.source_system,
            sourceUrl: row.source_url,
            retrievedAt: row.retrieved_at,
          })),
          limit,
          fhash,
          (row) => row.callId
        )
      );
    } catch (error) {
      return err(databaseError('listFundingCalls failed', error));
    }
  };

  const listFundingApplicationListings = async (
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrFundingApplicationListing>, ApiError>> => {
    const setup = sourcePageSetup(
      page,
      'funding_application_listings',
      page.releaseId ?? releaseId
    );
    if (setup.isErr()) return err(setup.error);
    const { limit, fhash, after } = setup.value;
    try {
      const result = await sql<{
        listing_id: string;
        listing_candidate_key_v1: string;
        call_id: string | null;
        source_request_call_id: string | null;
        applicant_cui: string | null;
        applicant_name: string | null;
        sent_at: string | null;
        order_number: string | null;
        completeness_status: string;
        source_system: string;
        source_url: string;
        retrieved_at: string;
      }>`
        select listing_id, listing_candidate_key_v1, call_id,
          source_request_call_id,
          case when applicant_cui ~ '^[0-9]{1,10}$'
            then applicant_cui end as applicant_cui,
          case when applicant_cui is null or applicant_cui ~ '^[0-9]{1,10}$'
            then applicant_name end as applicant_name,
          sent_at::text, order_number, completeness_status,
          source_system, source_url, retrieved_at::text
        from pnrr.api_funding_application_listings
        where (${after}::text is null or listing_id > ${after})
        order by listing_id
        limit ${limit + 1}
      `.execute(db);
      return ok(
        finishSourcePage(
          result.rows.map((row) => ({
            listingId: row.listing_id,
            listingCandidateKey: row.listing_candidate_key_v1,
            callId: row.call_id,
            sourceRequestCallId: row.source_request_call_id,
            applicantCui: row.applicant_cui,
            applicantName: row.applicant_name,
            sentAt: row.sent_at,
            orderNumber: row.order_number,
            completenessStatus: row.completeness_status,
            sourceSystem: row.source_system,
            sourceUrl: row.source_url,
            retrievedAt: row.retrieved_at,
          })),
          limit,
          fhash,
          (row) => row.listingId
        )
      );
    } catch (error) {
      return err(databaseError('listFundingApplicationListings failed', error));
    }
  };

  const listProgramRevisions = async (
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrProgramRevision>, ApiError>> => {
    const setup = sourcePageSetup(page, 'program_revisions', page.releaseId ?? releaseId);
    if (setup.isErr()) return err(setup.error);
    const { limit, fhash, after } = setup.value;
    try {
      const result = await sql<{
        revision_id: string;
        identifier_scheme: string;
        legal_reference: string;
        celex: string | null;
        legal_status: string;
        is_current_adopted: boolean;
        effective_date: string | null;
        source_authority: string;
        source_url: string;
        document_count: string;
        text_ready_document_count: string;
        ocr_required_document_count: string;
      }>`
        select r.revision_id, r.identifier_scheme, r.legal_reference, r.celex,
          r.legal_status, r.is_current_adopted, r.effective_date::text,
          r.source_authority, r.source_url,
          count(d.document_id)::text as document_count,
          count(*) filter (
            where d.text_extraction_status in ('text_ready', 'ocr_ready')
          )::text as text_ready_document_count,
          count(*) filter (
            where d.text_extraction_status = 'ocr_required'
          )::text as ocr_required_document_count
        from pnrr.program_revisions r
        left join pnrr.program_documents d
          on d.revision_id = r.revision_id and d.privacy_class = 'public'
        where r.privacy_class = 'public'
          and (${after}::text is null or r.revision_id > ${after})
        group by r.revision_id
        order by r.revision_id
        limit ${limit + 1}
      `.execute(db);
      return ok(
        finishSourcePage(
          result.rows.map((row) => ({
            revisionId: row.revision_id,
            identifierScheme: row.identifier_scheme,
            legalReference: row.legal_reference,
            celex: row.celex,
            legalStatus: row.legal_status,
            isCurrentAdopted: row.is_current_adopted,
            effectiveDate: row.effective_date,
            sourceAuthority: row.source_authority,
            sourceUrl: row.source_url,
            documentCount: Number(row.document_count),
            textReadyDocumentCount: Number(row.text_ready_document_count),
            ocrRequiredDocumentCount: Number(row.ocr_required_document_count),
          })),
          limit,
          fhash,
          (row) => row.revisionId
        )
      );
    } catch (error) {
      return err(databaseError('listProgramRevisions failed', error));
    }
  };

  const listCatalogResources = async (
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrCatalogResource>, ApiError>> => {
    const setup = sourcePageSetup(page, 'catalog_resources', page.releaseId ?? releaseId);
    if (setup.isErr()) return err(setup.error);
    const { limit, fhash, after } = setup.value;
    try {
      const result = await sql<{
        resource_id: string;
        package_id: string | null;
        resource_name: string | null;
        format: string | null;
        mimetype: string | null;
        datastore_active: boolean | null;
        file_url: string | null;
        last_modified: string | null;
        declared_hash: string | null;
        source_system: string;
        source_url: string;
        retrieved_at: string;
      }>`
        select resource_id, package_id, resource_name, format, mimetype,
          datastore_active, file_url, last_modified::text, declared_hash,
          source_system, source_url, retrieved_at::text
        from pnrr.api_catalog_resources
        where (${after}::text is null or resource_id > ${after})
        order by resource_id
        limit ${limit + 1}
      `.execute(db);
      return ok(
        finishSourcePage(
          result.rows.map((row) => ({
            resourceId: row.resource_id,
            packageId: row.package_id,
            resourceName: row.resource_name,
            format: row.format,
            mimeType: row.mimetype,
            datastoreActive: row.datastore_active,
            fileUrl: row.file_url,
            lastModified: row.last_modified,
            declaredHash: row.declared_hash,
            sourceSystem: row.source_system,
            sourceUrl: row.source_url,
            retrievedAt: row.retrieved_at,
          })),
          limit,
          fhash,
          (row) => row.resourceId
        )
      );
    } catch (error) {
      return err(databaseError('listCatalogResources failed', error));
    }
  };

  const listDocumentReferences = async (
    page: CursorPageRequest,
    releaseId?: string
  ): Promise<Result<CursorPage<PnrrDocumentReference>, ApiError>> => {
    const setup = sourcePageSetup(page, 'document_references', page.releaseId ?? releaseId);
    if (setup.isErr()) return err(setup.error);
    const { limit, fhash, after } = setup.value;
    try {
      const result = await sql<{
        document_key: string;
        acquisition_key: string | null;
        lot_key: string | null;
        announcement_key: string | null;
        program_revision_id: string | null;
        language: string | null;
        document_role: string | null;
        file_name: string | null;
        mime_type: string | null;
        document_type: string | null;
        source_url: string;
        retrieved_at: string | null;
        content_sha256: string | null;
        extraction_state: string;
        has_object_custody: boolean;
      }>`
        select document_key, acquisition_key, lot_key, announcement_key,
          program_revision_id, language, document_role, file_name, mime_type,
          document_type, source_url, retrieved_at::text, content_sha256,
          extraction_state, has_object_custody
        from pnrr.api_document_references
        where (${after}::text is null or document_key > ${after})
        order by document_key
        limit ${limit + 1}
      `.execute(db);
      return ok(
        finishSourcePage(
          result.rows.map((row) => ({
            documentKey: row.document_key,
            acquisitionKey: row.acquisition_key,
            lotKey: row.lot_key,
            announcementKey: row.announcement_key,
            programRevisionId: row.program_revision_id,
            language: row.language,
            documentRole: row.document_role,
            fileName: row.file_name,
            mimeType: row.mime_type,
            documentType: row.document_type,
            sourceUrl: row.source_url,
            retrievedAt: row.retrieved_at,
            contentSha256: row.content_sha256,
            extractionState: row.extraction_state,
            hasObjectCustody: row.has_object_custody,
          })),
          limit,
          fhash,
          (row) => row.documentKey
        )
      );
    } catch (error) {
      return err(databaseError('listDocumentReferences failed', error));
    }
  };

  const getCurrentRelease = async (): Promise<Result<PnrrRelease, ApiError>> => {
    try {
      const manifestRelation = await sql<{ available: boolean }>`
        select to_regclass('etl.pnrr_releases') is not null as available
      `.execute(db);
      if (manifestRelation.rows[0]?.available === true) {
        const manifest = await sql<{
          release_id: string;
          source_run_id: string;
          release_kind: 'operational_snapshot' | 'backfill' | 'corrective';
          source_snapshot_at: string;
          activated_at: string | null;
          warnings: unknown;
        }>`
          select release_id, source_run_id, release_kind, source_snapshot_at::text,
            activated_at::text, warnings
          from etl.pnrr_releases
          where release_state = 'active'
          order by activated_at desc nulls last, release_id desc
          limit 1
        `.execute(db);
        const active = manifest.rows[0];
        const latestPromotion = await sql<{
          run_id: string;
          source_snapshot_at: string;
          finished_at: string | null;
        }>`
          select run_id, source_snapshot_at::text, finished_at::text
          from etl.pnrr_projection_v2_runs
          where promoted_at is not null
          order by promoted_at desc, run_id desc
          limit 1
        `.execute(db);
        const promoted = latestPromotion.rows[0];
        if (active === undefined) {
          return ok({
            releaseId: 'pnrr-no-active-release',
            releaseKind: 'operational_snapshot',
            state: 'abstained',
            sourceSnapshotAt: promoted?.source_snapshot_at ?? null,
            completedAt: promoted?.finished_at ?? null,
            lanes: [
              {
                lane: 'release-manifest',
                state: 'abstained',
                asOf: promoted?.source_snapshot_at ?? null,
                suspended: true,
                reasonCodes: ['no_active_release'],
              },
            ],
            limitation:
              'Release manifests exist, but no generation has been explicitly activated for serving.',
          });
        }
        if (promoted === undefined) {
          return ok({
            releaseId: active.release_id,
            releaseKind: active.release_kind,
            state: 'abstained',
            sourceSnapshotAt: active.source_snapshot_at,
            completedAt: active.activated_at,
            lanes: [
              {
                lane: 'release-manifest',
                state: 'abstained',
                asOf: null,
                suspended: true,
                reasonCodes: ['promotion_generation_unverifiable'],
              },
            ],
            limitation:
              'The active manifest cannot be matched to a promoted projection generation.',
          });
        }
        if (promoted.run_id !== active.source_run_id) {
          return ok({
            releaseId: active.release_id,
            releaseKind: active.release_kind,
            state: 'abstained',
            sourceSnapshotAt: active.source_snapshot_at,
            completedAt: active.activated_at,
            lanes: [
              {
                lane: 'release-manifest',
                state: 'abstained',
                asOf: promoted.source_snapshot_at,
                suspended: true,
                reasonCodes: ['active_release_generation_mismatch'],
              },
            ],
            limitation:
              'Served PNRR tables were promoted after the active release; facts are withheld until that generation is validated and activated.',
          });
        }
        const laneResult = await sql<{
          lane: string;
          capability_state: 'served' | 'degraded' | 'abstained';
          as_of: string | null;
          suspended: boolean;
          warnings: unknown;
        }>`
            select lane, capability_state, as_of::text, suspended, warnings
            from etl.pnrr_release_lanes
            where release_id = ${active.release_id}
            order by lane
          `.execute(db);
        const lanes: readonly PnrrLaneFreshness[] = laneResult.rows.map((lane) => ({
          lane: lane.lane,
          state:
            lane.suspended && lane.capability_state === 'served'
              ? 'degraded'
              : lane.capability_state,
          asOf: lane.as_of,
          suspended: lane.suspended,
          reasonCodes: [
            ...stringArray(lane.warnings),
            ...(lane.suspended ? ['refresh_suspended'] : []),
          ],
        }));
        if (lanes.length === 0) {
          return ok({
            releaseId: active.release_id,
            releaseKind: active.release_kind,
            state: 'abstained',
            sourceSnapshotAt: active.source_snapshot_at,
            completedAt: active.activated_at,
            lanes: [
              {
                lane: 'release-manifest',
                state: 'abstained',
                asOf: active.source_snapshot_at,
                suspended: true,
                reasonCodes: ['release_lane_manifest_empty'],
              },
            ],
            limitation: 'The active release has no lane manifest, so its facts cannot be verified.',
          });
        }
        const state: PnrrAnswerState = lanes.some(
          (lane) => lane.state === 'degraded' || lane.state === 'abstained'
        )
          ? 'degraded'
          : 'served';
        const activeWarnings = stringArray(active.warnings).join('; ');
        return ok({
          releaseId: active.release_id,
          releaseKind: active.release_kind,
          state,
          sourceSnapshotAt: active.source_snapshot_at,
          completedAt: active.activated_at,
          lanes,
          limitation:
            activeWarnings !== ''
              ? activeWarnings
              : 'Atomic release manifest with lane-specific counts and digests.',
        });
      }

      const releaseResult = await sql<{
        run_id: string;
        status: string;
        source_snapshot_at: string;
        finished_at: string | null;
      }>`
        select run_id, status, source_snapshot_at::text, finished_at::text
        from etl.pnrr_projection_v2_runs
        where promoted_at is not null
        order by promoted_at desc, run_id desc
        limit 1
      `.execute(db);
      const policyResult = await sql<{
        lane: string;
        suspended: boolean;
        suspend_reason: string | null;
        updated_at: string | null;
      }>`
        select lane, suspended, suspend_reason, updated_at::text
        from etl.sync_policy
        where source_id = 'pnrr'
        order by lane
      `.execute(db);

      const run = releaseResult.rows[0];
      const noRelease = run === undefined;
      const unsafePromotedGeneration = run !== undefined && run.status !== 'succeeded';
      const projectionPolicy = policyResult.rows.find((row) => row.lane === 'projection-v2');
      const lanes: PnrrLaneFreshness[] = [
        {
          lane: 'projection-v2',
          state: noRelease || unsafePromotedGeneration ? 'abstained' : 'degraded',
          asOf: run?.source_snapshot_at ?? null,
          suspended: projectionPolicy?.suspended ?? true,
          reasonCodes: [
            'release_manifest_incomplete',
            ...(unsafePromotedGeneration ? ['latest_promoted_generation_not_successful'] : []),
            ...(run?.status === 'promoted_validation_failed' ? ['promoted_validation_failed'] : []),
            ...(projectionPolicy?.suspended !== false ? ['refresh_suspended'] : []),
          ],
        },
        {
          lane: 'legacy-procurement',
          state: 'legacy_unversioned',
          asOf: null,
          suspended: true,
          reasonCodes: ['legacy_unversioned', 'procurement_money_abstained'],
        },
        {
          lane: 'documents',
          state: 'abstained',
          asOf: null,
          suspended: true,
          reasonCodes: ['document_extraction_not_activated'],
        },
      ];

      return ok({
        releaseId: run?.run_id ?? 'pnrr-no-successful-release',
        releaseKind: 'operational_snapshot',
        state: noRelease || unsafePromotedGeneration ? 'abstained' : 'degraded',
        sourceSnapshotAt: run?.source_snapshot_at ?? null,
        completedAt: run?.finished_at ?? null,
        lanes,
        limitation: unsafePromotedGeneration
          ? 'The latest promoted projection did not complete validation; PNRR facts are withheld.'
          : 'Operational loader completion only: per-lane immutable counts and digests are not yet preserved as an atomic release manifest.',
      });
    } catch (error) {
      return err(databaseError('getCurrentRelease failed', error));
    }
  };

  const getCapabilities = async (): Promise<Result<readonly PnrrCapability[], ApiError>> => {
    const release = await getCurrentRelease();
    if (release.isErr()) return err(release.error);
    if (release.value.state === 'abstained') {
      const reasonCodes = release.value.lanes.flatMap((lane) => lane.reasonCodes);
      return ok(
        PNRR_CAPABILITY_IDS.map((id) => ({
          id,
          releaseId: release.value.releaseId,
          state: 'abstained' as const,
          reasonCodes,
          limitation: release.value.limitation,
        }))
      );
    }
    if (release.value.releaseId.startsWith('pnrr-release-v1:')) {
      try {
        const result = await sql<{
          capability: string;
          capability_state: 'served' | 'degraded' | 'abstained';
          reason_codes: string[];
          limitation: string | null;
        }>`
          select capability, capability_state, reason_codes, limitation
          from etl.pnrr_release_capabilities
          where release_id = ${release.value.releaseId}
          order by capability
        `.execute(db);
        const byId = new Map(result.rows.map((row) => [row.capability, row]));
        const declared = PNRR_CAPABILITY_IDS.map((id): PnrrCapability => {
          const row = byId.get(id);
          if (row === undefined) {
            return {
              id,
              releaseId: release.value.releaseId,
              state: 'abstained',
              reasonCodes: ['capability_not_declared_for_release'],
              limitation:
                'This capability is absent from the active release manifest and is withheld.',
            };
          }
          return {
            id: row.capability,
            releaseId: release.value.releaseId,
            state: row.capability_state,
            reasonCodes: row.reason_codes,
            limitation: row.limitation,
          };
        });
        const additional = result.rows
          .filter(
            (row) =>
              !PNRR_CAPABILITY_IDS.includes(row.capability as (typeof PNRR_CAPABILITY_IDS)[number])
          )
          .map(
            (row): PnrrCapability => ({
              id: row.capability,
              releaseId: release.value.releaseId,
              state: row.capability_state,
              reasonCodes: row.reason_codes,
              limitation: row.limitation,
            })
          );
        return ok(
          [...declared, ...additional].sort((left, right) => left.id.localeCompare(right.id))
        );
      } catch (error) {
        return err(databaseError('getCapabilities manifest read failed', error));
      }
    }
    // Global abstention returned above; this branch describes a legacy,
    // non-manifest release that is queryable only in degraded mode.
    return ok([
      {
        id: 'overview',
        releaseId: release.value.releaseId,
        state: 'degraded',
        reasonCodes: ['release_manifest_incomplete', 'payment_duplicate_review_pending'],
        limitation:
          'Facts are source-separated; payment totals remain degraded pending duplicate review.',
      },
      {
        id: 'projects',
        releaseId: release.value.releaseId,
        state: 'degraded',
        reasonCodes: ['release_scoped_observation_key', 'project_membership_not_persisted'],
        limitation:
          'The route key is the current MIPE observation id until durable project_key_v1 membership is loaded.',
      },
      {
        id: 'organizations',
        releaseId: release.value.releaseId,
        state: 'degraded',
        reasonCodes: ['aliases_incomplete'],
        limitation:
          'CUI identity is authoritative; source aliases are not yet a complete versioned set.',
      },
      {
        id: 'places',
        releaseId: release.value.releaseId,
        state: 'degraded',
        reasonCodes: ['uat_inferred_count_only'],
        limitation: 'County facts are source-role-qualified; inferred UAT is count-only.',
      },
      {
        id: 'verification',
        releaseId: release.value.releaseId,
        state: 'degraded',
        reasonCodes: ['verification_rules_runtime_v1'],
        limitation:
          'Deterministic quality checks are served; review decisions are not written here.',
      },
      {
        id: 'program_revision',
        releaseId: release.value.releaseId,
        state: 'degraded',
        reasonCodes: ['current_adopted_items_incomplete', 'newer_council_amendment_pending'],
        limitation:
          'Revision and document metadata are served. The current adopted annex is not yet available as extracted items, and a newer Council amendment remains pending.',
      },
      {
        id: 'procurement_money',
        releaseId: release.value.releaseId,
        state: 'abstained',
        reasonCodes: ['participant_allocation_unresolved'],
        limitation: 'Counts, roles and evidence are available; additive money is not.',
      },
      {
        id: 'documents',
        releaseId: release.value.releaseId,
        state: 'degraded',
        reasonCodes: ['metadata_only', 'document_extraction_not_activated'],
        limitation:
          'Public document metadata and custody state are available; extracted text and claims remain unavailable.',
      },
    ]);
  };

  const answerMeta = (
    scope: PnrrAnalysisScope,
    release: PnrrRelease,
    coverage: PnrrAnswerMeta['coverage'],
    reasonCodes: readonly string[] = []
  ): PnrrAnswerMeta => ({
    scope,
    state: release.state,
    reasonCodes:
      release.releaseId === 'pnrr-no-successful-release'
        ? ['no_successful_projection_release', ...reasonCodes]
        : release.releaseId.startsWith('pnrr-release-v1:')
          ? reasonCodes
          : ['release_manifest_incomplete', ...reasonCodes],
    coverage,
    release,
    caveats: [
      'Payments, commitments and program indicators are different grains and are never summed.',
      'RON and EUR values remain source-native and are never converted by the API.',
      'The operational release does not yet provide historical release querying.',
    ],
    provenance: ['pnrr.api_payments', 'pnrr.api_commitments', 'pnrr.api_progress_current'],
  });

  const percent = (covered: number, total: number): number | null =>
    total === 0 ? null : Math.round((covered / total) * 10_000) / 100;

  const getOverview = async (scope: PnrrAnalysisScope): Promise<Result<PnrrOverview, ApiError>> => {
    const release = await getCurrentRelease();
    if (release.isErr()) return err(release.error);
    try {
      const result = await sql<{
        indicator_snapshot_date: string | null;
        indicator_project_count: number | null;
        allocation_eur: string | null;
        received_eur: string | null;
        paid_eur: string | null;
        payment_count: string;
        payment_net_ron: string | null;
        payment_gross_ron: string | null;
        payment_reversal_ron: string | null;
        payment_first_date: string | null;
        payment_last_date: string | null;
        commitment_count: string;
        additive_commitment_count: string;
        unresolved_commitment_count: string;
        additive_commitment_ron: string | null;
        progress_total_count: string;
        progress_observed_count: string;
        progress_completed_count: string;
        progress_over_hundred_count: string;
        missing_financial_progress_count: string;
        missing_physical_progress_count: string;
      }>`
        with latest_indicator as (
          select snapshot_date, project_count::integer as nr_projects,
            allocated_eur, received_eur, paid_eur
          from pnrr.api_progress_current
          where record_kind = 'aggregate_indicator'
          order by snapshot_date desc
          limit 1
        ), payment_stats as (
          select count(*) as payment_count,
            sum(amount_lei)::text as payment_net_ron,
            sum(amount_lei) filter (where payment_direction = 'disbursement')::text
              as payment_gross_ron,
            (-sum(amount_lei) filter (where payment_direction = 'reversal'))::text
              as payment_reversal_ron,
            min(payment_date)::text as payment_first_date,
            max(payment_date)::text as payment_last_date
          from pnrr.api_payments p
          where (${scope.componentCode}::text is null or p.component_code = ${scope.componentCode})
            and (${scope.beneficiaryCui}::text is null or p.beneficiary_cui = ${scope.beneficiaryCui})
            and (${scope.countySiruta}::text is null or p.county_siruta = ${scope.countySiruta})
            and (${scope.from}::date is null or p.payment_date >= ${scope.from}::date)
            and (${scope.to}::date is null or p.payment_date <= ${scope.to}::date)
        ), commitment_stats as (
          select count(*) as commitment_count,
            count(*) filter (where total_value is not null) as additive_commitment_count,
            count(*) filter (where total_value is null) as unresolved_commitment_count,
            sum(total_value)::text as additive_commitment_ron
          from pnrr.api_commitments c
          where (${scope.componentCode}::text is null or c.component_code = ${scope.componentCode})
            and (${scope.beneficiaryCui}::text is null or c.beneficiary_cui = ${scope.beneficiaryCui})
            and (${scope.countySiruta}::text is null or c.county_siruta = ${scope.countySiruta})
            and (${scope.from}::date is null or c.commitment_date >= ${scope.from}::date)
            and (${scope.to}::date is null or c.commitment_date <= ${scope.to}::date)
        ), progress_stats as (
          select count(*) as progress_total_count,
            count(*) filter (
              where physical_progress is not null or financial_progress is not null
            ) as progress_observed_count,
            count(*) filter (where physical_progress >= 1) as progress_completed_count,
            count(*) filter (
              where physical_progress > 1 or financial_progress > 1
            ) as progress_over_hundred_count,
            count(*) filter (where financial_progress is null)
              as missing_financial_progress_count,
            count(*) filter (where physical_progress is null)
              as missing_physical_progress_count
          from pnrr.api_progress_current p
          where p.record_kind = 'project_progress'
            and (${scope.componentCode}::text is null or p.component_code = ${scope.componentCode})
            and (${scope.beneficiaryCui}::text is null or p.beneficiary_cui = ${scope.beneficiaryCui})
            and (${scope.countySiruta}::text is null or p.county_siruta = ${scope.countySiruta})
            and (${scope.from}::date is null or p.snapshot_date >= ${scope.from}::date)
            and (${scope.to}::date is null or p.snapshot_date <= ${scope.to}::date)
        )
        select li.snapshot_date::text as indicator_snapshot_date,
          li.nr_projects as indicator_project_count,
          li.allocated_eur::text as allocation_eur,
          li.received_eur::text as received_eur,
          li.paid_eur::text as paid_eur,
          ps.*, cs.*, prs.*
        from payment_stats ps
        cross join commitment_stats cs
        cross join progress_stats prs
        left join latest_indicator li on true
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined) return err(databaseError('getOverview returned no aggregate row'));
      const paymentCount = Number(row.payment_count);
      const commitmentCount = Number(row.commitment_count);
      const additiveCount = Number(row.additive_commitment_count);
      const progressTotal = Number(row.progress_total_count);
      const progressObserved = Number(row.progress_observed_count);
      const coverage = [
        {
          field: 'commitment.additiveValue',
          covered: additiveCount,
          total: commitmentCount,
          percent: percent(additiveCount, commitmentCount),
        },
        {
          field: 'progress.physical',
          covered: progressTotal - Number(row.missing_physical_progress_count),
          total: progressTotal,
          percent: percent(
            progressTotal - Number(row.missing_physical_progress_count),
            progressTotal
          ),
        },
      ];
      const money = (
        factType:
          | 'plan_allocation'
          | 'eu_receipt'
          | 'national_reported_payment'
          | 'beneficiary_payment'
          | 'commitment',
        amount: string | null,
        currency: 'RON' | 'EUR',
        coveredCount: number,
        totalCount: number,
        aggregationState: 'additive' | 'reported_unresolved' = 'additive'
      ) => ({ factType, amount, currency, aggregationState, coveredCount, totalCount });
      return ok({
        meta: answerMeta(scope, release.value, coverage, ['payment_duplicate_review_pending']),
        program: {
          snapshotDate: row.indicator_snapshot_date,
          projectCount: row.indicator_project_count,
          allocationEur: money('plan_allocation', row.allocation_eur, 'EUR', 1, 1),
          receivedEur: money('eu_receipt', row.received_eur, 'EUR', 1, 1),
          paidEur: money('national_reported_payment', row.paid_eur, 'EUR', 1, 1),
        },
        beneficiaryPayments: {
          count: paymentCount,
          netRon: money(
            'beneficiary_payment',
            row.payment_net_ron,
            'RON',
            paymentCount,
            paymentCount
          ),
          grossRon: money(
            'beneficiary_payment',
            row.payment_gross_ron,
            'RON',
            paymentCount,
            paymentCount
          ),
          reversalRon: money(
            'beneficiary_payment',
            row.payment_reversal_ron,
            'RON',
            paymentCount,
            paymentCount
          ),
          firstDate: row.payment_first_date,
          lastDate: row.payment_last_date,
        },
        commitments: {
          count: commitmentCount,
          additiveCount,
          unresolvedCount: Number(row.unresolved_commitment_count),
          additiveRon: money(
            'commitment',
            row.additive_commitment_ron,
            'RON',
            additiveCount,
            commitmentCount
          ),
        },
        delivery: {
          observedCount: progressObserved,
          completedCount: Number(row.progress_completed_count),
          overHundredCount: Number(row.progress_over_hundred_count),
          missingFinancialProgressCount: Number(row.missing_financial_progress_count),
          missingPhysicalProgressCount: Number(row.missing_physical_progress_count),
        },
      });
    } catch (error) {
      return err(databaseError('getOverview failed', error));
    }
  };

  const getPlaceProfile = async (
    countySiruta: string,
    scope: PnrrAnalysisScope
  ): Promise<Result<PnrrPlaceProfile | null, ApiError>> => {
    const release = await getCurrentRelease();
    if (release.isErr()) return err(release.error);
    try {
      const result = await sql<{
        county_name: string | null;
        payment_count: string;
        payment_net_ron: string | null;
        commitment_count: string;
        additive_commitment_count: string;
        unresolved_commitment_count: string;
        additive_commitment_ron: string | null;
        project_observation_count: string;
        source_locality_label_count: string;
      }>`
        with canonical_county as (
          select county_siruta_code, max(county_name) as county_name
          from core.territories
          where county_siruta_code = ${countySiruta}
          group by county_siruta_code
        )
        select
          coalesce(
            cc.county_name,
            (select max(county_name) from pnrr.api_payments where county_siruta = ${countySiruta}),
            (select max(county_name) from pnrr.api_commitments where county_siruta = ${countySiruta})
          ) as county_name,
          (select count(*) from pnrr.api_payments p
            where p.county_siruta = ${countySiruta}
              and (${scope.componentCode}::text is null or p.component_code = ${scope.componentCode})
              and (${scope.beneficiaryCui}::text is null or p.beneficiary_cui = ${scope.beneficiaryCui})
              and (${scope.from}::date is null or p.payment_date >= ${scope.from}::date)
              and (${scope.to}::date is null or p.payment_date <= ${scope.to}::date))
            as payment_count,
          (select sum(amount_lei)::text from pnrr.api_payments p
            where p.county_siruta = ${countySiruta}
              and (${scope.componentCode}::text is null or p.component_code = ${scope.componentCode})
              and (${scope.beneficiaryCui}::text is null or p.beneficiary_cui = ${scope.beneficiaryCui})
              and (${scope.from}::date is null or p.payment_date >= ${scope.from}::date)
              and (${scope.to}::date is null or p.payment_date <= ${scope.to}::date))
            as payment_net_ron,
          (select count(*) from pnrr.api_commitments c
            where c.county_siruta = ${countySiruta}
              and (${scope.componentCode}::text is null or c.component_code = ${scope.componentCode})
              and (${scope.beneficiaryCui}::text is null or c.beneficiary_cui = ${scope.beneficiaryCui})
              and (${scope.from}::date is null or c.commitment_date >= ${scope.from}::date)
              and (${scope.to}::date is null or c.commitment_date <= ${scope.to}::date))
            as commitment_count,
          (select count(*) from pnrr.api_commitments c
            where c.county_siruta = ${countySiruta} and c.total_value is not null
              and (${scope.componentCode}::text is null or c.component_code = ${scope.componentCode})
              and (${scope.beneficiaryCui}::text is null or c.beneficiary_cui = ${scope.beneficiaryCui})
              and (${scope.from}::date is null or c.commitment_date >= ${scope.from}::date)
              and (${scope.to}::date is null or c.commitment_date <= ${scope.to}::date))
            as additive_commitment_count,
          (select count(*) from pnrr.api_commitments c
            where c.county_siruta = ${countySiruta} and c.total_value is null
              and (${scope.componentCode}::text is null or c.component_code = ${scope.componentCode})
              and (${scope.beneficiaryCui}::text is null or c.beneficiary_cui = ${scope.beneficiaryCui})
              and (${scope.from}::date is null or c.commitment_date >= ${scope.from}::date)
              and (${scope.to}::date is null or c.commitment_date <= ${scope.to}::date))
            as unresolved_commitment_count,
          (select sum(total_value)::text from pnrr.api_commitments c
            where c.county_siruta = ${countySiruta}
              and (${scope.componentCode}::text is null or c.component_code = ${scope.componentCode})
              and (${scope.beneficiaryCui}::text is null or c.beneficiary_cui = ${scope.beneficiaryCui})
              and (${scope.from}::date is null or c.commitment_date >= ${scope.from}::date)
              and (${scope.to}::date is null or c.commitment_date <= ${scope.to}::date))
            as additive_commitment_ron,
          (select count(*) from pnrr.api_progress_current p
            where p.record_kind = 'project_progress'
              and p.county_siruta = ${countySiruta}
              and (${scope.componentCode}::text is null or p.component_code = ${scope.componentCode})
              and (${scope.beneficiaryCui}::text is null or p.beneficiary_cui = ${scope.beneficiaryCui})
              and (${scope.from}::date is null or p.snapshot_date >= ${scope.from}::date)
              and (${scope.to}::date is null or p.snapshot_date <= ${scope.to}::date))
            as project_observation_count,
          (select count(*) from pnrr.api_progress_current p
            where p.record_kind = 'project_progress'
              and p.county_siruta = ${countySiruta}
              and p.locality_name is not null
              and (${scope.componentCode}::text is null or p.component_code = ${scope.componentCode})
              and (${scope.beneficiaryCui}::text is null or p.beneficiary_cui = ${scope.beneficiaryCui})
              and (${scope.from}::date is null or p.snapshot_date >= ${scope.from}::date)
              and (${scope.to}::date is null or p.snapshot_date <= ${scope.to}::date))
            as source_locality_label_count
        from canonical_county cc
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined) return ok(null);
      const commitmentCount = Number(row.commitment_count);
      const additiveCount = Number(row.additive_commitment_count);
      return ok({
        meta: answerMeta(
          { ...scope, countySiruta },
          release.value,
          [
            {
              field: 'commitment.additiveValue',
              covered: additiveCount,
              total: commitmentCount,
              percent: percent(additiveCount, commitmentCount),
            },
          ],
          ['uat_inferred_count_only']
        ),
        countySiruta,
        countyName: row.county_name,
        paymentCount: Number(row.payment_count),
        paymentNetRon: row.payment_net_ron,
        commitmentCount,
        additiveCommitmentCount: additiveCount,
        unresolvedCommitmentCount: Number(row.unresolved_commitment_count),
        additiveCommitmentRon: row.additive_commitment_ron,
        projectObservationCount: Number(row.project_observation_count),
        sourceLocalityLabelCount: Number(row.source_locality_label_count),
        sourceLocalityLabelValue: null,
      });
    } catch (error) {
      return err(databaseError('getPlaceProfile failed', error));
    }
  };

  const listPlaces = async (
    scope: PnrrAnalysisScope
  ): Promise<Result<readonly PnrrPlaceSummary[], ApiError>> => {
    try {
      const result = await sql<{
        county_siruta: string;
        county_name: string;
        payment_count: string;
        payment_net_ron: string | null;
        commitment_count: string;
        additive_commitment_count: string;
        unresolved_commitment_count: string;
        additive_commitment_ron: string | null;
        project_observation_count: string;
        source_locality_label_count: string;
      }>`
        with counties as (
          select county_siruta_code as county_siruta,
            max(county_name) as county_name
          from core.territories
          where county_siruta_code is not null
            and county_name is not null
          group by county_siruta_code
        ), payment_stats as (
          select p.county_siruta, count(*) as payment_count,
            sum(p.amount_lei)::text as payment_net_ron
          from pnrr.api_payments p
          where p.county_siruta is not null
            and (${scope.componentCode}::text is null or p.component_code = ${scope.componentCode})
            and (${scope.beneficiaryCui}::text is null or p.beneficiary_cui = ${scope.beneficiaryCui})
            and (${scope.from}::date is null or p.payment_date >= ${scope.from}::date)
            and (${scope.to}::date is null or p.payment_date <= ${scope.to}::date)
          group by p.county_siruta
        ), commitment_stats as (
          select c.county_siruta, count(*) as commitment_count,
            count(*) filter (where c.total_value is not null)
              as additive_commitment_count,
            count(*) filter (where c.total_value is null)
              as unresolved_commitment_count,
            sum(c.total_value)::text as additive_commitment_ron
          from pnrr.api_commitments c
          where c.county_siruta is not null
            and (${scope.componentCode}::text is null or c.component_code = ${scope.componentCode})
            and (${scope.beneficiaryCui}::text is null or c.beneficiary_cui = ${scope.beneficiaryCui})
            and (${scope.from}::date is null or c.commitment_date >= ${scope.from}::date)
            and (${scope.to}::date is null or c.commitment_date <= ${scope.to}::date)
          group by c.county_siruta
        ), progress_stats as (
          select p.county_siruta, count(*) as project_observation_count,
            count(*) filter (where p.locality_name is not null)
              as source_locality_label_count
          from pnrr.api_progress_current p
          where p.record_kind = 'project_progress'
            and p.county_siruta is not null
            and (${scope.componentCode}::text is null or p.component_code = ${scope.componentCode})
            and (${scope.beneficiaryCui}::text is null or p.beneficiary_cui = ${scope.beneficiaryCui})
            and (${scope.from}::date is null or p.snapshot_date >= ${scope.from}::date)
            and (${scope.to}::date is null or p.snapshot_date <= ${scope.to}::date)
          group by p.county_siruta
        )
        select co.county_siruta, co.county_name,
          coalesce(ps.payment_count, 0) as payment_count,
          ps.payment_net_ron,
          coalesce(cs.commitment_count, 0) as commitment_count,
          coalesce(cs.additive_commitment_count, 0) as additive_commitment_count,
          coalesce(cs.unresolved_commitment_count, 0) as unresolved_commitment_count,
          cs.additive_commitment_ron,
          coalesce(prs.project_observation_count, 0) as project_observation_count,
          coalesce(prs.source_locality_label_count, 0)
            as source_locality_label_count
        from counties co
        left join payment_stats ps using (county_siruta)
        left join commitment_stats cs using (county_siruta)
        left join progress_stats prs using (county_siruta)
        order by co.county_name, co.county_siruta
      `.execute(db);
      return ok(
        result.rows.map((row) => ({
          countySiruta: row.county_siruta,
          countyName: row.county_name,
          paymentCount: Number(row.payment_count),
          paymentNetRon: row.payment_net_ron,
          commitmentCount: Number(row.commitment_count),
          additiveCommitmentCount: Number(row.additive_commitment_count),
          unresolvedCommitmentCount: Number(row.unresolved_commitment_count),
          additiveCommitmentRon: row.additive_commitment_ron,
          projectObservationCount: Number(row.project_observation_count),
          sourceLocalityLabelCount: Number(row.source_locality_label_count),
          sourceLocalityLabelValue: null,
        }))
      );
    } catch (error) {
      return err(databaseError('listPlaces failed', error));
    }
  };

  const getVerification = async (
    scope: PnrrAnalysisScope
  ): Promise<Result<PnrrVerificationSummary, ApiError>> => {
    const release = await getCurrentRelease();
    if (release.isErr()) return err(release.error);
    try {
      const result = await sql<{
        unresolved_commitment_count: string;
        duplicate_payment_group_count: string;
        missing_commitment_source_url_count: string;
        end_before_start_count: string;
        over_hundred_progress_count: string;
        missing_progress_link_count: string;
      }>`
        select
          (select count(*) from pnrr.api_commitments where total_value is null)
            as unresolved_commitment_count,
          (select count(*) from pnrr.payment_duplicate_groups
            where classification <> 'single_observation')
            as duplicate_payment_group_count,
          (select count(*) from pnrr.api_commitments
            where source_url is null or source_url = '')
            as missing_commitment_source_url_count,
          (select count(*) from pnrr.api_commitments where date_quality = 'end_before_start')
            as end_before_start_count,
          (select count(*) from pnrr.api_progress_current
            where record_kind = 'project_progress'
              and (physical_progress > 1 or financial_progress > 1))
            as over_hundred_progress_count,
          (select count(*) from pnrr.progress_observations
            where privacy_class = 'public'
              and commitment_business_id is not null
              and commitment_envelope_key_v1 is null)
            as missing_progress_link_count
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined) return err(databaseError('getVerification returned no aggregate row'));
      return ok({
        meta: answerMeta(scope, release.value, [], ['verification_rules_runtime_v1']),
        ruleSetVersion: 'pnrr-verification-v1',
        unresolvedCommitmentCount: Number(row.unresolved_commitment_count),
        duplicatePaymentGroupCount: Number(row.duplicate_payment_group_count),
        missingCommitmentSourceUrlCount: Number(row.missing_commitment_source_url_count),
        endBeforeStartCount: Number(row.end_before_start_count),
        overHundredProgressCount: Number(row.over_hundred_progress_count),
        missingProgressLinkCount: Number(row.missing_progress_link_count),
      });
    } catch (error) {
      return err(databaseError('getVerification failed', error));
    }
  };

  // ── procurement graph ───────────────────────────────────────────────────────

  const listAcquisitions = async (
    rawFilter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrAcquisition>, ApiError>> => {
    const normalized = normalizePnrrFilter(rawFilter);
    if (normalized.isErr()) return err(normalized.error);
    const f = normalized.value;
    const driving = requireDrivingPredicate(
      f,
      ['beneficiaryCui', 'signedAt', 'announcementKey', 'componentCode'],
      'beneficiaryCui / signedAt / announcementKey / componentCode'
    );
    if (driving.isErr()) return err(driving.error);

    const limit = clampFirst(page.first);
    const fhash = releaseBoundFhash(fhashFor(pnrrAcquisitionsFilterSpec, f), page.releaseId);
    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'signed_at', dir: 'desc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    // componentCode lives on the joined announcement; the rest on `a`.
    const needsJoin = hasField(f, 'componentCode');
    const kernel = kernelConditions(pnrrAcquisitionsFilterSpec, f);
    if (kernel.isErr()) return err(kernel.error);
    const conds: RawBuilder<unknown>[] = [kernel.value];
    if (cursorKeys?.length === 2) {
      conds.push(
        descNullsLastCursor(
          'a.signed_at',
          'a.acquisition_key',
          cursorKeys[0] ?? '',
          cursorKeys[1] ?? ''
        )
      );
    }

    try {
      let query = db.selectFrom('pnrr.api_procurement_acquisitions as a');
      if (needsJoin) {
        query = query.innerJoin(
          'pnrr.api_procurement_announcements as an',
          'an.announcement_key',
          'a.announcement_key'
        );
      }
      const rows = await query
        .select([
          'a.acquisition_key',
          'a.announcement_key',
          'a.beneficiary_cui',
          'a.beneficiary_name',
          'a.procedure_type',
          sql<string | null>`a.signed_at::text`.as('signed_at'),
          sql<string | null>`a.reported_full_contract_value::text`.as('full_contract_value'),
          'a.currency',
          'a.award_criterion',
          'a.framework_agreement',
          'a.has_association_leader',
          'a.has_third_party_support',
          'a.has_subcontractor',
          sql<string | null>`a.retrieved_at::text`.as('retrieved_at'),
          sql<string>`(select count(*) from pnrr.api_procurement_participants ct where ct.acquisition_key = a.acquisition_key)`.as(
            'contractor_count'
          ),
        ])
        .where(composeWhere(conds))
        .orderBy(sql`a.signed_at desc nulls last`)
        .orderBy('a.acquisition_key', 'desc')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((row) => mapAcquisition(row));
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: 'signed_at',
            dir: 'desc',
            fhash,
            lastKeys: [last.signed_at ?? '', last.acquisition_key],
          });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listAcquisitions failed', error));
    }
  };

  const getAcquisition = async (
    key: string
  ): Promise<Result<PnrrAcquisitionDetail | null, ApiError>> => {
    try {
      const acqRow = await db
        .selectFrom('pnrr.api_procurement_acquisitions as a')
        .select([
          'a.acquisition_key',
          'a.announcement_key',
          'a.beneficiary_cui',
          'a.beneficiary_name',
          'a.procedure_type',
          sql<string | null>`a.signed_at::text`.as('signed_at'),
          sql<string | null>`a.reported_full_contract_value::text`.as('full_contract_value'),
          'a.currency',
          'a.award_criterion',
          'a.framework_agreement',
          'a.has_association_leader',
          'a.has_third_party_support',
          'a.has_subcontractor',
          sql<string | null>`a.retrieved_at::text`.as('retrieved_at'),
          sql<string>`(select count(*) from pnrr.api_procurement_participants ct where ct.acquisition_key = a.acquisition_key)`.as(
            'contractor_count'
          ),
        ])
        .where('a.acquisition_key', '=', key)
        .limit(1)
        .executeTakeFirst();
      if (acqRow === undefined) return ok(null);
      const acquisition = mapAcquisition(acqRow, true);

      const [annRow, lotRows, contractorRows] = await Promise.all([
        acqRow.announcement_key !== null
          ? db
              .selectFrom('pnrr.api_procurement_announcements as an')
              .select(announcementColumns())
              .where('an.announcement_key', '=', acqRow.announcement_key)
              .limit(1)
              .executeTakeFirst()
          : Promise.resolve(undefined),
        acqRow.announcement_key !== null
          ? db
              .selectFrom('pnrr.api_procurement_lots as lo')
              .select(['lo.lot_key', 'lo.announcement_key', 'lo.lot_number', 'lo.description'])
              .where('lo.announcement_key', '=', acqRow.announcement_key)
              .orderBy('lo.lot_number', 'asc')
              .execute()
          : Promise.resolve([]),
        db
          .selectFrom('pnrr.api_procurement_participants as ct')
          .select(contractorColumns())
          .where('ct.acquisition_key', '=', key)
          .execute(),
      ]);

      return ok({
        acquisition,
        announcement: annRow !== undefined ? mapAnnouncement(annRow) : null,
        lots: lotRows.map(mapLot),
        contractors: contractorRows.map((row) => mapContractor(row)),
      });
    } catch (error) {
      return err(databaseError('getAcquisition failed', error));
    }
  };

  const listContractors = async (
    rawFilter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrContractor>, ApiError>> => {
    const normalized = normalizePnrrFilter(rawFilter);
    if (normalized.isErr()) return err(normalized.error);
    const f = normalized.value;
    const driving = requireDrivingPredicate(
      f,
      ['contractorCui', 'acquisitionKey', 'role'],
      'contractorCui / acquisitionKey / role'
    );
    if (driving.isErr()) return err(driving.error);

    const limit = clampFirst(page.first);
    const fhash = releaseBoundFhash(fhashFor(pnrrContractorsFilterSpec, f), page.releaseId);
    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'contractor_key', dir: 'desc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const kernel = kernelConditions(pnrrContractorsFilterSpec, f);
    if (kernel.isErr()) return err(kernel.error);
    const conds: RawBuilder<unknown>[] = [kernel.value];
    if (cursorKeys?.length === 1) {
      const cKey = cursorKeys[0] ?? '';
      if (cKey !== '') conds.push(sql`ct.contractor_key < ${cKey}`);
    }

    try {
      const rows = await db
        .selectFrom('pnrr.api_procurement_participants as ct')
        .select(contractorColumns())
        .where(composeWhere(conds))
        .orderBy('ct.contractor_key', 'desc')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((row) => mapContractor(row));
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: 'contractor_key',
            dir: 'desc',
            fhash,
            lastKeys: [last.contractor_key],
          });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listContractors failed', error));
    }
  };

  const rankContractors = async (
    rawFilter: FilterInput,
    by: PnrrContractorRankBy,
    limit: number
  ): Promise<Result<readonly PnrrContractorRankRow[], ApiError>> => {
    const normalized = normalizePnrrFilter(rawFilter);
    if (normalized.isErr()) return err(normalized.error);
    const f = normalized.value;
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    const kernel = kernelConditions(pnrrContractorsFilterSpec, f);
    if (kernel.isErr()) return err(kernel.error);
    // Rank only real (cui-bearing) contractors; foreign winners (null cui) are
    // excluded (bucketing them together would be misleading). Self-awards (the
    // contractor IS the acquisition's beneficiary — 85 live rows) are excluded so
    // the ranking matches the loader's pnrr_subcontract flow gate (=0 self-loops);
    // the MCP/REST surfaces advertise this exclusion. The NOT EXISTS preserves the
    // contractors grain (no row multiplication from the acquisitions join).
    const conds = [
      kernel.value,
      sql`ct.contractor_cui is not null`,
      sql`ct.contractor_cui ~ '^[0-9]{1,10}$'`,
      sql`not exists (select 1 from pnrr.api_procurement_acquisitions a where a.acquisition_key = ct.acquisition_key and a.beneficiary_cui = ct.contractor_cui)`,
    ];
    void by;

    try {
      const rows = await db
        .selectFrom('pnrr.api_procurement_participants as ct')
        .select([
          'ct.contractor_cui',
          sql<string | null>`max(ct.contractor_name)`.as('contractor_name'),
          sql<string>`count(*)`.as('relationship_count'),
          sql<string>`count(*) filter (where ct.role not in ('winning_bidder', 'foreign_winning_bidder', 'subcontractor', 'association_leader', 'third_party_support'))`.as(
            'unknown_count'
          ),
          sql<string[]>`array_agg(distinct ct.role)`.as('roles'),
        ])
        .where(composeWhere(conds))
        .groupBy('ct.contractor_cui')
        .orderBy(sql`count(*) desc`)
        .orderBy('ct.contractor_cui', 'asc')
        .limit(capped)
        .execute();

      return ok(
        rows.map((r) => ({
          contractorCui: r.contractor_cui,
          contractorName: r.contractor_name,
          awardCount: Number(r.relationship_count),
          participantRelationCount: Number(r.relationship_count),
          unknownRelationshipCount: Number(r.unknown_count),
          totalValue: null,
          valueAggregationState: 'unavailable',
          valueReason: PROCUREMENT_VALUE_REASON,
          roles: normalizeRoles(r.roles),
        }))
      );
    } catch (error) {
      return err(databaseError('rankContractors failed', error));
    }
  };

  const contractorsForAcquisitions = async (
    keys: readonly string[]
  ): Promise<Result<ReadonlyMap<string, readonly PnrrContractor[]>, ApiError>> => {
    if (keys.length === 0) return ok(new Map());
    try {
      const rows = await db
        .selectFrom('pnrr.api_procurement_participants as ct')
        .select(contractorColumns())
        .where('ct.acquisition_key', 'in', [...new Set(keys)])
        .execute();
      const map = new Map<string, PnrrContractor[]>();
      for (const r of rows) {
        const k = r.acquisition_key;
        if (k === null) continue;
        const list = map.get(k) ?? [];
        list.push(mapContractor(r));
        map.set(k, list);
      }
      return ok(map);
    } catch (error) {
      return err(databaseError('contractorsForAcquisitions failed', error));
    }
  };

  // ── taxonomy / dimensions ─────────────────────────────────────────────────────

  const listComponents = async (): Promise<Result<readonly PnrrComponent[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('pnrr.components as cp')
        .select(['cp.component_code', 'cp.component_name', 'cp.pillar'])
        .orderBy(sql`length(cp.component_code)`)
        .orderBy('cp.component_code', 'asc')
        .execute();
      return ok(rows.map(mapComponent));
    } catch (error) {
      return err(databaseError('listComponents failed', error));
    }
  };

  const listMeasures = async (
    f: FilterInput
  ): Promise<Result<readonly PnrrMeasure[], ApiError>> => {
    const kernel = kernelConditions(pnrrMeasuresFilterSpec, f);
    if (kernel.isErr()) return err(kernel.error);
    try {
      const rows = await db
        .selectFrom('pnrr.measures as m')
        .select([
          'm.fenix_reference',
          'm.component_code',
          'm.measure_type',
          'm.measure_number',
          'm.measure_name',
        ])
        .where(kernel.value)
        .orderBy('m.fenix_reference', 'asc')
        .execute();
      return ok(rows.map(mapMeasure));
    } catch (error) {
      return err(databaseError('listMeasures failed', error));
    }
  };

  const resolveDimension = async (
    dim: PnrrResolveDim,
    q: string,
    limit: number
  ): Promise<Result<readonly PnrrResolveHit[], ApiError>> => {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    const pattern = `%${q.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
    try {
      switch (dim) {
        case 'entity':
        case 'contractor': {
          const rows =
            dim === 'entity'
              ? await db
                  .selectFrom('pnrr.entities as e')
                  .select(['e.cui as value', 'e.resolved_name as label'])
                  .where(sql<boolean>`e.cui ~ '^[0-9]{1,10}$'`)
                  .where(sql<boolean>`e.resolved_name ilike ${pattern} escape '\\'`)
                  .limit(capped)
                  .execute()
              : await db
                  .selectFrom('pnrr.api_procurement_participants as ct')
                  .select([
                    'ct.contractor_cui as value',
                    sql<string | null>`max(ct.contractor_name)`.as('label'),
                  ])
                  .where('ct.contractor_cui', 'is not', null)
                  .where(sql<boolean>`ct.contractor_cui ~ '^[0-9]{1,10}$'`)
                  .where(sql<boolean>`ct.contractor_name ilike ${pattern} escape '\\'`)
                  .groupBy('ct.contractor_cui')
                  .limit(capped)
                  .execute();
          return ok(
            rows
              .filter((r): r is { value: string; label: string | null } => r.value !== null)
              .map((r) => ({ dim, value: r.value, label: r.label ?? r.value, score: null }))
          );
        }
        case 'component': {
          const rows = await db
            .selectFrom('pnrr.components as cp')
            .select(['cp.component_code as value', 'cp.component_name as label'])
            .where(
              sql<boolean>`cp.component_code ilike ${pattern} escape '\\' or cp.component_name ilike ${pattern} escape '\\'`
            )
            .limit(capped)
            .execute();
          return ok(
            rows.map((r) => ({ dim, value: r.value, label: r.label ?? r.value, score: null }))
          );
        }
        case 'measure': {
          const rows = await db
            .selectFrom('pnrr.measures as m')
            .select(['m.fenix_reference as value', 'm.measure_name as label'])
            .where(
              sql<boolean>`m.fenix_reference ilike ${pattern} escape '\\' or m.measure_name ilike ${pattern} escape '\\'`
            )
            .limit(capped)
            .execute();
          return ok(
            rows.map((r) => ({ dim, value: r.value, label: r.label ?? r.value, score: null }))
          );
        }
        case 'county': {
          const rows = await db
            .selectFrom('pnrr.api_payments as p')
            .select([
              'p.county_siruta as value',
              sql<string | null>`max(p.county_name)`.as('label'),
            ])
            .where('p.county_siruta', 'is not', null)
            .where(sql<boolean>`p.county_name ilike ${pattern} escape '\\'`)
            .groupBy('p.county_siruta')
            .limit(capped)
            .execute();
          return ok(
            rows
              .filter((r): r is { value: string; label: string | null } => r.value !== null)
              .map((r) => ({ dim, value: r.value, label: r.label ?? r.value, score: null }))
          );
        }
        default:
          return err(invalidInput(`unknown resolve dimension '${String(dim)}'`, 'dim'));
      }
    } catch (error) {
      return err(databaseError('resolveDimension failed', error));
    }
  };

  return {
    listEntities,
    getEntity,
    getEntityProfile,
    listPayments,
    aggregatePayments,
    listCommitments,
    getCommitment,
    getCommitmentProgress,
    listProjects,
    getProject,
    getProjectHistory,
    getProjectFacets,
    listProgramIndicators,
    listFundingCalls,
    listFundingApplicationListings,
    listProgramRevisions,
    listCatalogResources,
    listDocumentReferences,
    getCurrentRelease,
    getCapabilities,
    getOverview,
    getPlaceProfile,
    listPlaces,
    getVerification,
    listAcquisitions,
    getAcquisition,
    listContractors,
    rankContractors,
    contractorsForAcquisitions,
    listComponents,
    listMeasures,
    resolveDimension,
  };
};

// ── shared select column lists + small helpers ────────────────────────────────

const snapshotColumns = () =>
  [
    's.snapshot_id',
    's.source_record_id',
    sql<string>`s.snapshot_date::text`.as('snapshot_date'),
    's.beneficiary_cui',
    's.contract_number',
    's.commitment_key',
    's.link_confidence',
    sql<string | null>`s.financial_progress::text`.as('financial_progress'),
    sql<string | null>`s.physical_progress::text`.as('physical_progress'),
    's.stage',
    sql<string | null>`s.received_eur::text`.as('received_eur'),
    sql<string | null>`s.paid_eur::text`.as('paid_eur'),
    sql<string | null>`s.allocated_eur::text`.as('allocated_eur'),
  ] as const;

const announcementColumns = () =>
  [
    'an.announcement_key',
    'an.platform_project_id',
    'an.applicant_cui',
    'an.applicant_name',
    'an.project_name',
    'an.call_name',
    'an.component_code',
    sql<string | null>`an.budget_value::text`.as('budget_value'),
    'an.status',
    'an.county_siruta',
  ] as const;

const contractorColumns = () =>
  [
    'ct.contractor_key',
    'ct.acquisition_key',
    'ct.role',
    'ct.contractor_cui',
    'ct.contractor_name',
    'ct.contractor_country',
    sql<string | null>`null::text`.as('contract_value'),
    sql<string | null>`null::text`.as('currency'),
    'ct.confidence',
    'ct.validation_status',
  ] as const;

const notFoundCommitment = (key: string): ApiError =>
  invalidInput(`commitment '${key}' not found`, 'commitmentKey');

/** Keep only the known contractor-role values (defensive against future roles). */
const normalizeRoles = (
  roles: readonly string[]
): readonly import('../../core/types.js').PnrrContractorRole[] => {
  const known = new Set([
    'winning_bidder',
    'foreign_winning_bidder',
    'subcontractor',
    'association_leader',
    'third_party_support',
    'unknown',
  ]);
  return [
    ...new Set(
      roles.map((role) =>
        known.has(role)
          ? (role as import('../../core/types.js').PnrrContractorRole)
          : ('unknown' as const)
      )
    ),
  ];
};

/** Resolve component/county group keys to friendly labels (small, cached per call). */
const resolveAggLabels = async (
  db: Db,
  by: PnrrPaymentGroupBy,
  keys: readonly (string | null)[]
): Promise<ReadonlyMap<string, string>> => {
  const present = [...new Set(keys.filter((k): k is string => k !== null))];
  if (present.length === 0 || by === 'year' || by === 'measure') return new Map();
  if (by === 'component') {
    const rows = await db
      .selectFrom('pnrr.components as cp')
      .select(['cp.component_code', 'cp.component_name'])
      .where('cp.component_code', 'in', present)
      .execute();
    return new Map(
      rows
        .filter(
          (r): r is { component_code: string; component_name: string } => r.component_name !== null
        )
        .map((r) => [r.component_code, r.component_name])
    );
  }
  // county: siruta → county_name (from payments, deduped)
  const rows = await db
    .selectFrom('pnrr.api_payments as p')
    .select(['p.county_siruta', sql<string | null>`max(p.county_name)`.as('county_name')])
    .where('p.county_siruta', 'in', present)
    .groupBy('p.county_siruta')
    .execute();
  return new Map(
    rows
      .filter(
        (r): r is { county_siruta: string; county_name: string } =>
          r.county_siruta !== null && r.county_name !== null
      )
      .map((r) => [r.county_siruta, r.county_name])
  );
};
