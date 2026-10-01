import { z } from 'zod';

import {
  GRAPHQL_ERROR_CODE,
  invalidInput,
  type ApiError,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import { ngoProfileLink } from './profile-links.js';
import {
  getNgoFinancialStatements,
  getNgoOrganizationProfile,
  getNgoRegistryProfile,
  MAX_FISCAL_YEAR,
  MIN_FISCAL_YEAR,
  validateFiscalYears,
  type NgoOrganizationRepository,
} from '../../core/organization.js';

/** Bounds the optional statement payload (46 labelled values per statement). */
export const MCP_MAX_FINANCIAL_YEARS = 3;

const KIND = 'ngo_organization_profile';
const failure = (error: ApiError): McpToolOutput => ({
  ok: false,
  kind: KIND,
  error: error.message,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
});

export const makeNgoOrganizationMcpTools = (
  repo: NgoOrganizationRepository,
  clientBaseUrl: string
): readonly KernelMcpTool[] => [
  {
    name: 'get_ngo_registry_profile',
    description:
      'Current NGO profile by literal RNONG registry number. Returns status resolved or ambiguous and profiles, each with nullable admitted CUI/identity. Registry-only profiles include purpose and provenance; CUI-based sections are not_loaded. Existing reviewed name/county matches are labelled by identity.method, not asserted as registry-declared CUIs. Conflicts and withheld names remain explicit. Unknown number returns item null. No addresses or contacts.',
    inputShape: { registryNumber: z.string().min(1).max(128) },
    async handler(args) {
      const result = await getNgoRegistryProfile(
        repo,
        typeof args['registryNumber'] === 'string' ? args['registryNumber'] : ''
      );
      if (result.isErr()) return { ...failure(result.error), kind: 'ngo_registry_profile' };
      const first = result.value?.status === 'resolved' ? result.value.profiles[0] : undefined;
      return {
        ok: true,
        kind: 'ngo_registry_profile',
        item: result.value,
        link: ngoProfileLink(clientBaseUrl, first?.cui, first?.registryNumber),
      };
    },
  },
  {
    name: 'get_ngo_organization_profile',
    description:
      'Current NGO registry organization for a CUI, only when that CUI is its eligible admitted identity; otherwise item is null (not proof it is not an NGO). identity.method: registry_cui = accepted direct link (CUI declared in the RNONG row); registry_cui_fiscal_agreement = corroborated declared link (CUI declared in the RNONG row and matched by the organization\'s own ANAF record); fiscal_exact_name_county = name/county inference from an exact ANAF full-name and county match (not declared by the registry); document_registration_bridge = documentary bridge from published evidence. None is a legal verification. Registry fields are source assertions; conflicts lists fields where observations disagree. ANAF registration state and fiscal inactivity are not legal dissolution. purpose.text is the full RNONG purpose as published (trimmed; source masking tokens such as <PERSON> kept); available with null text is a blank source cell, not_loaded means purposes are not loaded, not_released means the observations disagree (conflicts lists purpose). No addresses are published. socialServices, socialServiceAccreditations, socialEnterpriseCertificates (RUEIS; status as of that snapshot) and employmentServiceAccreditations (ANOFM) are current source lists joined by CUI, each with its current source snapshot (id, sourceUrl, sourceDeclaredDate, importedAt): an empty data list means not listed in that snapshot, not_loaded means the source is not loaded (snapshot and data null). Protective social services (e.g. domestic-violence or trafficking shelters, residential child protection) and unclassified ones (serviceType null) are countyOnly: no service name or locality. financials.fiscalYears lists admitted MFP statement years; a missing year is unknown, not zero. Pass financialYears (1-3 distinct years) to include those statements, read in a separate database snapshot: each carries its own year\'s I1..I46 dictionary labels (the same code can mean different things in other years), exact integer strings as published, and null for a blank cell ("0" is a reported zero). No totals are computed. The link opens the current CUI profile.',
    inputShape: {
      cui: z.string().regex(/^[1-9][0-9]{1,9}$/),
      financialYears: z
        .array(z.number().int().min(MIN_FISCAL_YEAR).max(MAX_FISCAL_YEAR))
        .min(1)
        .max(MCP_MAX_FINANCIAL_YEARS)
        .optional(),
    },
    async handler(args) {
      const cui = typeof args['cui'] === 'string' ? args['cui'] : '';
      // Validate the whole request before any read; availability never excuses an invalid list.
      const requested = args['financialYears'];
      if (
        requested !== undefined &&
        (!Array.isArray(requested) || requested.some((year) => typeof year !== 'number'))
      )
        return failure(invalidInput('financialYears must be a list of years', 'financialYears'));
      const years = validateFiscalYears(
        requested === undefined ? null : (requested as number[]),
        MCP_MAX_FINANCIAL_YEARS,
        'financialYears'
      );
      if (years.isErr()) return failure(years.error);

      const profile = await getNgoOrganizationProfile(repo, cui);
      if (profile.isErr()) return failure(profile.error);
      const link = ngoProfileLink(clientBaseUrl, profile.value?.cui);
      if (profile.value === null || years.value === null)
        return { ok: true, kind: KIND, item: profile.value, link };
      let statements: readonly unknown[] = [];
      if (profile.value.financials.availability === 'available') {
        const result = await getNgoFinancialStatements(repo, cui, years.value);
        if (result.isErr()) return failure(result.error);
        statements = result.value;
      }
      return {
        ok: true,
        kind: KIND,
        item: { ...profile.value, financials: { ...profile.value.financials, statements } },
        link,
      };
    },
  },
];
