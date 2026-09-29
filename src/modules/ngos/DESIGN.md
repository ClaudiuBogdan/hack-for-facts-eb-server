# NGO registry v1

RNONG registry observations are served through GraphQL and MCP, using only the explicit public views from scraper migrations `20260919T220000` / `220500`. Source records without CUI remain browseable. No fuzzy identities, financials, grants, purpose text, raw payloads or mock adapters are added.

The base row's privacy class is the maximum sensitivity of its columns; separately audited column projections carry their own class. Base legal/snapshot rows stay restricted. The repository type and SQL allowlist omit private fields structurally. The released RNONG decision keeps private originals in raw storage and projects only audited fields into production. Existing shared reader privileges remain unchanged; the repository still enforces an explicit field allowlist and public privacy filters. `NGO_REGISTRY_ENABLED` defaults false on both entrypoints. Missing/disabled data returns an explicit capability error, never a successful empty registry.

Lists use the shared filter DSL and cursor envelope. The indexed snapshot/row tuple drives reads; name/category/county/status filters scan within that snapshot. Snapshot id participates in cursor hash; refresh requires restarting pagination. No search index is introduced without measurements. History is append-only: archived detail is marked `isCurrent=false` and linked to a registry-number search, never guessed to be a unique current organization. Client details are noindex until durable identity is established.

Counts mean source observations, including duplicates. Date/status/public-utility fields are source assertions. List and detail always carry import date, source link, supplied-artifact basis and unverified national completeness. Display-only source CUI is distinct from the accepted linked-organization CUI. Cross-domain entity enrichment and the old mock NGO feature are outside v1.

## Live CUI profile — fiscal first

`ngoProfileOverview(cui)` and MCP `get_ngo_profile_overview` share one usecase.
A profile requires a current accepted RNONG CUI link and public core identity.
The repository reads all current registry observations and the optional
`ngo.public_fiscal_status` view in one SQL statement; multiple legal observations
remain visible, and core identity kind is not changed or used to infer membership.

Fiscal booleans and dates stay nullable. Fiscal inactivity is distinct from legal
dissolution; query date is distinct from capture time. The ANAF link opens the
source service documentation, not a captured response. No ANAF names, addresses,
raw payloads, object pointers or fingerprints are returned. Missing fiscal data
is unavailable, not a confirmed negative; missing current registry admission
returns no profile; database errors propagate as errors. Financials, services,
accreditations and funding are explicitly not released, with no fabricated zeros.

Deploy only after scraper migration `20260920T180010` is present. The existing
module enablement flag also gates profiles. The client uses a dedicated live
adapter for `/ong-uri/$cui`, independently of the legacy NGO mock dispatcher.

## Organization profile — admitted identity, ANAF and financials

`ngoOrganizationProfile(cui)` and MCP `get_ngo_organization_profile` share the
`core/organization.ts` usecases. This first slice looks profiles up by CUI only.
It has no organization-key lookup and does not add inferred identities to registry
browsing. The legacy queries above are unchanged: their `linkedOrganizationCui`,
`identityBasis` and `sections` keep registry-declared semantics for existing
clients. The client CUI page still renders the legacy overview, so the MCP link
points to the first public registry observation, or to the registry landing page
when there is no profile.

The scraper migration `20260929T120000` is drafted and tested locally, but has
not been applied. Applying it, granting the API reader EXECUTE privileges and
deploying the server are separate, unexecuted steps. Client integration is deferred.

Reads go only through two SELECT-only data-layer functions,
`ngo.public_organization_profile(cui)` and `ngo.public_financial_statements(cui, years)`.
They return safe columns and evaluate the organization grouping only for the
requested CUI. The batch views (`ngo.profiles`, `ngo.rnong_organizations`) take
about 4 s or more per keyed read because of their materialized CTEs, so they are
never queried. The server copies no identity, privacy, revocation or ANAF-binding
rule: the functions apply the current organization-group eligibility and the core
public, non-public-entity gates. An unknown, non-public or ineligible CUI returns
null. Missing functions return the capability error, and a timeout is reported as
a timeout. Each repository read runs in its own read-only snapshot with a 5 s
statement budget. The lazy statements read is a separate snapshot, so a response
is not one atomic database snapshot: a concurrent financial release can make the
statements newer than the profile's `fiscalYears`.

`identity.method` says how the CUI was admitted:

- `registry_cui`: accepted direct link, the CUI declared in the RNONG row.
- `registry_cui_fiscal_agreement`: corroborated declared link, the declared CUI
  matched by the organization's own ANAF record.
- `fiscal_exact_name_county`: name/county inference from an exact ANAF full-name
  and county match; the registry does not declare this CUI.
- `document_registration_bridge`: documentary bridge from published evidence.

None is a legal verification. `sourceCui` stays the registry-declared value. An
inferred identity's ANAF registration stays pinned to its frozen bridge
observation even after the current fiscal observation changes. Fiscal and
registration sections are therefore independent, and `not_loaded` never means a
negative fact. Purpose is always `not_released`. Every ANAF registered-office
field stays private, and offices, custody, hashes and storage pointers have no
GraphQL/MCP field. `registryRecords` reuse the audited public-record mapping.

Statements are fetched lazily: through the GraphQL `statements` field, or MCP
`financialYears` (at most 3). Year lists are validated before any availability
shortcut, so an invalid request is never reported as missing coverage. Each statement keeps its own year's dictionary labels (the original `name`), its source and dictionary URLs, and exact integer
strings (`^-?[0-9]+$`, never parsed). A blank cell is `null` and `"0"` is a
reported zero. A missing year is unknown. No totals or cross-year indicator series
are computed. Unknown availability values, identity methods, dictionary shapes or
missing provenance fail closed as `Database` errors.
