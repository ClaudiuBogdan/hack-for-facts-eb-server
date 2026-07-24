/**
 * In-memory fakes + fixtures for the procurement analysis executors (no mocking
 * library). The fake repo records the routes/params the executors derived so
 * tests assert the CONTRACT (which rollup, which grain, which basis), not SQL.
 */

import { ok, type Result } from 'neverthrow';

import type { GenerationQuality, GrainQualityVerdict } from '@/modules/procurement/core/gate-v2.js';
import type {
  ActiveGeneration,
  AnalysisBreakdownRead,
  AnalysisDistinctRow,
  AnalysisRepo,
  AnalysisSeriesRow,
  AnalysisStatsRead,
  ConcentrationRead,
} from '@/modules/procurement/core/ports.js';
import type { ApiError } from '@/modules/shared/index.js';

export const verdict = (
  over: {
    spend?: 'allow' | 'allow_disclosed' | 'abstain';
    time?: 'allow' | 'degraded' | 'abstain';
    geo?: 'allow' | 'degraded' | 'abstain';
    date?: number;
    value?: number;
  } = {}
): GrainQualityVerdict => ({
  coverage: { date: over.date ?? 0.9, value: over.value ?? 0.97, geo: 0.77, cpv: 0.9 },
  classes: { spend: over.spend ?? 'allow', time: over.time ?? 'allow', geo: over.geo ?? 'allow' },
});

/** Synthetic mixed verdicts used to exercise both served and abstained paths. */
export const LIVE_LIKE_QUALITY: GenerationQuality = {
  procedure: verdict({ time: 'abstain', date: 0.34 }),
  contract: verdict({ spend: 'abstain', value: 0.76 }),
  direct_acquisition: verdict(),
};

export const BUILD_ID = '42';

export const generation = (quality: GenerationQuality = LIVE_LIKE_QUALITY): ActiveGeneration => ({
  buildId: BUILD_ID,
  publishedAt: '2026-07-12T00:00:00Z',
  quality,
  matrixHash: 'matrix-hash-1', // informational passthrough — no longer gates serving
});

export const statsRead = (over: Partial<AnalysisStatsRead> = {}): AnalysisStatsRead => ({
  rows: '100',
  withValue: '80',
  withEstimated: '60',
  valueAwardedSum: '1000.00',
  valueEstimatedSum: '1200.00',
  valueCeilingSum: null,
  valueModAdjustedSum: null,
  minMonth: '2024-01',
  maxMonth: '2024-12',
  undatedCount: '5',
  undatedValueRon: '50.00',
  ...over,
});

/** Default coverage rows mirroring the live meta table (build 6 shape).
 * The framework quarantine DIAGNOSTIC row deliberately sits BEFORE the
 * groups_all serving row: the gate must match on population, not row order
 * (review F1 — matching (grain, basis) alone could serve the 0.031 verdict). */
export const BASIS_COVERAGE_ROWS = [
  { grain: 'framework', basis: 'ceiling', population: 'quarantined_mass', coverage: 0.0315 },
  { grain: 'contract', basis: 'estimated', population: 'applicable_canonical', coverage: 0.1953 },
  {
    grain: 'direct_acquisition',
    basis: 'estimated',
    population: 'applicable_canonical',
    coverage: 0.5859,
  },
  { grain: 'procedure', basis: 'estimated', population: 'applicable_canonical', coverage: 0.9273 },
  { grain: 'contract', basis: 'mod_adjusted', population: 'awarded_valued', coverage: 0.9865 },
  { grain: 'framework', basis: 'ceiling', population: 'groups_all', coverage: 0.927 },
  { grain: 'calloff', basis: 'calloff_value', population: 'all_rows', coverage: 0.9987 },
  { grain: 'calloff', basis: 'dated', population: 'all_rows', coverage: 1 },
  { grain: 'framework', basis: 'dated', population: 'groups_all', coverage: 0.9159 },
  { grain: 'modification', basis: 'dated', population: 'all_rows', coverage: 0.5151 },
  { grain: 'calloff', basis: 'buyer_geo', population: 'all_rows', coverage: 0.8898 },
  { grain: 'framework', basis: 'buyer_geo', population: 'groups_all', coverage: 0.9174 },
  { grain: 'modification', basis: 'buyer_geo', population: 'all_rows', coverage: 0.6223 },
] as const;

export interface RecordedCall {
  readonly method: string;
  readonly grain: string;
  readonly params: readonly unknown[];
}

export interface FakeAnalysisRepo {
  readonly repo: AnalysisRepo;
  readonly calls: RecordedCall[];
}

export interface FakeAnalysisRepoOptions {
  readonly quality?: GenerationQuality;
  /** null = no active generation (package unpublished). */
  readonly generation?: ActiveGeneration | null;
  readonly stats?: (grain: string) => AnalysisStatsRead;
  readonly series?: readonly AnalysisSeriesRow[];
  readonly distinct?: readonly AnalysisDistinctRow[];
  readonly breakdown?: AnalysisBreakdownRead;
  readonly concentration?: ConcentrationRead;
  readonly basisCoverage?: readonly {
    grain: string;
    basis: string;
    population: string;
    coverage: number;
  }[];
}

const okp = <T>(value: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(value));

export const fakeAnalysisRepo = (options: FakeAnalysisRepoOptions = {}): FakeAnalysisRepo => {
  const calls: RecordedCall[] = [];
  const gen = options.generation !== undefined ? options.generation : generation(options.quality);
  const record = (method: string, route: { grain: string }, params: readonly unknown[]): void => {
    calls.push({ method, grain: route.grain, params });
  };

  const repo: AnalysisRepo = {
    activeGeneration: () => okp(gen),
    basisCoverage: () => okp(options.basisCoverage ?? BASIS_COVERAGE_ROWS),
    statsFor: (route) => {
      record('statsFor', route, []);
      return okp(options.stats !== undefined ? options.stats(route.grain) : statsRead());
    },
    seriesFor: (route, _scope, _buildId, measure) => {
      record('seriesFor', route, [measure]);
      return okp(options.series ?? []);
    },
    distinctSeriesFor: (route, _scope, _buildId, key, bucket) => {
      record('distinctSeriesFor', route, [key, bucket]);
      return okp(options.distinct ?? []);
    },
    breakdownFor: (route, _scope, _buildId, dimension, topN, rankBy) => {
      record('breakdownFor', route, [dimension, topN, rankBy]);
      return okp(
        options.breakdown ?? {
          buckets: [],
          totals: statsRead({ rows: '0', withValue: '0', valueAwardedSum: '0', undatedCount: '0' }),
        }
      );
    },
    concentrationRowsFor: (route, _scope, _buildId, basis) => {
      record('concentrationRowsFor', route, [basis]);
      return okp(
        options.concentration ?? { rows: [], totals: statsRead(), unknownSupplierMeasure: null }
      );
    },
  };
  return { repo, calls };
};
