/**
 * Companies module — filter spec (plan §7). One `CollectionFilterSpec`; the kernel
 * derives the GraphQL input + SQL conditions + the stable `fhash` from it. The
 * module only DECLARES the spec.
 *
 * Aliases MUST match the repo FROM clause:
 *   `o`  core.organizations (the directory spine)
 *   `f`  companies_v2.fiscal_status (ANAF)
 *   `p`  companies_v2.onrc_published_profiles, bound to the pinned edition
 *   `i`  companies_v2.onrc_published_identifier_profiles (repo semijoin)
 *   `c`  companies_v2.onrc_published_caen_observations (repo semijoin)
 *
 * The ONRC fields are VIRTUAL (repo-intercepted): they compile against the
 * pinned edition only, and a request carrying one while no edition is
 * published is refused (`ServiceUnavailable`), never answered as empty.
 *   - `status`, `county`, `caenCode`, `onrcCaen` are ONE positive semijoin over
 *     the identifier profiles: every given criterion must hold on the SAME
 *     resolved identifier (status/county/CAEN of separate registrations never
 *     combine). Each CUI is listed once.
 *   - `legalForm`, `registrationDate`, `registrationDatePresent` read the CUI's
 *     qualified profile scalar (null when the evidence conflicts).
 *   - every `exclude` / absence form needs complete evidence: unknown,
 *     partial, unresolved or hidden evidence is never read as absence.
 * `hasFinancials` stays a virtual EXISTS over public statements.
 * ANAF fields (`vatPayer`, `declaredFiscallyInactive`, `mainCaenCode`) are
 * physical and independent: `declaredFiscallyInactive=false` is only ANAF's
 * declared-fiscal-list state, never an ONRC activity state.
 */

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

/** Edition-bound filter fields (refused while no ONRC edition is published). */
export const COMPANY_REGISTRY_FILTER_FIELDS = [
  'status',
  'county',
  'caenCode',
  'onrcCaen',
  'legalForm',
  'registrationDate',
  'registrationDatePresent',
] as const;

/** Repo-intercepted virtual filter fields (kernel composer must skip these). */
export const COMPANY_VIRTUAL_FIELDS = [...COMPANY_REGISTRY_FILTER_FIELDS, 'hasFinancials'] as const;

/** Driving predicates that bound a `groupBy=county` aggregate. */
export const COMPANY_AGGREGATE_DRIVING_FIELDS = [
  'county',
  'status',
  'caenCode',
  'onrcCaen',
] as const;

export const companiesFilterSpec: CollectionFilterSpec = {
  collection: 'companies',
  fields: [
    {
      name: 'cui',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'o', column: 'cui' },
      array: true,
      exclude: true,
      description: 'Normalized CUI (1–13 digits). Index seek on organizations_cui_uq.',
    },
    {
      name: 'county',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'i', column: 'county_codes' },
      array: true,
      exclude: true,
      description:
        'County code (e.g. CJ, B) or county name (diacritic-folded, no unaccent), resolved through public county territories. Positive: a resolved identifier of the pinned ONRC edition whose derived-geography county set holds it, on the same identifier as the other ONRC criteria. exclude: only companies whose complete county consensus is known and differs (multiple, partial, missing or unresolved geography never matches a negative). Refused while no edition is published.',
    },
    {
      name: 'status',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'i', column: 'status_codes' },
      array: true,
      exclude: true,
      description:
        'ONRC status code (e.g. 1048 funcțiune, 1084 radiată). Positive: ANY public original status observation on a resolved identifier of the pinned edition carries the code, also next to a conflicting code on that identifier; on the same identifier as the other ONRC criteria. Not a priority pick and not the CUI headline. exclude: only companies with complete status evidence and no such code. Never merged with ANAF declaredFiscallyInactive. Refused while no edition is published.',
    },
    {
      name: 'caenCode',
      type: 'string',
      ops: ['eq', 'in', 'prefix'],
      column: { alias: 'c', column: 'caen_code' },
      array: true,
      exclude: true,
      description:
        'Broad CURRENT ONRC observation match: the 4-digit code (prefix: 1-3 digits) in ANY revision among the public CAEN observations of the pinned edition, on the same identifier as the other ONRC criteria. No older editions and no ANAF main activity (use mainCaenCode). The same digits can mean different activities in different revisions: use onrcCaen for one revision. exclude: only companies with complete CAEN coverage and no such observation. Refused while no edition is published.',
    },
    {
      name: 'onrcCaen',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'c', column: 'caen_code' },
      array: true,
      exclude: true,
      description:
        "Exact ONRC CAEN selector '<revision>:<code>' (revision rev0, rev1, rev2 or rev3; e.g. rev2:6201, rev0:1111), as returned in companyResolve(dim: CAEN) key. Matches a public observation of exactly that revision and code in the pinned edition, on the same identifier as the other ONRC criteria. exclude needs complete CAEN coverage. Refused while no edition is published.",
    },
    {
      name: 'legalForm',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'p', column: 'legal_form' },
      array: true,
      exclude: true,
      description:
        "The pinned edition's qualified CUI legal form (no value when public observations conflict). exclude: only a known single or consistent value that differs. Refused while no edition is published.",
    },
    {
      name: 'vatPayer',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'f', column: 'is_vat_payer' },
      exclude: true,
      description: 'ANAF VAT-payer flag (joins fiscal_status; no index).',
    },
    {
      name: 'declaredFiscallyInactive',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'f', column: 'is_inactive' },
      exclude: true,
      description:
        "ANAF declared-fiscally-inactive-list flag. false is only ANAF's list state: NOT an ONRC status and NOT operating-active (§13-R1).",
    },
    {
      name: 'mainCaenCode',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'f', column: 'main_caen_code' },
      array: true,
      exclude: true,
      description:
        'ANAF declared main CAEN (fiscal_status; revision as ANAF reports it, often unknown; no index; residual). Independent of the ONRC caenCode/onrcCaen observations.',
    },
    {
      name: 'registrationDate',
      type: 'date',
      ops: ['between'],
      column: { alias: 'p', column: 'recorded_date' },
      description:
        "The pinned edition's qualified RECORDED date (the date ONRC recorded; civil date, day precision): NEVER a founding date or an age. Companies without a qualified value do not match. Refused while no edition is published.",
    },
    {
      name: 'registrationDatePresent',
      type: 'bool',
      ops: ['isNull'],
      column: { alias: 'p', column: 'recorded_date' },
      description:
        'Recorded-date presence (§14.2). isNull:false = a qualified recorded date; isNull:true = every public observation lacks a date (basis missing). Conflicting or unresolved dates match neither. Refused while no edition is published.',
    },
    {
      name: 'hasFinancials',
      type: 'bool',
      ops: ['isNull'],
      column: { alias: 'o', column: 'cui' },
      description:
        'EXISTS over companies_v2.financials (coverage probe; repo-intercepted virtual).',
    },
  ],
  sort: { default: 'name', allowed: ['name', 'registrationDate', 'cui'] },
};

/**
 * Status display text for COMPATIBILITY fields only (`CompanyStatus.label`,
 * status facet labels): this API's static nomenclature, never an
 * ONRC-observed label (observed labels stay NULL until a source bundle
 * binding is proved).
 */
export const COMPANY_STATUS_NOMENCLATURE: Readonly<Record<string, string>> = {
  '1084': 'radiată',
  '1048': 'funcțiune',
  '1074': 'întrerupere temporară de activitate',
  '1049': 'dizolvare',
  '1052': 'lichidare',
  '1070': 'faliment',
  '1107': 'insolvență',
  '1057': 'reorganizare judiciară',
};

export const COMPANIES_FILTER_SPECS = {
  companies: companiesFilterSpec,
} as const;
