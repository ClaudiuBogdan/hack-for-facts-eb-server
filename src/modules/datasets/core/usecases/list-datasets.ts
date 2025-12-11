// eslint-disable-next-line @typescript-eslint/naming-convention -- Fuse.js library exports PascalCase
import Fuse, { type IFuseOptions } from 'fuse.js';
import { err, ok, type Result } from 'neverthrow';

import { localizeDataset, toDatasetSummary } from './localize-dataset.js';

import type { DatasetRepoError } from '../errors.js';
import type { DatasetRepo } from '../ports.js';
import type {
  DatasetConnection,
  DatasetPageInfo,
  DatasetSummary,
  ListDatasetsInput,
} from '../types.js';

export interface ListDatasetsDeps {
  datasetRepo: DatasetRepo;
}

/**
 * Fuse.js options for fuzzy search across dataset fields.
 * Threshold of 0.3 provides a balance between precision and recall.
 */
const FUSE_OPTIONS: IFuseOptions<DatasetSummary> = {
  keys: [
    { name: 'name', weight: 1.0 },
    { name: 'title', weight: 1.0 },
    { name: 'description', weight: 0.8 },
    { name: 'sourceName', weight: 0.6 },
    { name: 'sourceUrl', weight: 0.4 },
  ],
  threshold: 0.3,
  ignoreLocation: true,
  includeScore: false,
};

/**
 * List datasets with optional filtering, search, and pagination.
 *
 * Processing order:
 * 1. Load all datasets
 * 2. Apply localization
 * 3. Filter by IDs (if provided)
 * 4. Apply fuzzy search (if search term provided)
 * 5. Sort alphabetically by ID
 * 6. Apply pagination
 * 7. Return connection with page info
 *
 * Performance note: The Fuse.js search index is recreated on each request.
 * For high-traffic scenarios, consider caching the index at the repository
 * level with cache invalidation when datasets change.
 */
export const listDatasets = async (
  deps: ListDatasetsDeps,
  input: ListDatasetsInput
): Promise<Result<DatasetConnection, DatasetRepoError>> => {
  // 1. Load all datasets
  const datasetsResult = await deps.datasetRepo.getAllWithMetadata();
  if (datasetsResult.isErr()) {
    return err(datasetsResult.error);
  }

  const datasets = datasetsResult.value;

  // 2. Apply localization and convert to summaries
  let summaries: DatasetSummary[] = datasets.map((dataset) => {
    const localized = localizeDataset(dataset, input.lang);
    return toDatasetSummary(localized);
  });

  // 3. Filter by IDs if provided
  if (input.filter?.ids !== undefined && input.filter.ids.length > 0) {
    const idsSet = new Set(input.filter.ids);
    summaries = summaries.filter((s) => idsSet.has(s.id));
  }

  // 4. Apply fuzzy search if search term provided
  if (input.filter?.search !== undefined && input.filter.search.trim() !== '') {
    const fuse = new Fuse(summaries, FUSE_OPTIONS);
    const results = fuse.search(input.filter.search.trim());
    summaries = results.map((r) => r.item);
  }

  // 5. Sort alphabetically by ID
  summaries.sort((a, b) => a.id.localeCompare(b.id));

  // 6. Calculate pagination
  const totalCount = summaries.length;
  const offset = Math.max(0, input.offset);
  const limit = Math.max(1, input.limit);

  // Apply pagination
  const paginatedSummaries = summaries.slice(offset, offset + limit);

  // 7. Build page info
  const pageInfo: DatasetPageInfo = {
    totalCount,
    hasNextPage: offset + limit < totalCount,
    hasPreviousPage: offset > 0,
  };

  return ok({
    nodes: paginatedSummaries,
    pageInfo,
  });
};
