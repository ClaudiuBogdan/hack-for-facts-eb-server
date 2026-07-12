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
    spend?: 'allow' | 'abstain';
    time?: 'allow' | 'degraded' | 'abstain';
    geo?: 'allow' | 'degraded' | 'abstain';
    date?: number;
    value?: number;
  } = {}
): GrainQualityVerdict => ({
  coverage: { date: over.date ?? 0.9, value: over.value ?? 0.97, geo: 0.77, cpv: 0.9 },
  classes: { spend: over.spend ?? 'allow', time: over.time ?? 'allow', geo: over.geo ?? 'allow' },
});

/** Mirrors the live reality: DA spend allowed, contract spend abstained. */
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
  matrixHash: 'test-matrix-hash',
});

export const statsRead = (over: Partial<AnalysisStatsRead> = {}): AnalysisStatsRead => ({
  rows: '100',
  withValue: '80',
  withEstimated: '60',
  valueAwardedSum: '1000.00',
  valueEstimatedSum: '1200.00',
  minMonth: '2024-01',
  maxMonth: '2024-12',
  undatedCount: '5',
  undatedValueRon: '50.00',
  ...over,
});

export interface RecordedCall {
  readonly method: string;
  readonly rollup: string;
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
}

const okp = <T>(value: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(value));

export const fakeAnalysisRepo = (options: FakeAnalysisRepoOptions = {}): FakeAnalysisRepo => {
  const calls: RecordedCall[] = [];
  const gen = options.generation !== undefined ? options.generation : generation(options.quality);
  const record = (
    method: string,
    route: { rollup: { rollup: string }; grain: string },
    params: readonly unknown[]
  ): void => {
    calls.push({ method, rollup: route.rollup.rollup, grain: route.grain, params });
  };

  const repo: AnalysisRepo = {
    activeGeneration: () => okp(gen),
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
