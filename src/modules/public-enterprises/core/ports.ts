import type {
  PublicEnterpriseIndicatorPage,
  PublicEnterpriseIndicatorRequest,
  PublicEnterpriseListRequest,
  PublicEnterpriseMembershipPage,
  PublicEnterpriseProfileRecord,
  PublicEnterpriseSource,
} from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/**
 * Reads ONLY the five R5 public views (`public_enterprises.public_*`). Every
 * method of a disabled repository returns an error without querying.
 */
export interface PublicEnterpriseRepository {
  /** The three source lanes, always in fixed order, unavailable ones included. */
  sources(): Promise<Result<readonly PublicEnterpriseSource[], ApiError>>;
  /** Null when the CUI is not a public anchor. */
  profile(cui: string): Promise<Result<PublicEnterpriseProfileRecord | null, ApiError>>;
  list(
    request: PublicEnterpriseListRequest
  ): Promise<Result<PublicEnterpriseMembershipPage, ApiError>>;
  indicators(
    request: PublicEnterpriseIndicatorRequest
  ): Promise<Result<PublicEnterpriseIndicatorPage, ApiError>>;
}
