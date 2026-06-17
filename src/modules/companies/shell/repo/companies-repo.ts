/**
 * Companies module — repository over the live `companies.*` + allowed `core.*`
 * schema (plan §3). The ONLY place that reads `companies.*`. Reads through the
 * kernel's typed Kysely instance (`Kysely<ProdDatabase>` augmented by
 * `shell/db/schema.ts`).
 *
 * Contracts enforced here:
 *  - **link-not-merge** (§2.1): a company is addressed by normalized CUI; per-CUI
 *    seeks hit `organizations_cui_uq`; `org_id` is projected for identity only and
 *    NEVER used as a cross-source key or reassigned.
 *  - **`is_active` dropped** (§13-R1): no method selects `fiscal_status.is_active`.
 *  - **two-hop regnum** (§2.1): `findByRegistrationNumber` seeks
 *    `organization_identifiers (scheme='onrc-cod-inmatriculare', value)` → org_id,
 *    JOIN `organizations (kind='company')` → cui. Returns a LIST (one-to-many).
 *  - **no-unaccent name search** (§15.7): the pg fallback folds diacritics in TS
 *    and is hard-capped; the default path is Meili. The repo never calls `unaccent()`.
 *  - **money/bigint as strings** (§14.1): cast `::text` at the SQL boundary;
 *    `employees` never coerced to a JS number.
 *  - **NOT flows** (§4.3): this repo never reads `flows.money_flows`.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, invalidInput, normalizeCui, offsetFor, toConditionBuilders, type ApiError, type FilterInput, type MeiliClient, type OffsetParams  } from '@/modules/shared/index.js';
import { foldDiacritics } from '@/modules/shared/shell/repo/fold.js';

import {
  fieldOf,
  isNullValue,
  requireAggregateDriver,
  splitVirtual,
  stringValues,
} from './filter-helpers.js';
import {
  mapAddress,
  mapCaen,
  mapEuBranch,
  mapFinancialYear,
  mapFiscal,
  mapHeadlineStatus,
  mapRepresentative,
  mapStatusFlag,
  mapTerritory,
  type FinancialRow,
} from './mappers.js';
import {
  COMPANY_AGGREGATE_DRIVING_FIELDS,
  companiesFilterSpec,
} from '../../core/filters.js';
import {
  COMPANY_TERRITORY_COVERAGE_NOTE,
  type CaenCodeHit,
  type CompanyCoverage,
  type CompanyEntitySlice,
  type CompanyFinancialYear,
  type CompanyGroupBy,
  type CompanyGroupCount,
  type CompanyListRow,
  type CompanyNameHit,
  type CompanySort,
} from '../../core/types.js';

import type { CompaniesRepository, CompanyListResult, CompanyPresenceCounts, CompanyProfileData } from '../../core/ports.js';


type Db = Kysely<import('@/modules/shared/index.js').ProdDatabase>;

const REGNUM_SCHEME = 'onrc-cod-inmatriculare';
const LIST_TOTAL_CAP = 10_000;
const NAME_FALLBACK_SCAN = 200;

/**
 * Romanian diacritic fold for SQL `translate()` — MUST mirror the kernel TS
 * `foldDiacritics` map (§15.7) so a TS-folded needle matches a SQL-folded column.
 * Both strings are exactly 14 chars (cedilla Ş/Ţ + comma-below Ș/Ț, upper+lower):
 *   ă â î ș ş ț ţ Ă Â Î Ș Ş Ț Ţ  →  a a i s s t t a a i s s t t
 * `unaccent` is NOT installed; never call it. Wrap in `lower()` at the call site.
 */
const FOLD_FROM = 'ăâîșşțţĂÂÎȘŞȚŢ';
const FOLD_TO = 'aaissttaaisstt';

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/** The full financials column list (cast money/bigint → text). */
const financialColumns = () =>
  [
    'year',
    sql<string | null>`turnover::text`.as('turnover'),
    sql<string | null>`net_profit::text`.as('net_profit'),
    sql<string | null>`net_loss::text`.as('net_loss'),
    sql<string | null>`employees::text`.as('employees'),
    sql<string | null>`total_revenue::text`.as('total_revenue'),
    sql<string | null>`total_expenses::text`.as('total_expenses'),
    sql<string | null>`gross_profit::text`.as('gross_profit'),
    sql<string | null>`gross_loss::text`.as('gross_loss'),
    sql<string | null>`receivables::text`.as('receivables'),
    sql<string | null>`current_assets::text`.as('current_assets'),
    sql<string | null>`fixed_assets::text`.as('fixed_assets'),
    sql<string | null>`cash_and_bank::text`.as('cash_and_bank'),
    sql<string | null>`prepaid_expenses::text`.as('prepaid_expenses'),
    sql<string | null>`deferred_income::text`.as('deferred_income'),
    sql<string | null>`subscribed_capital::text`.as('subscribed_capital'),
    sql<string | null>`inventories::text`.as('inventories'),
    sql<string | null>`debts::text`.as('debts'),
    sql<string | null>`provisions::text`.as('provisions'),
    sql<string | null>`total_equity::text`.as('total_equity'),
    sql<string | null>`patrimony_regie::text`.as('patrimony_regie'),
    'lines',
  ] as const;

/**
 * Compile the physical (kernel-composable) filter into SQL, then add the virtual
 * predicates (`caenCode` EXISTS, `county` diacritic-folded, `hasFinancials` EXISTS).
 * Aliases: o organizations, r registrations, f fiscal_status.
 */
const buildListConditions = (input: FilterInput): Result<RawBuilder<unknown>[], ApiError> => {
  const { physical, virtual } = splitVirtual(input);
  const built = toConditionBuilders(companiesFilterSpec, physical);
  if (built.isErr()) return err(built.error);
  const conds: RawBuilder<unknown>[] = [sql`o.kind = 'company'`, ...built.value];

  const caen = caenExists(fieldOf(virtual, 'caenCode'), false);
  if (caen.isErr()) return err(caen.error);
  if (caen.value !== null) conds.push(caen.value);

  const county = countyFolded(fieldOf(virtual, 'county'), false);
  if (county.isErr()) return err(county.error);
  if (county.value !== null) conds.push(county.value);

  const hasFin = isNullValue(fieldOf(virtual, 'hasFinancials'));
  if (hasFin !== undefined) {
    // hasFinancials isNull:false → "has at least one financial row" (NOT NULL presence).
    const wantPresent = !hasFin;
    conds.push(
      wantPresent
        ? sql`exists (select 1 from companies.financials fz where fz.cui = o.cui)`
        : sql`not exists (select 1 from companies.financials fz where fz.cui = o.cui)`
    );
  }

  // exclude-side virtuals (caenCode/county) — negate.
  const exclude = (input.exclude ?? {}) as Record<string, unknown>;
  if (typeof exclude === 'object') {
    const caenEx = caenExists(exclude['caenCode'] as never, true);
    if (caenEx.isErr()) return err(caenEx.error);
    if (caenEx.value !== null) conds.push(caenEx.value);
    const countyEx = countyFolded(exclude['county'] as never, true);
    if (countyEx.isErr()) return err(countyEx.error);
    if (countyEx.value !== null) conds.push(countyEx.value);
  }

  return ok(conds);
};

/** `caenCode` eq/in/prefix → EXISTS over caen_activities (index caen_activities_code_idx). */
const caenExists = (
  f: import('@/modules/shared/index.js').FieldFilter | undefined,
  negate: boolean
): Result<RawBuilder<unknown> | null, ApiError> => {
  if (f === undefined) return ok(null);
  const { eq, in: inV, prefix } = stringValues(f);
  const preds: RawBuilder<unknown>[] = [];
  if (eq !== undefined) preds.push(sql`ca.caen_code = ${eq}`);
  if (inV !== undefined && inV.length > 0) {
    preds.push(sql`ca.caen_code in (${sql.join(inV.map((v) => sql`${v}`), sql`, `)})`);
  }
  if (prefix !== undefined) {
    const esc = prefix.replace(/[\\%_]/gu, (m) => `\\${m}`);
    preds.push(sql`ca.caen_code like ${esc + '%'} escape '\\'`); // sargable range scan
  }
  if (preds.length === 0) return ok(null);
  const inner = sql.join(preds, sql` or `);
  const exists = sql`exists (select 1 from companies.caen_activities ca where ca.cui = o.cui and (${inner}))`;
  return ok(negate ? sql`not (${exists})` : exists);
};

/** `county` eq/in → diacritic-folded match on r.raw_county (NO unaccent; §15.7). */
const countyFolded = (
  f: import('@/modules/shared/index.js').FieldFilter | undefined,
  negate: boolean
): Result<RawBuilder<unknown> | null, ApiError> => {
  if (f === undefined) return ok(null);
  const { eq, in: inV } = stringValues(f);
  const wanted = [...(eq !== undefined ? [eq] : []), ...(inV ?? [])].map((v) => foldDiacritics(v));
  if (wanted.length === 0) return ok(null);
  // Fold the column in SQL with translate() (no unaccent) + lower, matching the
  // TS fold map exactly. Cheap residual filter (bounded by the 10k list cap).
  const foldedCol = sql`lower(translate(r.raw_county, ${FOLD_FROM}, ${FOLD_TO}))`;
  const cond = sql`${foldedCol} in (${sql.join(wanted.map((w) => sql`${w}`), sql`, `)})`;
  // Negate keeps NULL-county rows (NOT IN over NULL is UNKNOWN → would drop them).
  return ok(negate ? sql`(r.raw_county is null or not (${cond}))` : cond);
};

const orderByFor = (sort: CompanySort): RawBuilder<unknown> => {
  switch (sort) {
    case 'registrationDate':
      return sql`r.registration_date desc nulls last, o.cui asc`;
    case 'cui':
      return sql`o.cui asc`;
    case 'name':
    default:
      return sql`o.name asc, o.cui asc`;
  }
};

const LIST_SELECT = () =>
  [
    'o.cui',
    'o.org_id',
    'o.name',
    'r.legal_form',
    'r.status_code',
    'r.status_label',
    'r.raw_county',
    'r.registration_date',
    'f.is_vat_payer',
    'f.is_inactive',
  ] as const;

const mapListRow = (row: {
  cui: string | null;
  org_id: string;
  name: string;
  legal_form: string | null;
  status_code: string | null;
  status_label: string | null;
  raw_county: string | null;
  registration_date: string | null;
  is_vat_payer: boolean | null;
  is_inactive: boolean | null;
}): CompanyListRow => ({
  cui: row.cui ?? '',
  orgId: row.org_id,
  name: row.name,
  legalForm: row.legal_form,
  headlineStatus: mapHeadlineStatus(row.status_code, row.status_label),
  county: row.raw_county,
  vatPayer: row.is_vat_payer,
  declaredFiscallyInactive: row.is_inactive,
  registrationDate: row.registration_date,
  registrationDatePresent: row.registration_date !== null,
});

export const makeCompaniesRepo = (db: Db): CompaniesRepository => {
  // ── detail (per-CUI fan-out) ────────────────────────────────────────────────
  const getProfileData = async (rawCui: string): Promise<Result<CompanyProfileData | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      // Presence first via the cheap org seek (organizations_cui_uq).
      const org = await db
        .selectFrom('core.organizations')
        .select(['org_id', 'cui', 'name'])
        .where('cui', '=', cui)
        .where('kind', '=', 'company')
        .limit(1)
        .executeTakeFirst();
      if (org === undefined) return ok(null);

      const [reg, fiscal, fin, caen, reps, flags, branches] = await Promise.all([
        db
          .selectFrom('companies.registrations')
          .select([
            'cod_inmatriculare', 'legal_form',
            sql<string | null>`registration_date::text`.as('registration_date'),
            'status_code', 'status_label', 'raw_address', 'raw_county', 'raw_locality',
            'uat_siruta_code', 'uat_name', 'county_name', 'match_confidence',
            sql<string | null>`snapshot_at::date::text`.as('onrc_as_of'),
          ])
          .where('cui', '=', cui)
          .limit(1)
          .executeTakeFirst(),
        db
          .selectFrom('companies.fiscal_status')
          .select([
            'is_vat_payer', 'is_inactive', 'main_caen_code', 'registered_name',
            sql<string | null>`snapshot_at::date::text`.as('snapshot_at'),
          ])
          .where('cui', '=', cui)
          .limit(1)
          .executeTakeFirst(),
        db
          .selectFrom('companies.financials')
          .select(financialColumns())
          .where('cui', '=', cui)
          .orderBy('year', 'desc')
          .execute(),
        db
          .selectFrom('companies.caen_activities as ca')
          .leftJoin('core.classification_codes as cc', (join) =>
            join.onRef('cc.code', '=', 'ca.caen_code').on('cc.system', '=', sql`'caen_' || ca.caen_rev`)
          )
          .select(['ca.caen_code', 'ca.caen_rev', 'ca.source', 'cc.label'])
          .where('ca.cui', '=', cui)
          .orderBy('ca.caen_code', 'asc')
          .execute(),
        db
          .selectFrom('companies.representatives')
          .select(['name', 'role'])
          .where('cui', '=', cui)
          .orderBy('name', 'asc')
          .execute(),
        db
          .selectFrom('companies.status_flags')
          .select(['status_code', 'status_label'])
          .where('cui', '=', cui)
          .execute(),
        db
          .selectFrom('companies.eu_branches')
          .select(['branch_name', 'country', 'euid', 'fiscal_code'])
          .where('cui', '=', cui)
          .execute(),
      ]);

      const anafAsOf = fiscal?.snapshot_at ?? null;
      const onrcAsOf = reg?.onrc_as_of ?? null;

      const data: CompanyProfileData = {
        cui,
        orgId: org.org_id,
        name: org.name,
        legalForm: reg?.legal_form ?? null,
        codInmatriculare: reg?.cod_inmatriculare ?? null,
        registrationDate: reg?.registration_date ?? null,
        registrationDatePresent: (reg?.registration_date ?? null) !== null,
        headlineStatus: mapHeadlineStatus(reg?.status_code ?? null, reg?.status_label ?? null),
        statusFlags: flags.map(mapStatusFlag),
        territory:
          reg !== undefined
            ? mapTerritory({
                uat_siruta_code: reg.uat_siruta_code,
                uat_name: reg.uat_name,
                county_name: reg.county_name,
                match_confidence: reg.match_confidence,
              })
            : null,
        address: mapAddress({
          raw_address: reg?.raw_address ?? null,
          raw_county: reg?.raw_county ?? null,
          raw_locality: reg?.raw_locality ?? null,
        }),
        fiscal: mapFiscal(fiscal),
        caenActivities: caen.map(mapCaen),
        representatives: reps.map(mapRepresentative),
        financials: fin.map((r) => mapFinancialYear(r)),
        euBranches: branches.map(mapEuBranch),
        asOf: { onrc: onrcAsOf, anaf: anafAsOf },
      };
      return ok(data);
    } catch (error) {
      return err(databaseError('getProfileData failed', error));
    }
  };

  const getFinancials = async (rawCui: string): Promise<Result<readonly CompanyFinancialYear[], ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const rows = await db
        .selectFrom('companies.financials')
        .select(financialColumns())
        .where('cui', '=', cui)
        .orderBy('year', 'desc')
        .execute();
      return ok(rows.map((r) => mapFinancialYear(r)));
    } catch (error) {
      return err(databaseError('getFinancials failed', error));
    }
  };

  // ── list / filter ───────────────────────────────────────────────────────────
  const listCompanies = async (
    filter: FilterInput,
    sort: CompanySort,
    page: OffsetParams
  ): Promise<Result<CompanyListResult, ApiError>> => {
    const condsRes = buildListConditions(filter);
    if (condsRes.isErr()) return err(condsRes.error);
    const where = composeWhere(condsRes.value);
    try {
      const rows = await db
        .selectFrom('core.organizations as o')
        .leftJoin('companies.registrations as r', 'r.cui', 'o.cui')
        .leftJoin('companies.fiscal_status as f', 'f.cui', 'o.cui')
        .select(LIST_SELECT())
        .where(where)
        .orderBy(orderByFor(sort))
        .limit(page.pageSize)
        .offset(offsetFor(page))
        .execute();

      // Bounded total (§14.4): count over a LIMIT cap+1 subquery so a large
      // unfiltered list never scans 3.99M rows — `estimated` flags the cap.
      const countRow = await db
        .selectFrom(
          db
            .selectFrom('core.organizations as o')
            .leftJoin('companies.registrations as r', 'r.cui', 'o.cui')
            .leftJoin('companies.fiscal_status as f', 'f.cui', 'o.cui')
            .select(sql<number>`1`.as('one'))
            .where(where)
            .limit(LIST_TOTAL_CAP + 1)
            .as('capped')
        )
        .select(sql<string>`count(*)`.as('cnt'))
        .executeTakeFirst();
      const rawCount = Number(countRow?.cnt ?? 0);
      const estimated = rawCount > LIST_TOTAL_CAP;
      const total = estimated ? LIST_TOTAL_CAP : rawCount;

      return ok({ rows: rows.map(mapListRow), total, estimated });
    } catch (error) {
      return err(databaseError('listCompanies failed', error));
    }
  };

  // ── resolution / discovery ──────────────────────────────────────────────────
  const resolveByName = async (
    q: string,
    limit: number,
    meili: MeiliClient | null
  ): Promise<Result<{ hits: readonly CompanyNameHit[]; degraded: boolean }, ApiError>> => {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    // PRIMARY: Meili (company/organizations index). Degrade silently to pg on any error.
    if (meili !== null) {
      const m = await meili.multiSearch(q, ['organizations', 'companies'], capped);
      if (m.isOk()) {
        // Collect candidate CUIs (ordered by Meili score), then VALIDATE them
        // against core.organizations(kind='company') — the shared `organizations`
        // index also carries public entities, so a raw Meili hit may be a
        // non-company CUI (§link-not-merge: we only resolve to companies here).
        const ordered: { cui: string; label: string; score: number | null }[] = [];
        const seen = new Set<string>();
        for (const result of m.value) {
          for (const hit of result.hits) {
            const cui = typeof hit.attrs['cui'] === 'string' ? normalizeCui(hit.attrs['cui']) : null;
            if (cui === null || seen.has(cui)) continue;
            seen.add(cui);
            ordered.push({ cui, label: hit.title, score: hit.score });
          }
        }
        if (ordered.length > 0) {
          const valid = await db
            .selectFrom('core.organizations')
            .select(['cui', 'name'])
            .where('kind', '=', 'company')
            .where('cui', 'in', ordered.map((o) => o.cui))
            .execute();
          const nameByCui = new Map(valid.filter((v): v is { cui: string; name: string } => v.cui !== null).map((v) => [v.cui, v.name]));
          const hits = ordered
            .filter((o) => nameByCui.has(o.cui))
            .slice(0, capped)
            .map((o): CompanyNameHit => ({ dim: 'name', value: o.cui, label: nameByCui.get(o.cui) ?? o.label, cui: o.cui, confidence: o.score }));
          if (hits.length > 0) return ok({ hits, degraded: false });
        }
        // Meili reachable but no company hit (e.g. company index not built yet) → pg fallback.
      }
    }
    // DEGRADED fallback: capped, kind='company'-scoped, TS diacritic fold. No unaccent,
    // no trigram-index reliance; the LIMIT bounds the parallel seq scan (§15.7).
    const folded = foldDiacritics(q);
    if (folded === '') return ok({ hits: [], degraded: true });
    try {
      const needle = '%' + folded.replace(/[%_\\]/gu, '\\$&') + '%';
      const rows = await db
        .selectFrom('core.organizations')
        .select(['cui', 'name', 'normalized_name', 'county_name'])
        .where('kind', '=', 'company')
        .where('cui', 'is not', null)
        .where(sql<boolean>`coalesce(normalized_name, name) ilike ${needle} escape '\\'`)
        .limit(NAME_FALLBACK_SCAN)
        .execute();
      const ranked = rows
        .map((r) => {
          const hay = foldDiacritics(r.normalized_name ?? r.name);
          const idx = hay.indexOf(folded);
          const score = idx < 0 ? 0 : 1 / (1 + idx) + 1 / (1 + hay.length);
          return { r, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, capped)
        .map(({ r, score }): CompanyNameHit => ({
          dim: 'name',
          value: r.cui ?? '',
          label: r.name,
          cui: r.cui,
          confidence: score,
        }));
      return ok({ hits: ranked, degraded: true });
    } catch (error) {
      return err(databaseError('resolveByName fallback failed', error));
    }
  };

  const findByRegistrationNumber = async (cod: string): Promise<Result<readonly CompanyNameHit[], ApiError>> => {
    const value = cod.trim();
    if (value === '') return ok([]);
    try {
      // TWO-HOP: identifiers (scheme,value) → org_id, JOIN organizations (kind='company') → cui.
      // Returns a LIST (one-to-many — research finding 3).
      const rows = await db
        .selectFrom('core.organization_identifiers as oi')
        .innerJoin('core.organizations as o', 'o.org_id', 'oi.org_id')
        .select(['o.cui', 'o.name'])
        .where('oi.scheme', '=', REGNUM_SCHEME)
        .where('oi.value', '=', value)
        .where('o.kind', '=', 'company')
        .limit(50)
        .execute();
      return ok(
        rows
          .filter((r): r is { cui: string; name: string } => r.cui !== null)
          .map((r) => ({ dim: 'regnum', value: r.cui, label: r.name, cui: r.cui, confidence: null }))
      );
    } catch (error) {
      return err(databaseError('findByRegistrationNumber failed', error));
    }
  };

  const resolveCaen = async (label: string, limit: number): Promise<Result<readonly CaenCodeHit[], ApiError>> => {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    const pattern = '%' + label.replace(/[\\%_]/gu, (m) => `\\${m}`) + '%';
    try {
      const rows = await db
        .selectFrom('core.classification_codes')
        .select(['code', 'system', 'label'])
        .where(sql<boolean>`system like 'caen\\_%' escape '\\'`)
        .where(sql<boolean>`label ilike ${pattern} escape '\\'`)
        .limit(capped)
        .execute();
      return ok(
        rows.map((r) => ({ code: r.code, rev: r.system.replace(/^caen_/u, ''), label: r.label }))
      );
    } catch (error) {
      return err(databaseError('resolveCaen failed', error));
    }
  };

  const resolveCounty = async (q: string): Promise<Result<readonly string[], ApiError>> => {
    const folded = foldDiacritics(q);
    try {
      const rows = await db
        .selectFrom('companies.registrations')
        .select(['raw_county'])
        .where('raw_county', 'is not', null)
        .where(
          sql<boolean>`lower(translate(raw_county, ${FOLD_FROM}, ${FOLD_TO})) like ${'%' + folded.replace(/[%_\\]/gu, '\\$&') + '%'} escape '\\'`
        )
        .groupBy('raw_county')
        .orderBy('raw_county', 'asc')
        .limit(50)
        .execute();
      return ok(rows.map((r) => r.raw_county).filter((c): c is string => c !== null));
    } catch (error) {
      return err(databaseError('resolveCounty failed', error));
    }
  };

  // ── aggregates (count-ranked) ───────────────────────────────────────────────
  const countBy = async (
    groupBy: CompanyGroupBy,
    filter: FilterInput
  ): Promise<Result<{ groups: readonly CompanyGroupCount[]; denominator: number; coverage: CompanyCoverage }, ApiError>> => {
    // groupBy=county has no raw_county index → require a selective predicate.
    if (groupBy === 'county') {
      const gate = requireAggregateDriver(filter, COMPANY_AGGREGATE_DRIVING_FIELDS, 'county / status / caenCode');
      if (gate.isErr()) return err(gate.error);
    }
    const condsRes = buildListConditions(filter);
    if (condsRes.isErr()) return err(condsRes.error);
    const where = composeWhere(condsRes.value);

    try {
      let groups: CompanyGroupCount[];
      if (groupBy === 'status') {
        // count(distinct o.cui): the cui is unique in registrations, but DISTINCT
        // is the safe grain (no double-count if a future load adds rows).
        const rows = await db
          .selectFrom('core.organizations as o')
          .leftJoin('companies.registrations as r', 'r.cui', 'o.cui')
          .leftJoin('companies.fiscal_status as f', 'f.cui', 'o.cui')
          .select(['r.status_code as key', sql<string | null>`max(r.status_label)`.as('label'), sql<string>`count(distinct o.cui)`.as('cnt')])
          .where(where)
          .groupBy('r.status_code')
          .orderBy(sql`count(distinct o.cui) desc`)
          .limit(500)
          .execute();
        groups = rows.map((r) => ({ key: r.key ?? '(none)', label: r.label, count: Number(r.cnt) }));
      } else if (groupBy === 'caenDivision') {
        // The grouping join uses alias `cad` so it does NOT collide with the `ca`
        // the `caenCode` EXISTS subquery (in `where`) declares — otherwise the
        // EXISTS would bind to the wrong relation and bypass the filter (B1).
        const rows = await db
          .selectFrom('core.organizations as o')
          .leftJoin('companies.registrations as r', 'r.cui', 'o.cui')
          .leftJoin('companies.fiscal_status as f', 'f.cui', 'o.cui')
          .innerJoin('companies.caen_activities as cad', 'cad.cui', 'o.cui')
          .select([sql<string>`left(cad.caen_code, 2)`.as('key'), sql<string>`count(distinct o.cui)`.as('cnt')])
          .where(where)
          .groupBy(sql`left(cad.caen_code, 2)`)
          .orderBy(sql`count(distinct o.cui) desc`)
          .limit(500)
          .execute();
        groups = rows.map((r) => ({ key: r.key, label: null, count: Number(r.cnt) }));
      } else {
        // county
        const rows = await db
          .selectFrom('core.organizations as o')
          .leftJoin('companies.registrations as r', 'r.cui', 'o.cui')
          .leftJoin('companies.fiscal_status as f', 'f.cui', 'o.cui')
          .select(['r.raw_county as key', sql<string>`count(distinct o.cui)`.as('cnt')])
          .where(where)
          .groupBy('r.raw_county')
          .orderBy(sql`count(distinct o.cui) desc`)
          .limit(500)
          .execute();
        groups = rows.map((r) => ({ key: r.key ?? '(none)', label: null, count: Number(r.cnt) }));
      }

      const denominator = groups.reduce((s, g) => s + g.count, 0);
      const coverage: CompanyCoverage = {
        territoryMatched: null,
        territoryUnmatched: null,
        note: COMPANY_TERRITORY_COVERAGE_NOTE,
      };
      return ok({ groups, denominator, coverage });
    } catch (error) {
      return err(databaseError('countBy failed', error));
    }
  };

  // ── contributor support ─────────────────────────────────────────────────────
  const sliceSelect = () =>
    [
      'o.cui', 'o.name',
      'r.legal_form', 'r.status_code', 'r.status_label',
      sql<string | null>`r.registration_date::text`.as('registration_date'),
      'r.uat_siruta_code', 'r.uat_name', 'r.county_name', 'r.match_confidence',
      sql<string | null>`r.snapshot_at::date::text`.as('onrc_as_of'),
      'f.is_vat_payer', 'f.is_inactive',
      sql<string | null>`f.snapshot_at::date::text`.as('anaf_as_of'),
    ] as const;

  interface SliceRow {
    cui: string | null;
    name: string;
    legal_form: string | null;
    status_code: string | null;
    status_label: string | null;
    registration_date: string | null;
    uat_siruta_code: number | null;
    uat_name: string | null;
    county_name: string | null;
    match_confidence: string | null;
    onrc_as_of: string | null;
    is_vat_payer: boolean | null;
    is_inactive: boolean | null;
    anaf_as_of: string | null;
  }

  /** Pure assembly: the latest financial is fetched separately and passed in. */
  const sliceFromRow = (row: SliceRow, latestFin: FinancialRow | null): CompanyEntitySlice => ({
    cui: row.cui ?? '',
    name: row.name,
    legalForm: row.legal_form,
    headlineStatus: mapHeadlineStatus(row.status_code, row.status_label),
    vatPayer: row.is_vat_payer,
    declaredFiscallyInactive: row.is_inactive,
    registrationDate: row.registration_date,
    registrationDatePresent: row.registration_date !== null,
    territory: mapTerritory({
      uat_siruta_code: row.uat_siruta_code,
      uat_name: row.uat_name,
      county_name: row.county_name,
      match_confidence: row.match_confidence,
    }),
    latestFinancial: latestFin !== null ? mapFinancialYear(latestFin) : null,
    asOf: { onrc: row.onrc_as_of, anaf: row.anaf_as_of },
  });

  /** Latest financial year per CUI in ONE query (DISTINCT ON walks financials_pkey). */
  const latestFinancialsByCui = async (cuis: readonly string[]): Promise<Map<string, FinancialRow>> => {
    if (cuis.length === 0) return new Map();
    const rows = await db
      .selectFrom('companies.financials')
      .select(['cui', ...financialColumns()])
      .where('cui', 'in', [...cuis])
      .distinctOn('cui')
      .orderBy('cui')
      .orderBy('year', 'desc')
      .execute();
    const out = new Map<string, FinancialRow>();
    for (const r of rows) out.set(r.cui, r);
    return out;
  };

  const profileSlice = async (rawCui: string): Promise<Result<CompanyEntitySlice | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const row = await db
        .selectFrom('core.organizations as o')
        .leftJoin('companies.registrations as r', 'r.cui', 'o.cui')
        .leftJoin('companies.fiscal_status as f', 'f.cui', 'o.cui')
        .select(sliceSelect())
        .where('o.cui', '=', cui)
        .where('o.kind', '=', 'company')
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return ok(null);
      const latest = await latestFinancialsByCui([cui]);
      return ok(sliceFromRow(row, latest.get(cui) ?? null));
    } catch (error) {
      return err(databaseError('profileSlice failed', error));
    }
  };

  const profileSlicesForCuis = async (
    cuis: readonly string[]
  ): Promise<Result<ReadonlyMap<string, CompanyEntitySlice>, ApiError>> => {
    const normalized = [...new Set(cuis.map((c) => normalizeCui(c)).filter((c): c is string => c !== null))];
    if (normalized.length === 0) return ok(new Map());
    try {
      const [rows, latest] = await Promise.all([
        db
          .selectFrom('core.organizations as o')
          .leftJoin('companies.registrations as r', 'r.cui', 'o.cui')
          .leftJoin('companies.fiscal_status as f', 'f.cui', 'o.cui')
          .select(sliceSelect())
          .where('o.kind', '=', 'company')
          .where('o.cui', 'in', normalized)
          .execute(),
        latestFinancialsByCui(normalized),
      ]);
      const out = new Map<string, CompanyEntitySlice>();
      for (const row of rows) {
        if (row.cui === null) continue;
        out.set(row.cui, sliceFromRow(row, latest.get(row.cui) ?? null));
      }
      return ok(out);
    } catch (error) {
      return err(databaseError('profileSlicesForCuis failed', error));
    }
  };

  const presenceCounts = async (rawCui: string): Promise<Result<CompanyPresenceCounts | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const org = await db
        .selectFrom('core.organizations as o')
        .leftJoin('companies.registrations as r', 'r.cui', 'o.cui')
        .leftJoin('companies.fiscal_status as f', 'f.cui', 'o.cui')
        .select([
          'o.name', 'r.status_label',
          sql<string | null>`r.snapshot_at::date::text`.as('onrc_as_of'),
          sql<string | null>`f.snapshot_at::date::text`.as('anaf_as_of'),
        ])
        .where('o.cui', '=', cui)
        .where('o.kind', '=', 'company')
        .limit(1)
        .executeTakeFirst();
      if (org === undefined) return ok(null);
      const [fin, caen, reps] = await Promise.all([
        db.selectFrom('companies.financials').select(sql<string>`count(*)`.as('cnt')).where('cui', '=', cui).executeTakeFirst(),
        db.selectFrom('companies.caen_activities').select(sql<string>`count(*)`.as('cnt')).where('cui', '=', cui).executeTakeFirst(),
        db.selectFrom('companies.representatives').select(sql<string>`count(*)`.as('cnt')).where('cui', '=', cui).executeTakeFirst(),
      ]);
      return ok({
        cui,
        name: org.name,
        headlineStatus: org.status_label,
        financials: Number(fin?.cnt ?? 0),
        caenActivities: Number(caen?.cnt ?? 0),
        representatives: Number(reps?.cnt ?? 0),
        onrcAsOf: org.onrc_as_of,
        anafAsOf: org.anaf_as_of,
      });
    } catch (error) {
      return err(databaseError('presenceCounts failed', error));
    }
  };

  return {
    getProfileData,
    getFinancials,
    listCompanies,
    resolveByName,
    findByRegistrationNumber,
    resolveCaen,
    resolveCounty,
    countBy,
    profileSlice,
    presenceCounts,
    profileSlicesForCuis,
  };
};
