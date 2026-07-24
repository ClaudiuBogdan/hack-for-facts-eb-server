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
 *  - breakdown runs top-N + totals as two statements over the immutable
 *    table and derives `other` by exact BigInt subtraction.
 */

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
  ConcentrationRow,
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

const CONTRACT_PROFILE: GrainSqlProfile = {
  base: CORE_BASE,
  accept: CORE_ACCEPT,
  anchorCol: 'value_awarded_bani',
  anchorField: 'awarded',
  estimated: { col: 'value_estimated_bani', accept: ESTIMATED_ACCEPT },
  modAdjusted: {
    col: 'value_mod_adjusted_bani',
    accept: "mod_adjustment_state IN ('adjusted', 'no_mods')",
  },
  supplierDistinctExpr: `uniqExactIf(supplier_identity_key, ${SUPPLIER_KEY_VALID})`,
};

const profileFor = (grain: string): GrainSqlProfile => GRAIN_SQL[grain] ?? CONTRACT_PROFILE;

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

/** Exact bani (Int64/Int128 decimal string) → RON decimal string. */
const baniToRon = (bani: string | null | undefined): string | null => {
  if (bani === null || bani === undefined) return null;
  const v = BigInt(bani);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  return `${sign}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
};

interface CompiledScope {
  readonly table: string;
  /** Full row-selection predicate: dims AND (dated-window OR undated). */
  readonly where: string;
  /** Predicate marking rows that belong to the dated aggregates. */
  readonly dated: string;
  /** True when the scope can never match (structural N/A, e.g. supplier dims on procedures). */
  readonly impossible: boolean;
}

const compileScope = (route: AnalysisRoute, scope: AnalysisScope): CompiledScope => {
  const grain = route.grain;
  const table = TABLE_BY_GRAIN[grain] ?? 'facts_contracts_v2';
  const profile = profileFor(grain);
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
    conds.push(`positionCaseInsensitiveUTF8(ifNull(title, ''), ${escapeString(scope.q)}) > 0`);
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
  const dated = bounds.length > 0 ? `(NOT is_undated AND ${bounds.join(' AND ')})` : '1';
  conds.push(`(${dated} OR is_undated)`);

  return { table, where: conds.join(' AND '), dated, impossible };
};

const EMPTY_STATS: AnalysisStatsRead = {
  rows: '0',
  withValue: '0',
  withEstimated: '0',
  valueAwardedSum: null,
  valueEstimatedSum: null,
  valueCeilingSum: null,
  valueModAdjustedSum: null,
  minMonth: null,
  maxMonth: null,
  undatedCount: '0',
  undatedValueRon: null,
};

export const makeClickhouseAnalysisRepo = (
  config: ClickhouseAnalysisConfig,
  activeGeneration: AnalysisRepo['activeGeneration'],
  logger?: Logger
): AnalysisRepo => {
  const query = async <T>(sql: string): Promise<Result<readonly T[], ApiError>> => {
    try {
      const url = new URL(config.url);
      url.searchParams.set('database', config.database);
      const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
      if (config.user !== undefined) headers['X-ClickHouse-User'] = config.user;
      if (config.password !== undefined) headers['X-ClickHouse-Key'] = config.password;
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: `${sql} FORMAT JSON`,
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
      const parsed = (await response.json()) as { data: readonly T[] };
      return ok(parsed.data);
    } catch (error) {
      logger?.error({ error: String(error) }, 'clickhouse query error');
      return err(databaseError(`clickhouse unreachable: ${String(error)}`));
    }
  };

  const statsSelect = (p: GrainSqlProfile, dated: string): string => {
    const moneySum = (col: string, accept: string): string =>
      `if(countIf(${dated}) = 0, NULL, toString(sumIf(toInt128(${col}), ${dated} AND ${accept})))`;
    const anchorSum = p.anchorCol === null ? 'NULL' : moneySum(p.anchorCol, p.accept);
    return `
      toString(countIf(${dated})) AS rows,
      toString(countIf(${dated} AND ${p.accept})) AS with_value,
      toString(${p.estimated === undefined ? '0' : `countIf(${dated} AND ${p.estimated.accept} AND ${p.estimated.col} IS NOT NULL)`}) AS with_estimated,
      ${p.anchorField === 'awarded' ? anchorSum : 'NULL'} AS awarded_bani_out,
      ${p.estimated === undefined ? 'NULL' : moneySum(p.estimated.col, `${p.estimated.accept} AND ${p.estimated.col} IS NOT NULL`)} AS estimated_bani_out,
      ${p.anchorField === 'ceiling' ? anchorSum : 'NULL'} AS ceiling_bani_out,
      ${p.modAdjusted === undefined ? 'NULL' : moneySum(p.modAdjusted.col, p.modAdjusted.accept)} AS mod_adjusted_bani_out,
      if(countIf(${dated} AND NOT is_undated) = 0, NULL,
         formatDateTime(minIf(date_basis, ${dated} AND NOT is_undated), '%Y-%m')) AS min_month,
      if(countIf(${dated} AND NOT is_undated) = 0, NULL,
         formatDateTime(maxIf(date_basis, ${dated} AND NOT is_undated), '%Y-%m')) AS max_month,
      toString(countIf(is_undated)) AS undated_count,
      ${
        p.anchorCol === null
          ? 'NULL'
          : `if(countIf(is_undated) = 0, NULL,
         toString(sumIf(toInt128(${p.anchorCol}), is_undated AND ${p.accept})))`
      } AS undated_bani_out`;
  };

  interface RawStats {
    rows: string;
    with_value: string;
    with_estimated: string;
    awarded_bani_out: string | null;
    estimated_bani_out: string | null;
    ceiling_bani_out: string | null;
    mod_adjusted_bani_out: string | null;
    min_month: string | null;
    max_month: string | null;
    undated_count: string;
    undated_bani_out: string | null;
  }

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
          minMonth: row.min_month,
          maxMonth: row.max_month,
          undatedCount: row.undated_count,
          undatedValueRon: baniToRon(row.undated_bani_out),
        };

  const statsFor: AnalysisRepo['statsFor'] = async (route, scope, _buildId) => {
    const c = compileScope(route, scope);
    if (c.impossible) return ok(EMPTY_STATS);
    const r = await query<RawStats>(
      `SELECT ${statsSelect(profileFor(route.grain), c.dated)} FROM ${c.table} WHERE ${c.where}`
    );
    return r.map((rows) => toStats(rows[0]));
  };

  const measureExpr = (grain: string, measure: MeasureId, dated: string): string | null => {
    const p = profileFor(grain);
    const moneySum = (col: string, accept: string): string =>
      `if(countIf(${dated}) = 0, NULL, toString(sumIf(toInt128(${col}), ${dated} AND ${accept})))`;
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
    const c = compileScope(route, scope);
    const p = profileFor(route.grain);
    if (c.impossible) return ok([]);
    const expr = measureExpr(route.grain, measure, 'NOT is_undated');
    if (expr === null) return err(databaseError(`series measure '${measure}' unsupported`));
    const anchorBani =
      p.anchorCol === null ? 'NULL' : `toString(sumIf(toInt128(${p.anchorCol}), ${p.accept}))`;
    const r = await query<{
      month: string | null;
      value: string | null;
      record_count: string;
      with_value: string;
      awarded_bani_out: string | null;
    }>(`
      SELECT
        if(is_undated, NULL, formatDateTime(toStartOfMonth(date_basis), '%Y-%m')) AS month,
        ${expr} AS value,
        toString(count()) AS record_count,
        toString(countIf(${p.accept})) AS with_value,
        ${anchorBani} AS awarded_bani_out
      FROM ${c.table}
      WHERE ${c.where} AND (${c.dated} OR is_undated)
      GROUP BY month
      ORDER BY month ASC NULLS LAST`);
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
    const c = compileScope(route, scope);
    const p = profileFor(route.grain);
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
      p.anchorCol === null ? 'NULL' : `toString(sumIf(toInt128(${p.anchorCol}), ${p.accept}))`;
    const bucketExpr = BUCKET_LABEL[bucket];
    const r = await query<{
      bucket: string | null;
      value: string;
      record_count: string;
      with_value: string;
      awarded_bani_out: string | null;
    }>(`
      SELECT
        if(is_undated, NULL, ${bucketExpr}) AS bucket,
        toString(${keyExpr}) AS value,
        toString(count()) AS record_count,
        toString(countIf(${p.accept})) AS with_value,
        ${anchorBani} AS awarded_bani_out
      FROM ${c.table}
      WHERE ${c.where} AND (${c.dated} OR is_undated)
      GROUP BY bucket
      ORDER BY bucket ASC NULLS LAST`);
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
    buildId,
    dimension,
    topN,
    rankBy
  ) => {
    const c = compileScope(route, scope);
    const totalsR = await statsFor(route, scope, buildId);
    if (totalsR.isErr()) return err(totalsR.error);
    const totals = totalsR.value;
    if (c.impossible) return ok({ buckets: [], totals });

    const column =
      BREAKDOWN_DIM_COLUMNS[dimension] === undefined
        ? undefined
        : grainColumn(route.grain, BREAKDOWN_DIM_COLUMNS[dimension]);
    if (column === undefined)
      return err(databaseError(`breakdown dimension '${dimension}' unsupported`));
    if (column === 'supplier_identity_key' && SUPPLIERLESS_GRAINS.has(route.grain)) {
      return ok({ buckets: [], totals });
    }

    // ORDER BY must use the numeric aggregate, NOT the toString() output
    // alias (string alias would rank lexicographically — alias-shadow trap).
    const p = profileFor(route.grain);
    const anchorAgg =
      p.anchorCol === null
        ? '0'
        : `ifNull(sumIf(toInt128(${p.anchorCol}), ${c.dated} AND ${p.accept}), 0)`;
    const rankExpr = rankBy === 'value' && p.anchorCol !== null ? anchorAgg : `countIf(${c.dated})`;
    interface RawBucket {
      key: string;
      cnt: string;
      wv: string;
      awarded_bani: string;
    }
    const topR = await query<RawBucket>(`
      SELECT ${column} AS key,
        toString(countIf(${c.dated})) AS cnt,
        toString(countIf(${c.dated} AND ${p.accept})) AS wv,
        toString(${anchorAgg}) AS awarded_bani
      FROM ${c.table}
      WHERE ${c.where} AND ${column} IS NOT NULL
      GROUP BY key
      ORDER BY ${rankExpr} DESC, key ASC
      LIMIT ${String(Math.max(1, Math.min(topN, TOPN_SIRUTA_MAX)))}`);
    if (topR.isErr()) return err(topR.error);

    const unknownR = await query<{ cnt: string; wv: string; awarded_bani: string }>(`
      SELECT
        toString(countIf(${c.dated})) AS cnt,
        toString(countIf(${c.dated} AND ${p.accept})) AS wv,
        toString(${anchorAgg}) AS awarded_bani
      FROM ${c.table}
      WHERE ${c.where} AND ${column} IS NULL`);
    if (unknownR.isErr()) return err(unknownR.error);
    const unknown = unknownR.value[0] ?? { cnt: '0', wv: '0', awarded_bani: '0' };

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
    return ok({ buckets, totals } satisfies AnalysisBreakdownRead);
  };

  const concentrationRowsFor: AnalysisRepo['concentrationRowsFor'] = async (
    route,
    scope,
    buildId,
    basis
  ) => {
    const c = compileScope(route, scope);
    const p = profileFor(route.grain);
    const totalsR = await statsFor(route, scope, buildId);
    if (totalsR.isErr()) return err(totalsR.error);
    const totals = totalsR.value;
    if (c.impossible || SUPPLIERLESS_GRAINS.has(route.grain) || p.anchorCol === null) {
      return ok({ rows: [], totals, unknownSupplierMeasure: null });
    }
    const measure =
      basis === 'value'
        ? `toString(ifNull(sumIf(toInt128(${p.anchorCol}), ${c.dated} AND ${p.accept}), 0))`
        : `toString(countIf(${c.dated}))`;
    const rowsR = await query<{ supplier_key: string; measure: string }>(`
      SELECT supplier_cui AS supplier_key, ${measure} AS measure
      FROM ${c.table}
      WHERE ${c.where} AND supplier_cui IS NOT NULL
      GROUP BY supplier_key`);
    if (rowsR.isErr()) return err(rowsR.error);
    const unknownR = await query<{ measure: string }>(`
      SELECT ${measure} AS measure FROM ${c.table}
      WHERE ${c.where} AND supplier_cui IS NULL`);
    if (unknownR.isErr()) return err(unknownR.error);
    const rows: ConcentrationRow[] = rowsR.value.map((row) => ({
      supplierKey: row.supplier_key,
      measure: basis === 'value' ? (baniToRon(row.measure) ?? '0.00') : row.measure,
    }));
    const unknownRaw = unknownR.value[0]?.measure ?? null;
    const unknownSupplierMeasure =
      unknownRaw === null || unknownRaw === '0'
        ? null
        : basis === 'value'
          ? baniToRon(unknownRaw)
          : unknownRaw;
    return ok({ rows, totals, unknownSupplierMeasure } satisfies ConcentrationRead);
  };

  // Per-build basis coverage (immutable rows — cached for the process life).
  const coverageCache = new Map<string, readonly BasisCoverageRow[]>();
  const basisCoverage: AnalysisRepo['basisCoverage'] = async (buildId) => {
    const cached = coverageCache.get(buildId);
    if (cached !== undefined) return ok(cached);
    const r = await query<BasisCoverageRow>(
      `SELECT grain, basis, population, coverage FROM meta_value_coverage_v2 WHERE build_id = ${escapeString(buildId)}`
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
    concentrationRowsFor,
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
    concentrationRowsFor: () => Promise.resolve(unconfigured()),
  };
};
