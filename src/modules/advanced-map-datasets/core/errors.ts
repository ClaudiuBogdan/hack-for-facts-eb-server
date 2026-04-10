export interface InvalidInputError {
  type: 'InvalidInputError';
  message: string;
}

export interface NotFoundError {
  type: 'NotFoundError';
  message: string;
}

export interface ForbiddenError {
  type: 'ForbiddenError';
  message: string;
}

export interface DatasetInUseError {
  type: 'DatasetInUseError';
  message: string;
  referencingMaps: readonly {
    mapId: string;
    title: string;
    snapshotId: string | null;
  }[];
}

export interface ProviderError {
  type: 'ProviderError';
  message: string;
  cause?: unknown;
}

export type AdvancedMapDatasetError =
  | InvalidInputError
  | NotFoundError
  | ForbiddenError
  | DatasetInUseError
  | ProviderError;

export const createInvalidInputError = (message: string): InvalidInputError => ({
  type: 'InvalidInputError',
  message,
});

export const createNotFoundError = (message = 'Dataset not found'): NotFoundError => ({
  type: 'NotFoundError',
  message,
});

export const createForbiddenError = (message = 'Access denied'): ForbiddenError => ({
  type: 'ForbiddenError',
  message,
});

export const createDatasetInUseError = (
  referencingMaps: readonly {
    mapId: string;
    title: string;
    snapshotId: string | null;
  }[],
  message = 'Dataset is still referenced by existing maps'
): DatasetInUseError => ({
  type: 'DatasetInUseError',
  message,
  referencingMaps,
});

export const createProviderError = (message: string, cause?: unknown): ProviderError => ({
  type: 'ProviderError',
  message,
  ...(cause !== undefined ? { cause } : {}),
});

export const ADVANCED_MAP_DATASET_ERROR_HTTP_STATUS: Record<
  AdvancedMapDatasetError['type'],
  number
> = {
  InvalidInputError: 400,
  NotFoundError: 404,
  ForbiddenError: 403,
  DatasetInUseError: 400,
  ProviderError: 500,
};

export const getHttpStatusForError = (error: AdvancedMapDatasetError): number => {
  return ADVANCED_MAP_DATASET_ERROR_HTTP_STATUS[error.type];
};
