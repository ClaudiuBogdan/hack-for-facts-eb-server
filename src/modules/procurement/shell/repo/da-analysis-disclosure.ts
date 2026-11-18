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

  /**
   * Run a DA read on a scope D6 allows: a non-public supplier code matches
   * nothing. The code is checked again after the read; if a nightly publish
   * withheld it mid-request, the read runs again matching nothing.
   */
  const guarded = async <T>(
    grain: string,
    scope: AnalysisScope,
    read: (scope: AnalysisScope) => Promise<Result<T, ApiError>>
  ): Promise<Result<T, ApiError>> => {
    const code = scope.supplierCui;
    if (grain !== DA || code === undefined) return read(scope);
    const hidden = { ...scope, supplierCui: NO_SUPPLIER_MATCH };
    const before = await codes();
    if (before.isErr()) return err(before.error);
    if (!before.value.has(code)) return read(hidden);
    const result = await read(scope);
    const after = await codes();
    if (after.isErr()) return err(after.error);
    return after.value.has(code) ? result : read(hidden);
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
      return ok({
        ...gen.value,
        capabilities: { ...gen.value.capabilities, daSupplierPrivacy: true },
      });
    },
    statsFor: (route, scope, gen) =>
      guarded(route.grain, scope, (s) => repo.statsFor(route, s, gen)),
    seriesFor: (route, scope, gen, measure) =>
      guarded(route.grain, scope, (s) => repo.seriesFor(route, s, gen, measure)),
    distinctSeriesFor: (route, scope, gen, key, bucket) =>
      guarded(route.grain, scope, (s) => repo.distinctSeriesFor(route, s, gen, key, bucket)),
    concentrationFor: (route, scope, gen, basis) =>
      guarded(route.grain, scope, (s) => repo.concentrationFor(route, s, gen, basis)),
    breakdownFor: async (route, scope, gen, dimension, topN, rankBy) => {
      const read = await guarded(route.grain, scope, (s) =>
        repo.breakdownFor(route, s, gen, dimension, topN, rankBy)
      );
      if (read.isErr() || route.grain !== DA || dimension !== 'supplier') return read;
      // The set read AFTER the facts: a code withheld mid-request is merged too.
      const publicCodes = await codes();
      if (publicCodes.isErr()) return err(publicCodes.error);
      return ok({
        ...read.value,
        buckets: mergeWithheld(read.value.buckets, publicCodes.value, read.value.rankedBy),
      });
    },
    recordsFor: async (route, scope, gen, page) => {
      const read = await guarded(route.grain, scope, (s) => repo.recordsFor(route, s, gen, page));
      if (read.isErr() || route.grain !== DA) return read;
      const publicCodes = await codes();
      if (publicCodes.isErr()) return err(publicCodes.error);
      return ok({
        ...read.value,
        rows: read.value.rows.map((row) => discloseRecord(row, publicCodes.value)),
      });
    },
  };
};
