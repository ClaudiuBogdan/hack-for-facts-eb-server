# Legislation on legal_v2 (LEGAL_SOURCE=v2)

Status: built 2026-11-20 for Chronos dev, off by default (`LEGAL_SOURCE=legacy`). The design is the data platform's
`docs/domains/legislation/refactoring/dev-legal-v2-surface.md` (scrapper repo). This page records what the API does.

## The switch

`LEGAL_SOURCE=v2` changes the legal module's acts, outline and render repositories and its search engine. The GraphQL
schema, the REST routes and the MCP tools stay the same for both sources. `legacy` (the default) leaves today's
behaviour unchanged.

| What                                                                                                                                                          | Source on v2                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Act identity, citation keys, aliases, resolve                                                                                                                 | `legal_v2.acts`, `act_citation_keys`, `act_aliases` (same act ids as `legal`)                                         |
| Versions (`documents`, `canonical`, `versionCount`)                                                                                                           | `legal_v2.forms` with their states                                                                                    |
| Text (REST render), outline                                                                                                                                   | `legal_v2` text units: `form_components`, `text_units`, `unit_render`, `unit_provisions`, `unit_links`, `unit_assets` |
| Status, statusEvidence, inDegree, entryIntoForce, amendedAfterPublication, links, incomingAnchors, timeline, changes feed, summary (domains, category), title | **bridged** from `legal.*` by act_id                                                                                  |
| Monitorul                                                                                                                                                     | unchanged (`legal.mo_*`)                                                                                              |
| Search                                                                                                                                                        | words only on the legal-v2 test indexes, hydrated from legal_v2                                                       |

## Rules

- **Privacy.** Every legal_v2 read filters `privacy_class = 'public'` on every relation it touches. The views
  `form_states`, `page_targets`, `link_targets` and `read_form` have no privacy predicate, so the API does not use them.
  A restricted component, unit or render chunk of a served text answers 403, never a shorter text. A link whose row or
  target act is restricted is served as a plain reference with no target.
- **Bridge.** `LegalAct.bridgedFields` lists what came from the previous corpus, and `dataSource` is `legal_v2`. When
  `legal` does not hold the act, `bridgedFields` is empty and `status`, `statusEvidence`, `inDegree` and
  `amendedAfterPublication` are null. In the directory filters and the status grid such an act counts as `necunoscut`,
  so the STATUS buckets still add up to the total.
- **Document ids.** A form is `f<form_id>`. An old numeric page id resolves, on the render and outline routes, to the
  form its newest bound capture shows (route `afis`, then `detail`, `detail_base`, `print`), and the answer carries the
  form id.
- **Versions.** original → `original`, republication → `republicare`, consolidation → `consolidare`; `versionDate` is
  `portal_order_date`. New nullable fields: `readable`, `caveat` (`unofficial_consolidation` on every consolidation),
  `portalLabelRaw`, `portalLabelDate`, `held`, `formKey`, `sourceUrl`; on the act, `newerNotAvailable` and
  `defaultBasis`.
- **Default form** (`isCanonical`, `canonical`). The rule of rebuild-model.md §7 and of the SQL function
  `legal_v2.default_forms`, computed per act in `core/v2/forms.ts` (the function computes every act and the role's
  statement limit is 15 s). It is the latest accepted, body-resolved, readable consolidation whose Portal date is not
  after today (Bucharest), else the original. It is not yet the owner's 2026-11-12 rule (latest form of any kind), which
  the SQL function has not adopted either.
- **Render.** One statement per request reads the form, its components and, when exactly one text unit serves it, that
  unit's chunks, its links with their targets and its images. The stored `tldf-unit` v1 is converted to the TLDF 1.1
  envelope, manifest or chunk the reader already takes (`core/v2/tldf-unit.ts`):
  - blocks and marks are the compiler's own;
  - a link's kind is re-derived from its href by the structure parser's classifier;
  - the target act comes from `page_acts` and the target form from the bound capture of the linked route;
  - an image takes the custody hash.
    The parser's exclusion counts and defect ledger are not held in serving, so `accounting.excluded_by_reason` is empty
    and `defects` is absent. `generation.run_id` is the form's receipt id, `meta.renderSource` is `legal_v2:tldf-unit/1`,
    and the ETag is `W/"<converter>-<composition_digest[:32]>-g<identity generation>"`. A form with no published text
    answers 409 `RENDER_UNAVAILABLE`, `renderStatus: not_loaded`. A form made of several text units (header plus body)
    answers `composition_not_served`, because that case is not in this version.
- **Outline.** `unit_provisions` of the form's units, composed by per-unit offsets. Each entry's `path` is the id of the
  render block with the same span (the TLDF compiler makes a block's hull equal its node's span), so the reader's
  `tldf-{path}` anchors work unchanged.
- **Search.** `LEGAL_SEARCH_OPENSEARCH_ACTS_INDEX` and `LEGAL_SEARCH_OPENSEARCH_SECTIONS_INDEX` name the
  `legal-v2-test-acts-*` and `legal-v2-test-units-*` indexes; both are required. Each index must carry its exporter
  contract in `_mapping._meta` (`legal-v2-test/acts/1`, `legal-v2-test/units/1`) and a `built_at` stamp.
  - BM25 runs over names and titles (acts) and over `text`/`text.folded`, heading path and act name (units), with act
    type, issuer and year filters and `privacy_class = public`.
  - Hits are acts: name matches first, then acts reached through their provisions, each with up to three provision hits.
  - Status, domain and category filters apply to the hydrated page only, so `totalsExhaustive` is false and `actsTotal`
    is null.
  - The semantic leg reports `semantic search unavailable`.
  - Without both indexes, search falls back to the legacy Postgres path over `legal` (`engine: postgres`).

## Not in this version

Analytics; rebuilding status, links or summaries in legal_v2; header-plus-body compositions; the text of linked annexes
(components without a unit); meaning search.
