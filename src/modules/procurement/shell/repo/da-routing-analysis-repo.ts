/**
 * The analysis repo with the direct_acquisition grain answered by another
 * source (PROCUREMENT_DA_V3_ENABLED): procurement_v3 on Postgres today, a
 * ClickHouse projection of procurement_v3 later — both behind
 * `DaV3AnalysisSource`. Every other grain, and procedure canonicality, stays
 * on the base repo (ClickHouse).
 *
 * The request generation is the base generation with
 * `capabilities.directAcquisitionV3` set and the DA grain's own generation
 * under `grainSources.direct_acquisition`; the usecases gate, label and read
 * the DA grain with that one. The DA grain never falls back to the legacy
 * facts (they name suppliers D6 withholds): when the DA source cannot resolve
 * a generation, the DA grain carries no quality verdict (money, time and geo
 * abstain) and its reads fail, while the other grains still answer.
 */

import { err, ok } from 'neverthrow';

import { retryAfterSecondsOf, type Logger } from '@/modules/shared/index.js';

import { DA_V3_CAPABILITIES, type DaV3AnalysisSource } from './da-v3-analysis-source.js';

import type { ActiveGeneration, AnalysisRepo, GrainSource } from '../../core/ports.js';

const DA = 'direct_acquisition';

export const makeDaRoutingAnalysisRepo = (
  base: AnalysisRepo,
  da: DaV3AnalysisSource,
  logger?: Logger
): AnalysisRepo => {
  /** Build ids the DA source issued; their basis coverage is empty (no estimate is served). */
  const daBuilds = new Set<string>();

  const activeGeneration: AnalysisRepo['activeGeneration'] = async () => {
    const [baseR, daR] = await Promise.all([base.activeGeneration(), da.generation()]);
    if (daR.isErr())
      logger?.warn({ error: daR.error.message }, 'direct-acquisition generation unavailable');
    const daGen = daR.isOk() ? daR.value : null;
    if (daGen !== null) daBuilds.add(daGen.buildId);
    const baseGen = baseR.isOk() ? baseR.value : null;

    if (baseGen === null) {
      // Without a base generation only the DA grain can answer.
      if (daGen === null) return baseR.isErr() ? err(baseR.error) : ok(null);
      // A busy base stays retryable for the other grains (the usecases answer
      // it); the DA grain, read from procurement_v3, still answers.
      const busyFor = baseR.isErr() ? retryAfterSecondsOf(baseR.error) : undefined;
      return ok({
        ...daGen,
        capabilities: {
          ...daGen.capabilities,
          analysisBaseUnavailable: true,
          ...(busyFor !== undefined && { analysisBaseBusyRetryAfterSeconds: busyFor }),
        },
        grainSources: { [DA]: { generation: daGen, coverage: [] } },
      });
    }
    const daSource: GrainSource =
      daGen !== null
        ? { generation: daGen, coverage: [] }
        : {
            // Fail closed: no verdict, no legacy fallback.
            generation: {
              ...baseGen,
              quality: {},
              capabilities: { ...DA_V3_CAPABILITIES, directAcquisitionV3Unavailable: true },
              notes: [
                'direct acquisitions (release 1) are unavailable: their publication could not be read',
              ],
            },
            coverage: [],
          };
    const request: ActiveGeneration = {
      ...baseGen,
      capabilities: { ...baseGen.capabilities, directAcquisitionV3: true },
      grainSources: { ...baseGen.grainSources, [DA]: daSource },
    };
    return ok(request);
  };

  return {
    activeGeneration,
    basisCoverage: (buildId) =>
      daBuilds.has(buildId) ? Promise.resolve(ok([])) : base.basisCoverage(buildId),
    statsFor: (route, scope, gen) =>
      route.grain === DA ? da.statsFor(route, scope, gen) : base.statsFor(route, scope, gen),
    seriesFor: (route, scope, gen, measure) =>
      route.grain === DA
        ? da.seriesFor(route, scope, gen, measure)
        : base.seriesFor(route, scope, gen, measure),
    distinctSeriesFor: (route, scope, gen, key, bucket) =>
      route.grain === DA
        ? da.distinctSeriesFor(route, scope, gen, key, bucket)
        : base.distinctSeriesFor(route, scope, gen, key, bucket),
    breakdownFor: (route, scope, gen, dimension, topN, rankBy) =>
      route.grain === DA
        ? da.breakdownFor(route, scope, gen, dimension, topN, rankBy)
        : base.breakdownFor(route, scope, gen, dimension, topN, rankBy),
    concentrationFor: (route, scope, gen, basis) =>
      route.grain === DA
        ? da.concentrationFor(route, scope, gen, basis)
        : base.concentrationFor(route, scope, gen, basis),
    recordsFor: (route, scope, gen, page) =>
      route.grain === DA
        ? da.recordsFor(route, scope, gen, page)
        : base.recordsFor(route, scope, gen, page),
    procedureCanonicalityBuild: () => base.procedureCanonicalityBuild(),
    procedureCanonicality: (buildId, ids) => base.procedureCanonicality(buildId, ids),
    procedureDuplicates: (buildId, id) => base.procedureDuplicates(buildId, id),
  };
};
