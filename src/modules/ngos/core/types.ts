import type { FilterInput } from '@/modules/shared/index.js';

export interface NgoRegistrySnapshot {
  readonly id: string;
  readonly sourceDeclaredDate: string | null;
  readonly importedAt: string;
  readonly capturedAt: string;
  readonly refreshOverdue: boolean;
  readonly acceptedAt: string | null;
  readonly recordCount: number;
  readonly isCurrent: boolean;
  readonly sourceUrl: string;
  readonly coverageBasis: string;
  readonly nationalCompleteness: string;
}

/** Public projection only: purpose/raw payload/address/contact fields cannot inhabit this type. */
export interface NgoRegistryRecord {
  readonly id: string;
  readonly sourceRowNumber: number;
  readonly registryNumber: string;
  readonly specialRegistryNumber: string | null;
  readonly sourceRegistrationDate: string | null;
  readonly category: string;
  readonly legalForm: string;
  readonly name: string;
  readonly court: string;
  readonly sourceRegistryStatus: string;
  readonly county: string | null;
  readonly locality: string | null;
  readonly sourceCui: string | null;
  readonly linkedOrganizationCui: string | null;
  readonly isBranch: boolean | null;
  readonly sourceReportsPublicUtility: boolean | null;
  readonly snapshot: NgoRegistrySnapshot;
}
export interface NgoRegistryPage {
  readonly items: readonly NgoRegistryRecord[];
  readonly next: string | null;
  readonly snapshot: NgoRegistrySnapshot;
}
export interface NgoRegistryRequest {
  readonly filter: FilterInput;
  readonly first: number;
  readonly after?: string;
}
