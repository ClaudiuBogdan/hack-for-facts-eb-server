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
  fhashFor,
  invalidInput,
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
  type SnapshotRow,
} from './mappers.js';
import {
  pnrrAcquisitionsFilterSpec,
  pnrrCommitmentsFilterSpec,
  pnrrContractorsFilterSpec,
  pnrrEntitiesFilterSpec,
  pnrrMeasuresFilterSpec,
  pnrrPaymentsFilterSpec,
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
  type PnrrMeasure,
  type PnrrPayment,
  type PnrrPaymentAggRow,
  type PnrrPaymentGroupBy,
  type PnrrProgramIndicator,
  type PnrrResolveDim,
  type PnrrResolveHit,
} from '../../core/types.js';

import type { CursorPageRequest, PnrrRepository } from '../../core/ports.js';

type Db = Kysely<ProdDatabase>;

const clampFirst = (first: number): number => Math.min(Math.max(Math.floor(first), 1), 100);

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

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
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrEntity>, ApiError>> => {
    // The directory is intentionally browsable unfiltered (cursor on the PK
    // `cui`, an index-ordered scan); we do NOT force a driving predicate here.
    // But virtual filters must still validate (a bad role/hub silently no-ops).
    const vv = validateVirtualFilters(f);
    if (vv.isErr()) return err(vv.error);
    const limit = clampFirst(page.first);
    const fhash = fhashFor(pnrrEntitiesFilterSpec, f);
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
    const conds = [kernel.value, ...entityVirtualConditions(f)];
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
          .selectFrom('pnrr.payments as p')
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
          .where(notPersonalRecipient('p'))
          .executeTakeFirst(),
        db
          .selectFrom('pnrr.payments as p')
          .select([
            'p.component_code',
            sql<string>`count(*)`.as('cnt'),
            sql<string | null>`sum(p.amount_lei)::text`.as('total_lei'),
          ])
          .where('p.beneficiary_cui', '=', cui)
          .where(notPersonalRecipient('p'))
          .groupBy('p.component_code')
          .orderBy(sql`sum(p.amount_lei) desc nulls last`)
          .execute(),
        db
          .selectFrom('pnrr.commitments as c')
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
          .selectFrom('pnrr.acquisitions as a')
          .select([
            sql<string>`count(*)`.as('cnt'),
            sql<string | null>`sum(a.full_contract_value)::text`.as('total_value'),
          ])
          .where('a.beneficiary_cui', '=', cui)
          .executeTakeFirst(),
        db
          .selectFrom('pnrr.contractors as ct')
          .select([
            sql<string>`count(*)`.as('cnt'),
            sql<string | null>`sum(ct.contract_value)::text`.as('total_value'),
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
          acquisitionsValue: acq?.total_value ?? null,
          wonAsContractor: Number(won?.cnt ?? 0),
          wonValue: won?.total_value ?? null,
        },
        grainNote: PNRR_GRAIN_NOTE,
        dataAsOf: pay?.as_of ?? null,
      });
    } catch (error) {
      return err(databaseError('getEntityProfile failed', error));
    }
  };

  // ── ledger ──────────────────────────────────────────────────────────────────

  /**
   * Defense-in-depth PII gate (§8.2): never surface or aggregate rows flagged
   * `is_personal_recipient` (a natural-person recipient). The loader already
   * scrubs these (0 live rows on payments), but the server filters them at the
   * query boundary too so a future ingest can never leak them. `IS DISTINCT FROM
   * TRUE` also keeps NULL-flag rows. `<alias>` is a trusted internal identifier.
   */
  const notPersonalRecipient = (alias: string): RawBuilder<SqlBool> =>
    sql<SqlBool>`${sql.ref(`${alias}.is_personal_recipient`)} is distinct from true`;

  /** Compile the `year` virtual field into a payment_date range condition. */
  const yearCondition = (input: FilterInput, col: string): RawBuilder<unknown> | undefined => {
    const year = intEq(fieldOf(input, 'year'));
    if (year === undefined) return undefined;
    const y = String(year);
    return sql`${sql.ref(col)} between ${`${y}-01-01`}::date and ${`${y}-12-31`}::date`;
  };

  const listPayments = async (
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrPayment>, ApiError>> => {
    const vv = validateVirtualFilters(f);
    if (vv.isErr()) return err(vv.error);
    const driving = requireDrivingPredicate(
      f,
      ['beneficiaryCui', 'componentCode', 'measureFenix', 'paymentDate', 'year'],
      'beneficiaryCui / componentCode / measureFenix / paymentDate / year'
    );
    if (driving.isErr()) return err(driving.error);

    const limit = clampFirst(page.first);
    const fhash = fhashFor(pnrrPaymentsFilterSpec, f);
    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'payment_date', dir: 'desc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const physical = omitFields(f, ['year']);
    const kernel = kernelConditions(pnrrPaymentsFilterSpec, physical);
    if (kernel.isErr()) return err(kernel.error);
    const conds: RawBuilder<unknown>[] = [kernel.value, notPersonalRecipient('p')];
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
        .selectFrom('pnrr.payments as p')
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
    f: FilterInput,
    by: PnrrPaymentGroupBy
  ): Promise<Result<readonly PnrrPaymentAggRow[], ApiError>> => {
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
    const conds: RawBuilder<unknown>[] = [kernel.value, notPersonalRecipient('p')];
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
        .selectFrom('pnrr.payments as p')
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
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrCommitment>, ApiError>> => {
    const driving = requireDrivingPredicate(
      f,
      ['beneficiaryCui', 'contractNumber', 'componentCode'],
      'beneficiaryCui / contractNumber / componentCode'
    );
    if (driving.isErr()) return err(driving.error);

    const limit = clampFirst(page.first);
    const fhash = fhashFor(pnrrCommitmentsFilterSpec, f);
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
        .selectFrom('pnrr.commitments as c')
        .select([
          'c.commitment_key',
          'c.beneficiary_cui',
          'c.beneficiary_name',
          'c.id_angajament',
          'c.contract_number',
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
          sql<string | null>`c.end_date::text`.as('end_date'),
          'c.status',
          'c.county_name',
          'c.county_siruta',
          sql<string | null>`c.retrieved_at::text`.as('retrieved_at'),
          sql<string>`(select count(*) from pnrr.commitment_snapshots s where s.beneficiary_cui = c.beneficiary_cui and s.contract_number = c.contract_number)`.as(
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
            from pnrr.commitment_snapshots s
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

  /** Resolve commitmentKey → bounded snapshots explicitly linked to that commitment. */
  const getCommitmentProgress = async (
    commitmentKey: string
  ): Promise<Result<readonly PnrrCommitmentSnapshot[], ApiError>> => {
    try {
      const commit = await db
        .selectFrom('pnrr.commitments as c')
        .select('c.commitment_key')
        .where('c.commitment_key', '=', commitmentKey)
        .limit(1)
        .executeTakeFirst();
      if (commit === undefined) return err(notFoundCommitment(commitmentKey));

      const rows = await db
        .selectFrom('pnrr.commitment_snapshots as s')
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

  // ── procurement graph ───────────────────────────────────────────────────────

  const listAcquisitions = async (
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrAcquisition>, ApiError>> => {
    const driving = requireDrivingPredicate(
      f,
      ['beneficiaryCui', 'signedAt', 'announcementKey', 'componentCode'],
      'beneficiaryCui / signedAt / announcementKey / componentCode'
    );
    if (driving.isErr()) return err(driving.error);

    const limit = clampFirst(page.first);
    const fhash = fhashFor(pnrrAcquisitionsFilterSpec, f);
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
      let query = db.selectFrom('pnrr.acquisitions as a');
      if (needsJoin) {
        query = query.innerJoin(
          'pnrr.announcements as an',
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
          sql<string | null>`a.full_contract_value::text`.as('full_contract_value'),
          'a.currency',
          'a.award_criterion',
          'a.framework_agreement',
          'a.has_association_leader',
          'a.has_third_party_support',
          'a.has_subcontractor',
          sql<string | null>`a.retrieved_at::text`.as('retrieved_at'),
          sql<string>`(select count(*) from pnrr.contractors ct where ct.acquisition_key = a.acquisition_key)`.as(
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
      const items = pageRows.map(mapAcquisition);
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
        .selectFrom('pnrr.acquisitions as a')
        .select([
          'a.acquisition_key',
          'a.announcement_key',
          'a.beneficiary_cui',
          'a.beneficiary_name',
          'a.procedure_type',
          sql<string | null>`a.signed_at::text`.as('signed_at'),
          sql<string | null>`a.full_contract_value::text`.as('full_contract_value'),
          'a.currency',
          'a.award_criterion',
          'a.framework_agreement',
          'a.has_association_leader',
          'a.has_third_party_support',
          'a.has_subcontractor',
          sql<string | null>`a.retrieved_at::text`.as('retrieved_at'),
          sql<string>`(select count(*) from pnrr.contractors ct where ct.acquisition_key = a.acquisition_key)`.as(
            'contractor_count'
          ),
        ])
        .where('a.acquisition_key', '=', key)
        .limit(1)
        .executeTakeFirst();
      if (acqRow === undefined) return ok(null);
      const acquisition = mapAcquisition(acqRow);

      const [annRow, lotRows, contractorRows] = await Promise.all([
        acqRow.announcement_key !== null
          ? db
              .selectFrom('pnrr.announcements as an')
              .select(announcementColumns())
              .where('an.announcement_key', '=', acqRow.announcement_key)
              .limit(1)
              .executeTakeFirst()
          : Promise.resolve(undefined),
        acqRow.announcement_key !== null
          ? db
              .selectFrom('pnrr.lots as lo')
              .select(['lo.lot_key', 'lo.announcement_key', 'lo.lot_number', 'lo.description'])
              .where('lo.announcement_key', '=', acqRow.announcement_key)
              .orderBy('lo.lot_number', 'asc')
              .execute()
          : Promise.resolve([]),
        db
          .selectFrom('pnrr.contractors as ct')
          .select(contractorColumns())
          .where('ct.acquisition_key', '=', key)
          .execute(),
      ]);

      return ok({
        acquisition,
        announcement: annRow !== undefined ? mapAnnouncement(annRow) : null,
        lots: lotRows.map(mapLot),
        contractors: contractorRows.map(mapContractor),
      });
    } catch (error) {
      return err(databaseError('getAcquisition failed', error));
    }
  };

  const listContractors = async (
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<PnrrContractor>, ApiError>> => {
    const driving = requireDrivingPredicate(
      f,
      ['contractorCui', 'acquisitionKey', 'role'],
      'contractorCui / acquisitionKey / role'
    );
    if (driving.isErr()) return err(driving.error);

    const limit = clampFirst(page.first);
    const fhash = fhashFor(pnrrContractorsFilterSpec, f);
    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'contract_value', dir: 'desc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const kernel = kernelConditions(pnrrContractorsFilterSpec, f);
    if (kernel.isErr()) return err(kernel.error);
    const conds: RawBuilder<unknown>[] = [kernel.value];
    if (cursorKeys?.length === 2) {
      const cVal = cursorKeys[0] ?? '';
      const cKey = cursorKeys[1] ?? '';
      // value desc nulls last, then key desc. Encode null value as '' sentinel.
      if (cVal === '') {
        conds.push(sql`(ct.contract_value is null and ct.contractor_key < ${cKey})`);
      } else {
        conds.push(
          sql`(ct.contract_value < ${cVal}::numeric or ct.contract_value is null or (ct.contract_value = ${cVal}::numeric and ct.contractor_key < ${cKey}))`
        );
      }
    }

    try {
      const rows = await db
        .selectFrom('pnrr.contractors as ct')
        .select(contractorColumns())
        .where(composeWhere(conds))
        .orderBy(sql`ct.contract_value desc nulls last`)
        .orderBy('ct.contractor_key', 'desc')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map(mapContractor);
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: 'contract_value',
            dir: 'desc',
            fhash,
            lastKeys: [last.contract_value ?? '', last.contractor_key],
          });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listContractors failed', error));
    }
  };

  const rankContractors = async (
    f: FilterInput,
    by: PnrrContractorRankBy,
    limit: number
  ): Promise<Result<readonly PnrrContractorRankRow[], ApiError>> => {
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
      sql`not exists (select 1 from pnrr.acquisitions a where a.acquisition_key = ct.acquisition_key and a.beneficiary_cui = ct.contractor_cui)`,
    ];
    const orderExpr =
      by === 'awards' ? sql`count(*) desc` : sql`sum(ct.contract_value) desc nulls last`;

    try {
      const rows = await db
        .selectFrom('pnrr.contractors as ct')
        .select([
          'ct.contractor_cui',
          sql<string | null>`max(ct.contractor_name)`.as('contractor_name'),
          sql<string>`count(*)`.as('award_count'),
          sql<string | null>`sum(ct.contract_value)::text`.as('total_value'),
          sql<string[]>`array_agg(distinct ct.role)`.as('roles'),
        ])
        .where(composeWhere(conds))
        .groupBy('ct.contractor_cui')
        .orderBy(() => orderExpr)
        .limit(capped)
        .execute();

      return ok(
        rows.map((r) => ({
          contractorCui: r.contractor_cui,
          contractorName: r.contractor_name,
          awardCount: Number(r.award_count),
          totalValue: r.total_value,
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
        .selectFrom('pnrr.contractors as ct')
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
                  .where(sql<boolean>`e.resolved_name ilike ${pattern} escape '\\'`)
                  .limit(capped)
                  .execute()
              : await db
                  .selectFrom('pnrr.contractors as ct')
                  .select([
                    'ct.contractor_cui as value',
                    sql<string | null>`max(ct.contractor_name)`.as('label'),
                  ])
                  .where('ct.contractor_cui', 'is not', null)
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
            .selectFrom('pnrr.payments as p')
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
    getCommitmentProgress,
    listProgramIndicators,
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
    sql<string | null>`ct.contract_value::text`.as('contract_value'),
    'ct.currency',
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
  ]);
  return roles.filter((r): r is import('../../core/types.js').PnrrContractorRole => known.has(r));
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
    .selectFrom('pnrr.payments as p')
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
