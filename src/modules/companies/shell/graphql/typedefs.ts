/**
 * Companies module — GraphQL SDL slice (plan §6). All types `Company*`-prefixed
 * (§14.8); extends root `Query` + `type Entity`. The `CompaniesFilter` input is
 * GENERATED from the §7 spec via the kernel `toGraphQLInput(spec)` so REST/GraphQL/
 * MCP never drift. Kernel scalars (`CUI`, `Money`, `Date`, `BigInt`, `SIRUTA`,
 * `JSON`, `PageInfo`, `Entity`) are referenced, never redefined.
 *
 * Lists are connection-only (cursor); the company list is keyset-paginated by the
 * active sort. `totalCount` is BOUNDED (≤10,000) + `totalEstimated` (§14.4) — a
 * large unfiltered list never `COUNT(*)`s 3.99M rows.
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import { companiesFilterSpec } from '../../core/filters.js';

const filterInput = toGraphQLInput(companiesFilterSpec);

const objectsAndQuery = /* GraphQL */ `
  enum CompanySort {
    NAME
    REGISTRATION_DATE
    CUI
  }
  enum CompanyResolveDim {
    NAME
    REGNUM
    CAEN
    COUNTY
  }
  enum CompanyMatchConfidence {
    SAFE
    UNMATCHED
  }
  enum CompanyGroupBy {
    COUNTY
    STATUS
    CAEN_DIVISION
  }

  "ONRC registry publication state. A state, never a count: UNPUBLISHED, WITHDRAWN and UNAVAILABLE never mean an empty registry and never fall back to legacy registry rows."
  enum CompanyRegistryState {
    "One accessible edition is published and pinned for this response."
    PUBLISHED
    "No ONRC edition is published."
    UNPUBLISHED
    "The active edition is not publicly accessible (access withdrawn or outside the accepted privacy policy)."
    WITHDRAWN
    "This runtime cannot read the publication (migration or grant missing)."
    UNAVAILABLE
  }
  "A CUI in the pinned scope. NOT_IN_EDITION: no qualified public profile in the pinned edition (absent, held, ambiguous or privacy-hidden) - never 'not legally registered'."
  enum CompanyRegistryCuiState {
    IN_EDITION
    NOT_IN_EDITION
    UNPUBLISHED
    WITHDRAWN
    UNAVAILABLE
  }
  "How a CUI-level value is qualified. A value is shown only for SINGLE_OBSERVATION, CONSISTENT_OBSERVATIONS and (non-geography, non-status) PARTIAL_OBSERVATIONS; MULTIPLE_VALUES, MISSING and UNRESOLVED carry no value."
  enum CompanyRegistryBasis {
    SINGLE_OBSERVATION
    CONSISTENT_OBSERVATIONS
    PARTIAL_OBSERVATIONS
    MULTIPLE_VALUES
    MISSING
    UNRESOLVED
  }
  "Evidence completeness of the CUI's CAEN/status observations. Only COMPLETE / COMPLETE_EMPTY support a negative (absence) answer."
  enum CompanyRegistryCoverage {
    COMPLETE
    COMPLETE_EMPTY
    PARTIAL
    UNRESOLVED
  }
  "ONRC_EDITION: the pinned edition's qualified public name. CORE_ORGANIZATION: the directory spine's name (platform identity hub), not an observation of this edition."
  enum CompanyNameSource {
    ONRC_EDITION
    CORE_ORGANIZATION
  }
  "Where a compatibility status label comes from: this API's static nomenclature, or the code itself. Never an ONRC-observed label."
  enum CompanyStatusLabelSource {
    API_NOMENCLATURE
    CODE
  }
  enum CompanyLegalPersonEligibility {
    ELIGIBLE
    EXCLUDED
    UNRESOLVED
  }

  "The ONRC registry envelope every registry-bearing response carries, empty results included. Bind cursors, caches and saved views to scopeKey; read it fresh with companyRegistry."
  type CompanyRegistryEnvelope {
    "Always onrc."
    source: String!
    state: CompanyRegistryState!
    "The pinned edition; null unless PUBLISHED."
    editionId: BigInt
    sourceSnapshotId: String
    "ONRC's publication date of the edition's source files (civil date)."
    sourcePublishedAt: Date
    interpretationVersion: String
    dimensionPolicyVersion: String
    "The legal-person eligibility policy every profile of the edition carries; null when the edition shows no public profile."
    eligibilityPolicyVersion: String
    "Moves on every publish, rollback and access withdrawal."
    publicationEpoch: BigInt
    "Company access (privacy) epoch: every ONRC event and every public-company privacy change moves it."
    accessEpoch: BigInt
    "Fixed text when not PUBLISHED."
    reason: String
    "Opaque key of this scope (state, edition, both epochs)."
    scopeKey: String!
  }

  "A CUI-level value with the basis that qualifies it."
  type CompanyRegistryValue {
    value: String
    basis: CompanyRegistryBasis!
  }
  "The date ONRC RECORDED (civil date, day precision, no time zone) with its basis. Never a founding date, an age or a legally current registration date."
  type CompanyRegistryDate {
    value: Date
    basis: CompanyRegistryBasis!
  }

  "The pinned edition's qualified profile of one CUI."
  type CompanyRegistryCuiProfile {
    identityObservations: Int!
    identifierCount: Int!
    unresolvedIdentifierCount: Int!
    unidentifiedObservations: Int!
    name: CompanyRegistryValue!
    legalForm: CompanyRegistryValue!
    recordedDate: CompanyRegistryDate!
    "Derived geography: complete consensus only."
    countyCode: CompanyRegistryValue!
    "Canonical county name from the territory hub (current presentation data, not edition evidence)."
    countyName: String
    uatSirutaCode: CompanyRegistryValue!
    uatName: String
    "Complete status consensus of every resolved identifier; never a priority pick. Null value on conflict, partial or unresolved evidence."
    statusCode: CompanyRegistryValue!
    caenCoverage: CompanyRegistryCoverage!
    statusCoverage: CompanyRegistryCoverage!
    legalPersonEligibility: CompanyLegalPersonEligibility!
    eligibilityReason: String
    eligibilityPolicyVersion: String!
  }

  "One public resolved identifier group: a lookup group of the normalized observed registration identifier, not a legal alias and not a legal registration entity."
  type CompanyRegistryIdentifier {
    "Stable: <editionId>:<identifierKey>."
    id: String!
    identifierKey: String!
    identityRowCount: Int!
    "The PUBLIC status code set."
    statusCodes: [String!]!
    "Any public original 1048 on this identifier, also next to a conflicting code."
    hasActiveObservation: Boolean!
    "Presentation summary of ONE complete identifier; not the active filter and not the CUI status."
    statusSummaryCode: String
    statusSummaryBasis: String!
    statusObservations: Int!
    unparsedStatusObservations: Int!
    countyCodes: [String!]!
    countyBasis: String!
    caenObservations: Int!
    unparsedCaenObservations: Int!
    unknownRevisionCaenObservations: Int!
  }

  "Safe public provenance of one original source row (no manifest, object-store reference, raw token or address)."
  type CompanyRegistryProvenance {
    "OD_FIRME | OD_CAEN_AUTORIZAT | OD_STARE_FIRMA."
    resourceKey: String!
    sourceRowNumber: Int!
    sourceRowSha256: String!
    "The resource's official URL from THIS edition's manifest."
    sourceUrl: String
    sourceFileSha256: String
    sourcePublishedAt: Date
  }

  "One original public OD_FIRME row of the pinned edition."
  type CompanyRegistryIdentityObservation {
    "Stable: <editionId>:<resourceKey>:<sourceRowNumber>."
    id: String!
    identifierKey: String
    name: String
    euid: String
    legalForm: String
    "Civil date ONRC recorded on this row; never a founding date."
    recordedDate: Date
    "date | datetime | blank | unparsed_shape | invalid_calendar | invalid_time."
    recordedDateState: String!
    countyCode: String
    uatSirutaCode: String
    provenance: CompanyRegistryProvenance!
  }

  "A CAEN label from the CURRENT database catalog by exact (revision, code): never frozen in or observed by the edition."
  type CompanyCaenCatalogLabel {
    label: String!
    "caen_<revision>."
    system: String!
    "current_db_catalog."
    source: String!
  }

  "One original public OD_CAEN_AUTORIZAT row of the pinned edition."
  type CompanyRegistryCaenObservation {
    id: String!
    identifierKey: String!
    "code | missing | invalid."
    parseState: String!
    code: String
    "known | missing | invalid."
    revisionState: String!
    "rev0..rev3 when known; an unknown revision gets no label."
    revision: String
    catalogLabel: CompanyCaenCatalogLabel
    provenance: CompanyRegistryProvenance!
  }

  "One original public OD_STARE_FIRMA row of the pinned edition. Labels stay NULL until a source bundle binding is proved."
  type CompanyRegistryStatusObservation {
    id: String!
    identifierKey: String!
    parseState: String!
    code: String
    label: String
    labelSource: String
    provenance: CompanyRegistryProvenance!
  }

  "Registry evidence of one CUI in the pinned scope. Conflicting public observations are retained and listed, never priority-picked."
  type CompanyRegistryEvidence {
    registry: CompanyRegistryEnvelope!
    cuiState: CompanyRegistryCuiState!
    profile: CompanyRegistryCuiProfile
    identifiers: [CompanyRegistryIdentifier!]!
    identityObservations: [CompanyRegistryIdentityObservation!]!
    caenObservations: [CompanyRegistryCaenObservation!]!
    statusObservations: [CompanyRegistryStatusObservation!]!
    "True when a list reached its bound (200 identifiers, 500 rows per kind); complete counts are on profile/identifiers."
    observationsTruncated: Boolean!
  }

  "A published, accessible ONRC edition a client may pin or compare against."
  type CompanyRegistryEdition {
    editionId: BigInt!
    sourceSnapshotId: String!
    sourcePublishedAt: Date
    interpretationVersion: String!
    dimensionPolicyVersion: String!
    "True for the edition the current scope pins."
    current: Boolean!
  }

  "Compact registry read for client pinning. Read fresh, never cached: metadata only, never an access authorization for cached data."
  type CompanyRegistryCapabilities {
    registry: CompanyRegistryEnvelope!
    scopeKey: String!
    editions: [CompanyRegistryEdition!]!
    "Filter fields evaluated against the pinned edition (refused with SERVICE_UNAVAILABLE when not PUBLISHED)."
    registryFilterFields: [String!]!
    caenRevisions: [String!]!
  }

  "A compatibility status: the code of the pinned edition's complete status consensus, with display text from this API's static nomenclature (labelSource). Never an ONRC-observed label."
  type CompanyStatus {
    code: String!
    label: String!
    labelSource: CompanyStatusLabelSource!
  }
  "A distinct parsed public status code the pinned edition observes, with the edition's observed label (null until a source bundle binding is proved)."
  type CompanyStatusFlag {
    code: String!
    label: String
  }

  "The pinned edition's derived-geography consensus (an address that may contribute derived geography, complete agreement only). SAFE = a UAT consensus value; UNMATCHED = a county consensus without one. Null when neither exists (bases on registry.profile)."
  type CompanyTerritory {
    sirutaCode: SIRUTA
    uatName: String
    countyName: String
    matchConfidence: CompanyMatchConfidence!
  }

  "Deprecated compatibility shape: display is always empty (no address is served); county mirrors territory.countyName; locality is null."
  type CompanyAddress {
    display: String!
    county: String
    locality: String
  }

  type CompanyFiscal {
    vatPayer: Boolean
    "= is_inactive. The ONLY fiscal-inactivity boolean. NOT operating-active; is_active (its exact complement) is intentionally dropped (§13-R1)."
    declaredFiscallyInactive: Boolean
    mainCaenCode: String
    "Source-reported CAEN revision; null when the source does not supply it."
    mainCaenRev: String
    registeredName: String
    "ANAF's state date for this answer (status_date), never the retrieval time; null when unknown."
    asOf: Date
  }

  "Activity: one per (revision, code) the pinned ONRC edition publicly observes (source onrc), then ANAF's declared main activity (source anaf, its own revision, often unknown). Never older editions, derived comparisons or ANAF's no-activity sentinel."
  type CompanyCaenActivity {
    code: String!
    rev: String
    "Current database catalog label of the row's OWN known revision; null when the revision is unknown (never borrowed from another source or revision, never an edition-frozen label)."
    label: String
    "onrc: observed in the pinned edition; anaf: declared fiscal main activity."
    source: String!
    "current_db_catalog when label is set."
    labelSource: String
  }
  "Restricted in companies_v2; public profile returns an empty list until an authorized surface is added."
  type CompanyRepresentative {
    name: String!
    role: String!
  }
  type CompanyEuBranch {
    branchName: String
    country: String
    euid: String
    fiscalCode: String
  }

  type CompanyFinancialYear {
    year: Int!
    "Publisher of this statement year: 'anaf' (FY2019+) or 'mfp' (FY2008–2018 bulk). The seam is CHECK-enforced at 2019 — clients should mark it when charting across it."
    sourceSystem: String!
    "The exact ORIGINAL source value, held or not (see qualification): a source observation, not a qualified figure."
    turnover: Money
    "The exact ORIGINAL source value (see qualification)."
    netProfit: Money
    "The exact ORIGINAL source value (see qualification)."
    netLoss: Money
    "bigint as string — source outliers overflow int4; never a JS number. The exact ORIGINAL source value (see qualification)."
    employees: BigInt
    "The 20 typed metrics, exact ORIGINAL source values (see qualification)."
    summary: JSON!
    "Nullable in v2 profiles; canonical statement lines live in companies_v2.financial_indicators."
    lines: JSON
    "Where the statement was published."
    source: CompanyStatementSource!
    "The statement's qualification under the ACTIVE published admission policy. Only REPORTED values may enter a derived figure or comparison; NOT_ASSESSED means no value may (it never means reported)."
    qualification: CompanyStatementQualification!
  }

  "Whether the evaluator could qualify a statement. NOT_ASSESSED carries a reason and no statuses."
  enum CompanyQualificationAssessment {
    ASSESSED
    NOT_ASSESSED
  }

  "Per-metric evaluator status, the seven values the analytics release publishes. REPORTED = admitted by the named extraction/mapping policy, NOT an economic certification of the figure."
  enum CompanyMetricStatus {
    REPORTED
    "Admitted, but the source value is NULL (never 0)."
    MISSING
    "The metric is not admitted for this fiscal year."
    NOT_ADMITTED
    "The statement layout is not admitted, or the policy withholds this metric for that layout."
    HELD_PROFILE
    "A reviewed hold on this exact statement and metric (the original stays visible)."
    HELD_OBSERVATION
    "A quality flag or metric issue the policy names holds it."
    HELD_QUALITY
    "net_result only: a present component is not reported."
    HELD_COMPONENT
  }

  type CompanyMetricQualification {
    "Evaluator metric name: turnover, net_profit, net_loss, employees, total_revenue, total_expenses, gross_profit, gross_loss, receivables, current_assets, fixed_assets, cash_and_bank, prepaid_expenses, deferred_income, subscribed_capital, inventories, debts, provisions, total_equity, patrimony_regie, net_result."
    metric: String!
    status: CompanyMetricStatus!
  }

  """
  The qualification of one statement by the published evaluator (sql-v1),
  under the write-once admission policy of the active analytics publication.
  It never changes the original values. Reasons when NOT_ASSESSED:
  qualification_unavailable (this runtime cannot read the evaluator),
  no_active_policy, policy_missing, policy_unsupported,
  evaluator_unsupported_policy_feature, policy_unreadable, policy_unqualified,
  unrepresentable_reported_value, net_result_out_of_range,
  qualification_malformed. An unknown reason is still not assessed.
  """
  type CompanyStatementQualification {
    assessment: CompanyQualificationAssessment!
    "Null exactly when ASSESSED."
    reason: String
    "The analytics release whose published policy evaluated the statement."
    releaseId: String
    policyVersion: String
    policySha256: String
    "Approval date of the POLICY. Never a source, processing or freshness date."
    policyApprovedOn: Date
    evaluatorVersion: String
    "All 21 metrics when ASSESSED (20 source metrics, then net_result); empty when NOT_ASSESSED."
    metrics: [CompanyMetricQualification!]!
    netResultStatus: CompanyMetricStatus
    "The evaluator's net result (profit − loss, an absent side as 0 only when admitted), exact; set only when netResultStatus is REPORTED. Never the stored generated financials.net_result."
    netResult: Money
    "The reviewed reason of an observation hold naming this statement."
    holdReason: String
    "How the statement no longer matches the reviewed hold; the hold stays in force."
    holdDrift: [String!]!
  }

  "Where a statement was published. ANAF: the bilanț web-service URL stored with the statement. MFP: the exact data.gov.ro resource it was read from. url is null when not recorded: never guessed, never another publisher's URL."
  type CompanyStatementSource {
    "anaf | mfp"
    sourceSystem: String!
    url: String
    "anaf_statement | mfp_resource; null with url."
    urlKind: String
    statementProfileHash: String
    metricRuleVersion: String!
  }

  "A dated, warn-only legacy anomaly flag on one (cui, year) statement. Advisory: qualifies a figure, never suppresses one."
  type CompanyFinancialQualityFlag {
    year: Int!
    flagCode: String!
    metricName: String!
    "'info' | 'review' | 'warning' today; open domain (kept String so a new upstream class cannot break an advisory surface)."
    severity: String!
    "Exact decimal string in the METRIC'S OWN UNIT - RON for money metrics, a headcount for employees, a ratio for ratio checks. NOT always money; do not blanket-format as RON."
    numericValue: String
    "Same unit rules as numericValue (e.g. employees_outlier threshold is the headcount 1000000, not RON)."
    thresholdValue: String
  }

  """
  Dated advisory flags + MEASURED corpus-wide context. Absence semantics are
  load-bearing: a missing flag is NOT an assessment. The legacy table stores
  anomalies only, keeps no per-statement assessment receipt and is not tied
  to the statement revision it saw (newest flags 2026-08-25, financials
  rebuilt 2026-09-27), so a statement year without a flag must be rendered as
  "unassessed" - never as checked or clean, whether or not the year is in
  assessedYears. assessedYears is a SET of years holding at least one flag
  corpus-wide (FY2020 has none; FY2008-2018 predates the lane) - context, not
  coverage of any one statement. The rule set also evolves (4-6 flag codes
  per year).
  """
  type CompanyFinancialQualityAssessment {
    "Ascending distinct years holding at least one flag corpus-wide (today: 2019, 2021-2025). Context only: not a per-statement assessment receipt."
    assessedYears: [Int!]!
    "Creation date of the NEWEST flag row; not a last-assessment watermark (a re-run refreshes existing flags without changing their creation date) and does not establish whether the current statement revision was assessed."
    assessedAt: Date
    flags: [CompanyFinancialQualityFlag!]!
  }

  "Latest vs prior statement year. A delta uses only REPORTED values of that metric in both years under the same policy digest, evaluator and release (the net from the evaluator's netResult); one held metric removes only its own delta. Money deltas are exact at the inputs' own scale (two places minimum). Each null delta names its reason: not_assessed, policy_incompatible, latest_not_reported, prior_not_reported, not_exact."
  type CompanyFinancialTrajectory {
    fromYear: Int
    toYear: Int
    turnoverDelta: Money
    netResultDelta: Money
    employeesDelta: BigInt
    turnoverDeltaReason: String
    netResultDeltaReason: String
    employeesDeltaReason: String
  }

  "Financial statements recorded under a CUI, served as attributed source observations (sourceSystem per year). The namespace is the CUI, NOT company membership: the CUI may have no core organization (e.g. MFP-era filers) or be a public non-company organization (NGO, public body). A statement is withheld when a known core organization for the CUI is non-public."
  type CompanyFinancials {
    years: [CompanyFinancialYear!]!
    latest: CompanyFinancialYear
    trajectory: CompanyFinancialTrajectory
  }

  "Closed set of diffable fields. COUNTY/LOCALITY compare the edition's derived geography (county code / UAT SIRUTA) and report canonical names. Status is not diffed: observed status sets are evidence on the profile, not a change."
  enum CompanyRegistrationField {
    LEGAL_NAME
    LEGAL_FORM
    COUNTY
    LOCALITY
  }

  "An observation-set comparison of two published editions: never a legal rename, registration or deletion."
  enum CompanyRegistrationDiffStatus {
    CHANGED
    UNCHANGED
    "A qualified public profile only in the later edition (newly observed, newly public or newly qualified); no registration is implied."
    APPEARED
    "A qualified public profile only in the earlier edition; no deletion, striking-off or cause is implied."
    DISAPPEARED
    "No comparison happened; see reason (registry_<state>, first_edition, not_in_edition, not_in_either_edition, evidence_bound_exceeded = more distinct public values than the comparison reads, never compared on a partial set). Never collapsed into UNCHANGED or null."
    NOT_COMPARABLE
    "A field holds several public values on at least one side and the sets differ: no single change is asserted."
    AMBIGUOUS
  }

  type CompanyRegistrationChange {
    field: CompanyRegistrationField!
    "Public display values as the editions show them (exact text; geography as canonical names)."
    from: String
    to: String
  }

  """
  Comparison of the CUI's public identity observations in the PINNED edition
  (the parent profile's edition) and the newest accessible published edition
  with an earlier source date. The first edition has nothing to compare
  (NOT_COMPARABLE, reason first_edition) and never reports a disappearance.
  Dates are ONRC source publication dates, never retrieval times.
  """
  type CompanyRegistrationDiff {
    fromEditionId: BigInt
    toEditionId: BigInt
    fromCaptureDate: Date
    toCaptureDate: Date
    status: CompanyRegistrationDiffStatus!
    "Set when NOT_COMPARABLE."
    reason: String
    "Non-empty only when status = CHANGED."
    changes: [CompanyRegistrationChange!]!
  }

  "Source observation dates, never our write or fetch times; null when unknown."
  type CompanyAsOf {
    "Source publication date of the pinned ONRC edition; null unless PUBLISHED."
    onrc: Date
    "ANAF's state date (status_date) for the fiscal answer."
    anaf: Date
  }

  "Public money RECEIVED (company = payee). Kernel FlowsRepo (grain-gated). Never mixes registry + flow grains."
  type CompanyPublicMoney {
    totalRon: Money!
    flowCount: Int!
    "Per-(year, flowType) breakdown; year is populated (flow_year)."
    byYear: [CompanyPublicMoneyYear!]!
    "Per-flowType rollup (year-agnostic)."
    byFlowType: [CompanyPublicMoneyFlowType!]!
    topPayers: [CompanyPublicMoneyPayer!]!
  }
  type CompanyPublicMoneyYear {
    year: Int
    flowType: String!
    totalRon: Money!
    count: Int!
  }
  type CompanyPublicMoneyFlowType {
    flowType: String!
    totalRon: Money!
    count: Int!
  }
  type CompanyPublicMoneyPayer {
    cui: CUI
    name: String
    totalRon: Money!
    count: Int!
  }

  "A directory company (public company spine) by CUI. ONRC fields are the pinned edition's QUALIFIED consensus values (null on conflict, absence, unresolved evidence or a non-published registry), with all public observations under registry. Fiscal (ANAF) and financial sections are independent of the registry state."
  type Company {
    cui: CUI!
    orgId: BigInt!
    "Display name: the edition's qualified public name, else the directory spine's name (see nameSource)."
    name: String!
    nameSource: CompanyNameSource!
    "Qualified CUI legal form of the pinned edition."
    legalForm: String
    "The single public resolved identifier key; null with none or several (see registry.identifiers)."
    codInmatriculare: String
    "The edition's qualified RECORDED date (registry.profile.recordedDate). NEVER a founding date or age."
    registrationDate: Date
    registrationDatePresent: Boolean!
    "Complete status consensus of the pinned edition; null on conflicting, partial or unresolved evidence (the observations stay listed)."
    headlineStatus: CompanyStatus
    "Deprecated: distinct parsed public status codes of the pinned edition (use registry.statusObservations)."
    statusFlags: [CompanyStatusFlag!]!
    territory: CompanyTerritory
    address: CompanyAddress!
    fiscal: CompanyFiscal
    caenActivities: [CompanyCaenActivity!]!
    "Public representative names are withheld until the v2 restricted person data has an access-gated API path."
    representatives: [CompanyRepresentative!]!
    financials: [CompanyFinancialYear!]!
    "Dated advisory quality flags + corpus-wide context (a missing flag is unassessed, not clean); lazily resolved. Nullable for per-field error isolation (audit H2) - an advisory failure must not null the whole profile."
    financialQualityAssessment: CompanyFinancialQualityAssessment
    "Two-edition comparison under the SAME pinned edition as this profile, read only when selected, with this Company and under its single final recheck: a scope or access move refuses the whole Company, never just this field. Nullable for per-field isolation of an ordinary comparison failure (H2)."
    registrationDiff: CompanyRegistrationDiff
    "Not part of the ONRC edition contract: always empty (never served from the legacy projection)."
    euBranches: [CompanyEuBranch!]!
    "ONRC registry evidence of this CUI in the pinned scope (envelope, CUI state, qualified profile, identifiers, observations with provenance)."
    registry: CompanyRegistryEvidence!
    "Public money received (payee), via the kernel FlowsRepo. Null when none."
    publicMoney: CompanyPublicMoney
    asOf: CompanyAsOf!
  }

  "Lean per-entity company summary (Entity.company / entity-360). NOT the full Company list/profile shape — it carries only the cross-source slice the contributor returns."
  type CompanyEntitySummary {
    cui: CUI!
    name: String!
    nameSource: CompanyNameSource!
    legalForm: String
    headlineStatus: CompanyStatus
    vatPayer: Boolean
    declaredFiscallyInactive: Boolean
    "The edition's qualified RECORDED date; never a founding date."
    registrationDate: Date
    registrationDatePresent: Boolean!
    territory: CompanyTerritory
    latestFinancial: CompanyFinancialYear
    registryCuiState: CompanyRegistryCuiState!
    registry: CompanyRegistryEnvelope!
    asOf: CompanyAsOf!
  }

  type CompanyResolveHit {
    dim: CompanyResolveDim!
    "NAME/REGNUM: the CUI. CAEN: the bare code (the broad caenCode filter). COUNTY: the canonical county name."
    value: String!
    label: String!
    cui: CUI
    confidence: Float
    "CAEN: the catalog revision (rev0..rev3)."
    revision: String
    "CAEN: the exact onrcCaen selector <revision>:<code>."
    key: String
    "NAME/REGNUM: onrc_edition | core_organization. CAEN: current_db_catalog. COUNTY: territory_hub."
    labelSource: String
  }
  "A resolve answer with its metadata. NAME/REGNUM: hits read and rechecked under ONE registry scope (registry, scopeKey; set for zero hits too), and decided again when the whole operation completed. CAEN/COUNTY: independent catalog reads; registry and scopeKey are null (catalog labels carry no ONRC provenance)."
  type CompanyResolveResult {
    "The same hits companyResolve returns."
    hits: [CompanyResolveHit!]!
    "NAME: the search engine was unavailable, or its index generation was not witnessed current for this registry scope, and a capped fallback answered. Never a synonym for zero hits; false for REGNUM/CAEN/COUNTY."
    degraded: Boolean!
    "More than one hit."
    ambiguous: Boolean!
    "NAME/REGNUM: the scope the hits were read under. Null for CAEN/COUNTY."
    registry: CompanyRegistryEnvelope
    "NAME/REGNUM: registry.scopeKey. Null for CAEN/COUNTY."
    scopeKey: String
  }
  type CompanyCaenHit {
    code: String!
    rev: String
    label: String
  }

  "One facet bucket. COUNTY/STATUS: each CUI counts once, under its consensus value or an explicit basis bucket (basis set; key '(<basis>)'; '(not_in_edition)' for a spine without a profile); a county key is the county code, label its canonical name; a status label is the API nomenclature. CAEN_DIVISION: key '<revision|unknown>:<2 digits>', distinct CUIs per bucket, buckets overlap."
  type CompanyGroupCount {
    key: String!
    label: String
    count: Int!
    basis: String
  }
  type CompanyCoverage {
    territoryMatched: Int
    territoryUnmatched: Int
    note: String!
  }
  type CompanyCountyProfile {
    groupBy: CompanyGroupBy!
    groups: [CompanyGroupCount!]!
    "The filtered population (distinct CUIs), never a sum of overlapping buckets."
    denominator: Int!
    coverage: CompanyCoverage!
    registry: CompanyRegistryEnvelope!
  }

  "Landing aggregate for the /companies hub, served from a per-process cache bound to the registry scope: every read rechecks the current scope; a publish, rollback, withdrawal or access change is never served from an older entry, and a non-published registry is an error (never zeros). computedAt is the instant the legs ran."
  type CompanyHubStats {
    "Every company on the CUI directory spine. NOT the whole ONRC registry."
    totalCompanies: Int!
    "Spine companies with ANY public original 1048 observation on a resolved identifier of the pinned edition, counted on its own: a CUI with a conflicting code counts here and sits in the (multiple_values) status bucket."
    activeCompanies: Int!
    "Status consensus breakdown (one bucket per CUI, explicit basis buckets), count-desc."
    statusMix: [CompanyGroupCount!]!
    "Top 10 county consensus buckets among ACTIVE companies; basis buckets excluded (see coverage)."
    topCounties: [CompanyGroupCount!]!
    "(revision, CAEN division) buckets among ACTIVE companies from observations on the identifier carrying the active observation; distinct CUIs per bucket, overlapping."
    caenDivisions: [CompanyGroupCount!]!
    "Territory coverage of the ACTIVE population."
    coverage: CompanyCoverage!
    registry: CompanyRegistryEnvelope!
    "ISO-8601 instant the legs were computed."
    computedAt: String!
  }

  "A lean company list row (the connection node). NOT the full Company profile. Fetch the full Company via company(cui)."
  type CompanyListItem {
    cui: CUI!
    orgId: BigInt!
    name: String!
    nameSource: CompanyNameSource!
    legalForm: String
    headlineStatus: CompanyStatus
    "Canonical county name of the edition's complete county consensus."
    county: String
    vatPayer: Boolean
    declaredFiscallyInactive: Boolean
    "The edition's qualified RECORDED date; never a founding date."
    registrationDate: Date
    registrationDatePresent: Boolean!
    registryCuiState: CompanyRegistryCuiState!
    "Any public original 1048 on a resolved identifier; null unless IN_EDITION."
    hasActiveObservation: Boolean
    statusBasis: CompanyRegistryBasis
    countyBasis: CompanyRegistryBasis
    recordedDateBasis: CompanyRegistryBasis
  }

  type CompanyEdge {
    node: CompanyListItem!
    cursor: String!
  }
  "totalCount is bounded ≤10,000; totalEstimated flags the cap (§14.4). Cursors bind the filter, sort AND the registry scope: a later page under another scope is refused (INVALID_INPUT, restart pagination)."
  type CompanyConnection {
    edges: [CompanyEdge!]!
    pageInfo: PageInfo!
    totalCount: Int
    totalEstimated: Boolean!
    registry: CompanyRegistryEnvelope!
  }

  extend type Query {
    "Directory company profile by CUI (pinned registry evidence + fiscal + financials + public money)."
    company(cui: CUI!): Company
    "Filterable company list. q (name) resolves via Meili first, then hydrates by CUI; connection-only. Registry filters/sorts need a PUBLISHED edition (SERVICE_UNAVAILABLE otherwise). Nullable: an error isolates to this field instead of nulling the whole response (audit H2)."
    companies(
      filter: CompaniesFilter
      q: String
      sort: CompanySort = NAME
      first: Int = 20
      after: String
    ): CompanyConnection
    "Full financials series + computed latest + trajectory for a CUI. Source observations by CUI: a result does not assert that the CUI is a company or listed in the company directory (see CompanyFinancials)."
    companyFinancials(cui: CUI!): CompanyFinancials
    "Resolve free text to a filter value: name→CUI (Meili candidates rehydrated from the public spine), regnum→CUI list (the pinned edition's normalized identifier), caen→code with revision and onrcCaen key, county→canonical. Nullable for per-field error isolation (audit H2)."
    companyResolve(dim: CompanyResolveDim!, q: String!, limit: Int = 10): [CompanyResolveHit!]
    "companyResolve with its metadata (degraded, ambiguous) and, for NAME/REGNUM, the registry scope of the hits. registryScope (NAME/REGNUM only): the scopeKey the caller's page is bound to; a key this API did not issue, or a scope that is not the pinned one (also after a move during the request), is refused with INVALID_INPUT, never re-pinned. Omit it to take the current scope. limit <= 0 returns no hits, still scoped. Nullable: a refusal nulls this field only."
    companyResolveResult(
      dim: CompanyResolveDim!
      q: String!
      limit: Int = 10
      registryScope: String
    ): CompanyResolveResult
    "Count-ranked county/status/CAEN-division profile over the list's exact predicates. groupBy=COUNTY requires a selective filter. Needs a PUBLISHED edition. Nullable for per-field error isolation (audit H2)."
    companyCountyProfile(
      filter: CompaniesFilter
      groupBy: CompanyGroupBy = COUNTY
    ): CompanyCountyProfile
    "Cached landing aggregate for the /companies hub, bound to the current registry scope. Nullable for per-field error isolation (audit H2)."
    companyHubStats: CompanyHubStats
    "The current ONRC registry envelope, scope key and accessible published editions, read fresh (for client pinning)."
    companyRegistry: CompanyRegistryCapabilities
  }

  extend type Entity {
    "Company summary for this entity by CUI (link-not-merge; via the cross-source contributor). Lean slice, not the full Company profile."
    company: CompanyEntitySummary
  }
`;

export const companiesTypeDefs = `${objectsAndQuery}\n\n${filterInput}`;
