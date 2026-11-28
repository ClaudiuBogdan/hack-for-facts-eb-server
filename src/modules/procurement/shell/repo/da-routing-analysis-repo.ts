/**
 * The analysis repo with grains answered by their own sources:
 * - direct_acquisition (PROCUREMENT_DA_V3_ENABLED): procurement_v3 on Postgres today, a
 *   ClickHouse projection of procurement_v3 later — both behind `DaV3AnalysisSource`;
 * - contract (PROCUREMENT_CA_ANALYSIS_ENABLED, PROC-KB0Z): the ClickHouse money build,
 *   behind `CaMoneyAnalysisSource` (stats and series; other shapes abstain in the usecases).
 * Every other grain, and procedure canonicality, stays on the base repo (ClickHouse).
 *
 * The request generation is the base generation with `capabilities.directAcquisitionV3` /
 * `contractMoneyV3` set and each routed grain's own generation under `grainSources`; the
 * usecases gate, label and read a routed grain with that one. A routed grain never falls back
 * to the legacy facts (they name suppliers D6 withholds): when its source cannot resolve a
 * generation, it carries no quality verdict (money, time and geo abstain) and its reads fail,
 * while the other grains still answer.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  retryAfterSecondsOf,
  serviceUnavailable,
  type ApiError,
  type Logger,
} from '@/modules/shared/index.js';

import { CA_MONEY_CAPABILITIES, type CaMoneyAnalysisSource } from './ca-money-analysis-source.js';
import { DA_V3_CAPABILITIES, type DaV3AnalysisSource } from './da-v3-analysis-source.js';

import type { AnalysisGrain } from '../../core/constants.js';
import type { ActiveGeneration, AnalysisRepo, GrainSource } from '../../core/ports.js';

const DA = 'direct_acquisition';
const CONTRACT = 'contract';

const CA_UNAVAILABLE_NOTE = 'contract awards are unavailable: the money build could not be read';
const DA_UNAVAILABLE_NOTE =
  'direct acquisitions (release 1) are unavailable: their publication could not be read';

/** A shape this source does not serve was read (the usecases abstain before it). */
const notServed = (): Promise<Result<never, ApiError>> =>
  Promise.resolve(
    err(serviceUnavailable('this shape is not served for contract awards from the money build yet'))
  );

export const makeDaRoutingAnalysisRepo = (
  base: AnalysisRepo,
  da: DaV3AnalysisSource | undefined,
  logger?: Logger,
  ca?: CaMoneyAnalysisSource
): AnalysisRepo => {
  /** Build ids the routed sources issued; their basis coverage is empty (no estimate is served). */
  const ownBuilds = new Set<string>();

  const resolve = async (
    read: (() => Promise<Result<ActiveGeneration | null, ApiError>>) | undefined,
    label: string
  ): Promise<ActiveGeneration | null> => {
    if (read === undefined) return null;
    const result = await read();
    if (result.isErr()) {
      logger?.warn({ error: result.error.message }, `${label} generation unavailable`);
      return null;
    }
    if (result.value !== null) ownBuilds.add(result.value.buildId);
    return result.value;
  };

  /** A routed grain whose source resolved nothing: no verdict, its own unavailability. */
  const failClosed = (template: ActiveGeneration, grain: AnalysisGrain): GrainSource => ({
    generation: {
      ...template,
      quality: {},
      capabilities:
        grain === DA
          ? { ...DA_V3_CAPABILITIES, directAcquisitionV3Unavailable: true }
          : { ...CA_MONEY_CAPABILITIES, contractMoneyV3Unavailable: true },
      notes: [grain === DA ? DA_UNAVAILABLE_NOTE : CA_UNAVAILABLE_NOTE],
    },
    coverage: [],
  });

  const activeGeneration: AnalysisRepo['activeGeneration'] = async () => {
    const [baseR, daGen, caGen] = await Promise.all([
      base.activeGeneration(),
      resolve(da === undefined ? undefined : () => da.generation(), 'direct-acquisition'),
      resolve(ca === undefined ? undefined : () => ca.generation(), 'contract-award'),
    ]);
    const baseGen = baseR.isOk() ? baseR.value : null;
    // The generation the request carries when the base has none: the first routed one resolved.
    const template = baseGen ?? daGen ?? caGen;
    if (template === null) return baseR.isErr() ? err(baseR.error) : ok(null);

    const grainSources: Partial<Record<AnalysisGrain, GrainSource>> = {
      ...baseGen?.grainSources,
    };
    if (da !== undefined) {
      grainSources[DA] =
        daGen !== null ? { generation: daGen, coverage: [] } : failClosed(template, DA);
    }
    if (ca !== undefined) {
      grainSources[CONTRACT] =
        caGen !== null ? { generation: caGen, coverage: [] } : failClosed(template, CONTRACT);
    }
    const routed = {
      ...(da !== undefined && { directAcquisitionV3: true }),
      ...(ca !== undefined && { contractMoneyV3: true }),
    };

    if (baseGen === null) {
      // A busy base stays retryable for the other grains (the usecases answer it); the
      // routed grains, read from their own sources, still answer.
      const busyFor = baseR.isErr() ? retryAfterSecondsOf(baseR.error) : undefined;
      return ok({
        ...template,
        capabilities: {
          ...template.capabilities,
          ...routed,
          analysisBaseUnavailable: true,
          ...(busyFor !== undefined && { analysisBaseBusyRetryAfterSeconds: busyFor }),
        },
        grainSources,
      });
    }
    return ok({
      ...baseGen,
      capabilities: { ...baseGen.capabilities, ...routed },
      grainSources,
    });
  };

  const isDa = (grain: AnalysisGrain): boolean => grain === DA && da !== undefined;
  const isCa = (grain: AnalysisGrain): boolean => grain === CONTRACT && ca !== undefined;

  return {
    activeGeneration,
    basisCoverage: (buildId) =>
      ownBuilds.has(buildId) ? Promise.resolve(ok([])) : base.basisCoverage(buildId),
    statsFor: (route, scope, gen) =>
      isDa(route.grain) && da !== undefined
        ? da.statsFor(route, scope, gen)
        : isCa(route.grain) && ca !== undefined
          ? ca.statsFor(route, scope, gen)
          : base.statsFor(route, scope, gen),
    seriesFor: (route, scope, gen, measure) =>
      isDa(route.grain) && da !== undefined
        ? da.seriesFor(route, scope, gen, measure)
        : isCa(route.grain) && ca !== undefined
          ? ca.seriesFor(route, scope, gen, measure)
          : base.seriesFor(route, scope, gen, measure),
    distinctSeriesFor: (route, scope, gen, key, bucket) =>
      isDa(route.grain) && da !== undefined
        ? da.distinctSeriesFor(route, scope, gen, key, bucket)
        : isCa(route.grain)
          ? notServed()
          : base.distinctSeriesFor(route, scope, gen, key, bucket),
    breakdownFor: (route, scope, gen, dimension, topN, rankBy) =>
      isDa(route.grain) && da !== undefined
        ? da.breakdownFor(route, scope, gen, dimension, topN, rankBy)
        : isCa(route.grain)
          ? notServed()
          : base.breakdownFor(route, scope, gen, dimension, topN, rankBy),
    concentrationFor: (route, scope, gen, basis) =>
      isDa(route.grain) && da !== undefined
        ? da.concentrationFor(route, scope, gen, basis)
        : isCa(route.grain)
          ? notServed()
          : base.concentrationFor(route, scope, gen, basis),
    recordsFor: (route, scope, gen, page) =>
      isDa(route.grain) && da !== undefined
        ? da.recordsFor(route, scope, gen, page)
        : isCa(route.grain)
          ? notServed()
          : base.recordsFor(route, scope, gen, page),
    procedureCanonicalityBuild: () => base.procedureCanonicalityBuild(),
    procedureCanonicality: (buildId, ids) => base.procedureCanonicality(buildId, ids),
    procedureDuplicates: (buildId, id) => base.procedureDuplicates(buildId, id),
  };
};
