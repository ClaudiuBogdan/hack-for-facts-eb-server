export type {
  AdvancedMapDatasetVisibility,
  AdvancedMapDatasetJsonTextItem,
  AdvancedMapDatasetJsonLinkItem,
  AdvancedMapDatasetJsonMarkdownItem,
  AdvancedMapDatasetJsonItem,
  AdvancedMapDatasetRow,
  AdvancedMapDatasetReference,
  AdvancedMapDatasetSummary,
  AdvancedMapDatasetDetail,
  AdvancedMapDatasetPageInfo,
  AdvancedMapDatasetConnection,
  CreateAdvancedMapDatasetInput,
  UpdateAdvancedMapDatasetInput,
  ReplaceAdvancedMapDatasetRowsInput,
} from './core/types.js';

export {
  ADVANCED_MAP_DATASET_TITLE_MAX_LENGTH,
  ADVANCED_MAP_DATASET_DESCRIPTION_MAX_LENGTH,
  ADVANCED_MAP_DATASET_MARKDOWN_MAX_LENGTH,
  ADVANCED_MAP_DATASET_UNIT_MAX_LENGTH,
  ADVANCED_MAP_DATASET_MAX_UPLOAD_BYTES,
  ADVANCED_MAP_DATASET_MAX_ROW_COUNT,
  ADVANCED_MAP_DATASET_JSON_TEXT_MAX_LENGTH,
  ADVANCED_MAP_DATASET_JSON_LINK_URL_MAX_LENGTH,
  ADVANCED_MAP_DATASET_JSON_LINK_LABEL_MAX_LENGTH,
  AdvancedMapDatasetJsonTextValueSchema,
  AdvancedMapDatasetJsonLinkValueSchema,
  AdvancedMapDatasetJsonMarkdownValueSchema,
  AdvancedMapDatasetJsonTextItemSchema,
  AdvancedMapDatasetJsonLinkItemSchema,
  AdvancedMapDatasetJsonMarkdownItemSchema,
  AdvancedMapDatasetJsonItemSchema,
} from './core/types.js';

export type {
  InvalidInputError,
  NotFoundError,
  ForbiddenError,
  DatasetInUseError,
  ProviderError,
  AdvancedMapDatasetError,
} from './core/errors.js';

export {
  createInvalidInputError,
  createNotFoundError,
  createForbiddenError,
  createDatasetInUseError,
  createProviderError,
  ADVANCED_MAP_DATASET_ERROR_HTTP_STATUS,
  getHttpStatusForError,
} from './core/errors.js';

export type {
  CreateAdvancedMapDatasetParams,
  UpdateAdvancedMapDatasetMetadataParams,
  ReplaceAdvancedMapDatasetRowsParams,
  AccessibleAdvancedMapDatasetLookupInput,
  AdvancedMapDatasetRepository,
  AdvancedMapDatasetWritePermissionChecker,
} from './core/ports.js';

export {
  createAdvancedMapDataset,
  type CreateAdvancedMapDatasetDeps,
  type CreateAdvancedMapDatasetUseCaseInput,
} from './core/usecases/create-dataset.js';
export {
  deleteAdvancedMapDataset,
  type DeleteAdvancedMapDatasetDeps,
  type DeleteAdvancedMapDatasetInput,
} from './core/usecases/delete-dataset.js';
export {
  getAdvancedMapDataset,
  type GetAdvancedMapDatasetDeps,
  type GetAdvancedMapDatasetInput,
} from './core/usecases/get-dataset.js';
export {
  getPublicAdvancedMapDataset,
  type GetPublicAdvancedMapDatasetDeps,
  type GetPublicAdvancedMapDatasetInput,
} from './core/usecases/get-public-dataset.js';
export {
  listAdvancedMapDatasets,
  type ListAdvancedMapDatasetsDeps,
  type ListAdvancedMapDatasetsInput,
} from './core/usecases/list-datasets.js';
export {
  listPublicAdvancedMapDatasets,
  type ListPublicAdvancedMapDatasetsDeps,
  type ListPublicAdvancedMapDatasetsInput,
} from './core/usecases/list-public-datasets.js';
export {
  replaceAdvancedMapDatasetRows,
  type ReplaceAdvancedMapDatasetRowsDeps,
  type ReplaceAdvancedMapDatasetRowsUseCaseInput,
} from './core/usecases/replace-dataset-rows.js';
export {
  updateAdvancedMapDatasetMetadata,
  type UpdateAdvancedMapDatasetMetadataDeps,
  type UpdateAdvancedMapDatasetMetadataUseCaseInput,
} from './core/usecases/update-dataset-metadata.js';

export {
  makeAdvancedMapDatasetsRepo,
  type AdvancedMapDatasetsRepoOptions,
} from './shell/repo/advanced-map-datasets-repo.js';

export {
  makeClerkAdvancedMapDatasetWritePermissionChecker,
  type ClerkWritePermissionCheckerOptions,
} from './shell/security/clerk-write-permission-checker.js';

export {
  makeAdvancedMapDatasetRoutes,
  type MakeAdvancedMapDatasetRoutesDeps,
} from './shell/rest/routes.js';

export {
  DatasetVisibilitySchema,
  DatasetIdParamsSchema,
  DatasetPublicIdParamsSchema,
  DatasetListQuerySchema,
  CreateDatasetJsonBodySchema,
  ReplaceDatasetRowsBodySchema,
  UpdateDatasetBodySchema,
  DatasetRowSchema,
  DatasetSummarySchema,
  DatasetDetailSchema,
  DatasetPageInfoSchema,
  DatasetConnectionSchema,
  DatasetResponseSchema,
  DatasetListResponseSchema,
  DatasetDeleteResponseSchema,
  ErrorResponseSchema,
  type DatasetIdParams,
  type DatasetPublicIdParams,
  type DatasetListQuery,
  type CreateDatasetJsonBody,
  type ReplaceDatasetRowsBody,
  type UpdateDatasetBody,
} from './shell/rest/schemas.js';

export {
  defaultAdvancedMapDatasetIdGenerator,
  type AdvancedMapDatasetIdGenerator,
} from './shell/utils/id-generator.js';
