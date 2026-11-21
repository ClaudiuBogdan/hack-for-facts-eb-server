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
  The shared form gate checks privacy first. A restricted act, form or page route answers 404. A restricted
  published composition, component, unit or chunk answers 403. GraphQL render availability then shows only
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
- **Citation.** legal_v2 stores the act's natural key (`lege:363:2018:`) in `acts.display_citation` until the loader
  ports its formatter. The API formats `displayCitation` from legal_v2's own type, number, year and issuer with a port
  of the scrapper's `displayCitation` (`core/v2/display-citation.ts`), e.g. `Legea nr. 363/2018`, `HG nr. 5/2020`,
  `Decretul din 2001`. A citation is identity, so it is never bridged; a stored value that is no longer the key is
  served as stored. Name lookup (`ilike`) and the `DISPLAY_CITATION` sort still read the stored key.
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
- **Readable.** `FORM_READABLE_SQL` gates render info, body, outline, search verification and the inputs to default
  selection. The public form must be current and have a published public composition. It must contain exactly one
  whole unit, or, for a consolidation, exactly a header at ordinal 0 and a body at ordinal 1. Every component and
  unit must be public. Each unit needs a public capture binding for its form and slot and at least one render chunk.
  All its chunks must be public. A consolidation also needs the Portal label date.
- **Default form** (`isCanonical`, `canonical`). The owner's decision of 2026-11-12: the policy `latest_any_kind`, the
  latest form of any kind, republications included, read over per-form facts. `core/v2/forms.ts` ports the raw function
  `portal_acts.p2a_default_form` (writer/sql/21-form-states.sql) line for line and computes it per act. The serving
  `legal_v2.default_forms()` is not used: its header says it predates the decision and still applies the older rule.
  - Order first: every known form with a Portal ordering date is ordered by date, then reviewed rank. The latest date
    is the latest position, judged among all forms on that date.
  - Two or more forms there that a reviewer has not all ranked: one fixed rule picks (the form the Portal lists last,
    a listed form over an unlisted one, the highest page id, the greater key), flagged `defaultOrderReviewed: false`.
  - Availability second: the chosen form is the default only when it is readable (`defaultBasis: current`). Otherwise
    no form is canonical (`latest_not_available`); `latestAvailableDocumentId` names the latest form with text, to offer
    as "not the current form". `latestDocumentId` is the form the rule picks as latest, with text or not (null on the
    legacy source).
  - `newerNotAvailable` counts known forms of any kind without text dated on or after the DATE of the latest readable
    form. A lower-ranked form of that same day counts too, so it can be non-zero while `defaultBasis` is `current`.
  - Ended forms take no part: they are neither placed nor counted, and an ended newest form leaves the older one
    current.
  - Only dated forms are placed. An act whose only readable form is an undated original (1,924 acts in production) has
    `defaultBasis: no_known_form`, a null `canonical` and null document ids; its `documents` list still offers the
    form (`readable: true`, `versionDate: null`, `isCanonical: false`). The reader has to link it from its empty state.
  - One selection per act: on a card every default-form field (`canonical`, `canonicalDocumentId`, `defaultBasis`,
    the latest ids, `newerNotAvailable`) is the card's own value, explicit nulls included; on a list row they all come
    from one batched selection. MCP incoming links copy `defaultBasis` and both latest ids onto each citing act.
  - Future-dated forms count like any other (owner decision: no rule treats them differently); the API reads every
    known form, as the raw function does with no day.
  - The pg suite runs the raw function itself (hash-pinned, over the API's per-form facts) against `computeDefaultForm`
    on the fixture for five days, with ended forms left out as the raw function leaves them out, and they agree.
    `latest_consolidation_or_original` stays selectable internally.

- **Render.** A single statement reads the route, gate and requested payload in one snapshot. A single-chunk whole
  unit has an envelope. Multi-chunk forms have a manifest at index 0, followed by one data chunk per stored chunk
  in component and local chunk-sequence order. The header supplies a pair's form URL and retains its link to the
  body. An unavailable public form can return these statuses.
  - `not_loaded` for an ended form, missing publication or a component without text chunks.
  - `composition_not_served` for an unsupported slot combination, component order or form kind.
  - `label_missing` for a consolidation without the Portal label date (LEG-X3AV).
  - `source_not_bound` when a supplying capture lacks a public binding to its form and slot.

  A pair displays a single newline after the last header chunk. Its synthetic paragraph occupies one UTF-16 code
  unit, including when either page already has edge whitespace. The form SHA-256 covers the UTF-8 encoding of
  header text, newline and body text. A cold hash uses the DDL's `render_chunk_text` fold. The API caches the hash
  by form and composition digest and rechecks the gate on each read. Version lists requesting only render status
  and count skip the fold. For pairs, the TLDF generation body hash is the composition digest and the compiler and
  parser versions describe the body. `meta.renderHead` records these substitutions.

  Conversion (`core/v2/tldf-unit.ts`):
  - every stored chunk is validated (TypeBox), and the TLDF 1.1 output is built from an allowlist, never spread;
  - a link's kind comes from anchored Portal patterns, and any scheme but http, https and mailto is refused;
  - a Portal link keeps its validated route, page id and query on the Portal host; only an external link keeps its href;
  - a v2 render is `Cache-Control: no-store`, with no ETag and no 304, because link targets and custody can change
    under one composition.

  `meta` carries `servedForm` (document id, kind, date, caveat, Portal label and date, and the source URL of the
  supplying capture's own bound row), `renderHead` (the versioned head substitutions: run id = receipt id, structure
  parser version = parse build, exclusion counts and defects not held), `fidelityFlags` and `renderSource`.

- **Outline.** The outline reads the public provisions of all components. Its cache key includes the composition
  digest, each ordinal, unit id and that unit's withheld provision sequences. Both the cache lookup and the fill
  run the form gate. Provision and presentation-node paths use the render's block ids and UTF-16 offsets. A pair
  prefixes dotted paths with the ordinal and reserves separate numeric `unmarked:N` keys for each component and
  the boundary. Marks take form-wide ordinals. Link and image ordinals resolve within their supplying unit.
  Numbers come from the parser address. Presentation nodes have no grammar depth.
- **Search.** `LEGAL_SEARCH_OPENSEARCH_ACTS_INDEX` and `LEGAL_SEARCH_OPENSEARCH_SECTIONS_INDEX` name the
  `legal-v2-test-acts-*` and `legal-v2-test-units-*` indexes. Both are required: without them word search is
  `ServiceUnavailable`, never the legacy engine, the Postgres retrieval or the embedder; exact citations still answer.
  Each index must carry its exporter contract in `_mapping._meta` and a `built_at` stamp.
  - BM25 runs over names and titles (acts) and over `text`/`text.folded`, heading path and act name (units), with act
    type, issuer and year filters and `privacy_class = public`.
  - Every unit hit is verified against its `uses` in ONE statement before any text is served. The checks: a public,
    readable form of the hit's act; the unit as that form's current public component; the provision public and holding
    the use's whole range; public chunks of that same unit covering the entire range. The section's citation path, label, range
    and source URL come from that verified occurrence: the parser address, the provision label, and the supplying unit's
    own bound capture. In a pair the section key identifies the unit and provision sequence even if both pages
    use the same article address. Highlight offsets include all preceding component text and the display boundary.
    The index snippet is shown only when the occurrence's content key is the indexed wording's key. `servedForm` carries the form (LEG-X3AV) with the act's
    amendment facts merged in, and the reader link carries `?doc=<form>`. Unverifiable hits are dropped and not
    counted: `actsTotal`, `sectionsTotal` and `unhydratedHits` are null, null and 0.
  - Status, domain and category filters apply to the hydrated page only. The summary they read is bridged by act id,
    never through the default form, so an act with no readable latest form, or no v2 text, keeps its summary.
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
  even when the targeted form or route is restricted. Closing this requires the target form's and route's visibility
  in link conversion.
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

Analytics; rebuilding status, links or summaries in legal_v2; the text of linked annexes
(components without a unit); meaning search.
