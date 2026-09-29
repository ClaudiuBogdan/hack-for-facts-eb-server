import type { NgoRegistryRecord, NgoRegistrySnapshot } from './types.js';

/** Identity methods admitted by the data layer (scraper migrations 20260926T120000, 20260928T210000). */
export const NGO_IDENTITY_METHODS = [
  'registry_cui',
  'registry_cui_fiscal_agreement',
  'fiscal_exact_name_county',
  'document_registration_bridge',
] as const;
export type NgoIdentityMethod = (typeof NGO_IDENTITY_METHODS)[number];

/** The ANAF link is web-service documentation, not a captured response (same URL the fiscal views publish). */
export const ANAF_WEB_SERVICE_DOCUMENTATION_URL =
  'https://static.anaf.ro/static/10/Anaf/Informatii_R/servicii_web.html';

export type NgoRegistryConflictField =
  | 'court'
  | 'name'
  | 'category'
  | 'status'
  | 'county'
  | 'locality'
  | 'sourceCui'
  | 'identity'
  | 'cui';

/** `not_loaded` is missing coverage, never a negative fact. */
export type NgoLoadedSection<T> =
  | { readonly availability: 'available'; readonly data: T }
  | { readonly availability: 'not_loaded'; readonly data: null };

/** ANAF registration assertions from the observation the identity admits; none is a legal-status verdict. */
export interface NgoAnafRegistration {
  readonly registrationState: string | null;
  readonly registrationStateText: string | null;
  readonly registrationStateDate: string | null;
  readonly registrationDate: string | null;
  readonly legalForm: string | null;
  readonly organizationForm: string | null;
  readonly fiscalOffice: string | null;
  readonly declaredFiscallyInactive: boolean | null;
  readonly inactivatedOn: string | null;
  readonly reactivatedOn: string | null;
  readonly inactiveRegisterRemovedOn: string | null;
  readonly queryDate: string;
  readonly capturedAt: string;
  readonly sourceSnapshotId: string;
  readonly documentationUrl: string;
}

export interface NgoOrganizationFiscal {
  readonly vatPayer: boolean | null;
  readonly declaredFiscallyInactive: boolean | null;
  readonly mainCaenCode: string | null;
  readonly queryDate: string | null;
  readonly capturedAt: string | null;
  readonly sourceSnapshotId: string;
  readonly documentationUrl: string;
}

/** One dictionary position of one statement; `value` null is a blank source cell, "0" a reported zero. */
export interface NgoFinancialIndicator {
  readonly code: string;
  readonly label: string;
  readonly value: string | null;
}

export interface NgoFinancialStatement {
  readonly fiscalYear: number;
  readonly sourceUrl: string;
  readonly dictionaryUrl: string;
  readonly sourceRowNumber: number;
  readonly capturedAt: string;
  readonly indicators: readonly NgoFinancialIndicator[];
}

/** Current registry organization with an eligible admitted CUI. Consensus fields are null where observations differ. */
export interface NgoOrganizationProfile {
  readonly cui: string;
  readonly identity: { readonly cui: string; readonly method: NgoIdentityMethod };
  readonly organizationKey: string;
  readonly registryNumber: string;
  readonly registryNumberValid: boolean;
  readonly name: string | null;
  readonly category: string | null;
  readonly legalForm: string | null;
  readonly specialRegistryNumber: string | null;
  readonly sourceRegistrationDate: string | null;
  readonly sourceRegistryStatus: string | null;
  readonly county: string | null;
  readonly locality: string | null;
  readonly isBranch: boolean | null;
  readonly sourceReportsPublicUtility: boolean | null;
  readonly sourceCui: string | null;
  readonly courts: readonly string[];
  readonly observationCount: number;
  readonly conflicts: readonly NgoRegistryConflictField[];
  readonly snapshot: NgoRegistrySnapshot;
  readonly registryRecords: readonly NgoRegistryRecord[];
  readonly purpose: { readonly availability: 'not_released' };
  readonly anafRegistration: NgoLoadedSection<NgoAnafRegistration>;
  readonly fiscal: NgoLoadedSection<NgoOrganizationFiscal>;
  /** Admitted statement years; a missing year is unknown, not zero and not proof of no filing. */
  readonly financials: {
    readonly availability: 'available' | 'not_loaded';
    readonly fiscalYears: readonly number[];
  };
}
