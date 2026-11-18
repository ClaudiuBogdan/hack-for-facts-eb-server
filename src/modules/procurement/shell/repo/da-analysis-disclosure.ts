/**
 * Site-wide D6 on the analysis API's direct_acquisition grain while it is
 * served from the LEGACY ClickHouse facts: the DA release flag is off or rolled
 * back, but PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED is on (root, 2026-11-18:
 * a rollback never re-exposes a name). Applied on read, over the base repo, so
 * no cached answer bypasses it. The v3 source applies the same rule in SQL.
 *
 * - A scope on a supplier code that is not public matches nothing.
 * - Supplier breakdowns: every top bucket whose code is not public is merged
 *   into ONE `natural_person` bucket (then re-ranked); withheld suppliers
 *   outside the top set stay inside `other`, which names nobody.
 * - Records: a non-public supplier serves no code and no name; free text (the
 *   title) is withheld (decision 2026-11-10).
 * Other grains pass through unchanged.
 */

import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { DA_NATURAL_PERSON_BUCKET } from '../../core/constants.js';

import type { AnalysisScope } from '../../core/analysis-scope.js';
import type {
  AnalysisBreakdownBucketRow,
  AnalysisRecordRow,
  AnalysisRepo,
} from '../../core/ports.js';
import type { ApiError, SupplierDisclosurePort } from '@/modules/shared/index.js';

const DA = 'direct_acquisition';
/** A supplier key no fact row carries: a withheld code's scope matches nothing. */
const NO_SUPPLIER_MATCH = '~withheld';

const add = (a: string | null, b: string | null): string | null =>
  a === null && b === null ? null : new Decimal(a ?? '0').plus(b ?? '0').toFixed();

export const withDaAnalysisDisclosure = (
  repo: AnalysisRepo,
  disclosure: SupplierDisclosurePort | undefined
): AnalysisRepo => {
  if (disclosure?.enforced !== true) return repo;

  const codes = async () => disclosure.publicSupplierCodes();
  const freshCodes = async () => disclosure.publicSupplierCodes({ fresh: true });

  /**
   * Run a DA read on a scope D6 allows: a non-public supplier code matches
   * nothing. After the read, ONE fresh check decides: if a nightly publish
   * withheld the scope's code mid-request, the read runs again matching nothing.
   * The returned codes are that decision, used to scrub what is served.
   */
  const guarded = async <T>(
    scope: AnalysisScope,
    read: (scope: AnalysisScope) => Promise<Result<T, ApiError>>
  ): Promise<Result<{ value: T; codes: ReadonlySet<string> }, ApiError>> => {
    const code = scope.supplierCui;
    const hidden = { ...scope, supplierCui: NO_SUPPLIER_MATCH };
    const before = await codes();
    if (before.isErr()) return err(before.error);
    if (code !== undefined && !before.value.has(code)) {
      const result = await read(hidden);
      return result.isErr() ? err(result.error) : ok({ value: result.value, codes: before.value });
    }
    const result = await read(scope);
    if (result.isErr()) return err(result.error);
    const after = await freshCodes();
    if (after.isErr()) return err(after.error);
    if (code === undefined || after.value.has(code))
      return ok({ value: result.value, codes: after.value });
    const again = await read(hidden);
    return again.isErr() ? err(again.error) : ok({ value: again.value, codes: after.value });
  };

  /** A plain DA read under D6 (no scrub needed beyond the scope). */
  const plain = async <T>(
    grain: string,
    scope: AnalysisScope,
    read: (scope: AnalysisScope) => Promise<Result<T, ApiError>>
  ): Promise<Result<T, ApiError>> => {
    if (grain !== DA || scope.supplierCui === undefined) return read(scope);
    const result = await guarded(scope, read);
    return result.isErr() ? err(result.error) : ok(result.value.value);
  };

  const mergeWithheld = (
    buckets: readonly AnalysisBreakdownBucketRow[],
    publicCodes: ReadonlySet<string>,
    rankedBy: 'value' | 'count'
  ): AnalysisBreakdownBucketRow[] => {
    const named: AnalysisBreakdownBucketRow[] = [];
    const hidden: AnalysisBreakdownBucketRow[] = [];
    const rest: AnalysisBreakdownBucketRow[] = [];
    for (const bucket of buckets) {
      if (bucket.kind !== 'top') rest.push(bucket);
      else if (bucket.key !== null && publicCodes.has(bucket.key)) named.push(bucket);
      else hidden.push(bucket);
    }
    const withheld: AnalysisBreakdownBucketRow | null =
      hidden.length === 0
        ? null
        : {
            kind: 'top',
            key: DA_NATURAL_PERSON_BUCKET,
            recordCount: hidden
              .reduce((sum, b) => sum.plus(b.recordCount), new Decimal(0))
              .toFixed(),
            withValue: hidden.reduce((sum, b) => sum.plus(b.withValue), new Decimal(0)).toFixed(),
            valueAwardedSum: hidden.reduce<string | null>(
              (sum, b) => add(sum, b.valueAwardedSum),
              null
            ),
          };
    const measure = (b: AnalysisBreakdownBucketRow) =>
      new Decimal(rankedBy === 'value' ? (b.valueAwardedSum ?? '0') : b.recordCount);
    const tops = [...named, ...(withheld === null ? [] : [withheld])].sort((a, b) =>
      measure(b).comparedTo(measure(a))
    );
    return [...tops, ...rest];
  };

  const discloseRecord = (
    row: AnalysisRecordRow,
    publicCodes: ReadonlySet<string>
  ): AnalysisRecordRow => {
    const named = row.supplierCui !== null && publicCodes.has(row.supplierCui);
    const hasSupplier = row.supplierCui !== null || row.supplierName !== null;
    return {
      ...row,
      title: null,
      supplierCui: named ? row.supplierCui : null,
      supplierName: named ? row.supplierName : null,
      supplierDisplayKind: hasSupplier ? (named ? 'company' : 'natural_person') : null,
    };
  };

  return {
    ...repo,
    // Tell routing the legacy DA facts are under D6 (see GenerationCapabilities.daSupplierPrivacy).
    activeGeneration: async () => {
      const gen = await repo.activeGeneration();
      if (gen.isErr() || gen.value === null) return gen;
      const asOf = await disclosure.privacyAsOf();
      return ok({
        ...gen.value,
        capabilities: { ...gen.value.capabilities, daSupplierPrivacy: true },
        disclosureKey: asOf.isOk() && asOf.value !== null ? asOf.value : 'unavailable',
      });
    },
    statsFor: (route, scope, gen) => plain(route.grain, scope, (s) => repo.statsFor(route, s, gen)),
    seriesFor: (route, scope, gen, measure) =>
      plain(route.grain, scope, (s) => repo.seriesFor(route, s, gen, measure)),
    distinctSeriesFor: (route, scope, gen, key, bucket) =>
      plain(route.grain, scope, (s) => repo.distinctSeriesFor(route, s, gen, key, bucket)),
    concentrationFor: (route, scope, gen, basis) =>
      plain(route.grain, scope, (s) => repo.concentrationFor(route, s, gen, basis)),
    breakdownFor: async (route, scope, gen, dimension, topN, rankBy) => {
      const read = (s: AnalysisScope) => repo.breakdownFor(route, s, gen, dimension, topN, rankBy);
      if (route.grain !== DA || dimension !== 'supplier') return plain(route.grain, scope, read);
      const result = await guarded(scope, read);
      if (result.isErr()) return err(result.error);
      const { value, codes: decided } = result.value;
      return ok({ ...value, buckets: mergeWithheld(value.buckets, decided, value.rankedBy) });
    },
    recordsFor: async (route, scope, gen, page) => {
      const read = (s: AnalysisScope) => repo.recordsFor(route, s, gen, page);
      if (route.grain !== DA) return read(scope);
      const result = await guarded(scope, read);
      if (result.isErr()) return err(result.error);
      const { value, codes: decided } = result.value;
      return ok({ ...value, rows: value.rows.map((row) => discloseRecord(row, decided)) });
    },
  };
};
