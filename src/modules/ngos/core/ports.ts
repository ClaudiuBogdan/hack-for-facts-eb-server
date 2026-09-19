import type {
  NgoRegistryPage,
  NgoRegistryRecord,
  NgoRegistryRequest,
  NgoRegistrySnapshot,
} from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

export interface NgoRegistryRepository {
  coverage(): Promise<Result<NgoRegistrySnapshot, ApiError>>;
  list(request: NgoRegistryRequest): Promise<Result<NgoRegistryPage, ApiError>>;
  detail(id: string): Promise<Result<NgoRegistryRecord | null, ApiError>>;
}
