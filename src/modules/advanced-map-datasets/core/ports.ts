import type { AdvancedMapDatasetError } from './errors.js';
import type {
  AdvancedMapDatasetConnection,
  AdvancedMapDatasetDetail,
  AdvancedMapDatasetReference,
  AdvancedMapDatasetRow,
  AdvancedMapDatasetSummary,
  AdvancedMapDatasetVisibility,
} from './types.js';
import type { Result } from 'neverthrow';

export interface CreateAdvancedMapDatasetParams {
  id: string;
  publicId: string;
  userId: string;
  title: string;
  description: string | null;
  markdown: string | null;
  unit: string | null;
  visibility: AdvancedMapDatasetVisibility;
  rows: readonly AdvancedMapDatasetRow[];
}

export interface UpdateAdvancedMapDatasetMetadataParams {
  datasetId: string;
  userId: string;
  title: string;
  description: string | null;
  markdown: string | null;
  unit: string | null;
  visibility: AdvancedMapDatasetVisibility;
  allowPublicWrite: boolean;
}

export interface ReplaceAdvancedMapDatasetRowsParams {
  datasetId: string;
  userId: string;
  rows: readonly AdvancedMapDatasetRow[];
  allowPublicWrite: boolean;
}

export interface AccessibleAdvancedMapDatasetLookupInput {
  datasetId?: string;
  datasetPublicId?: string;
  requestUserId?: string;
}

export interface AdvancedMapDatasetRepository {
  createDataset(
    input: CreateAdvancedMapDatasetParams
  ): Promise<Result<AdvancedMapDatasetDetail, AdvancedMapDatasetError>>;

  getDatasetForUser(
    datasetId: string,
    userId: string
  ): Promise<Result<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>>;

  listDatasetsForUser(
    userId: string,
    limit: number,
    offset: number
  ): Promise<Result<AdvancedMapDatasetConnection, AdvancedMapDatasetError>>;

  updateDatasetMetadata(
    input: UpdateAdvancedMapDatasetMetadataParams
  ): Promise<Result<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>>;

  replaceDatasetRows(
    input: ReplaceAdvancedMapDatasetRowsParams
  ): Promise<Result<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>>;

  softDeleteDataset(
    datasetId: string,
    userId: string,
    allowPublicWrite: boolean
  ): Promise<Result<boolean, AdvancedMapDatasetError>>;

  listPublicDatasets(
    limit: number,
    offset: number
  ): Promise<Result<AdvancedMapDatasetConnection, AdvancedMapDatasetError>>;

  getPublicDatasetByPublicId(
    publicId: string
  ): Promise<Result<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>>;

  getShareableDatasetHeadById(
    datasetId: string
  ): Promise<Result<AdvancedMapDatasetSummary | null, AdvancedMapDatasetError>>;

  getAccessibleDatasetHead(
    input: AccessibleAdvancedMapDatasetLookupInput
  ): Promise<Result<AdvancedMapDatasetSummary | null, AdvancedMapDatasetError>>;

  getAccessibleDataset(
    input: AccessibleAdvancedMapDatasetLookupInput
  ): Promise<Result<AdvancedMapDatasetDetail | null, AdvancedMapDatasetError>>;

  listDatasetRows(
    datasetId: string
  ): Promise<Result<AdvancedMapDatasetRow[], AdvancedMapDatasetError>>;

  listReferencingMaps(
    datasetId: string
  ): Promise<Result<AdvancedMapDatasetReference[], AdvancedMapDatasetError>>;

  listPublicReferencingMaps(
    datasetId: string
  ): Promise<Result<AdvancedMapDatasetReference[], AdvancedMapDatasetError>>;
}

export interface AdvancedMapDatasetWritePermissionChecker {
  canWrite(userId: string): Promise<boolean>;
}
