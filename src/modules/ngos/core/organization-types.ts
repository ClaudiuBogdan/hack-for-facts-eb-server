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
  | 'cui'
  | 'purpose';

/**
 * Full RNONG purpose ("Scop") as published, trimmed at the ends; source masking tokens are kept.
 * `available` with null text is a blank source cell. `not_loaded`: purposes are not loaded for every
 * observation. `not_released`: the organization's observations disagree (see conflicts).
 * Provenance is the profile's registry `snapshot`.
 */
export type NgoPurpose =
  | { readonly availability: 'available'; readonly text: string | null }
  | { readonly availability: 'not_loaded' | 'not_released'; readonly text: null };

/** `not_loaded` is missing coverage, never a negative fact. */
export type NgoLoadedSection<T> =
  | { readonly availability: 'available'; readonly data: T }
  | { readonly availability: 'not_loaded'; readonly data: null };

/** The current snapshot a source-list section was read from; field names match `NgoRegistrySnapshot`. */
export interface NgoSectionSnapshot {
  readonly id: string;
  readonly sourceUrl: string;
  /** Null when the source publishes no snapshot date. */
  readonly sourceDeclaredDate: string | null;
  readonly importedAt: string;
}

/** A current source list keyed by the organization's CUI; an empty list means "not listed in this snapshot". */
export type NgoSourceSection<T> =
  | {
      readonly availability: 'available';
      readonly snapshot: NgoSectionSnapshot;
      readonly data: readonly T[];
    }
  | { readonly availability: 'not_loaded'; readonly snapshot: null; readonly data: null };

/** Licensed social service. Protective or unclassified types are `countyOnly`: no service name, no locality. */
export interface NgoSocialService {
  readonly serviceType: string | null;
  readonly serviceCode: string | null;
  readonly serviceName: string | null;
  readonly county: string | null;
  readonly locality: string | null;
  readonly capacity: number | null;
  readonly licenseNumber: string | null;
  readonly licensedOn: string | null;
  readonly countyOnly: boolean;
}

export interface NgoSocialServiceAccreditation {
  readonly certificateNumber: string | null;
  readonly decisionNumber: string | null;
}

/** RUEIS certificate; `status` is as published in the snapshot, not a live check. */
export interface NgoSocialEnterpriseCertificate {
  readonly certificateNumber: string | null;
  readonly certificateDate: string | null;
  readonly validUntil: string | null;
  readonly status: string | null;
}

export interface NgoEmploymentServiceAccreditation {
  readonly certificateNumber: string | null;
  readonly issuedOn: string | null;
}

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
  readonly purpose: NgoPurpose;
  readonly anafRegistration: NgoLoadedSection<NgoAnafRegistration>;
  readonly fiscal: NgoLoadedSection<NgoOrganizationFiscal>;
  /** Admitted statement years; a missing year is unknown, not zero and not proof of no filing. */
  readonly financials: {
    readonly availability: 'available' | 'not_loaded';
    readonly fiscalYears: readonly number[];
  };
  readonly socialServices: NgoSourceSection<NgoSocialService>;
  readonly socialServiceAccreditations: NgoSourceSection<NgoSocialServiceAccreditation>;
  readonly socialEnterpriseCertificates: NgoSourceSection<NgoSocialEnterpriseCertificate>;
  readonly employmentServiceAccreditations: NgoSourceSection<NgoEmploymentServiceAccreditation>;
}

/** Current registry group; CUI enrichment is absent unless identity is admitted. */
export interface NgoRegistryProfile extends Omit<NgoOrganizationProfile, 'cui' | 'identity'> {
  readonly cui: string | null;
  readonly identity: NgoOrganizationProfile['identity'] | null;
  readonly nameWithheld: boolean;
}
export interface NgoRegistryProfileResult {
  readonly status: 'resolved' | 'ambiguous';
  readonly profiles: readonly NgoRegistryProfile[];
}
