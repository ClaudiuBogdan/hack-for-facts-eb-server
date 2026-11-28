/**
 * The analysis API's contract grain from the ClickHouse money build (PROC-KB0Z slice a,
 * flag PROCUREMENT_CA_ANALYSIS_ENABLED): stats and series over the facts procurementTotals
 * sums, with the same WHERE (`moneyWhere`), floor and D6 rule (`core/ca-money-analysis.ts`).
 *
 * - The generation is the active money build; its build id carries the floor day as well
 *   (`caMoneyBuildId`), so pins and caches move when either does.
 * - D6 is the totals' rule: a supplier scope reads facts only for a code that is public now
 *   (site-wide set, when enforced) and in this build's supplier map; otherwise it matches
 *   nothing. A read for a public supplier is re-checked against a fresh publication after it.
 * - The quality verdict is measured once per build and floor from the build's own coverage.
 * - Breakdowns, concentration, records and distinct counts are not served yet: the usecases
 *   abstain on them for this source (`contractMoneyV3`) before any read.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  disclosureKeyOf,
  invalidInput,
  serviceUnavailable,
  type ApiError,
  type Logger,
  type SupplierDisclosurePort,
} from '@/modules/shared/index.js';

import {
  CA_MONEY_VALUE_NOTE,
  caMoneyBuildId,
  caMoneyBuildIdFits,
  caMoneySeries,
  caMoneySeriesMeasureServed,
  caMoneyStats,
  caMoneyVerdict,
  compileCaMoneyScope,
  type CaMoneyPort,
  type CaMoneyQuery,
  type CaMoneyRow,
} from '../../core/ca-money-analysis.js';
import { servedCaFloor } from '../../core/money-totals.js';

import type { GenerationCapabilities } from '../../core/constants.js';
import type { GrainQualityVerdict } from '../../core/gate-v2.js';
import type { ActiveGeneration, AnalysisRepo } from '../../core/ports.js';

export const CA_MONEY_CAPABILITIES: GenerationCapabilities = {
  frameworkRole: true,
  supplierGeography: false,
  contractMoneyV3: true,
};

export interface CaMoneyAnalysisSource {
  /** The contract grain's generation; null when no money build is active. */
  generation(): Promise<Result<ActiveGeneration | null, ApiError>>;
  statsFor: AnalysisRepo['statsFor'];
  seriesFor: AnalysisRepo['seriesFor'];
}

const REPUBLISHED = (): ApiError =>
  serviceUnavailable(
    'the supplier privacy list or the money build moved during this request; repeat the request'
  );

/** What a build id this source issued stands for. */
interface Issued {
  readonly build: string;
  readonly floor: string;
}

/** How long a request waits for a build's first coverage measurement. */
const COVERAGE_WAIT_MS = 3000;

/** Issued build ids kept (a request resolves one; a few cover concurrent cutovers). */
const ISSUED_MAX = 32;

export const makeCaMoneyAnalysisSource = (
  port: CaMoneyPort,
  disclosure?: SupplierDisclosurePort,
  logger?: Logger
): CaMoneyAnalysisSource => {
  const issued = new Map<string, Issued>();
  const verdicts = new Map<string, Promise<Result<GrainQualityVerdict, ApiError>>>();
  const d6 = disclosure?.enforced === true ? disclosure : undefined;

  const verdictOf = (
    build: string,
    floor: string
  ): Promise<Result<GrainQualityVerdict, ApiError>> => {
    const key = `${build}:${floor}`;
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    const promise = port.contractCoverage(build, floor).then((coverage) => {
      if (coverage.isErr()) {
        verdicts.delete(key);
        logger?.warn(
          { build, error: coverage.error.message },
          'contract-award quality read failed'
        );
        return err(coverage.error);
      }
      return ok(caMoneyVerdict(coverage.value));
    });
    verdicts.set(key, promise);
    return promise;
  };

  const generation: CaMoneyAnalysisSource['generation'] = async () => {
    const build = await port.activeBuild();
    if (build.isErr()) return err(build.error);
    if (build.value === null) return ok(null);
    const recorded = await port.caFloor(build.value);
    const floor = servedCaFloor(recorded.isOk() ? recorded.value : null);
    let disclosureKey = 'off';
    if (d6 !== undefined) {
      const codes = await d6.publicSupplierCodes();
      if (codes.isErr()) return err(codes.error);
      disclosureKey = disclosureKeyOf(codes.value);
    }
    // A build id the pin cannot hold is not served (money builds are small sequential ids).
    if (!caMoneyBuildIdFits(build.value)) {
      return err(
        serviceUnavailable('the active money build id cannot be served as an analysis build')
      );
    }
    // Coverage is measured once per build and floor; a slow first measurement never holds up the
    // request (nor its other grains): the contract grain abstains this once instead.
    const quality = await Promise.race([
      verdictOf(build.value, floor),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, COVERAGE_WAIT_MS).unref();
      }),
    ]);
    // Coverage that could not be read (a missing grant, a dropped table, a slow first read)
    // abstains the grain before any read.
    if (quality === null || quality.isErr()) {
      return err(serviceUnavailable('the money build coverage could not be read'));
    }
    const buildId = caMoneyBuildId(build.value, floor);
    issued.delete(buildId);
    issued.set(buildId, { build: build.value, floor });
    while (issued.size > ISSUED_MAX) {
      const oldest = issued.keys().next().value;
      if (oldest === undefined) break;
      issued.delete(oldest);
    }
    return ok({
      buildId,
      publishedAt: null,
      matrixHash: null,
      quality: { contract: quality.value },
      capabilities: CA_MONEY_CAPABILITIES,
      disclosureKey,
      notes: [CA_MONEY_VALUE_NOTE],
    });
  };

  /** The rows of a compiled scope under D6, re-checked when a public supplier was read. */
  const rowsOf = async (
    gen: ActiveGeneration,
    query: CaMoneyQuery
  ): Promise<Result<readonly CaMoneyRow[], ApiError>> => {
    const source = issued.get(gen.buildId);
    if (source === undefined) return err(REPUBLISHED());
    // A scope whose record kinds intersect to none (a framework agreement under the purchases
    // default) selects nothing: never an empty IN list.
    if (query.shapes.length === 0) return ok([]);
    const code = query.filters.supplierCode;
    let ref: string | null = null;
    if (code !== null) {
      if (d6 !== undefined) {
        const codes = await d6.publicSupplierCodes();
        if (codes.isErr()) return err(codes.error);
        // Every answer of a request is decided under the key its envelope names.
        if (disclosureKeyOf(codes.value) !== (gen.disclosureKey ?? 'off'))
          return err(REPUBLISHED());
        if (!codes.value.has(code)) return ok([]);
      }
      const found = await port.supplierRef(source.build, code);
      if (found.isErr()) return err(found.error);
      ref = found.value;
    }
    // Not public in this build (D6, or a company the build gives no id): nothing is read.
    const rows =
      code !== null && ref === null
        ? ok([])
        : await port.contractRows(source.build, query.filters, ref, query.valueKinds, source.floor);
    if (rows.isErr()) return err(rows.error);
    // Every supplier-scoped answer, read or not, is re-checked against a fresh publication.
    if (d6 !== undefined && code !== null) {
      const fresh = await d6.publicSupplierCodes({ fresh: true });
      if (fresh.isErr()) return err(fresh.error);
      if (disclosureKeyOf(fresh.value) !== gen.disclosureKey) return err(REPUBLISHED());
    }
    return ok(rows.value);
  };

  const statsFor: CaMoneyAnalysisSource['statsFor'] = async (_route, scope, gen) => {
    const query = compileCaMoneyScope(scope);
    if (query.isErr()) return err(query.error);
    const rows = await rowsOf(gen, query.value);
    return rows.map((value) => caMoneyStats(value, query.value));
  };

  const seriesFor: CaMoneyAnalysisSource['seriesFor'] = async (_route, scope, gen, measure) => {
    if (!caMoneySeriesMeasureServed(measure)) {
      return err(
        invalidInput(`series measure '${measure}' is not served for contract awards yet`, 'measure')
      );
    }
    const query = compileCaMoneyScope(scope);
    if (query.isErr()) return err(query.error);
    const rows = await rowsOf(gen, query.value);
    return rows.map((value) => caMoneySeries(value, query.value, measure));
  };

  return { generation, statsFor, seriesFor };
};
