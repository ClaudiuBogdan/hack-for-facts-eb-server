/** One published source page: descriptor and observations share a database snapshot. */
import { err, ok, type Result } from 'neverthrow';

import {
  MAX_OBSERVATION_LIMIT,
  type InsDatasetView,
  type InsDimensionView,
  type InsObservationFilter,
  type InsObservationView,
  type InsPage,
} from './types.js';
import { listObservations } from './usecases.js';

import type { InsRepo } from './ports.js';
import type { ApiError } from '@/modules/shared/index.js';

export interface InsPublicationToken {
  readonly revisionId: string;
  readonly custodySha256: string;
  readonly transformContractSha256: string;
}
export type InsSourcePageResult =
  | {
      readonly kind: 'page';
      readonly dataset: InsDatasetView | null;
      readonly dimensions: readonly InsDimensionView[];
      readonly publication: InsPublicationToken | null;
      readonly page: InsPage<InsObservationView>;
    }
  | {
      readonly kind: 'publicationChanged';
      readonly currentPublication: InsPublicationToken | null;
    };

const tokenOf = (dataset: InsDatasetView | null): InsPublicationToken | null =>
  dataset?.publicationStatus === 'READY' &&
  dataset.revisionId !== null &&
  dataset.custodySha256 !== null &&
  dataset.transformContractSha256 !== null
    ? {
        revisionId: dataset.revisionId,
        custodySha256: dataset.custodySha256,
        transformContractSha256: dataset.transformContractSha256,
      }
    : null;

export const readInsSourcePage = (
  outer: InsRepo,
  input: {
    readonly datasetCode: string;
    readonly filter: InsObservationFilter;
    readonly limit: number;
    readonly offset: number;
    readonly expectedPublication?: InsPublicationToken;
  }
): Promise<Result<InsSourcePageResult, ApiError>> => {
  if (
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_OBSERVATION_LIMIT ||
    (input.offset > 0 && input.expectedPublication === undefined)
  ) {
    return Promise.resolve(
      err({
        type: 'InvalidInput',
        field: 'offset',
        message:
          'Source continuation requires a valid offset, limit and expectedPublication from the first page',
      })
    );
  }
  return outer.withSnapshot(async (repo): Promise<Result<InsSourcePageResult, ApiError>> => {
    const code = input.datasetCode.trim().toUpperCase();
    const found = await repo.getDataset(code);
    if (found.isErr()) return err(found.error);
    const dataset = found.value;
    if (
      dataset !== null &&
      dataset.publicationStatus !== 'NOT_LOADED' &&
      (dataset.publicationStatus !== 'READY' ||
        dataset.dataStatus !== 'AVAILABLE' ||
        tokenOf(dataset) === null)
    )
      return err({ type: 'ServiceUnavailable', message: 'INS dataset publication is unavailable' });
    const publication = tokenOf(dataset);
    const expected = input.expectedPublication;
    // Tokens are compared only in code; they never parameterize a database query.
    if (
      expected !== undefined &&
      (expected.revisionId !== publication?.revisionId ||
        expected.custodySha256 !== publication.custodySha256 ||
        expected.transformContractSha256 !== publication.transformContractSha256)
    )
      return ok({ kind: 'publicationChanged', currentPublication: publication });
    const dimensions = dataset === null ? ok([]) : await repo.listDimensions(code);
    if (dimensions.isErr()) return err(dimensions.error);
    const page = await listObservations(repo, code, input.filter, input.limit, input.offset);
    if (page.isErr()) return err(page.error);
    return ok({
      kind: 'page',
      dataset,
      dimensions: dimensions.value,
      publication,
      page: page.value,
    });
  });
};
