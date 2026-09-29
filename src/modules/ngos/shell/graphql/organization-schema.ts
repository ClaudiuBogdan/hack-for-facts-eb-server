import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, type ApiError } from '@/modules/shared/index.js';

import {
  getNgoFinancialStatements,
  getNgoOrganizationProfile,
  validateFiscalYears,
  type NgoOrganizationRepository,
} from '../../core/organization.js';

import type { NgoOrganizationProfile } from '../../core/organization-types.js';
import type { Result } from 'neverthrow';

export const ngoOrganizationTypeDefs = `
  """
  How the organization's CUI was admitted.
  registry_cui: accepted direct link, the CUI declared in the RNONG row.
  registry_cui_fiscal_agreement: corroborated declared link, the CUI declared in the RNONG row and
  matched by the organization's own ANAF record.
  fiscal_exact_name_county: name/county inference from an exact ANAF full-name and county match;
  the registry does not declare this CUI.
  document_registration_bridge: documentary bridge from published evidence to the registration.
  None is a legal verification.
  """
  enum NgoIdentityMethod {
    registry_cui
    registry_cui_fiscal_agreement
    fiscal_exact_name_county
    document_registration_bridge
  }
  "not_loaded is missing coverage, never a negative fact."
  enum NgoSectionAvailability {
    available
    not_loaded
    not_released
  }
  type NgoOrganizationIdentity {
    cui: CUI!
    method: NgoIdentityMethod!
  }
  type NgoPurposeSection {
    availability: NgoSectionAvailability!
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
  }
  extend type Query {
    "Null when the CUI is not the eligible identity of a current public registry organization; not proof it is not an NGO."
    ngoOrganizationProfile(cui: CUI!): NgoOrganizationProfile
  }
`;

type FinancialsParent = NgoOrganizationProfile['financials'] & { readonly cui: string };

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr())
    throw new GraphQLError(result.error.message, {
      extensions: { code: GRAPHQL_ERROR_CODE[result.error.type] },
    });
  return result.value;
};

export const makeNgoOrganizationResolvers = (repo: NgoOrganizationRepository) => ({
  Query: {
    ngoOrganizationProfile: async (_root: unknown, args: { cui: string }) =>
      unwrap(await getNgoOrganizationProfile(repo, args.cui)),
  },
  NgoOrganizationProfile: {
    financials: (profile: NgoOrganizationProfile): FinancialsParent => ({
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
      return section.availability === 'available'
        ? unwrap(await getNgoFinancialStatements(repo, section.cui, years))
        : [];
    },
  },
});
