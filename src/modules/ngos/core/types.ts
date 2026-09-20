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
  readonly nameWithheld: boolean;
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

export interface NgoFiscalObservation {
  readonly vatPayer: boolean | null;
  readonly declaredFiscallyInactive: boolean | null;
  readonly splitVat: boolean | null;
  readonly mainCaenCode: string | null;
  readonly mainCaenRev: string | null;
  readonly queryDate: string | null;
  readonly capturedAt: string | null;
  readonly sourceUrl: string;
  readonly sourceSnapshotId: string;
}
export interface NgoProfileOverview {
  readonly cui: string;
  readonly identityBasis: 'accepted_rnong_cui';
  readonly registryRecords: readonly NgoRegistryRecord[];
  readonly fiscal:
    | { readonly availability: 'available'; readonly data: NgoFiscalObservation }
    | { readonly availability: 'unavailable'; readonly data: null };
  readonly sections: readonly {
    readonly key: 'financials' | 'services' | 'accreditations' | 'funding';
    readonly availability: 'not_released';
  }[];
}
