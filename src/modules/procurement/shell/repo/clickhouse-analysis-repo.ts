/**
 * ClickHouse-backed `AnalysisRepo` — DEV iteration path (2026-07-22).
 *
 * Reads the prototype wide fact tables (`proto.facts_*_v2` on the chronos
 * CHI; see scrapper `prod-db/ch-prototype/`) over the plain-HTTP interface,
 * through the private Chronos Tailscale endpoint for local development.
 * Enabled by `PROD_CLICKHOUSE_URL`; when unset the module keeps the Postgres
 * rollup repo and nothing here is loaded.
 *
 * Contract fidelity notes (mirrors `analysis-repo.ts` semantics):
 *  - months are 'YYYY-MM'; the undated bucket (date_basis IS NULL) is
 *    selectable in the same statement and never counted in dated aggregates;
 *  - all monetary outputs are RON decimal strings; ClickHouse returns exact
 *    Int128 bani strings and the conversion is BigInt (never float);
 *  - sums are NULL (never zero) when the contributing set is empty;
 *  - `withValue` = accepted value_state count (pinned set below);
 *  - distincts: supplier = high-confidence identity keys, authority =
 *    non-null CUI (F14 checksum validation is a deferred export-lane item —
 *    see scrapper `prod-db/ch-prototype/DEFERRED_ISSUES.md` #2);
 *  - `activeGeneration()` delegates to the Postgres repo so buildId, quality
 *    verdicts and matrix hash stay honest — ClickHouse is a projection.
 *
 * DEV-ONLY shortcuts (accepted for the iteration slice, not production):
 *  - scope values are escaped and inlined (parsed/validated upstream);
 *    the production loader/serving path binds parameters;
 *  - breakdown derives `other` by exact BigInt subtraction over immutable
 *    facts. Concurrent identical statements are single-flighted, and compact
 *    HTTP rows are reconstructed only after their envelope is validated.
 */

import { Type, type Static, type TObject } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type Logger } from '@/modules/shared/index.js';

import { TOPN_SIRUTA_MAX, type MeasureId, type SeriesBucket } from '../../core/constants.js';

import type { AnalysisScope } from '../../core/analysis-scope.js';
import type { AnalysisRoute } from '../../core/combinations.js';
import type { BasisCoverageRow } from '../../core/gate-v2.js';
import type {
  AnalysisBreakdownBucketRow,
  AnalysisBreakdownRead,
  AnalysisRepo,
  AnalysisStatsRead,
  ConcentrationRead,
} from '../../core/ports.js';

export interface ClickhouseAnalysisConfig {
  /** Base URL of the ClickHouse HTTP interface, e.g. http://localhost:58123 */
  readonly url: string;
  /** Database holding the wide fact tables (default: proto). */
  readonly database: string;
  readonly user?: string;
  readonly password?: string;
}

/** Pinned accepted value_state set (semantic-artifact stand-in; measured 2026-07-22). */
const ACCEPTED_STATES = ["'official_exact'", "'official_ron_equivalent'"].join(', ');

const TABLE_BY_GRAIN: Record<string, string> = {
  contract: 'facts_contracts_v2',
  direct_acquisition: 'facts_da_v2',
  procedure: 'facts_procedures_v2',
  framework: 'facts_frameworks_v2',
  calloff: 'facts_calloffs_v2',
  modification: 'facts_contract_mods_v2',
};

/**
 * Per-grain SQL profile (value-basis wave, design v1.1): each grain's base
 * population predicate, its money-acceptance predicate + anchor column, and
 * the optional per-basis columns. Bases are never interchangeable — every
 * money expression pairs ONE column with ITS acceptance predicate.
 */
interface GrainSqlProfile {
  /** Base population conds (core grains: canonical + non-cancelled). */
  readonly base: readonly string[];
  /** Acceptance predicate of the grain's ANCHOR money (withValue counts it). */
  readonly accept: string;
  /** Anchor money column (awarded / ceiling / call-off value); null = counts-only. */
  readonly anchorCol: string | null;
  /** Which stats-read field the anchor money feeds. */
  readonly anchorField: 'awarded' | 'ceiling';
  /** Estimated basis (core grains): applicability + outlier-quarantine gated. */
  readonly estimated?: { readonly col: string; readonly accept: string };
  /** Mod-adjusted basis (contract grain only). */
  readonly modAdjusted?: { readonly col: string; readonly accept: string };
  /** Distinct-supplier key expression (differs where identity keys are absent). */
  readonly supplierDistinctExpr?: string;
  /**
   * Association-withheld disclosure (user decision 2026-07-25, codex review
   * finding 2): on supplier-money profiles, the scope-exact withheld mass =
   * Σ attributed − Σ supplier over the same population. Present ONLY on the
   * supplier variant — its non-null read result doubles as the "this was a
   * supplier-money read" signal for the usecase caveats.
   */
  readonly withheldFrom?: { readonly col: string; readonly accept: string };
}

/** High-confidence supplier identity (mirrors spec F14 supplier rule). */
const SUPPLIER_KEY_VALID =
  "(supplier_identity_key IS NOT NULL AND ifNull(supplier_identity_confidence, '') = 'high')";

const CORE_BASE = ['is_canonical', "(status IS NULL OR status != 'cancelled')"] as const;
const CORE_ACCEPT = `value_state IN (${ACCEPTED_STATES})`;
const ESTIMATED_ACCEPT = "estimated_applicable AND estimated_quality = 'ok'";

const GRAIN_SQL: Record<string, GrainSqlProfile> = {
  direct_acquisition: {
    base: CORE_BASE,
    accept: CORE_ACCEPT,
    anchorCol: 'value_awarded_bani',
    anchorField: 'awarded',
    estimated: { col: 'value_estimated_bani', accept: ESTIMATED_ACCEPT },
    supplierDistinctExpr: `uniqExactIf(supplier_identity_key, ${SUPPLIER_KEY_VALID})`,
  },
  procedure: {
    base: CORE_BASE,
    accept: CORE_ACCEPT,
    anchorCol: 'value_awarded_bani',
    anchorField: 'awarded',
    estimated: { col: 'value_estimated_bani', accept: ESTIMATED_ACCEPT },
  },
  framework: {
    base: [],
    accept: "ceiling_attribution = 'attributed'",
    anchorCol: 'value_ceiling_bani',
    anchorField: 'ceiling',
  },
  calloff: {
    base: [],
    accept: 'value_bani IS NOT NULL',
    anchorCol: 'value_bani',
    anchorField: 'awarded',
    supplierDistinctExpr: 'uniqExactIf(supplier_cui, supplier_cui IS NOT NULL)',
  },
  modification: {
    base: [],
    accept: '0',
    anchorCol: null,
    anchorField: 'awarded',
  },
};

/**
 * Contract-grain money serves the ASSOCIATION-ATTRIBUTED columns
 * (PROCUREMENT_ASSOCIATION_DEDUP_DESIGN r3, locked 2026-07-25): consortium
 * awards are published once per member with the full value on each row, so
 * raw value_awarded_bani multi-counts ~30% of the national total. Exactly
 * one row per award group carries value_awarded_attributed_bani; acceptance
 * IS the non-NULL carrier test (the data layer's gates guarantee
 * carrier ⊆ accepted states). withValue therefore counts value-bearing
 * AWARDS, not member observations (M3 law).
 */
const CONTRACT_PROFILE: GrainSqlProfile = {
  base: CORE_BASE,
  accept: 'value_awarded_attributed_bani IS NOT NULL',
  anchorCol: 'value_awarded_attributed_bani',
  anchorField: 'awarded',
  estimated: { col: 'value_estimated_bani', accept: ESTIMATED_ACCEPT },
  modAdjusted: {
    col: 'value_mod_adjusted_attributed_bani',
    accept: 'value_mod_adjusted_attributed_bani IS NOT NULL',
  },
  supplierDistinctExpr: `uniqExactIf(supplier_identity_key, ${SUPPLIER_KEY_VALID})`,
};

/**
 * Supplier-dimension variant (user decision D3=C): named-supplier money
 * NEVER includes multi-member association money — shares are unobservable.
 * value_awarded_supplier_bani carries single awards + single-member
 * duplicate groups only; the withheld association mass is disclosed, not
 * silently reassigned. Selected for supplier-scoped requests, supplier-keyed
 * breakdowns, and concentration.
 */
// Mod-adjusted money exists only at the ATTRIBUTED grain — mixing it with
// supplier money would compare different populations (review finding 1).
// Supplier-scoped requests abstain on the mod-adjusted basis entirely
// (the key is OMITTED, not undefined — exactOptionalPropertyTypes).
// eslint-disable-next-line @typescript-eslint/naming-convention -- the underscore marks the deliberately omitted key, never referenced again
const { modAdjusted: _contractModAdjusted, ...CONTRACT_PROFILE_NO_MOD } = CONTRACT_PROFILE;
const CONTRACT_SUPPLIER_PROFILE: GrainSqlProfile = {
  ...CONTRACT_PROFILE_NO_MOD,
  accept: 'value_awarded_supplier_bani IS NOT NULL',
  anchorCol: 'value_awarded_supplier_bani',
  withheldFrom: {
    col: 'value_awarded_attributed_bani',
    accept: 'value_awarded_attributed_bani IS NOT NULL',
  },
};

const profileFor = (grain: string, supplierMoney = false): GrainSqlProfile =>
  GRAIN_SQL[grain] ?? (supplierMoney ? CONTRACT_SUPPLIER_PROFILE : CONTRACT_PROFILE);

/**
 * Per-grain column overrides: modifications expose the LINKED contract's
 * CPV division / record kind (enrichment columns; 95.6% / 99.9% populated).
 * Applies to both scope compilation and breakdown grouping.
 */
const GRAIN_COLUMN_OVERRIDES: Record<string, Record<string, string>> = {
  modification: {
    cpv_division: 'linked_cpv_division',
    record_kind: 'linked_record_kind',
    cpvDivision: 'linked_cpv_division',
    recordKind: 'linked_record_kind',
  },
};

const grainColumn = (grain: string, column: string): string =>
  GRAIN_COLUMN_OVERRIDES[grain]?.[column] ?? column;

/** Grains that structurally have no supplier columns. */
const SUPPLIERLESS_GRAINS = new Set(['procedure', 'framework']);

const DIM_COLUMNS: readonly (readonly [keyof AnalysisScope, string])[] = [
  ['authorityCui', 'authority_cui'],
  ['supplierCui', 'supplier_cui'],
  ['cpvDivision', 'cpv_division'],
  ['cpvCode', 'cpv_code'],
  ['buyerCounty', 'buyer_county_code'],
  ['buyerRegion', 'buyer_region'],
  ['supplierCounty', 'supplier_county_code'],
  ['supplierRegion', 'supplier_region'],
  ['status', 'status'],
  ['procedureType', 'procedure_type'],
  ['recordKind', 'record_kind'],
];

/**
 * CPV hierarchy scopes: canonical 8-digit level codes (validated upstream),
 * compiled as a cpv_code prefix match at the level's digit length.
 */
const CPV_PREFIX_SCOPES: readonly (readonly ['cpvGroup' | 'cpvClass' | 'cpvCategory', number])[] = [
  ['cpvGroup', 3],
  ['cpvClass', 4],
  ['cpvCategory', 5],
];

const SUPPLIER_SCOPE_FIELDS: readonly (keyof AnalysisScope)[] = [
  'supplierCui',
  'supplierCounty',
  'supplierRegion',
  'supplierSiruta',
];

/** A supplier-scoped request must aggregate supplier-attributable money. */
const supplierScoped = (scope: AnalysisScope): boolean =>
  SUPPLIER_SCOPE_FIELDS.some((field) => scope[field] !== undefined);

/** Breakdown dimensions keyed on the supplier — same money rule applies. */
const SUPPLIER_BREAKDOWN_DIMS: ReadonlySet<string> = new Set([
  'supplier',
  'supplierRegion',
  'supplierCounty',
  'supplierSiruta',
]);

const BREAKDOWN_DIM_COLUMNS: Record<string, string> = {
  authority: 'authority_cui',
  // PG-parity: breakdown/concentration keys are bare supplier CUIs (client
  // supplier links resolve by CUI). Identity keys remain the DISTINCTS rule.
  supplier: 'supplier_cui',
  cpvDivision: 'cpv_division',
  // CPV level buckets key on the CANONICAL 8-digit level code (prefix +
  // trailing zeros) so the exact-match cpv_codes label loader serves them.
  // A record coded at a COARSER level (zero level digit, e.g. 45000000 in a
  // group breakdown) belongs to no bucket at this level → NULL → unknown;
  // NULL/malformed cpv_code follows the same path.
  cpvGroup:
    "if(length(cpv_code) = 8 AND substring(cpv_code, 3, 1) != '0', concat(substring(cpv_code, 1, 3), '00000'), NULL)",
  cpvClass:
    "if(length(cpv_code) = 8 AND substring(cpv_code, 4, 1) != '0', concat(substring(cpv_code, 1, 4), '0000'), NULL)",
  cpvCategory:
    "if(length(cpv_code) = 8 AND substring(cpv_code, 5, 1) != '0', concat(substring(cpv_code, 1, 5), '000'), NULL)",
  cpvCode: 'cpv_code',
  status: 'status',
  procedureType: 'procedure_type',
  recordKind: 'record_kind',
  buyerRegion: 'buyer_region',
  buyerCounty: 'buyer_county_code',
  buyerSiruta: 'toString(buyer_siruta_uat)',
  supplierRegion: 'supplier_region',
  supplierCounty: 'supplier_county_code',
  supplierSiruta: 'toString(supplier_siruta_uat)',
};

/** PG label parity: 'YYYY-MM' / 'YYYY-Qn' / 'YYYY' (analysis-repo.ts). */
const BUCKET_LABEL: Record<SeriesBucket, string> = {
  month: "formatDateTime(date_basis, '%Y-%m')",
  quarter: "concat(toString(toYear(date_basis)), '-Q', toString(toQuarter(date_basis)))",
  year: 'toString(toYear(date_basis))',
};

const escapeString = (value: string): string =>
  `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Exact scaled-integer string → decimal string, without float conversion. */
const scaledIntegerToDecimal = (
  raw: string | null | undefined,
  decimalPlaces: number
): string | null => {
  if (raw === null || raw === undefined) return null;
  const v = BigInt(raw);
  const scale = 10n ** BigInt(decimalPlaces);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  return `${sign}${(abs / scale).toString()}.${(abs % scale)
    .toString()
    .padStart(decimalPlaces, '0')}`;
};

/** Exact bani (Int64/Int128 decimal string) → RON decimal string. */
const baniToRon = (bani: string | null | undefined): string | null =>
  scaledIntegerToDecimal(bani, 2);

/** Exact bani² (Decimal256 scale 0 string) → RON² decimal string. */
const baniSquaredToRonSquared = (baniSquared: string): string =>
  scaledIntegerToDecimal(baniSquared, 4) ?? '0.0000';

interface CompiledScope {
  readonly table: string;
  /** Full row-selection predicate: dims AND (dated-window OR undated). */
  readonly where: string;
  /** Predicate marking rows that belong to the dated aggregates. */
  readonly dated: string;
  /** True when the scope can never match (structural N/A, e.g. supplier dims on procedures). */
  readonly impossible: boolean;
  /**
   * True when the request carries a time window. `where` then deliberately
   * keeps undated rows (they feed the disclosure counts) while `dated` drives
   * every period measure — so any GROUPED read must additionally require at
   * least one dated row per key, or a key present only outside the window
   * surfaces as a zero-record bucket (see `datedGroupHaving`).
   */
  readonly bounded: boolean;
}

const compileScope = (
  route: AnalysisRoute,
  scope: AnalysisScope,
  supplierMoney = false
): CompiledScope => {
  const grain = route.grain;
  const table = TABLE_BY_GRAIN[grain] ?? 'facts_contracts_v2';
  const profile = profileFor(grain, supplierMoney);
  // Value-contract rule (frozen facts, 2026-07-22): cancelled records are
  // excluded from every transaction/spend measure on the CORE grains. The
  // value-basis populations serve their full row set (no canonicality/status
  // columns exist there).
  const conds: string[] = [...profile.base];
  if (conds.length === 0) conds.push('1');
  let impossible = false;

  if (SUPPLIERLESS_GRAINS.has(grain)) {
    for (const field of SUPPLIER_SCOPE_FIELDS) {
      if (scope[field] !== undefined) impossible = true;
    }
  }
  for (const [field, column] of DIM_COLUMNS) {
    const value = scope[field];
    if (typeof value === 'string' && value !== '') {
      conds.push(`${grainColumn(grain, column)} = ${escapeString(value)}`);
    }
  }
  // SIRUTA scopes target numeric UAT columns; non-numeric input can never
  // match (SIRUTA codes are digits) and compiles to an impossible predicate.
  const sirutaScopes = [
    ['buyerSiruta', 'buyer_siruta_uat'],
    ['supplierSiruta', 'supplier_siruta_uat'],
  ] as const;
  for (const [field, column] of sirutaScopes) {
    const value = scope[field];
    if (typeof value !== 'string' || value === '') continue;
    if (/^\d{1,7}$/.test(value)) {
      conds.push(`${column} = ${String(Number(value))}`);
    } else {
      impossible = true;
    }
  }

  for (const [field, prefixLen] of CPV_PREFIX_SCOPES) {
    const value = scope[field];
    if (typeof value !== 'string' || value === '') continue;
    conds.push(`startsWith(ifNull(cpv_code, ''), ${escapeString(value.slice(0, prefixLen))})`);
  }

  if (scope.q !== undefined && scope.q !== '') {
    const rowMatch = `positionCaseInsensitiveUTF8(ifNull(title, ''), ${escapeString(scope.q)}) > 0`;
    // Group-aware q (assoc design §4.3): an association's money sits on ONE
    // carrier row, but the searched title may live on a sibling member row
    // (multi-title groups measured 481). A row also matches when any row of
    // its award group matches.
    conds.push(
      table === 'facts_contracts_v2'
        ? `(${rowMatch} OR award_key IN (SELECT award_key FROM ${table} WHERE award_key IS NOT NULL AND ${rowMatch}))`
        : rowMatch
    );
  }

  // Value bounds restrict the ROW population to the grain's ANCHOR money in
  // range ("contracts over X RON" / "frameworks with ceiling over X"); RON →
  // bani is exact at 2 decimals. Counts-only grains reject bounds upstream.
  if (
    (scope.valueMin !== undefined || scope.valueMax !== undefined) &&
    profile.anchorCol !== null
  ) {
    conds.push(profile.accept);
    if (scope.valueMin !== undefined) {
      conds.push(`${profile.anchorCol} >= ${String(Math.round(scope.valueMin * 100))}`);
    }
    if (scope.valueMax !== undefined) {
      conds.push(`${profile.anchorCol} <= ${String(Math.round(scope.valueMax * 100))}`);
    }
  }

  const bounds: string[] = [];
  if (scope.year !== undefined) {
    bounds.push(`date_basis >= toDate('${String(scope.year)}-01-01')`);
    bounds.push(`date_basis < toDate('${String(scope.year + 1)}-01-01')`);
  } else {
    if (scope.from !== undefined) bounds.push(`date_basis >= toDate('${scope.from}-01')`);
    if (scope.to !== undefined) {
      bounds.push(`date_basis < addMonths(toDate('${scope.to}-01'), 1)`);
    }
  }
  // PG parity (analysis-repo.ts compileScope): with no time bounds the dated
  // predicate is TRUE — headline aggregates include undated rows; a bounded
  // window prunes undated from the dated aggregates only.
  const bounded = bounds.length > 0;
  const dated = bounded ? `(NOT is_undated AND ${bounds.join(' AND ')})` : '1';
  conds.push(`(${dated} OR is_undated)`);

  return { table, where: conds.join(' AND '), dated, impossible, bounded };
};

/**
 * The GROUP BY guard for dimension keys in a BOUNDED period. `where` keeps
 * undated rows so the disclosure counts stay whole, but a key represented ONLY
 * by undated rows is not present in the requested period at all: it must not
 * take a top-N slot, and it must not be counted as a distinct supplier. Keys
 * with dated rows and no accepted money stay (they are count-capable answers).
 *
 * Unbounded scopes keep their documented all-time semantics — every row is
 * "dated" there, so no guard is emitted.
 */
const datedGroupHaving = (c: CompiledScope): string =>
  c.bounded ? `HAVING countIf(${c.dated}) > 0` : '';

const EMPTY_STATS: AnalysisStatsRead = {
  rows: '0',
  withValue: '0',
  withEstimated: '0',
  valueAwardedSum: null,
  valueEstimatedSum: null,
  valueCeilingSum: null,
  valueModAdjustedSum: null,
  valueAwardedMatchedSum: null,
  minMonth: null,
  maxMonth: null,
  undatedCount: '0',
  undatedValueRon: null,
  valueWithheldAssociationSum: null,
};

const IntegerStringSchema = Type.String({ pattern: '^-?[0-9]+$' });
const CountStringSchema = Type.String({ pattern: '^[0-9]+$' });
const NullableIntegerStringSchema = Type.Union([IntegerStringSchema, Type.Null()]);
const NullableMonthSchema = Type.Union([
  Type.String({ pattern: '^[0-9]{4}-[0-9]{2}$' }),
  Type.Null(),
]);

const RawStatsRowSchema = Type.Object(
  {
    rows: CountStringSchema,
    with_value: CountStringSchema,
    with_estimated: CountStringSchema,
    awarded_bani_out: NullableIntegerStringSchema,
    estimated_bani_out: NullableIntegerStringSchema,
    ceiling_bani_out: NullableIntegerStringSchema,
    mod_adjusted_bani_out: NullableIntegerStringSchema,
    awarded_matched_bani_out: NullableIntegerStringSchema,
    min_month: NullableMonthSchema,
    max_month: NullableMonthSchema,
    undated_count: CountStringSchema,
    undated_bani_out: NullableIntegerStringSchema,
    withheld_bani_out: NullableIntegerStringSchema,
  },
  { additionalProperties: false }
);

const RawSeriesRowSchema = Type.Object(
  {
    month: NullableMonthSchema,
    value: NullableIntegerStringSchema,
    record_count: CountStringSchema,
    with_value: CountStringSchema,
    awarded_bani_out: NullableIntegerStringSchema,
  },
  { additionalProperties: false }
);

const RawDistinctSeriesRowSchema = Type.Object(
  {
    bucket: Type.Union([Type.String(), Type.Null()]),
    value: CountStringSchema,
    record_count: CountStringSchema,
    with_value: CountStringSchema,
    awarded_bani_out: NullableIntegerStringSchema,
  },
  { additionalProperties: false }
);

const RawUnknownBucketRowSchema = Type.Object(
  {
    cnt: CountStringSchema,
    wv: CountStringSchema,
    awarded_bani: IntegerStringSchema,
  },
  { additionalProperties: false }
);

const RawBucketRowSchema = Type.Object(
  {
    key: Type.String(),
    cnt: CountStringSchema,
    wv: CountStringSchema,
    awarded_bani: IntegerStringSchema,
  },
  { additionalProperties: false }
);

const RawConcentrationRowSchema = Type.Object(
  {
    supplier_count: CountStringSchema,
    positive_supplier_count: CountStringSchema,
    measure_total: CountStringSchema,
    top1_measure: CountStringSchema,
    top5_measure: CountStringSchema,
    measure_squared_sum: CountStringSchema,
    unknown_measure: IntegerStringSchema,
  },
  { additionalProperties: false }
);

const BasisCoverageRowSchema = Type.Object(
  {
    grain: Type.String(),
    basis: Type.String(),
    population: Type.String(),
    coverage: Type.Number(),
  },
  { additionalProperties: false }
);

const ClickhouseCompactResponseSchema = Type.Object(
  {
    meta: Type.Array(
      Type.Object({
        name: Type.String(),
        type: Type.String(),
      })
    ),
    data: Type.Array(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true }
);

const compactRows = <S extends TObject>(
  payload: unknown,
  rowSchema: S
): Result<readonly Static<S>[], ApiError> => {
  if (!Value.Check(ClickhouseCompactResponseSchema, payload)) {
    return err(databaseError('clickhouse returned an invalid JSONCompact response'));
  }
  const names = payload.meta.map((column) => column.name);
  if (new Set(names).size !== names.length) {
    return err(databaseError('clickhouse returned duplicate JSONCompact column names'));
  }
  const expectedNames = Object.keys(rowSchema.properties);
  if (
    names.length !== expectedNames.length ||
    expectedNames.some((name) => !names.includes(name))
  ) {
    return err(databaseError('clickhouse returned unexpected JSONCompact columns'));
  }
  const rows: Static<S>[] = [];
  for (const values of payload.data) {
    if (values.length !== names.length) {
      return err(databaseError('clickhouse returned a malformed JSONCompact row'));
    }
    const row: unknown = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    if (!Value.Check(rowSchema, row)) {
      return err(databaseError('clickhouse returned an invalid JSONCompact row'));
    }
    rows.push(row);
  }
  return ok(rows);
};

export const makeClickhouseAnalysisRepo = (
  config: ClickhouseAnalysisConfig,
  activeGeneration: AnalysisRepo['activeGeneration'],
  logger?: Logger
): AnalysisRepo => {
  const inFlightQueries = new Map<string, Promise<Result<readonly unknown[], ApiError>>>();

  const runQuery = async <S extends TObject>(
    sql: string,
    rowSchema: S
  ): Promise<Result<readonly Static<S>[], ApiError>> => {
    const startedAt = performance.now();
    try {
      const url = new URL(config.url);
      url.searchParams.set('database', config.database);
      const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
      if (config.user !== undefined) headers['X-ClickHouse-User'] = config.user;
      if (config.password !== undefined) headers['X-ClickHouse-Key'] = config.password;
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: `${sql} FORMAT JSONCompact`,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const body = await response.text();
        logger?.error(
          { status: response.status, body: body.slice(0, 500) },
          'clickhouse query failed'
        );
        return err(
          databaseError(`clickhouse HTTP ${String(response.status)}: ${body.slice(0, 300)}`)
        );
      }
      const parsed: unknown = await response.json();
      const rows = compactRows(parsed, rowSchema);
      if (rows.isOk()) {
        const contentLength = response.headers.get('content-length');
        const parsedContentLength = contentLength === null ? null : Number(contentLength);
        logger?.debug(
          {
            elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
            responseBytes:
              parsedContentLength !== null && Number.isFinite(parsedContentLength)
                ? parsedContentLength
                : null,
            rows: rows.value.length,
            format: 'JSONCompact',
          },
          'clickhouse query completed'
        );
      }
      return rows;
    } catch (error) {
      logger?.error({ error: String(error) }, 'clickhouse query error');
      return err(databaseError(`clickhouse unreachable: ${String(error)}`));
    }
  };

  const query = <S extends TObject>(
    sql: string,
    rowSchema: S
  ): Promise<Result<readonly Static<S>[], ApiError>> => {
    const pending = inFlightQueries.get(sql);
    if (pending !== undefined) {
      return pending as Promise<Result<readonly Static<S>[], ApiError>>;
    }
    const started = runQuery(sql, rowSchema).finally(() => {
      inFlightQueries.delete(sql);
    });
    inFlightQueries.set(sql, started);
    return started;
  };

  const statsSelect = (p: GrainSqlProfile, dated: string): string => {
    // Null law (assoc review finding 3): a sum is NULL when no row satisfies
    // the MONEY predicate — an association-only supplier scope must answer
    // "withheld", never "0.00".
    const moneySum = (col: string, accept: string): string =>
      `if(countIf(${dated} AND ${accept}) = 0, NULL, toString(sumIf(toInt128(${col}), ${dated} AND ${accept})))`;
    const anchorSum = p.anchorCol === null ? 'NULL' : moneySum(p.anchorCol, p.accept);
    return `
      toString(countIf(${dated})) AS rows,
      toString(countIf(${dated} AND ${p.accept})) AS with_value,
      toString(${p.estimated === undefined ? '0' : `countIf(${dated} AND ${p.estimated.accept} AND ${p.estimated.col} IS NOT NULL)`}) AS with_estimated,
      ${p.anchorField === 'awarded' ? anchorSum : 'NULL'} AS awarded_bani_out,
      ${p.estimated === undefined ? 'NULL' : moneySum(p.estimated.col, `${p.estimated.accept} AND ${p.estimated.col} IS NOT NULL`)} AS estimated_bani_out,
      ${p.anchorField === 'ceiling' ? anchorSum : 'NULL'} AS ceiling_bani_out,
      ${p.modAdjusted === undefined ? 'NULL' : moneySum(p.modAdjusted.col, p.modAdjusted.accept)} AS mod_adjusted_bani_out,
      ${
        p.modAdjusted === undefined || p.anchorCol === null
          ? 'NULL'
          : moneySum(p.anchorCol, p.modAdjusted.accept)
      } AS awarded_matched_bani_out,
      if(countIf(${dated} AND NOT is_undated) = 0, NULL,
         formatDateTime(minIf(date_basis, ${dated} AND NOT is_undated), '%Y-%m')) AS min_month,
      if(countIf(${dated} AND NOT is_undated) = 0, NULL,
         formatDateTime(maxIf(date_basis, ${dated} AND NOT is_undated), '%Y-%m')) AS max_month,
      ${
        p.withheldFrom === undefined || p.anchorCol === null
          ? 'NULL'
          : `if(countIf(${dated} AND ${p.withheldFrom.accept}) = 0, NULL,
         toString(ifNull(sumIf(toInt128(${p.withheldFrom.col}), ${dated} AND ${p.withheldFrom.accept}), 0)
                - ifNull(sumIf(toInt128(${p.anchorCol}), ${dated} AND ${p.accept}), 0)))`
      } AS withheld_bani_out,
      toString(countIf(is_undated)) AS undated_count,
      ${
        p.anchorCol === null
          ? 'NULL'
          : `if(countIf(is_undated AND ${p.accept}) = 0, NULL,
         toString(sumIf(toInt128(${p.anchorCol}), is_undated AND ${p.accept})))`
      } AS undated_bani_out`;
  };

  type RawStats = Static<typeof RawStatsRowSchema>;

  const toStats = (row: RawStats | undefined): AnalysisStatsRead =>
    row === undefined
      ? EMPTY_STATS
      : {
          rows: row.rows,
          withValue: row.with_value,
          withEstimated: row.with_estimated,
          valueAwardedSum: baniToRon(row.awarded_bani_out),
          valueEstimatedSum: baniToRon(row.estimated_bani_out),
          valueCeilingSum: baniToRon(row.ceiling_bani_out),
          valueModAdjustedSum: baniToRon(row.mod_adjusted_bani_out),
          valueAwardedMatchedSum: baniToRon(row.awarded_matched_bani_out),
          minMonth: row.min_month,
          maxMonth: row.max_month,
          undatedCount: row.undated_count,
          undatedValueRon: baniToRon(row.undated_bani_out),
          valueWithheldAssociationSum: baniToRon(row.withheld_bani_out),
        };

  const statsCore = async (
    route: AnalysisRoute,
    scope: AnalysisScope,
    supplierMoney: boolean
  ): Promise<Result<AnalysisStatsRead, ApiError>> => {
    const c = compileScope(route, scope, supplierMoney);
    if (c.impossible) return ok(EMPTY_STATS);
    const r = await query(
      `SELECT ${statsSelect(profileFor(route.grain, supplierMoney), c.dated)} FROM ${c.table} WHERE ${c.where}`,
      RawStatsRowSchema
    );
    return r.map((rows) => toStats(rows[0]));
  };

  const statsFor: AnalysisRepo['statsFor'] = async (route, scope, _buildId) =>
    statsCore(route, scope, supplierScoped(scope));

  const measureExpr = (
    grain: string,
    measure: MeasureId,
    dated: string,
    supplierMoney = false
  ): string | null => {
    const p = profileFor(grain, supplierMoney);
    const moneySum = (col: string, accept: string): string =>
      `if(countIf(${dated} AND ${accept}) = 0, NULL, toString(sumIf(toInt128(${col}), ${dated} AND ${accept})))`;
    switch (measure) {
      case 'recordCount':
        return `toString(countIf(${dated}))`;
      case 'withValueCount':
        return `toString(countIf(${dated} AND ${p.accept}))`;
      case 'valueAwardedSum':
        return p.anchorField === 'awarded' && p.anchorCol !== null
          ? moneySum(p.anchorCol, p.accept)
          : null;
      case 'valueCeilingSum':
        return p.anchorField === 'ceiling' && p.anchorCol !== null
          ? moneySum(p.anchorCol, p.accept)
          : null;
      case 'valueModAdjustedSum':
        return p.modAdjusted === undefined
          ? null
          : moneySum(p.modAdjusted.col, p.modAdjusted.accept);
      // valueAwardedMatchedSum is deliberately absent: policy declares it for
      // `stats` only, and statsSelect computes it directly. Implementing it
      // here would sit outside MONETARY_MEASURES, so enabling series later
      // would emit bani labelled as RON — a silent 100× error.
      case 'valueEstimatedSum':
        return p.estimated === undefined
          ? null
          : moneySum(p.estimated.col, `${p.estimated.accept} AND ${p.estimated.col} IS NOT NULL`);
      default:
        return null;
    }
  };

  /** Monetary measures come back as bani and need RON conversion. */
  const MONETARY_MEASURES: ReadonlySet<MeasureId> = new Set([
    'valueAwardedSum',
    'valueEstimatedSum',
    'valueCeilingSum',
    'valueModAdjustedSum',
  ]);

  const seriesFor: AnalysisRepo['seriesFor'] = async (route, scope, _buildId, measure) => {
    const sup = supplierScoped(scope);
    const c = compileScope(route, scope, sup);
    const p = profileFor(route.grain, sup);
    if (c.impossible) return ok([]);
    const expr = measureExpr(route.grain, measure, 'NOT is_undated', sup);
    if (expr === null) return err(databaseError(`series measure '${measure}' unsupported`));
    const anchorBani =
      p.anchorCol === null
        ? 'NULL'
        : `if(countIf(${p.accept}) = 0, NULL, toString(sumIf(toInt128(${p.anchorCol}), ${p.accept})))`;
    const r = await query(
      `
      SELECT
        if(is_undated, NULL, formatDateTime(toStartOfMonth(date_basis), '%Y-%m')) AS month,
        ${expr} AS value,
        toString(count()) AS record_count,
        toString(countIf(${p.accept})) AS with_value,
        ${anchorBani} AS awarded_bani_out
      FROM ${c.table}
      WHERE ${c.where} AND (${c.dated} OR is_undated)
      GROUP BY month
      ORDER BY month ASC NULLS LAST`,
      RawSeriesRowSchema
    );
    return r.map((rows) =>
      rows.map((row) => ({
        month: row.month,
        value: MONETARY_MEASURES.has(measure) ? baniToRon(row.value) : row.value,
        recordCount: row.record_count,
        withValue: row.with_value,
        valueAwardedSum: baniToRon(row.awarded_bani_out),
      }))
    );
  };

  const distinctSeriesFor: AnalysisRepo['distinctSeriesFor'] = async (
    route,
    scope,
    _buildId,
    key,
    bucket
  ) => {
    const sup = supplierScoped(scope);
    const c = compileScope(route, scope, sup);
    const p = profileFor(route.grain, sup);
    if (c.impossible) return ok([]);
    if (
      key === 'supplier' &&
      (SUPPLIERLESS_GRAINS.has(route.grain) || p.supplierDistinctExpr === undefined)
    ) {
      return ok([]);
    }
    const keyExpr =
      key === 'supplier'
        ? (p.supplierDistinctExpr ?? `uniqExactIf(supplier_cui, supplier_cui IS NOT NULL)`)
        : `uniqExactIf(authority_cui, authority_cui IS NOT NULL)`;
    const anchorBani =
      p.anchorCol === null
        ? 'NULL'
        : `if(countIf(${p.accept}) = 0, NULL, toString(sumIf(toInt128(${p.anchorCol}), ${p.accept})))`;
    const bucketExpr = BUCKET_LABEL[bucket];
    const r = await query(
      `
      SELECT
        if(is_undated, NULL, ${bucketExpr}) AS bucket,
        toString(${keyExpr}) AS value,
        toString(count()) AS record_count,
        toString(countIf(${p.accept})) AS with_value,
        ${anchorBani} AS awarded_bani_out
      FROM ${c.table}
      WHERE ${c.where} AND (${c.dated} OR is_undated)
      GROUP BY bucket
      ORDER BY bucket ASC NULLS LAST`,
      RawDistinctSeriesRowSchema
    );
    return r.map((rows) =>
      rows.map((row) => ({
        bucket: row.bucket,
        value: row.value,
        recordCount: row.record_count,
        withValue: row.with_value,
        valueAwardedSum: baniToRon(row.awarded_bani_out),
      }))
    );
  };

  const breakdownFor: AnalysisRepo['breakdownFor'] = async (
    route,
    scope,
    _buildId,
    dimension,
    topN,
    rankBy
  ) => {
    // Supplier-keyed breakdowns aggregate supplier-attributable money, and
    // the TOTALS row must use the SAME money basis or the derived 'other'
    // bucket would silently absorb the withheld association mass (M1).
    const sup = supplierScoped(scope) || SUPPLIER_BREAKDOWN_DIMS.has(dimension);
    const c = compileScope(route, scope, sup);
    const p = profileFor(route.grain, sup);
    const totalsR = await statsCore(route, scope, sup);
    if (totalsR.isErr()) return err(totalsR.error);
    const totals = totalsR.value;
    if (c.impossible) return ok({ buckets: [], totals, rankedBy: 'count' });

    const column =
      BREAKDOWN_DIM_COLUMNS[dimension] === undefined
        ? undefined
        : grainColumn(route.grain, BREAKDOWN_DIM_COLUMNS[dimension]);
    if (column === undefined)
      return err(databaseError(`breakdown dimension '${dimension}' unsupported`));
    if (column === 'supplier_identity_key' && SUPPLIERLESS_GRAINS.has(route.grain)) {
      return ok({ buckets: [], totals, rankedBy: 'count' });
    }

    // ORDER BY must use the numeric aggregate, NOT the toString() output
    // alias (string alias would rank lexicographically — alias-shadow trap).
    const anchorAgg =
      p.anchorCol === null
        ? '0'
        : `ifNull(sumIf(toInt128(${p.anchorCol}), ${c.dated} AND ${p.accept}), 0)`;

    // The unknown (NULL-key) read runs FIRST because it decides the ranking:
    // `totals.withValue − unknown.wv` is the number of value-bearing rows that
    // can reach a named bucket. When it is zero, a value ORDER BY would sort an
    // all-zero tie and the answer would claim a money ranking it never made —
    // so the top-N is genuinely re-ranked by record count BEFORE the LIMIT, and
    // the read reports `rankedBy: 'count'`. Costs no extra statement.
    const unknownR = await query(
      `
      SELECT
        toString(countIf(${c.dated})) AS cnt,
        toString(countIf(${c.dated} AND ${p.accept})) AS wv,
        toString(${anchorAgg}) AS awarded_bani
      FROM ${c.table}
      WHERE ${c.where} AND ${column} IS NULL`,
      RawUnknownBucketRowSchema
    );
    if (unknownR.isErr()) return err(unknownR.error);
    const unknown = unknownR.value[0] ?? { cnt: '0', wv: '0', awarded_bani: '0' };

    const valueBearingInBuckets = BigInt(totals.withValue) - BigInt(unknown.wv);
    const rankedBy: 'value' | 'count' =
      rankBy === 'value' && p.anchorCol !== null && valueBearingInBuckets > 0n ? 'value' : 'count';
    const rankExpr = rankedBy === 'value' ? anchorAgg : `countIf(${c.dated})`;
    const topR = await query(
      `
      SELECT ${column} AS key,
        toString(countIf(${c.dated})) AS cnt,
        toString(countIf(${c.dated} AND ${p.accept})) AS wv,
        toString(${anchorAgg}) AS awarded_bani
      FROM ${c.table}
      WHERE ${c.where} AND ${column} IS NOT NULL
      GROUP BY key
      ${datedGroupHaving(c)}
      ORDER BY ${rankExpr} DESC, key ASC
      LIMIT ${String(Math.max(1, Math.min(topN, TOPN_SIRUTA_MAX)))}`,
      RawBucketRowSchema
    );
    if (topR.isErr()) return err(topR.error);

    // `other` = dated totals − top buckets − unknown, all exact BigInt.
    let otherCnt = BigInt(totals.rows);
    let otherWv = BigInt(totals.withValue);
    // The anchor-money total is RON ("x.yy"); track in bani for exactness.
    // (Framework grain anchors on the ceiling; everything else on awarded.)
    const anchorTotal =
      p.anchorField === 'ceiling' ? totals.valueCeilingSum : totals.valueAwardedSum;
    let otherBani = anchorTotal === null ? 0n : BigInt(anchorTotal.replace('.', ''));
    const buckets: AnalysisBreakdownBucketRow[] = [];
    for (const row of topR.value) {
      buckets.push({
        kind: 'top',
        key: row.key,
        recordCount: row.cnt,
        withValue: row.wv,
        valueAwardedSum: baniToRon(row.awarded_bani),
      });
      otherCnt -= BigInt(row.cnt);
      otherWv -= BigInt(row.wv);
      otherBani -= BigInt(row.awarded_bani);
    }
    otherCnt -= BigInt(unknown.cnt);
    otherWv -= BigInt(unknown.wv);
    otherBani -= BigInt(unknown.awarded_bani);
    buckets.push({
      kind: 'other',
      key: null,
      recordCount: otherCnt.toString(),
      withValue: otherWv.toString(),
      valueAwardedSum: baniToRon(otherBani.toString()),
    });
    buckets.push({
      kind: 'unknown',
      key: null,
      recordCount: unknown.cnt,
      withValue: unknown.wv,
      valueAwardedSum: baniToRon(unknown.awarded_bani),
    });
    return ok({ buckets, totals, rankedBy } satisfies AnalysisBreakdownRead);
  };

  const concentrationFor: AnalysisRepo['concentrationFor'] = async (
    route,
    scope,
    _buildId,
    basis
  ) => {
    // Concentration is supplier-keyed by definition → supplier money always
    // (association money never enters HHI; the withheld share is disclosed
    // via the coverage/caveat layer).
    const c = compileScope(route, scope, true);
    const p = profileFor(route.grain, true);
    const totalsR = await statsCore(route, scope, true);
    if (totalsR.isErr()) return err(totalsR.error);
    const totals = totalsR.value;
    const empty: ConcentrationRead = {
      supplierCount: 0,
      positiveSupplierCount: 0,
      measureTotal: basis === 'value' ? '0.00' : '0',
      top1Measure: basis === 'value' ? '0.00' : '0',
      top5Measure: basis === 'value' ? '0.00' : '0',
      measureSquaredSum: basis === 'value' ? '0.0000' : '0',
      totals,
      unknownSupplierMeasure: null,
    };
    if (c.impossible || SUPPLIERLESS_GRAINS.has(route.grain) || p.anchorCol === null) {
      return ok(empty);
    }
    const measure =
      basis === 'value'
        ? `ifNull(sumIf(toInt128(${p.anchorCol}), ${c.dated} AND ${p.accept}), 0)`
        : `countIf(${c.dated})`;
    // Same bounded-period rule as the breakdown: a supplier present only on
    // undated rows is not in the requested period, so it must not inflate the
    // distinct-supplier count with a zero-measure row. NULL supplier is kept
    // as one grouped row so its excluded weight is returned by the same
    // bounded response.
    const aggregateR = await query(
      `
      SELECT
        toString(countIf(supplier_key IS NOT NULL)) AS supplier_count,
        toString(countIf(supplier_key IS NOT NULL AND measure > 0)) AS positive_supplier_count,
        toString(sumIf(toDecimal256(measure, 0),
                       supplier_key IS NOT NULL AND measure > 0)) AS measure_total,
        toString(maxIf(toDecimal256(measure, 0),
                       supplier_key IS NOT NULL AND measure > 0)) AS top1_measure,
        toString(arraySum(arraySlice(arrayReverseSort(groupArrayIf(
          toDecimal256(measure, 0), supplier_key IS NOT NULL AND measure > 0
        )), 1, 5))) AS top5_measure,
        toString(sumIf(
          toDecimal256(measure, 0) * toDecimal256(measure, 0),
          supplier_key IS NOT NULL AND measure > 0
        )) AS measure_squared_sum,
        toString(sumIf(toDecimal256(measure, 0), supplier_key IS NULL)) AS unknown_measure
      FROM (
        SELECT supplier_cui AS supplier_key, ${measure} AS measure
        FROM ${c.table}
        WHERE ${c.where}
        GROUP BY supplier_key
        ${datedGroupHaving(c)}
      )`,
      RawConcentrationRowSchema
    );
    if (aggregateR.isErr()) return err(aggregateR.error);
    const aggregate = aggregateR.value[0];
    if (aggregate === undefined) return ok(empty);
    const supplierCountRaw = BigInt(aggregate.supplier_count);
    const positiveSupplierCountRaw = BigInt(aggregate.positive_supplier_count);
    if (
      supplierCountRaw > BigInt(Number.MAX_SAFE_INTEGER) ||
      positiveSupplierCountRaw > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return err(databaseError('clickhouse concentration supplier count exceeds safe integer'));
    }
    const unknownRaw = aggregate.unknown_measure;
    const unknownSupplierMeasure =
      unknownRaw === '0' ? null : basis === 'value' ? baniToRon(unknownRaw) : unknownRaw;
    return ok({
      supplierCount: Number(supplierCountRaw),
      positiveSupplierCount: Number(positiveSupplierCountRaw),
      measureTotal:
        basis === 'value'
          ? (baniToRon(aggregate.measure_total) ?? '0.00')
          : aggregate.measure_total,
      top1Measure:
        basis === 'value' ? (baniToRon(aggregate.top1_measure) ?? '0.00') : aggregate.top1_measure,
      top5Measure:
        basis === 'value' ? (baniToRon(aggregate.top5_measure) ?? '0.00') : aggregate.top5_measure,
      measureSquaredSum:
        basis === 'value'
          ? baniSquaredToRonSquared(aggregate.measure_squared_sum)
          : aggregate.measure_squared_sum,
      totals,
      unknownSupplierMeasure,
    } satisfies ConcentrationRead);
  };

  // Per-build basis coverage (immutable rows — cached for the process life).
  const coverageCache = new Map<string, readonly BasisCoverageRow[]>();
  const basisCoverage: AnalysisRepo['basisCoverage'] = async (buildId) => {
    const cached = coverageCache.get(buildId);
    if (cached !== undefined) return ok(cached);
    const r = await query(
      `SELECT grain, basis, population, coverage FROM meta_value_coverage_v2 WHERE build_id = ${escapeString(buildId)}`,
      BasisCoverageRowSchema
    );
    if (r.isErr()) return err(r.error);
    coverageCache.set(buildId, r.value);
    return ok(r.value);
  };

  return {
    activeGeneration,
    basisCoverage,
    statsFor,
    seriesFor,
    distinctSeriesFor,
    breakdownFor,
    concentrationFor,
  };
};

/**
 * Fallback `AnalysisRepo` for when no ClickHouse backend is configured. Lists,
 * search and detail are unaffected — the module still boots — but every
 * analysis read fails with one clear, actionable error instead of a confusing
 * empty answer or a crash.
 */
export const makeUnconfiguredAnalysisRepo = (): AnalysisRepo => {
  const unconfigured = (): Result<never, ApiError> =>
    err(databaseError('procurement analytics backend (ClickHouse) is not configured'));
  return {
    activeGeneration: () => Promise.resolve(unconfigured()),
    basisCoverage: () => Promise.resolve(unconfigured()),
    statsFor: () => Promise.resolve(unconfigured()),
    seriesFor: () => Promise.resolve(unconfigured()),
    distinctSeriesFor: () => Promise.resolve(unconfigured()),
    breakdownFor: () => Promise.resolve(unconfigured()),
    concentrationFor: () => Promise.resolve(unconfigured()),
  };
};
