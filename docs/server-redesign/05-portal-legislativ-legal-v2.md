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

- **Privacy, legal_v2.** Every legal_v2 read filters `privacy_class = 'public'` on every relation it touches. The views
  `form_states`, `page_targets`, `link_targets` and `read_form` carry no privacy predicate, so the API does not use them.
  The render decides privacy before shape (`decideV2Render`): a restricted act or form answers 404; a restricted
  page route, published composition, component, unit or chunk answers 403. GraphQL render availability then shows only
  the verdict, with no hash, compiler, time or count. A link whose target act is not public is served with no locator
  at all: no act id, URL, fragment or document id. A restricted image occurrence keeps its zero-character block and
  loses its alt text and dimensions.
- **Privacy, the bridge.** Everything read from `legal` is gated on legal_v2 (`shell/repo/v2/gate.ts`), in the WHERE,
  before counting or paging. An act is visible only when its legal_v2 row is public, on either end of a fact:
  - the changes feed and status events (the event's act and its acting act);
  - references in and out (the citing act and the cited act);
  - incoming anchors (the source document's act);
  - the amendment count (the citing document's act);
  - vocabulary counts.

  A bridged title or summary is withheld when the old document's render rows are not all public.

- **Bridge details.** `statusEvidence.abrogated_by`, the only act list inside status evidence, keeps only acts public
  in legal_v2. A citing act is resolved through `act_documents`, so a public non-canonical citing document counts, as
  it does in the amendment count. Vocabulary counts over summaries also need the old document's render rows public.
- **Bridge nulls.** `LegalAct.bridgedFields` lists what came from the previous corpus, and `dataSource` is `legal_v2`.
  When `legal` does not hold the act, `bridgedFields` is empty and every bridged fact is null on GraphQL and MCP. This
  covers `status`, `statusEvidence`, `inDegree`, `amendedAfterPublication`, `versionProvenance.amendedAfterPublication`,
  `timeline`, `timelineComplete`, `links` and `incomingAnchors`: unknown, never `necunoscut`, `{}`, 0, or an empty,
  complete history. In the directory filters and the status grid such an act counts as `necunoscut`, so the STATUS
  buckets still add up to the total.
- **Document ids.** A form is `f<form_id>`. An old numeric page id resolves, inside the body statement, to the newest
  capture of its PREFERRED route (`afis`, then `detail`, `detail_base`, `print`). A held preferred route answers 409; it
  never falls through to another route's form. `LegalAct.resolveDocument(documentId)` is the act-scoped lookup, by the
  same rule: the preferred route's newest capture (held → null), an advertisement of the act only when the page has no
  current capture, and the form must belong to the act.
- **Versions.** original → `original`, republication → `republicare`, consolidation → `consolidare`; `versionDate` is
  `portal_order_date`. New nullable fields: `readable`, `caveat` (`unofficial_consolidation` on every consolidation),
  `portalLabelRaw`, `portalLabelDate`, `held`, `formKey`, `sourceUrl`; on the act, `newerNotAvailable` and
  `defaultBasis`.
- **Readable** means servable by the render: a published public composition of ONE public whole unit, no missing
  body, at least one chunk and none restricted, the unit's capture bound (public) to the form, and, for a
  consolidation, the Portal's label or its date.
- **Default form** (`isCanonical`, `canonical`). The rule of rebuild-model.md §7 and of the SQL function
  `legal_v2.default_forms`, computed per act in `core/v2/forms.ts` (the function computes every act and the role's
  statement limit is 15 s). It is the latest accepted, body-resolved, readable consolidation whose Portal date is not
  after today (Bucharest), else the original. A public act with no forms has a default result with zero counts. It is
  not yet the owner's 2026-11-12 rule (latest form of any kind), which the SQL function has not adopted either.
- **Render.** One statement per request reads the route, the form, the composition and only the chunk bodies the
  request serves. An envelope or manifest reads every chunk, with links; a chunk group reads its one stored chunk.
  Statuses:
  - no text: `not_loaded`;
  - anything but one whole unit with no missing body: `composition_not_served`;
  - a consolidation with neither the Portal's label nor its date: `label_missing` (LEG-X3AV);
  - a unit whose capture is not bound to the form: `source_not_bound`.

  Conversion (`core/v2/tldf-unit.ts`):
  - every stored chunk is validated (TypeBox), and the TLDF 1.1 output is built from an allowlist, never spread;
  - a link's kind comes from anchored Portal patterns, and any scheme but http, https and mailto is refused;
  - a Portal link keeps its validated route, page id and query on the Portal host; only an external link keeps its href;
  - a v2 render is `Cache-Control: no-store`, with no ETag and no 304, because link targets and custody can change
    under one composition.

  `meta` carries `servedForm` (document id, kind, date, caveat, Portal label and date, and the source URL of the
  supplying capture's own bound row), `renderHead` (the versioned head substitutions: run id = receipt id, structure
  parser version = parse build, exclusion counts and defects not held), `fidelityFlags` and `renderSource`.

- **Outline.** `unit_provisions` of the form's unit, under the render's gate, which runs on every request. It is cached
  per process by composition digest and withheld provisions. Each entry's `path` is the id of the render block with the
  same span. Numbers come from the parser's address only; a withheld address stays null, never "parsed". A path naming a
  presentation node (a table cell, an image) resolves from its render block, with no depth.
- **Search.** `LEGAL_SEARCH_OPENSEARCH_ACTS_INDEX` and `LEGAL_SEARCH_OPENSEARCH_SECTIONS_INDEX` name the
  `legal-v2-test-acts-*` and `legal-v2-test-units-*` indexes. Both are required: without them word search is
  `ServiceUnavailable`, never the legacy engine, the Postgres retrieval or the embedder; exact citations still answer.
  Each index must carry its exporter contract in `_mapping._meta` and a `built_at` stamp.
  - BM25 runs over names and titles (acts) and over `text`/`text.folded`, heading path and act name (units), with act
    type, issuer and year filters and `privacy_class = public`.
  - Every unit hit is verified against its `uses` in ONE statement before any text is served. The checks: a public,
    readable form of the hit's act; the unit as that form's current public component; the provision public and holding
    the use's whole range; all chunks public and reaching the range's end. The section's citation path, label, range
    and source URL come from that verified occurrence: the parser address, the provision label, and the supplying unit's
    own bound capture. They never come from the index's first use. The index snippet is shown only when the
    occurrence's content key is the indexed wording's key. `servedForm` carries the form (LEG-X3AV) with the act's
    amendment facts merged in, and the reader link carries `?doc=<form>`. Unverifiable hits are dropped and not
    counted: `actsTotal`, `sectionsTotal` and `unhydratedHits` are null, null and 0.
  - Status, domain and category filters apply to the hydrated page only.
  - The semantic leg reports `semantic search unavailable`.
- **MCP.** The same nulls for unbridged acts, including unknown coverage (`meta.known: false`) from the timeline and
  links tools. Incoming links show the citing act as legal_v2 serves it. The legal_v2 consolidation caveat replaces the
  legacy published-text caveat.
- **Cost.** Directory lists and counts join the old corpus only when the filter, sort or grouping reads it; a list
  pages ids first and hydrates the page after. Sorting by in-degree still joins `legal.acts` for every act; that has not
  been measured against production. `legalResolve(dim: act)` by name runs `display_citation ilike '%…%'` on
  `legal_v2.acts`. A trigram index (`create index … on legal_v2.acts using gin (display_citation gin_trgm_ops)`) would
  serve it; that needs a scrapper migration, which has not been made.
- **Proof.** `tests/integration/legal/legal-v2.pg.test.ts` runs against the scrapper's own legal_v2 migration
  (hash-pinned, `SCRAPPER_REPO_ROOT`) on a throwaway loopback database (`LEGAL_V2_TEST_PG_URL`,
  `LEGAL_V2_TEST_DB_NAME=server_legal_v2_<id>`, a superuser for seeding). It covers restricted parents and children, an
  unbridged act, GraphQL and MCP, and runs every mounted client document against the fixture, asserting no errors. It
  skips without those inputs.

## Accepted for dev, not fixed (review 2026-11-20)

- **in_degree counts hidden citing acts.** `inDegree` is the old corpus's precomputed count and may include citers that
  are restricted in legal_v2. It is a count only, and every legal_v2 row is public today. To close it, derive the count
  from gated references (or rebuild it in legal_v2) before any row is restricted.
- **A restricted target form or route of a public act.** A link to a public act keeps its Portal URL and fragment
  even when the targeted form or route is restricted, and the outline does not check the supplying capture. Both are
  latent while every row is public. To close them, carry the target form's and route's visibility into link conversion,
  and apply the render's binding check to the outline gate.
- **Date-only consolidation label.** A consolidation is served with the Portal's label date when the projection left
  the label wording null (it does so today). Filling the wording is LEG-X3AV work, due before the public site; the
  render rule then tightens to require the wording.
- **Search drops page-only occurrences.** The verifier requires a provision, so an occurrence the index records
  without one (`page_only`; 948,805 of them in the 2026-11-18 export) is dropped: fewer hits, never a wrong one. To
  close it, verify the occurrence's full range against the current public unit, reject any overlap with a restricted
  chunk, and return the hit with null provision metadata.
- **Performance (15 s limit).** To be measured on dev after deploy: the in-degree sort across schemas, citation
  substring lookup (candidate: a trigram index on `legal_v2.acts.display_citation`, by scrapper migration), and the
  per-chunk metadata and asset aggregation.

## Not in this version

Analytics; rebuilding status, links or summaries in legal_v2; header-plus-body compositions; the text of linked annexes
(components without a unit); meaning search.
