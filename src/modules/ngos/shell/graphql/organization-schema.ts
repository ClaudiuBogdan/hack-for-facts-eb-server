import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, type ApiError } from '@/modules/shared/index.js';

import {
  getNgoFinancialStatements,
  getNgoOrganizationProfile,
  getNgoRegistryProfile,
  validateFiscalYears,
  type NgoOrganizationRepository,
} from '../../core/organization.js';

import type { NgoOrganizationProfile, NgoRegistryProfile } from '../../core/organization-types.js';
import type { Result } from 'neverthrow';

export const ngoOrganizationTypeDefs = `
  "not_loaded is missing coverage, never a negative fact. not_released is emitted only by purpose, when the organization's observations disagree."
  enum NgoSectionAvailability {
    available
    not_loaded
    not_released
  }
  type NgoOrganizationIdentity {
    cui: CUI!
    method: NgoIdentityMethod!
  }
  "RNONG purpose (Scop) of the organization's registry observations; provenance is the profile's snapshot. available with null text: blank source cell. not_loaded: purposes are not loaded for every observation. not_released: the observations disagree (conflicts lists purpose)."
  type NgoPurposeSection {
    availability: NgoSectionAvailability!
    "Full source text as published, trimmed at the ends; source masking tokens such as <PERSON> are kept."
    text: String
  }
  "ANAF registration assertions of the admitted observation. Registration state, fiscal inactivity and inactive-register removal are not legal dissolution."
  type NgoAnafRegistration {
    registrationState: String
    registrationStateText: String
    registrationStateDate: Date
    registrationDate: Date
    legalForm: String
    organizationForm: String
    "Competent ANAF office (an institution, not an address)."
    fiscalOffice: String
    declaredFiscallyInactive: Boolean
    inactivatedOn: Date
    reactivatedOn: Date
    inactiveRegisterRemovedOn: Date
    queryDate: Date!
    capturedAt: DateTime!
    sourceSnapshotId: String!
    "ANAF web-service documentation, not a captured response."
    documentationUrl: String!
  }
  type NgoAnafRegistrationSection {
    availability: NgoSectionAvailability!
    data: NgoAnafRegistration
  }
  type NgoOrganizationFiscal {
    vatPayer: Boolean
    declaredFiscallyInactive: Boolean
    mainCaenCode: String
    queryDate: Date
    capturedAt: DateTime
    sourceSnapshotId: String!
    "ANAF web-service documentation, not a captured response."
    documentationUrl: String!
  }
  type NgoOrganizationFiscalSection {
    availability: NgoSectionAvailability!
    data: NgoOrganizationFiscal
  }
  "One position of this statement's own dictionary; the same code can mean different things in other years."
  type NgoFinancialIndicator {
    code: String!
    "Verbatim label from this resource's dictionary."
    label: String!
    "Exact integer string as published; null is a blank source cell, \\"0\\" a reported zero."
    value: String
  }
  type NgoFinancialStatement {
    fiscalYear: Int!
    "Official MF resource the statement was read from."
    sourceUrl: String!
    "Official dictionary for this resource's labels."
    dictionaryUrl: String!
    sourceRowNumber: Int!
    capturedAt: DateTime!
    indicators: [NgoFinancialIndicator!]!
  }
  type NgoFinancialsSection {
    availability: NgoSectionAvailability!
    "Admitted MFP statement years. A missing year is unknown: not zero and not proof of no filing."
    fiscalYears: [Int!]!
    "Admitted statements, newest first; no totals are computed. fiscalYears: 1-20 distinct years (1990-2100), validated even when financials are not loaded. Read separately from the profile, in its own database snapshot."
    statements(fiscalYears: [Int!]): [NgoFinancialStatement!]!
  }
  """
  Current source snapshot of a list section (socialServices, socialServiceAccreditations,
  socialEnterpriseCertificates, employmentServiceAccreditations); field names match NgoRegistrySnapshot.
  Lists are joined by CUI only. available with an empty data list: the organization is not listed in
  this snapshot. not_loaded: snapshot and data are null.
  """
  type NgoSectionSnapshot {
    id: ID!
    sourceUrl: String!
    "Null when the source publishes no snapshot date; importedAt is when it was loaded."
    sourceDeclaredDate: Date
    importedAt: DateTime!
  }
  "Licensed social service as listed by the ministry. countyOnly: a protective or unclassified service type (e.g. shelters for victims of domestic violence or trafficking, residential child protection), published with county only: no service name, no locality."
  type NgoSocialService {
    serviceType: String
    serviceCode: String
    serviceName: String
    county: String
    locality: String
    capacity: Int
    licenseNumber: String
    licensedOn: Date
    countyOnly: Boolean!
  }
  "Ministry list of licensed social services; see NgoSectionSnapshot for list semantics."
  type NgoSocialServicesSection {
    availability: NgoSectionAvailability!
    snapshot: NgoSectionSnapshot
    data: [NgoSocialService!]
  }
  "Accreditation as a social-service provider: certificate in force and accreditation decision number, as listed."
  type NgoSocialServiceAccreditation {
    certificateNumber: String
    decisionNumber: String
  }
  "Ministry list of accredited social-service providers; see NgoSectionSnapshot."
  type NgoSocialServiceAccreditationsSection {
    availability: NgoSectionAvailability!
    snapshot: NgoSectionSnapshot
    data: [NgoSocialServiceAccreditation!]
  }
  "RUEIS social-enterprise certificate. status is as published in that snapshot, not a live check."
  type NgoSocialEnterpriseCertificate {
    certificateNumber: String
    certificateDate: Date
    validUntil: Date
    status: String
  }
  "ANOFM social-enterprise register (RUEIS); see NgoSectionSnapshot."
  type NgoSocialEnterpriseCertificatesSection {
    availability: NgoSectionAvailability!
    snapshot: NgoSectionSnapshot
    data: [NgoSocialEnterpriseCertificate!]
  }
  "ANOFM accreditation as an employment-service provider."
  type NgoEmploymentServiceAccreditation {
    certificateNumber: String
    issuedOn: Date
  }
  "ANOFM register of accredited employment-service providers; see NgoSectionSnapshot."
  type NgoEmploymentServiceAccreditationsSection {
    availability: NgoSectionAvailability!
    snapshot: NgoSectionSnapshot
    data: [NgoEmploymentServiceAccreditation!]
  }
  "Current RNONG organization whose CUI is an eligible admitted identity. Registry fields are source assertions; consensus fields are null where observations differ (see conflicts)."
  type NgoOrganizationProfile {
    cui: CUI!
    identity: NgoOrganizationIdentity!
    organizationKey: String!
    registryNumber: String!
    registryNumberValid: Boolean!
    name: String
    category: String
    legalForm: String
    specialRegistryNumber: String
    sourceRegistrationDate: Date
    sourceRegistryStatus: String
    county: String
    locality: String
    isBranch: Boolean
    sourceReportsPublicUtility: Boolean
    "Registry-declared CUI (display only); see identity.method for how the organization CUI was admitted."
    sourceCui: String
    courts: [String!]!
    observationCount: Int!
    conflicts: [String!]!
    snapshot: NgoRegistrySnapshot!
    registryRecords: [NgoRegistryRecord!]!
    purpose: NgoPurposeSection!
    anafRegistration: NgoAnafRegistrationSection!
    fiscal: NgoOrganizationFiscalSection!
    financials: NgoFinancialsSection!
    socialServices: NgoSocialServicesSection!
    socialServiceAccreditations: NgoSocialServiceAccreditationsSection!
    socialEnterpriseCertificates: NgoSocialEnterpriseCertificatesSection!
    employmentServiceAccreditations: NgoEmploymentServiceAccreditationsSection!
  }
  type NgoRegistryProfile {
    cui: CUI
    identity: NgoOrganizationIdentity
    organizationKey: String!
    registryNumber: String!
    registryNumberValid: Boolean!
    nameWithheld: Boolean!
    name: String
    category: String
    legalForm: String
    specialRegistryNumber: String
    sourceRegistrationDate: Date
    sourceRegistryStatus: String
    county: String
    locality: String
    isBranch: Boolean
    sourceReportsPublicUtility: Boolean
    "Registry-declared CUI (display only); see identity.method for how the organization CUI was admitted."
    sourceCui: String
    courts: [String!]!
    observationCount: Int!
    conflicts: [String!]!
    snapshot: NgoRegistrySnapshot!
    registryRecords: [NgoRegistryRecord!]!
    purpose: NgoPurposeSection!
    anafRegistration: NgoAnafRegistrationSection!
    fiscal: NgoOrganizationFiscalSection!
    financials: NgoFinancialsSection!
    socialServices: NgoSocialServicesSection!
    socialServiceAccreditations: NgoSocialServiceAccreditationsSection!
    socialEnterpriseCertificates: NgoSocialEnterpriseCertificatesSection!
    employmentServiceAccreditations: NgoEmploymentServiceAccreditationsSection!
  }
  enum NgoRegistryProfileStatus { resolved ambiguous }
  "Current registry-number lookup. Malformed literals can identify several observation groups; ambiguous returns all candidates, never an arbitrary first one."
  type NgoRegistryProfileResult { status: NgoRegistryProfileStatus! profiles: [NgoRegistryProfile!]! }
  extend type Query {
    ngoRegistryProfile(registryNumber: String!): NgoRegistryProfileResult
    "Null when the CUI is not the eligible identity of a current public registry organization; not proof it is not an NGO."
    ngoOrganizationProfile(cui: CUI!): NgoOrganizationProfile
  }
`;

type FinancialsParent = NgoOrganizationProfile['financials'] & { readonly cui: string | null };

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr())
    throw new GraphQLError(result.error.message, {
      extensions: { code: GRAPHQL_ERROR_CODE[result.error.type] },
    });
  return result.value;
};

export const makeNgoOrganizationResolvers = (repo: NgoOrganizationRepository) => ({
  Query: {
    ngoRegistryProfile: async (_root: unknown, args: { registryNumber: string }) =>
      unwrap(await getNgoRegistryProfile(repo, args.registryNumber)),
    ngoOrganizationProfile: async (_root: unknown, args: { cui: string }) =>
      unwrap(await getNgoOrganizationProfile(repo, args.cui)),
  },
  NgoOrganizationProfile: {
    financials: (profile: NgoOrganizationProfile): FinancialsParent => ({
      ...profile.financials,
      cui: profile.cui,
    }),
  },
  NgoRegistryProfile: {
    financials: (profile: NgoRegistryProfile): FinancialsParent => ({
      ...profile.financials,
      cui: profile.cui,
    }),
  },
  NgoFinancialsSection: {
    statements: async (
      section: FinancialsParent,
      args: { fiscalYears?: readonly number[] | null }
    ) => {
      // Validate before the availability shortcut: an invalid request is never "no coverage".
      const years = unwrap(validateFiscalYears(args.fiscalYears ?? null));
      return section.availability === 'available' && section.cui !== null
        ? unwrap(await getNgoFinancialStatements(repo, section.cui, years))
        : [];
    },
  },
});
