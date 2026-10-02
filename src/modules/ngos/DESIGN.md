# NGO registry v1

RNONG registry observations are served through GraphQL and MCP, using only the explicit public views from scraper migrations `20260919T220000` / `220500`. Source records without CUI remain browseable. No fuzzy identities, financials, grants, purpose text, raw payloads or mock adapters are added to the registry lists; the organization profile below adds admitted financials, purpose text and source lists.

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
accreditations and funding are explicitly not released in this legacy overview,
with no fabricated zeros; `ngoOrganizationProfile` below publishes them.

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
negative fact. Purpose is published in full by the owner's 2026-09-30 decision (see
below). Every ANAF registered-office
field stays private, and offices, custody, hashes and storage pointers have no
GraphQL/MCP field. `registryRecords` reuse the audited public-record mapping.

Statements are fetched lazily: through the GraphQL `statements` field, or MCP
`financialYears` (at most 3). Year lists are validated before any availability
shortcut, so an invalid request is never reported as missing coverage. Each statement keeps its own year's dictionary labels (the original `name`), its source and dictionary URLs, and exact integer
strings (`^-?[0-9]+$`, never parsed). A blank cell is `null` and `"0"` is a
reported zero. A missing year is unknown. No totals or cross-year indicator series
are computed. Unknown availability values, identity methods, dictionary shapes or
missing provenance fail closed as `Database` errors.

## Statement financial review signals

Every statement adds `quality { ruleVersion assessment suspected reasons { code detail } }`
through the shared repository mapper, so GraphQL and MCP use the same assessment.
`ngo-revenue-v1` compares exact integers in lei: I38 above 1,000,000,000 emits
`IMPLAUSIBLE_REVENUE`; positive I38 equal to positive I1 emits
`REVENUE_EQUALS_FIXED_ASSETS`. Both can apply. These are review signals, not confirmed
filing errors. Values, labels, statement membership and public identity gates stay
unchanged. A missing cell never becomes zero; `suspected: false` means no rule matched
the available cells, not that the statement is proved correct.

The reviewed FY2008–2025 dictionaries retain the I1/I38 meanings. Assessment requires
their exact position labels and audited fiscal-year binding (2021–2023 reuse the
2020 labels; 2025 reuses 2024 labels). Future years or changed labels return
`assessment: unsupported`, `suspected: null` and no reasons. Requalify on refresh.
The threshold was measured on the full retained FY2016–2025 originals on 2026-10-02.

No NGO sector/year financial aggregate currently exists in this module. Flags do
not automatically exclude any statement or metric. The client hub separately builds
sums from all MFP non-profit filers, a broader population than admitted profiles;
adding this field alone does not migrate that build or guarantee identical totals.
Any future aggregate must document its population, source copies and exclusion policy,
and show the published total as well as any filtered total. Equality alone is not
an automatic exclusion policy.

## Profile source lists — social services, accreditations, RUEIS

`socialServices`, `socialServiceAccreditations`, `socialEnterpriseCertificates`
(RUEIS) and `employmentServiceAccreditations` (ANOFM) come from five plain allowlist
views in scraper migration `20260930T100000` (drafted, not applied). They are read inside the profile's own snapshot,
after `ngo.public_organization_profile` has admitted the CUI, with indexed `cui =`
lookups. There is no second admission and no organization gate of their own, so
they add a few milliseconds, not another ~200 ms admission. Joins are by CUI only.

Each section is `{ availability, snapshot, data }`. `snapshot` is the source's current
snapshot, `{ id, sourceUrl, sourceDeclaredDate, importedAt }`. The field names are a subset of
the registry `NgoRegistrySnapshot`, so one client component renders both. A current
snapshot with no rows for the CUI is `available` with `[]` ("not listed in that
snapshot"). No current snapshot is `not_loaded`. The views never project names,
address, siruta code, contacts, `provider_type` (no published legend),
`sanction_status`, the ANOFM free-text notes or the licences' Public/Privat column.
Service types use a closed classification of the 30 labels in the source. Only the
reviewed non-protective labels show service name and locality. Reviewed protective
labels (violence or trafficking victims, residential child/youth protection,
mother-and-child, street outreach) are `countyOnly` and keep their category. Any other
label, including NULL, is `countyOnly` with `serviceType` null, because an unknown
label can name a place. Each source is pinned to its production snapshot scope. The
mapper refuses a county-only row that still
carries a place, and it also refuses rows without a snapshot or a source with two
current snapshots. A missing view returns the same capability error as a missing
function. A view without the reader grant fails with 42501, a `Database` error for
the whole profile.

Deploy in this order:

1. Run the scope check, read-only. It must return four rows, one per pinned pair;
   a missing pair means that section will be `not_loaded`.

   ```sql
   select source_id, snapshot_scope, status from ngo.source_snapshots
   where is_current and (source_id, snapshot_scope) in (
     ('social_service_licenses', 'licensed_services'),
     ('social_service_providers', 'providers'), ('anofm_rueis', 'current'),
     ('anofm_employment_accreditation', 'current'));
   ```

2. Apply the scraper migrations `20260930T100000` and `20260930T110000`.
3. Run `pnpm etl ngos rnong-purpose-load --snapshot <current RNONG snapshot> --dry-run`,
   then the same command without `--dry-run`.
4. Run the label check as the owner. It must return no rows; any row is a live label
   outside the reviewed lists, shown as unclassified until it is reviewed.

   ```sql
   select ss.service_type, count(*) from ngo.social_services ss
   join ngo.public_social_services v using (source_record_key)
   where ss.service_type is not null and v.service_type is null group by 1;
   ```

5. Grant SELECT on the five section views and `ngo.rnong_public_purposes` to the reader.
6. Deploy the server.

Steps 1 and 4 exist because both redactions fail safe but silently. Purposes are keyed
by registry observation, so re-run step 3 with the new snapshot after every RNONG
promotion; until then every profile's purpose is `not_loaded`.

## Purpose text

By the owner's decision of 2026-09-30, `purpose.text` is the full RNONG "Scop" text,
exactly as published and trimmed at the ends. Line breaks, quotes and the source's
masking tokens (`<PERSON>`, `<LOCATION>`) are kept. The text is not screened, masked or
rewritten. This supersedes the 2026-09-26 screen/audit gate.

The scraper migration `20260930T110000` stores one row per non-withheld registry
observation. The command `rnong-purpose-load` fills it from verified raw records, and
the view `ngo.rnong_public_purposes` also excludes withheld names. The server reads
that view for the admitted `legal_record_ids`, in the profile's snapshot, and applies
the registry consensus rule:

- `available` when every observation has a loaded purpose and they agree; a blank
  cell gives null text.
- `not_loaded` when any observation lacks a loaded purpose.
- `not_released`, with `purpose` in `conflicts`, when observations disagree.

Purpose has no provenance fields of its own: it is the profile's registry `snapshot`. The profile function's legacy
`purpose_availability` column is no longer read.

## Registry profiles and registry-based search (2026-10-01)

`ngoRegistryProfile(registryNumber: String!)` is additive; the required-CUI query
keeps its contract. Unknown numbers return null. The result has `status` (`resolved`
or `ambiguous`) and `profiles`; a resolved result has one profile. Irregular number
literals can return several observation groups, which remain explicit candidates.
Valid national numbers retain all observations/conflicts together.

The registry profile mirrors the CUI profile with nullable `cui`/`identity` and
`nameWithheld`. Registry-only profiles include purpose and snapshot; CUI sections
are `not_loaded`, with empty financial years/statements. Admitted identities reuse
the existing CUI enrichment in the same read-only snapshot. MCP adds
`get_ngo_registry_profile`; an ambiguous result links to the registry landing page.
Registry records add `organizationCui`/`organizationIdentityMethod` through one
bounded current-group read per page. Source and legacy direct CUI fields are unchanged.

Search hits add `ngoRegistryNumber`, `ngoRegistryStatus`, `ngoIdentityMethod` and
`ngoSourceSnapshotId`. Filter `entityTags` by `source::rnong` for the NGO hub's single registry
population. Explicit CUI arrays are authoritative, including empty arrays. Registry
status remains separate from generic activity. Broader site search keeps its other
populations. Chronos dev uses an isolated full palette; production index and readers
are unchanged. Deploy database wrappers/grants and build that index before deploying
the server and configuring only the dev Deployment to read it.

## R5 search and current client links (2026-10-01)

The palette exposes `ngo` only for admitted registry membership
(`source::rnong`). Legacy NGO-kind identities outside that population remain
searchable as `organization_unclassified`, with their CUI/county and no profile
link. Higher-priority public types and other roles remain. IDs stay unchanged.
Registry-only search URLs are null; clients route using the registry number.

MCP links now use `/ngos/{cui}` or `/ngos/registry/{number}`. Registry numbers
escape tilde as `~~`, hyphen as `~-`, and slash as `-`, then URI-encode the
segment. Missing/ambiguous profiles link to `/ngos/registry`. Historical
observations link by registry number, never by export-bound row ID or old CUI.
This supersedes the historical client-link notes above.
