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
