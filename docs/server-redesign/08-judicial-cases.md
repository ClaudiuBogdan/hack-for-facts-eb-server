# 08 — Judicial Cases (`justice` schema)

> **Status:** plan. Conforms to `00-foundation-shared-kernel.md` (binding). This
> module is **PRIVACY-CRITICAL**. The structural default-deny privacy invariant
> (§14.9 + §8.2 of the foundation) is the centerpiece — see §2 and §3. Where this
> plan deviates from a foundation default it says so with rationale.
>
> **Module:** `src/modules/judicial/` (REST + GraphQL + MCP over a shared kernel).
> **Schema:** `justice` (9 tables, live in `transparenta_prod` since 2026-06-14).
> **GraphQL prefix:** `Judicial*`. **REST prefix:** `/api/v1/judicial/`.
>
> **Binding source docs (precedence, highest first):**
> `prod-db/JUDICIAL_DECISION_REVIEW.md` (privacy/publishable-rule contract) →
> `prod-db/JUDICIAL_CASES_NOTES.md` (JC-B design + measured numbers) →
> `prod-db/BRIEF_JUDICIAL_CASES_SCHEMA.md` → `prod-db/JUDICIAL_CORRELATION_RESEARCH.md`
> (design input; several of its proposed tables were rejected — see §1).

---

## 0. The privacy invariant, stated once (read this before anything else)

The justice domain stores litigation. Litigation names **natural persons**. The
single unrecoverable mistake this module can make is to emit a natural person's
name (or a free-text field that can contain one) on any public surface. The
schema was built so that the server **cannot** do this even by accident, and this
plan keeps that guarantee structural — not a convention, not a code review item.

Two columns are forbidden on every REST / GraphQL / MCP surface:

- `justice.party_name_keys.display_name`
- `justice.case_hearings.solution_summary`

The mechanism (foundation §14.9), made concrete in this plan:

1. **The repo row types literally have no field for those two columns.** The
   `SELECT` lists never name them. There is no mapper path from those columns to
   a view model. A developer cannot return them because the type system has no
   slot to put them in.
2. **Publishable names come only from one separate, rule-gated method**
   (`PartyDictionaryRepo.getPublishableName`), which reads `display_name` _inside
   the repo_, applies the publishable-rule predicate in SQL, and returns a
   `PublishableName` value object — never the raw row. Even that method can only
   ever surface company / public-entity names, because the dictionary table holds
   **zero** person names by construction (DB `CHECK party_kind IN
('company','public_entity')` + the loader's `PUBLISHABLE_RULES` gate).
3. **A dedicated test (the "leak audit") fails CI** if any compiled SQL, any
   GraphQL field, or any MCP output schema in this module references
   `display_name` or `solution_summary` outside the one gated method.

`solution_summary` has **no gated escape hatch** — it is excluded everywhere,
full stop. Only `display_name` is reachable, and only through the dictionary
gate. The rest of this document is the design that upholds these three points.

---

## 1. Summary & data status

**Schema:** `justice` (one schema, `transparenta_prod`). 9 tables, applied
2026-06-14 (scrapper migrations `20260614T120000__justice_domain.ts` +
`20260614T120100__justice_links.ts`). The server is **read-only** over them.

**What is loaded / queryable (JC-B core lanes — populated):**

Row counts are **as of the JC-A cutover manifest (2026-06-12/13)**; the fork-1
2012–2015 backfill is still adding rows (NOTES shows cases climbing past
6.20M / hearings past 18.23M post-envelope) — treat them as illustrative scale,
not live totals.

| Table                     | Grain                         | Row count (cutover manifest)                                     | Notes                                                                                                                                                                  |
| ------------------------- | ----------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `justice.courts`          | one court                     | **246** + 1 ICCJ row = **247** (live, 2026-10-02)                | Portal Just reference: 179 judecătorii / 46 tribunals / 15 curți de apel / 5 trib. militare / 1 curte mil. de apel. **Plus the ICCJ row** (`inalta_curte`, ordinal 0). |
| `justice.cases`           | one case (current projection) | **~6.16M** (6,156,549)                                           | `case_id` PK = reused raw bigint. Natural key `(source_slug, institution_code, case_number)`.                                                                          |
| `justice.case_hearings`   | `(case_id, hearing_index)`    | **~18.06M** (18,063,526)                                         | `solution_summary` EXISTS in DB, **forbidden on all surfaces** (§2); `solution` also withheld in v1 (§2.1).                                                            |
| `justice.case_appeals`    | `(case_id, appeal_index)`     | **~2.2M**                                                        | appeal declarations only; not target-case links.                                                                                                                       |
| `justice.party_name_keys` | one distinct publishable name | multi-million dictionary (Chao1 LB ~587k; full corpus several M) | **company / public_entity ONLY** by CHECK. Holds ZERO person names. `display_name` is the gated column.                                                                |
| `justice.case_parties`    | `(case_id, party_index)`      | **~16.82M** (16,815,928)                                         | NO name column. ~67% have `name_key_id IS NULL` (person/unknown/low-confidence).                                                                                       |

**What is DDL-only (empty in v1 — derive lanes gated on precision audits):**

| Table                              | Gated on                                                   | Server posture in v1                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `justice.party_company_candidates` | gate #9 (collision + person-FP audit)                      | **not exposed as fact**; only the resolved, audited subset surfaces, and only count-shaped (§4, §8). Empty ⇒ endpoints return empty/`coverage: 0`. |
| `justice.case_legal_references`    | gate #11 (citation precision vs `legal.act_citation_keys`) | exposed read-only when populated; safe (no PII). Empty in v1.                                                                                      |
| `justice.case_lineage_candidates`  | gate #10 (lineage precision)                               | candidate-only; not rendered as fact. Empty in v1.                                                                                                 |

**Deferred / descoped (per decision-review verdict 8 — tables are earned, not
built):** `case_object_taxonomy`, `solution_taxonomy`, `case_act_rollups`,
`case_change_events`, `case_precedent_decision_candidates`. The
correlation-research tables `case_party_observations`, `party_match_runs`,
`party_match_rejections` were **rejected** (the append-by-response observation
layer lives in **raw** `judicial_core.case_parties`; rejections fold into
`validation_status='rejected' + rejection_reason`; runs fold into
`etl.validation_results.details`). The server never sees raw.

**Freshness:** loader is incremental on two watermarks (cases/hearings/appeals on
`latest_source_modified_at`; parties on the raw party layer). Last raw fetch at
JC-B time 2026-06-07; source is crawl-cadence, not daily-live (§10).

**Cross-source posture:** **no consumer is waiting on justice today** (the legacy
timeline explicitly excludes it because cases are not CUI-linked). v1 product =
**dossier lookup + court analytics + privacy-safe company-litigation counts**,
NOT company due diligence and NOT person profiles.

---

## 2. Schema → domain model (with PII / excluded columns)

### 2.1 Excluded columns (the enumeration the foundation requires)

| Schema.table.column                                                                                                     | Type         | Why excluded                                                                                                                                                      | Escape hatch                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `party_name_keys.display_name`                                                                                          | text         | publishable name — must be rule-gated                                                                                                                             | **ONLY** via `PartyDictionaryRepo.getPublishableName` (company/public, publishable-rule).        |
| `case_hearings.solution_summary`                                                                                        | text         | free-text judgment summary — can contain person names / sensitive facts                                                                                           | **NONE.** Excluded everywhere.                                                                   |
| `case_parties` (no name column exists)                                                                                  | —            | by design the table has no name field                                                                                                                             | n/a                                                                                              |
| `case_parties.classifier_rule`, `classifier_version`, `parser_version`, `row_hash`, `latest_response_id`, `sync_run_id` | text/bigint  | internal provenance / classifier internals                                                                                                                        | not projected to public view models (internal only, used by the loader & the privacy predicate). |
| `party_company_candidates.evidence`, `.candidates` (jsonb)                                                              | jsonb        | constrained to safe registry values by the loader, but **restricted-surface**: never indexed, never API-projected (codex C — the leak that survives name-nulling) | not projected.                                                                                   |
| `party_company_candidates.reviewed_by`                                                                                  | text         | analyst PII                                                                                                                                                       | not projected.                                                                                   |
| `courts.evidence`, `cases.row_hash`-class provenance, all `*_snapshot_id`/`*_response_id`                               | jsonb/bigint | internal provenance                                                                                                                                               | not projected (or projected only as opaque `asOf` metadata).                                     |

**Also excluded by default: `case_hearings.solution`.** `solution` is raw source
free text. It is lower-risk than `solution_summary` (it is the source's short
solution label, e.g. "Admite", "Respinge", and historically party-name-free) but
it is **still uncontrolled free text**, and the catalog gate is "no person-party
names in serving." **Default-deny means default-OUT: `solution` is withheld from
ALL surfaces in v1** (revised from the first draft, which exposed it on
case-detail — the reviewer correctly flagged that shipping an un-audited free-text
column behind a `freeText` rendering hint is not redaction). `solution` is
admitted to the case-detail hearing list **only after** the same person-name-shape
audit the scrapper runs over dictionary names passes on a labeled `solution`
sample (recorded in `etl.validation_results`). Until then `JudicialHearing` has no
`solution` field either (so promotion is a deliberate type change + a fresh leak
audit, never a quiet config flip). `solution_summary` is forbidden permanently
regardless. See open question §13.1.

### 2.2 Row types (view models in `judicial/core/types.ts`)

Scalars follow foundation §14.1: `case_id`/`name_key_id` are **bigint → string**
end to end; dates are `YYYY-MM-DD` strings; timestamps ISO strings.

```ts
// ── Court ─────────────────────────────────────────────────────────────────
export interface JudicialCourt {
  readonly institutionCode: string; // courts.institution_code (PK)
  readonly ordinal: number;
  readonly courtLevel: JudicialCourtLevel; // enum (see §6)
  readonly specialization: string | null;
  readonly locality: string | null;
  readonly countyCode: string | null; // courts.county_code: the county ABBREVIATION as stored (B, TM, …)
  /** @deprecated misnamed alias: the same abbreviation as countyCode, NOT a SIRUTA code (A2). */
  readonly countySirutaCode: string | null;
  readonly parentInstitutionCode: string | null;
  readonly mappingConfidence: 'high' | 'medium' | 'low';
  // courts.evidence (jsonb), mapping_notes: NOT projected
}

// ── Case (current projection) ──────────────────────────────────────────────
export interface JudicialCase {
  readonly caseId: string; // bigint → string
  readonly sourceSlug: string; // 'portal_just'
  readonly institutionCode: string;
  readonly caseNumber: string;
  readonly caseNumberOld: string | null;
  readonly department: string | null;
  readonly category: string | null; // raw passthrough (no taxonomy in v1)
  readonly categoryName: string | null;
  readonly stage: string | null;
  readonly stageName: string | null;
  readonly object: string | null; // raw object text — safe (procedural subject, not parties)
  readonly sourceOpenedAt: string | null; // source-dependent date (see sourceOpenedAtBasis)
  readonly sourceOpenedAtBasis: 'portal_header_data' | 'iccj_earliest_captured_session' | 'unknown';
  readonly latestSourceModifiedAt: string | null;
  // latest_snapshot_id, sync_run_id, *_seen_at: internal, not projected
}

// ── Hearing — solution_summary AND solution STRUCTURALLY ABSENT in v1 ────────
export interface JudicialHearing {
  readonly caseId: string;
  readonly hearingIndex: number;
  readonly hearingAt: string | null; // ISO
  readonly panel: string | null;
  // NO solution_summary FIELD (forbidden permanently). NO solution FIELD in v1
  // (withheld until a person-shape audit passes — §2.1). The type carries neither.
  readonly pronouncementDate: string | null;
  readonly documentNumber: string | null;
  readonly documentDate: string | null;
}

// ── Appeal ──────────────────────────────────────────────────────────────────
export interface JudicialAppeal {
  readonly caseId: string;
  readonly appealIndex: number;
  readonly appealDeclaredAt: string | null;
  readonly appealType: string | null;
}

// ── Party (current projection) — NO NAME FIELD ──────────────────────────────
export interface JudicialParty {
  readonly caseId: string;
  readonly partyIndex: number;
  readonly partyKind: JudicialPartyKind; // 'company'|'public_entity'|'person'|'unknown'
  readonly roleNormalized: string | null; // controlled vocab; role_raw is NOT in prod at all
  readonly nameKeyId: string | null; // bigint→string; NULL for ~67% (person/unknown/low-conf)
  // NO display_name, NO name, NO role_raw. classifier_rule/version: internal only.
}

// ── Publishable name — the ONLY name-bearing value object ────────────────────
// Produced solely by PartyDictionaryRepo.getPublishableName, never by a party SELECT.
export interface PublishableName {
  readonly nameKeyId: string;
  readonly displayName: string; // company/public ONLY (dictionary CHECK)
  readonly partyKind: 'company' | 'public_entity';
  readonly legalForm: string | null;
}
```

A `JudicialParty` for `name_key_id` non-null is rendered to the client as a name
ONLY by a second call into `getPublishableName(nameKeyId)`. The two are joined in
the **usecase** layer (`getCaseParties`), so the join is auditable in one place and
the name path is explicit. There is no SQL join that pulls `display_name` into the
party row type.

### 2.3 Identity & territory linkage

- **CUI:** justice has **no native CUI**. CUI association exists only through the
  gated, audited `party_company_candidates.candidate_cui` (text, no FK — "a
  candidate, not an identity"). The module **registers a contributor** keyed by
  CUI that answers presence/count of _resolved_ company-litigation links (§4) —
  empty in v1 until gate #9 is green.
- **Territory (county abbreviation, not SIRUTA):** `courts.county_code` stores the
  county ABBREVIATION (e.g. `B`, `TM`; the 2026-10-03 read-only profile shows 42
  non-null values and one null bucket over 247 courts). It is a soft link to
  `core.territories.county_code` (no FK). A2 serves it as `JudicialCourt.countyCode`
  with the `countyCode` filter. The older `countySirutaCode` output (GraphQL
  `@deprecated`) and the `countySiruta` filter are **misnamed compatibility
  aliases** carrying the same abbreviation; neither is a SIRUTA identifier, and no
  SIRUTA mapping is qualified (none is guessed or joined). Supplying both filter
  aliases ANDs them. Cases inherit territory **via their court**, not a native
  column.
- **Legal acts:** `case_legal_references.target_act_id` is a soft link to
  `legal.acts` via `legal.act_citation_keys` (no FK). Cross-module read, gated on
  population (§4, cross-module needs in §11).

---

## 3. The privacy mechanism in the repo layer (centerpiece)

### 3.1 `PUBLISHABLE_RULES` and the gated name method

The dictionary holds only company/public names, but the **party row** can have
`name_key_id` non-null only for rows the loader deemed publishable. The server
re-asserts the predicate at read time so it never trusts the loader alone:

```ts
// judicial/shell/repo/constants.ts — mirrors the loader's PUBLISHABLE_RULES set.
// Versioned with classifier_version; the high-precision subset of party-kind-v0.
export const PUBLISHABLE_RULES = [
  'company_legal_form',
  'org_form',
  'insolvency_marker',
  'public_entity_anchor',
  // EXCLUDES the risky 'I.I.' double-initial rule and the weak 'fallback'/
  // 'person_shape' rules, which produce kind='company' but name_key_id=NULL
  // until gate #9 promotes them.
] as const;
export const CLASSIFIER_VERSION = 'party-kind-v0'; // the version this set is valid for
```

**The gate's correctness depends on `case_parties.classifier_rule` actually
storing these exact strings** (the pilot's measured rule-hit names —
`company_legal_form`/`org_form`/`insolvency_marker`/`public_entity_anchor` for
publishable, `person_shape`/`fallback`/`I.I.` for not). The migration does **not**
constrain `classifier_rule`'s vocabulary, so this constant cannot be allowed to
"echo itself." Two hard requirements (reviewer B1):

1. **The `classifier_rule` value domain + `classifier_version` are a binding
   loader↔server contract**, recorded in `JUDICIAL_CASES_NOTES.md` and asserted by
   the loader's tier-1 privacy check (NOTES: `name_key_id IS NOT NULL ⟹ kind ∈
{company,public_entity} AND classifier_rule ∈ PUBLISHABLE_RULES`). The server
   pins `CLASSIFIER_VERSION` and **refuses to apply the gate** (returns
   `ServiceUnavailable` + caveat) if it reads a `case_parties.classifier_version`
   it does not recognize — so a loader vocabulary change cannot silently widen the
   gate.
2. **The leak-audit test (§12 test 3b) asserts against the REAL loaded
   distribution**, not the constant: it queries `SELECT DISTINCT classifier_rule,
party_kind, (name_key_id IS NOT NULL) FROM justice.case_parties` on the fixture
   and asserts every `name_key_id`-bearing row's `classifier_rule` is in
   `PUBLISHABLE_RULES` AND no excluded rule ever has a non-null `name_key_id`. If
   the loader writes an unrecognized rule string, the test fails.

```ts
// PartyDictionaryRepo — the SOLE reader of party_name_keys.display_name.
export interface PartyDictionaryRepo {
  // Returns a publishable name ONLY when the name-key is reachable from at least
  // one publishable case_party row. The display_name column is read INSIDE this
  // method and never escapes except wrapped as PublishableName.
  getPublishableName(nameKeyId: string): Promise<Result<PublishableName | null, ApiError>>;
  getPublishableNames(
    nameKeyIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, PublishableName>, ApiError>>; // DataLoader batch
  // Name → name_key_id resolution for filters (company/public dictionary only).
  resolveCompanyName(
    q: string,
    limit: number
  ): Promise<Result<readonly PublishableName[], ApiError>>;
}
```

The SQL inside `getPublishableName` (parameterized, kernel `sql\`\``):

```sql
SELECT k.name_key_id, k.display_name, k.party_kind, k.legal_form
FROM justice.party_name_keys k
WHERE k.name_key_id = $1
  AND k.party_kind IN ('company','public_entity')   -- defence-in-depth vs DB CHECK
  AND EXISTS (                                       -- must trace to a publishable party row
    SELECT 1 FROM justice.case_parties p
    WHERE p.name_key_id = k.name_key_id
      AND p.party_kind IN ('company','public_entity')
      AND p.classifier_rule = ANY($2)                -- PUBLISHABLE_RULES
  );
```

`display_name` appears in exactly **one** SQL string in the entire module, inside
this method. The leak-audit test (§11/§12) greps the compiled query log and the
module source to assert that.

### 3.2 Every party-returning path is name-free by construction

- `JudicialPartyRepo.listPartiesForCase(caseId)` selects
  `(case_id, party_index, party_kind, role_normalized, name_key_id)` — never
  `display_name` (it isn't on that table) and never any name.
- The usecase `getCaseParties` enriches with names by calling
  `getPublishableNames([...nameKeyIds where non-null])` and merging. For
  `name_key_id IS NULL` parties (person/unknown/low-confidence), the rendered
  output is the controlled summary `{ partyKind, roleNormalized, name: null }` —
  e.g. the client shows "Pârât: 2 persoane fizice", never a name.

### 3.3 The three surfaces, each enforcing the invariant

- **REST:** the TypeBox **response** schemas for parties/hearings have no
  `displayName`/`solutionSummary` properties; Fastify serialization strips unknown
  properties (`additionalProperties: false`). Party names appear only as the
  optional `name` field on the case-detail response, populated solely by the gated
  method.
- **GraphQL:** `JudicialParty` SDL has **no** `displayName` field and no resolver
  that reads it. A `name: String` field on `JudicialParty` resolves through a
  **DataLoader over `getPublishableNames`** → `null` for non-publishable. `JudicialHearing`
  SDL has **no** `solutionSummary` field. The schema-merge conflict test (§14.8)
  plus the leak audit guarantee no extension re-adds them.
- **MCP:** tool **output** TypeBox schemas omit both columns. The company-litigation
  tools return **counts and case identifiers**, plus publishable company names via
  the gate; they never return party rows for person/unknown kinds. Person/unknown
  parties contribute only to anonymized counts (`personPartyCount`).

### 3.4 Search & embeddings (the most dangerous lane) — see §9

Default-deny extends to search: the justice search projection
(`doc_type='judicial_case'`) is **built by the scrapper search lane** with the
same publishable-rule gate; the server only **reads** `search.documents`. The
server's contract is: it **must not** synthesize a justice search document that
contains a party name, and it relies on the scrapper having excluded person names
from `search.documents.title/body/cuis`. The integration test asserts the server's
justice search results carry no name beyond gated company names (§9, §12).

---

## 4. Repo interfaces (ports) — `judicial/core/ports.ts`

All methods return `Promise<Result<T, ApiError>>` (neverthrow). Every method notes
the schema/tables/indexes it hits. The 6.16M-cases / 16.82M-parties scale means
**cursor pagination only** for parties and cross-court case lists (foundation
§14.4); list endpoints MUST be bounded by an indexed predicate.

```ts
// ── Courts (246-row reference; fully in memory after first load) ─────────────
export interface JudicialCourtRepo {
  list(filter: CourtFilterInput): Promise<Result<readonly JudicialCourt[], ApiError>>;
  // tables: justice.courts (PK institution_code). Cheap; offset+total OK.
  getByCode(code: string): Promise<Result<JudicialCourt | null, ApiError>>;
  listChildren(code: string): Promise<Result<readonly JudicialCourt[], ApiError>>; // parent_institution_code
}

// ── Cases ────────────────────────────────────────────────────────────────────
export interface JudicialCaseRepo {
  // Detail by id OR natural key. tables: justice.cases (PK case_id; UNIQUE natural key).
  getById(caseId: string): Promise<Result<JudicialCase | null, ApiError>>;
  getByNaturalKey(
    institutionCode: string,
    caseNumber: string
  ): Promise<Result<JudicialCase | null, ApiError>>;
  // CURSOR list. Driving index: cases_institution_idx (institution_code) when an
  // institution/court filter is present (mandatory for the unbounded case space),
  // OR cases_modified_idx (latest_source_modified_at) for time-ordered feeds.
  // Sort tuple = (exact sort timestamp, numeric case_id), desc by default, NULLS
  // LAST both ways; the repo builds every item's cursor from that tuple (§4.1).
  listCursor(
    filter: CaseFilterInput,
    page: CursorPage
  ): Promise<Result<CursorResult<JudicialCase>, ApiError>>;
  // Court analytics JD-2: cases/hearings by institution × category × year.
  // tables: justice.cases (+ a bounded join to courts for level). Aggregate class timeout.
  aggregate(filter: CaseAggregateInput): Promise<Result<readonly CaseAggregateGroup[], ApiError>>;
}

// ── Hearings & appeals (children; always bounded by case_id) ─────────────────
export interface JudicialHearingRepo {
  // tables: justice.case_hearings (PK (case_id,hearing_index)). NEVER selects solution_summary.
  listForCase(caseId: string): Promise<Result<readonly JudicialHearing[], ApiError>>;
}
export interface JudicialAppealRepo {
  listForCase(caseId: string): Promise<Result<readonly JudicialAppeal[], ApiError>>;
}

// ── Parties (NAME-FREE) ──────────────────────────────────────────────────────
export interface JudicialPartyRepo {
  // tables: justice.case_parties (PK (case_id,party_index)). SELECTs no name column.
  listForCase(caseId: string): Promise<Result<readonly JudicialParty[], ApiError>>;
}

// ── Party dictionary (the GATED name surface) — see §3 ───────────────────────
export interface PartyDictionaryRepo {
  /* getPublishableName, getPublishableNames, resolveCompanyName */
}

// ── Company-litigation links (GATED; empty until gate #9) ────────────────────
export interface JudicialCompanyLinkRepo {
  // tables: justice.party_company_candidates (idx on candidate_cui, name_key_id,
  // validation_status) + case_parties (name_key_idx) + cases. ONLY surfaces the
  // AUDITED subset: validation_status in the server-allowed set (see §4 note).
  // Returns COUNTS + case ids + publishable company name; never person rows.
  caseCountForCui(cui: string): Promise<Result<CompanyLitigationSummary | null, ApiError>>; // JD-1
  listCasesForCui(
    cui: string,
    page: CursorPage
  ): Promise<Result<CursorResult<JudicialCaseLink>, ApiError>>;
}

// ── Legal references (safe; empty until gate #11) ────────────────────────────
export interface JudicialLegalRefRepo {
  // tables: justice.case_legal_references (case_idx, target_idx). No PII *if* the
  // served projection is the stored extracted citation token and excludes rows
  // whose source_field='solution_summary' (S2): raw_text is a substring of
  // source_field, and source_field ∈ ('object','solution','solution_summary') by
  // DB CHECK — the 'solution_summary' rows must NOT surface. SELECTs the exact
  // token (raw_text AS citation) + source_field + hearing_index + the act and
  // resolution columns as stored, never the span offsets or surrounding text (§4.1).
  listForCase(caseId: string): Promise<Result<readonly JudicialLegalRef[], ApiError>>; // JD-3
  casesCitingAct(
    targetActId: string,
    page: CursorPage
  ): Promise<Result<CursorResult<JudicialCaseCitation>, ApiError>>;
}

// ── Lineage candidates (candidate-only; empty until gate #10) ────────────────
export interface JudicialLineageRepo {
  lineageForCase(caseId: string): Promise<Result<readonly JudicialLineageEdge[], ApiError>>; // JD-4
}
```

\*\*Server-allowed candidate statuses (hard rule, mirrors decision-review verdict 4

- catalog "Entity Resolution Gate"):** `JudicialCompanyLinkRepo` filters to
  `validation_status = 'published'` ONLY. v1 sets no row to `published` (the loader
  blocks `auto_accepted`/`published`), so v1 results are **empty by construction\*\* —
  the endpoint exists, returns `{ caseCount: 0, coverage: 0, caveats:
["company-litigation links not yet published"] }`, and never leaks a `candidate`
  or `needs_review` row as a fact. This is the foundation's "candidate ≠ fact" rule
  made an SQL predicate.

**Partition/index notes for heavy queries (none are partitioned, but all must be
bounded):**

| Query                | Driving index                                                          | Bound                                                                               |
| -------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| case list by court   | `cases_institution_idx`                                                | mandatory `institutionCode`/court filter (else 400)                                 |
| case feed by recency | `cases_modified_idx`                                                   | cursor on `(latest_source_modified_at, case_id)`, hard `limit ≤ 50`                 |
| case detail children | PKs `(case_id, *_index)`                                               | always single `case_id`                                                             |
| parties by name-key  | `case_parties_name_key_idx` (partial, `WHERE name_key_id IS NOT NULL`) | used by company-link reverse lookups                                                |
| company links by CUI | `party_company_candidates_cui_idx` + `_status_idx`                     | `candidate_cui` + `status='published'`                                              |
| cases citing act     | `case_legal_references_target_idx` (partial)                           | `target_act_id`                                                                     |
| court aggregate      | `cases_institution_idx`; GROUP BY institution/category/year            | bounded by court/level/period; aggregate timeout class (15s); see §10 (no MV in v1) |

**Aggregate `total` is the post-GROUP-BY group count, never a row scan (S4):** the
`/judicial/cases/aggregate` "total" is `count(distinct group)` over the already
court/period-bounded result set — it never issues a blocking `COUNT(*)` over
`justice.cases`. The aggregate must be entered through a bounding predicate
(court/level/period); an unbounded `groupBy=category` over all 6.16M cases is
`InvalidInput`, same rule as the case list.

### 4.1 A1 — exact citations, repo-owned cursors, truthful temporal text (2026-10-03)

**Citations.** `JudicialLegalRef.citation` is the exact stored extracted token
(`raw_text`), unmodified — not the surrounding source sentence and not rebuilt
from the act fields. Each reference also carries `sourceField` (`object` or a
hearing field) and a nullable `hearingIndex` (null for `object`). Act identity,
target, resolution status and confidence stay exactly as stored, including nulls
for an unresolved token (e.g. `art.336 ncp`). Rows remain reference-grain; both
readers keep the `solution_summary` exclusion. The MCP reference-list summary
counts citations (`Case {caseId} has {n} legal citation(s) ({resolved} uniquely
resolved).`).

**Cursors.** For `judicialCases` and `judicialCasesCitingAct` the repo returns
`{ node, cursor }` items built from each row's exact sort tuple, and GraphQL
passes them through as edges. `endCursor` is the last edge's cursor on every
nonempty page (final pages included) and null on an empty page; `hasNextPage`
is true exactly when more rows exist. Nodes, case detail and MCP payloads carry
no cursor metadata.

- Case-list tuple: the native `source_opened_at` / `latest_source_modified_at`
  plus the numeric `case_id`, NULLS LAST in both directions. The cursor key is the
  exact UTC text with six fractional digits and an explicit era
  (`2026-05-04T13:15:00.123456+00 AD`), `infinity`/`-infinity`, or `''` for NULL;
  it casts back to the identical stored value. Display fields are never keys.
- Case-list cursors carry a module-local `cursor-v2` filter identity (kernel
  envelope still v1). **Every earlier case-list cursor returns `INVALID_INPUT`
  "restart pagination" once after rollout** — their date/millisecond keys were
  lossy and cannot be translated.
- Reverse citations: unchanged `refId`/`desc`/`judicial_cases_citing:<actId>`
  identity, one cursor per reference row (`ref_id` DESC). Earlier valid end
  cursors keep working; earlier per-edge `caseId` cursors are rejected.
- Before any SQL, a cursor must decode to exactly the expected number of JSON
  string keys (no numbers, nulls or objects), pass the kernel envelope/identity
  check, and carry canonical values: signed-bigint ids without `-0` or leading
  zeros; timestamps in exactly the codec spelling, with a real proleptic-Gregorian
  date (year 0 does not exist; 1 BC is a leap year), and inside PostgreSQL's
  range `4714-11-24T00:00:00.000000+00 BC` … `294276-12-31T23:59:59.999999+00 AD`.
  Anything else is `INVALID_INPUT` with restart guidance.

**Temporal text.** Timestamps and dates are rendered in SQL; no JS Date
conversion remains in the case, `asOf` or child paths.

| Field                                                   | Ordinary (AD 1–9999)                                 | Exceptional stored value                                          |
| ------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `sourceOpenedAt`                                        | `YYYY-MM-DD` in the session timezone (unchanged)     | era text in the same timezone (`0001-12-31 BC`, `10000-01-01 AD`) |
| `latestSourceModifiedAt`, `asOf`, `hearingAt`           | UTC `YYYY-MM-DDTHH:mm:ss.SSSZ` (millisecond display) | exact UTC text with era (`10000-01-01T00:00:00.000000+00 AD`)     |
| `pronouncementDate`, `documentDate`, `appealDeclaredAt` | `YYYY-MM-DD` from the native date                    | full native year with era (`0001-12-31 BC`, `5874897-12-31 AD`)   |

All fields return `infinity`/`-infinity` and null as stored. Compatibility: modern
AD values keep their exact display bytes; year 0001 now stays 0001 (it previously
displayed as 2001); unusual values that previously failed the whole read, showed a
wrong year or dropped their era are now explicit text, and expanded years use
PostgreSQL's spelling instead of JS's signed six-digit form. `asOf` keeps its
interim `max(latest_source_modified_at)` meaning and `estimated: true`.

### 4.2 A3 — validated inputs and the company query (2026-10-04)

A3 repairs how existing inputs are read. It adds no endpoint, tool, scalar,
filter framework or status/privacy rule.

**Nulls and shapes.** Every judicial filter is normalized once, before the
bounding rule, the cursor identity, the kernel composer and the virtual
compilers, so all of them see the same object:

- Omitted and explicit `null` mean the same at optional positions only: the
  whole filter, a field, an operator, a range endpoint, and the flat GraphQL/MCP
  narrowing arguments. Required arguments (`dim`, `q`, `cui`, `targetActId`) stay
  required.
- `{}`, `between: {}` and all-null values never count as a bound. Beside a real
  bound, a case-filter `in: []` still matches nothing; a flat company list `[]`
  still means no narrowing.
- These are `InvalidInput` (GraphQL `INVALID_INPUT`, MCP `errorType` /
  `errorCode`) before any SQL: a scalar or list where a field or range object is
  required, an unknown field or operator, a null or wrongly typed list member
  (never dropped, never stringified), an unknown court level, and a wrongly typed
  operand.
- GraphQL itself already rejects a fractional or out-of-range `Int`, a string
  for an `Int` and a null member of a `[T!]` list, as an ordinary GraphQL
  validation error before any resolver.
- An inline literal of an unsupported kind for a kernel string scalar (`BigInt`,
  `Money`, `CUI`, `SIRUTA`, `Date`, `DateTime`) — Boolean, Float, Enum, Object or
  List — is `INVALID_INPUT` at GraphQL validation, in every module. It used to
  become `null`, so `judicialCase(caseId: true, …)` fell back to the natural key
  and `modified: { gte: true }` dropped the bound. String and integer literals,
  explicit `null`, runtime variables and serialization are unchanged.
- On MCP, a supplied `caseId` (even `""`) must pass the direct-ID guard; only
  an omitted or `null` `caseId` allows the natural-key lookup.

**Years.** An operand is an original integer number in GraphQL `Int` range
(signed 32-bit), never 0 (1 BC is -1); strings, booleans, fractions and
non-finite numbers are input errors, the same on MCP.

- All operators apply together, as one intersection: the lower bound is the
  largest of `eq`/`gte`/`between.from`, the upper the smallest of
  `eq`/`lte`/`between.to`. `{eq: 2024, gte: 2020}` now means 2024 only (it
  previously meant 2020–2024).
- A contradictory interval (`{eq: 2024, lte: 2023}`) is a valid, empty result,
  checked after every other input and cursor.
- The calendar is unchanged: the SESSION calendar year of `source_opened_at`.
  Null and infinite dates never match a year filter (`isfinite`).
- AD 1–9999 bounds keep index-friendly native January-boundary comparisons.
  Other bounds (BC, expanded and timestamp-domain years, including the session
  spillover year 294277) compare native `extract(year …)` instead, so no date
  outside the timestamp range and no year 0 is ever constructed.

**Aggregates.** The year group key is one expression used for grouping and for
the named count: null → `(none)`, a native infinity → `infinity`/`-infinity`,
otherwise the session year as text. Every row stays in the denominator, so an
infinite date no longer fails the aggregate.

The company summary's `years[].year` stays `Int!`. It lists finite years only.
Null or infinite dates still count in `caseCount` and `courtLevels`, and a caveat
names how many were omitted from `years`.

**Discovery and groupBy.** `dim` is one of the four dimensions (one local
constant), `q` must be a string, and `limit` is omitted/null (10) or an integer
1–50, with no coercion or clamping. An unknown `groupBy` is an input error, not a
year aggregate. All of these fail before any repo access, without echoing the
query.

**Direct IDs.** Case lookup, legal references by case, and reverse references by
act accept decimal digit strings (zero and leading zeros included) up to
`9223372036854775807`, checked with BigInt before SQL. Overflow, negative and
malformed IDs are `INVALID_INPUT`; a valid ID that matches nothing is still
absence. The reverse cursor identity keeps the caller's spelling. Child and
lineage reads inside case detail keep their existing guards.

**Company case list.** The old `SELECT DISTINCT c.case_id::text … ORDER BY
c.case_id` failed with PostgreSQL 42P10 even on zero rows. It now also selects
the native `c.case_id AS case_id_sort` (internal, never on a node), keeps the
numeric `ORDER BY c.case_id DESC`, and deduplicates before the limit. Duplicate
admitted joins therefore yield one case each.

- The published-status, CUI and join predicates are unchanged; no status is
  promoted.
- Its cursor uses the A1 strict decoder, and its filter identity is unchanged
  for valid inputs.
- `sourceOpenedAt` uses the A1 session-date display, so BC, expanded and infinite
  dates stay explicit.

**One-time case-list restart.** The case-cursor identity now also carries a
filter-semantics version (`judicial_cases:cursor-v2:filters-a3:<hash>`), hashed
over the normalized filter the SQL uses. A pre-A3 case-list cursor gets
`INVALID_INPUT` "cursor/filter mismatch; restart pagination" once after rollout,
because its compound years may have meant a different range. Reverse-reference
and company cursors keep their identities.

---

## 5. Usecases — `judicial/core/usecases/`

Framework-free, over ports, returning `Result`. Thin; REST/GraphQL/MCP all call
these.

| Usecase | Signature | Notes |
| ---------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listCourts` | `(filter) → Result<JudicialCourt[]>` | offset+total (246 rows). |
| `getCourtTree` | `(code) → Result<{court, children}>` | self-referential hierarchy. |
| `getCaseDetail` | `(caseId                                                           | naturalKey) → Result<JudicialCaseDetail>` | composes case + hearings + appeals + **name-free** parties, then enriches parties via `getPublishableNames` (the ONE name join). Includes `asOf` (§10). |
| `listCases` | `(filter, cursorPage) → Result<CursorResult<JudicialCase>>` | requires a bounding filter; default sort `(modifiedAt, caseId) desc`. |
| `getCourtCaseload` | `(filter) → Result<CaseAggregateGroup[]>` | JD-2: cases/hearings by court×category×year; deterministic SQL; returns denominator + coverage. |
| `getCaseParties` | `(caseId) → Result<{parties: PartyView[]; personPartyCount; ...}>` | the privacy-critical merge (§3.2). |
| `getCompanyLitigation` | `(cui) → Result<CompanyLitigationSummary>` | JD-1: count-shaped, `published`-only, empty in v1. |
| `listCompanyLitigationCases` | `(cui, cursorPage) → Result<CursorResult<JudicialCaseLink>>` | JD-1 detail; gated. |
| `getCaseLegalRefs` | `(caseId) → Result<JudicialLegalRef[]>` | JD-3; empty until gate #11. |
| `listCasesCitingAct` | `(targetActId, cursorPage) → ...` | JD-3 reverse; cross-module read (legal). |
| `getCaseLineage` | `(caseId) → Result<JudicialLineageEdge[]>` | JD-4; candidate-only, empty until gate #10. |

### Cross-source contributor (foundation §4.4 / §14.7)

```ts
export const makeJudicialContributor = (deps): SourceContributor => ({
  source: 'judicial',
  // presence = does this CUI have any PUBLISHED company-litigation link? (empty in v1)
  presenceFor: (cui) =>
    deps.companyLinks
      .caseCountForCui(cui)
      .map((s) =>
        s && s.caseCount > 0 ? { source: 'judicial', present: true, count: s.caseCount } : null
      ),
  // profileSlice = the privacy-safe company-litigation summary (NO person data ever)
  profileSlice: (cui) =>
    deps.usecases
      .getCompanyLitigation(cui)
      .map((s) => ({ source: 'judicial', kind: 'companyLitigation', summary: s })),
});
```

- **`flow_type`:** judicial registers **none** — there is no money flow in
  litigation; the module does not touch `flows.money_flows`. (Stated explicitly so
  the foundation `FLOW_TYPES` enum is not extended.)
- **`doc_type`:** registers **`judicial_case`** (privacy-gated projection — §9).
- The contributor's `profileSlice` returns ONLY counts + publishable company names;
  it is structurally incapable of emitting a person name (it calls the same gated
  repo). This is how Entity-360 stays privacy-safe without the kernel knowing
  anything justice-specific.

---

## 6. REST endpoints — `judicial/shell/rest/`

Prefix `/api/v1/judicial/`. Per-route `config: { public: true }` (foundation
§14.11). All query/param schemas are TypeBox; response schemas
`additionalProperties: false` (drops any stray column). Both envelopes carry
`requestId` + the domain `asOf` watermark.

| Method | Path | Query / params | Response | Pagination | Cache TTL | Timeout |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------ | --------------------------------------------------------- | ----------------- | --- | --- |
| GET | `/judicial/courts` | `level[]`, `countyCode[]` (deprecated alias `countySiruta[]`), `specialization`, `q` (name trigram) | `JudicialCourt[]` | offset+total (246) | 1h | 5s |
| GET | `/judicial/courts/:code` | — | `JudicialCourt` + `children[]` | — | 1h | 5s |
| GET | `/judicial/cases` | filter spec §7 (`institutionCode`/`courtLevel`/`category`/`stage`/`yearFrom/To`/`q`/`hasObject`…); **a court-or-recency bound is required** | `JudicialCase[]` | **cursor** | 60s | 5s |
| GET | `/judicial/cases/:caseId` | `caseId` | `JudicialCaseDetail` (case + hearings + appeals + parties[name-gated] + legalRefs + lineage) | — | 60s | 5s |
| GET | `/judicial/cases/lookup` | `institutionCode`, `caseNumber` | `JudicialCase` (natural-key lookup) | — | 60s | 5s |
| GET | `/judicial/cases/aggregate` | `groupBy=court                                                                                                                              | category                                                                                     | year               | courtLevel`, period/court/category filters | `CaseAggregateGroup[]` + `{denominator, coverage}` | offset+est. total | 5m | 15s |
| GET | `/judicial/companies/:cui/litigation` | `cui` | `CompanyLitigationSummary` (count + courtLevels + years; **published-only**) | — | 5m | 5s |
| GET | `/judicial/companies/:cui/cases` | `cui`, cursor | `JudicialCaseLink[]` (gated; empty v1) | cursor | 5m | 5s |
| GET | `/judicial/acts/:targetActId/cases` | `targetActId`, cursor | cases citing the act (empty until gate #11) | cursor | 5m | 5s |
| GET | `/judicial/filters/resolve` | `dim=court                                                                                                                                  | companyName                                                                                  | category           | courtLevel`, `q` | resolved values (court code, name_key_id+company name, …) | — | 5m | 5s |

**OpenAPI notes:** the module exports an OpenAPI fragment merged at
`/api/v1/openapi.json`. The fragment's component schemas for `JudicialParty` and
`JudicialHearing` **must not declare** `displayName`/`solutionSummary` — an OpenAPI
lint step in the leak audit asserts this so the published contract can never even
_document_ the forbidden fields.

**No `/judicial/parties` collection endpoint** (deliberate omission): there is no
way to list parties across cases — parties are only reachable scoped to a single
case (`/cases/:caseId`), which structurally prevents a "scrape all person names"
query. Stated as a design decision.

---

## 7. Filters — collection specs (priority area)

Specs are declared once per collection and consumed by the kernel filter pipeline
(foundation §14.2): `toTypeBox` → REST, `toGraphQLInput` → SDL `input`,
`toConditionBuilders` → parameterized WHERE, `canonicalizeFilters` → cache key +
cursor `fhash` + tri-surface equivalence. The module invents no DSL.

### 7.1 `judicial_cases` collection spec

| Field                          | Type     | Ops                        | Driving column / index                                                                                                                                                         | REST param              | GraphQL input           | MCP                      |
| ------------------------------ | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ----------------------- | ------------------------ |
| `institutionCode`              | string[] | `in`                       | `cases.institution_code` / `cases_institution_idx`                                                                                                                             | `institutionCode` (CSV) | `[String!]`             | resolved from court name |
| `courtLevel`                   | enum[]   | `in`                       | join `courts.court_level` (bounded)                                                                                                                                            | `courtLevel`            | `[JudicialCourtLevel!]` | enum                     |
| `category`                     | string[] | `in`                       | `cases.category`                                                                                                                                                               | `category`              | `[String!]`             | —                        |
| `stage`                        | string[] | `in`                       | `cases.stage`                                                                                                                                                                  | `stage`                 | `[String!]`             | —                        |
| `year` / `yearFrom` / `yearTo` | int      | `eq`/`gte`/`lte`/`between` | session calendar year of `cases.source_opened_at` — a source-dependent clock (see §10 date basis); mixed-source ranges combine clocks; operators intersect (§4.2)              | `yearFrom`/`yearTo`     | `{from,to}`             | year                     |
| `modifiedFrom`/`modifiedTo`    | date     | `between`                  | `cases.latest_source_modified_at` / `cases_modified_idx`                                                                                                                       | `modifiedFrom`/`To`     | `{from,to}`             | —                        |
| `q`                            | string   | `contains`                 | `cases.object`/`case_number` (Postgres trigram fallback; Meili for prefix) — **text engine: Postgres ILIKE/trigram by default; Meili for the autocomplete `q` on case_number** | `q`                     | `String`                | resolver step            |
| `hasObject`                    | bool     | `isNull` (mandatory op)    | `cases.object IS [NOT] NULL`                                                                                                                                                   | `hasObject`             | `Boolean`               | coverage                 |
| `sort`                         | enum     | —                          | `modifiedAt`(default,desc) / `openedAt`                                                                                                                                        | `sort`                  | `JudicialCaseSort`      | —                        |

**Bounding rule (enforced in the spec's validator, not ad-hoc):** at least one of
`institutionCode`, `courtLevel`, or a `modified*`/`year*` range must be present, or
the request is `InvalidInput` ("judicial case list requires a court or period
bound"). This is the §3 "no implicit unbounded scans" rule for a 6.16M-row table.
The rule is checked on the normalized filter (§4.2): null-only, `{}` and empty-list
values are not a bound; a contradictory year interval is a bound (it matches
nothing).

### 7.2 `judicial_courts` collection spec

| Field            | Type     | Ops             | Driving column                               | Notes                                                                                   |
| ---------------- | -------- | --------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `level`          | enum[]   | `in`            | `courts.court_level`                         | enum `JUDICIAL_COURT_LEVELS`: the five Portal Just levels, plus the ICCJ `inalta_curte` |
| `countyCode`     | string[] | `in`            | `courts.county_code`                         | the stored county abbreviation (`B`, `TM`, …); not a SIRUTA code                        |
| `countySiruta`   | string[] | `in`            | `courts.county_code`                         | DEPRECATED misnamed alias of `countyCode` (same values); both supplied ⇒ AND            |
| `specialization` | string   | `eq`/`contains` | `courts.specialization`                      |                                                                                         |
| `q`              | string   | `contains`      | `courts.institution_code`/`locality` trigram | name autocomplete                                                                       |

### 7.3 `judicial_company_litigation` filter (gated)

`cui` (required, resolved via identity hub), optional `courtLevel[]`, `year`
range, `category[]` (null means absent, an empty list does not narrow, years as in
§4.2). Backed by `party_company_candidates` (`published`-only) joined
to `case_parties`/`cases`. **Coverage** is mandatory in the response: company-name
→ CUI match rate is disclosed (catalog "Coverage Gate" / "Entity Resolution
Gate").

### 7.4 Discovery / resolve dimensions (`/judicial/filters/resolve` + MCP discovery)

| Dimension     | Resolves to                                       | Source                                                                        | Privacy note                                                                                 |
| ------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `court`       | `institution_code`                                | `justice.courts` (name/locality trigram)                                      | safe                                                                                         |
| `courtLevel`  | enum value                                        | static                                                                        | safe                                                                                         |
| `companyName` | `name_key_id` + publishable name + candidate CUIs | `PartyDictionaryRepo.resolveCompanyName` (**company/public dictionary ONLY**) | **safe — the dictionary holds no person names; resolving a person's name returns zero rows** |
| `category`    | distinct `cases.category`/`category_name`         | `justice.cases`                                                               | safe                                                                                         |

Inputs (§4.2): `dim` must be one of these four, `q` a string, `limit` omitted/null
(10) or an integer 1–50; anything else is `INVALID_INPUT` before any repo access,
and the error never echoes the query.

The `companyName` resolver is the one place a name is _typed in_; because it
queries only `party_name_keys` (company/public CHECK), a user searching a person's
name gets an empty result — the system literally cannot resolve a person. The
resolver **returns the dictionary's `display_name`, never echoes the query string
back** (S1): a person-name query reflected into the response would itself be a
leak, so the result carries only matched dictionary rows (which are company/public
by construction), and the leak audit asserts this (§12 test 4).

### 7.5 Golden question → filter examples (from `AI_AGENT_FILTER_QUESTION_CATALOG.md`)

| Catalog ID | Question                                | Filter                                                               | Authority                                           | v1 status                                                                   |
| ---------- | --------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| JD-1       | How many cases is company Y a party to? | resolve `companyName`→`name_key_id`/CUI; `getCompanyLitigation(cui)` | `party_company_candidates` (published-only)         | **empty in v1** (no published rows); endpoint returns `coverage:0` + caveat |
| JD-2       | Court load by institution/category/year | `cases.aggregate(groupBy, year, courtLevel)`                         | deterministic SQL over `justice.cases`(+courts)     | **live**                                                                    |
| JD-3       | What laws are cited in case metadata?   | `getCaseLegalRefs(caseId)` / `listCasesCitingAct(actId)`             | `case_legal_references` → `legal.act_citation_keys` | **empty until gate #11**                                                    |
| JD-4       | Case appeal/lineage chain               | `getCaseLineage(caseId)`                                             | `case_lineage_candidates` (candidate, not fact)     | **empty until gate #10**                                                    |

**Hard gates echoed as filter rules (catalog "Judicial Cases" + "LLM Safety
Gate"):** no person-party names in serving/search/embeddings; no
`solution_summary` projection; `name_key_id` ⇒ publishable classifier rule; fuzzy
company matching stays review-only (never `published`) until audited. Each MCP
aggregate returns `value / evidence / filters / denominator / coverage /
confidence / caveats` (catalog "Core Rule").

---

## 8. MCP tools — `judicial/shell/mcp/`

Two families (foundation §6.3): a discovery tool + query tools. TypeBox input +
output; handler calls the same usecase as REST; output `{ ok, kind, query, link,
item|items, summary?, coverage, denominator, caveats }`. Rate-limited, bounded.
**Output schemas omit `display_name`, `solution_summary`, `solution` (v1), and the
candidate `evidence`/`candidates`/`reviewed_by` jsonb/PII** (leak audit covers MCP).

| Tool                                   | Input                                       | Output                                                               | Usecase                | `link`                                 | Summary template                                                                      |
| -------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- | ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `resolve_judicial_filters` (discovery) | `dim`, `q`                                  | resolved values (court codes, name_key_id+company name, categories)  | `resolve*`             | `/judicial/courts?...`                 | "Resolved '{q}' to {n} {dim}(s)."                                                     |
| `get_judicial_case`                    | `caseId` or `{institutionCode, caseNumber}` | `JudicialCaseDetail` (name-gated parties; **no solution_summary**)   | `getCaseDetail`        | `/judicial/cases/{caseId}`             | "Case {caseNumber} at {court}: {stage}, {hearingCount} hearings."                     |
| `get_court_caseload`                   | `groupBy`, court/category/year filters      | aggregate rows + denominator + coverage                              | `getCourtCaseload`     | `/judicial/cases/aggregate?...`        | "{court/level} handled {cases} cases in {year}."                                      |
| `get_company_litigation`               | `cui` (resolved)                            | count + courtLevels + years + coverage; **published-only, empty v1** | `getCompanyLitigation` | `/judicial/companies/{cui}/litigation` | "Company {cui}: {caseCount} published case links (coverage {x}%)." Caveat when empty. |
| `get_case_legal_references`            | `caseId`                                    | resolved/ambiguous/unresolved citations                              | `getCaseLegalRefs`     | `/judicial/cases/{caseId}`             | "Case {caseId} has {n} legal citation(s) ({resolved} uniquely resolved)."             |

**No MCP tool returns party rows.** Person/unknown parties are exposed only as
`personPartyCount` inside `get_judicial_case`. The aggregate accuracy gate (catalog)
applies: `get_court_caseload` and `get_company_litigation` outputs must match an
independent SQL recomputation on a frozen snapshot (fixture tests, §12).

---

## 9. Search integration — `doc_type='judicial_case'`

- **doc_type owned:** `judicial_case` (one per case). **Projection is written by
  the scrapper search lane**, not the server. The server reads `search.documents`
  (foundation §4.5) and queries Meili/OpenSearch.
- **Privacy-gated projection contract (the server's requirement on the scrapper
  lane, restated here because it is load-bearing for this module's safety):**
  `search.documents` rows for `judicial_case` carry `title` = `{caseNumber} —
{court}`, `body` = **object + category only** (NEVER `solution_summary`, NEVER
  party names beyond gated company/public names), `cuis` = ONLY `published`
  company-link CUIs (empty in v1), `county_name` from the court. **No person name,
  no `solution_summary`, ever.** The server's integration test queries the live
  index and asserts no justice hit body/title contains a name beyond the gated
  dictionary (§12).
- **Meili index:** `judicial_cases` (instant lookup by case number / court).
  **OpenSearch index:** `judicial_cases` (full-text over object/category). Both
  read-only from the server.
- **Semantic / pgvector:** **capability-gated** (foundation §14.5). No vector
  column on `search.documents` in the snapshot. Justice semantic search is
  additionally **policy-gated off** even when pgvector lands, until a person-leak
  audit of embeddings passes — embeddings of judgment text are a re-identification
  risk. v1: `semantic=false` → returns `null` + `caveats:["semantic judicial
search disabled (privacy)"]`. Stated as a deliberate stricter-than-default
  posture.

---

## 10. Sync / freshness impact on serving

- **Loader cadence:** incremental, two watermarks (cases/hearings/appeals on
  `latest_source_modified_at`; parties on the raw party layer
  `extracted_at`/latest `response_id`). Per-case REPLACE means a hearing/party that
  disappears between snapshots leaves no stale orphan — the server always reads a
  clean current projection.
- **As-of semantics (A2, source-scoped):** case detail carries `asOf =
{ asOf, estimated, sourceSlug, basis, captureFreshnessAt, loadFreshnessAt }`.
  `asOf` is the stored `max(cases.latest_source_modified_at)` over the cases of
  the RESOLVED case's own `source_slug` (a parameterized `where c.source_slug =
…`), rendered with the A1 display rules (an exceptional maximum stays explicit
  text such as `infinity` or `10000-01-01T00:00:00.000000+00 AD`). It is never a
  global maximum borrowed across sources: ICCJ stores no modification time, so an
  ICCJ case reports `asOf: null` rather than Portal's value. `basis` is
  `max_stored_source_modified_at`; `estimated` stays `true` (compatibility). This
  is a stored source-modified maximum — not capture completeness, head
  observation, dataset freshness or load time; `captureFreshnessAt` and
  `loadFreshnessAt` are always `null` until independent evidence supports them.
  **Cache is TTL-only** (stated explicitly per §14.11). The dataset is
  crawl-cadence (not daily-live; ~5-day idle observed at JC-B), so TTLs are
  generous (60s lists / 5m aggregates).
- **Date basis (A2):** `sourceOpenedAt` is a source clock, explained per case by
  `sourceOpenedAtBasis` (derived from the actual `source_slug`, never ids, court
  names or case numbers): `portal_just` ⇒ `portal_header_data` (the Portal case
  header `data` field, copied by the raw parser and writer; not a verified
  filing/registration event); `iccj` ⇒ `iccj_earliest_captured_session` (the
  earliest captured ICCJ session for that case number; not a proven registration
  or first appearance); any other source ⇒ `unknown`. The basis is present even
  when the date is null. Year filters and year aggregates use the session
  calendar year of this source-dependent date, so counts over several sources
  combine different clocks. Stored values and the A1 display/timezone rules are
  unchanged.
- **Mutability:** cases mutate (gain hearings, change stage). The current
  projection is latest-wins; the server presents "current latest known state" and
  does NOT claim procedural history beyond it (change-event history is descoped —
  verdict 8). Case detail reports the source's stored modification maximum; `asOf` does not establish a database snapshot or capture/load freshness.
- **Gated tables flipping on:** when gate #9/#10/#11 go green and the derive lanes
  populate `party_company_candidates`(published) / `case_legal_references` /
  `case_lineage_candidates`, the corresponding endpoints begin returning data with
  **no server code change** — they are already wired, just empty. Cache busts on
  the loader version stamp.

---

## 11. Wiring — `judicial/index.ts`

```ts
export const makeJudicialModule = (deps: {
  db: Kysely<ProdDatabase>; // kernel-typed; touches justice.* + core/search/legal (read)
  cache: Cache;
  rateLimiter: RateLimiter;
  logger: Logger;
  meili: MeiliClient;
  opensearch: OpenSearchClient; // read-only
  territory: TerritoryRepo; // kernel — court territory resolution
}): JudicialModule => {
  /* build repos → usecases → rest/graphql/mcp/contributor */
};
```

Returns `{ restPlugin, graphql: { typeDefs, resolvers }, mcpTools, contributor,
repos }`. `build-app.ts` registers the REST plugin under `/api/v1/judicial/`,
merges the `Judicial*` GraphQL slice, registers MCP tools, registers the
contributor into the kernel registry (data-independent order).

- **Env additions:** none beyond kernel (`PROD_DATABASE_URL`, `MEILI_*`,
  `OPENSEARCH_*`). Optional `JUDICIAL_PUBLISHED_LINKS_ENABLED` feature flag (default
  off) is **not needed** — the `published`-only predicate already makes links empty;
  the flag is documented only as a kill-switch if a published row is ever found
  unexpectedly.
- **Legacy superseded:** none. There is no justice route/GraphQL/MCP today (the
  legacy timeline explicitly excludes justice). This is greenfield.
- **Cross-module needs (consumed, never imported — through kernel/soft links):**
  1. `core.territories` via kernel `TerritoryRepo` (court county/SIRUTA/region).
  2. `legal.acts` / `legal.act_citation_keys` for `case_legal_references.target_act_id`
     resolution — a **read** through the kernel DB instance, coordinated with the
     **legal module (05)** which owns `LegalAct` (foundation §9). Justice references
     `LegalAct` by `act_id` in GraphQL via the kernel join, not by importing the
     legal module.
  3. `companies` domain for `party_company_candidates.candidate_cui` enrichment —
     only when links are published; via the kernel identity hub by CUI.

---

## 12. Testing

**Unit (`tests/unit/judicial/`):**

- Usecase tests with mocked ports (`getCaseDetail` name-merge; `getCompanyLitigation`
  empty-in-v1 returns `coverage:0`).
- Filter spec → SQL compilation **snapshot tests** (the `judicial_cases` bounding
  rule rejects unbounded input; `canonicalizeFilters` stable key).
- Cursor encode/decode incl. `fhash` mismatch → `InvalidInput`.

**Integration (`tests/integration/judicial/`):** REST + GraphQL + MCP against a
seeded fixture schema; tri-surface equivalence (same filter → same data) via
`canonicalizeFilters`.

**The leak audit (dedicated privacy test — foundation §14.9, the gate):**

1. **Static:** grep the entire `judicial/` module source + the generated GraphQL
   SDL + every MCP output TypeBox schema + the OpenAPI fragment; assert
   `display_name`/`displayName` appears ONLY inside `PartyDictionaryRepo.getPublishableName(s)`
   and `solution_summary`/`solutionSummary`/`solution` (the column) appears
   **nowhere** in any projection/SELECT in v1.
2. **Runtime SQL log:** run the full REST/GraphQL/MCP integration suite with query
   logging; assert no emitted SQL selects `solution_summary` or `solution`, and
   `display_name` is selected only by the gated method's query.
3. **Surface output + (3b) classifier-rule contract:** for a fixture case with
   person + company parties, assert (a) person parties render as
   `{partyKind, role, name:null}`; (b) company party name appears only when the
   party row's `classifier_rule ∈ PUBLISHABLE_RULES`; (c) no response, GraphQL
   field, or MCP output contains `solution_summary`/`solution`. **(3b)** query
   `SELECT DISTINCT classifier_rule, party_kind, (name_key_id IS NOT NULL) FROM
justice.case_parties` and assert: every `name_key_id`-bearing row has
   `classifier_rule ∈ PUBLISHABLE_RULES`, AND no excluded rule ever carries a
   non-null `name_key_id`, AND every observed `classifier_version` is recognized by
   the server (else the gate must self-disable — §3.1 req 1).
4. **Dictionary CHECK assertion:** assert `resolveCompanyName('<a person name>')`
   returns empty (dictionary holds no person names) and that the resolver echoes
   the dictionary `display_name`, never the user's query string back (S1).
5. **Search projection:** assert no `doc_type='judicial_case'` hit's title/body/cuis
   contains a name beyond gated company/public names (guards the §9 contract).
6. **Gated-table jsonb/PII non-projection (covers the tables BEFORE they populate
   — reviewer B3):** assert that `party_company_candidates.evidence`, `.candidates`,
   `.reviewed_by` and `case_lineage_candidates.evidence` appear in **no** REST
   response schema, GraphQL field, MCP output schema, or OpenAPI component. Run the
   company-litigation + lineage suites against a fixture **seeded with one
   `published` candidate row whose `candidates` jsonb contains a planted
   person-name string**, and assert that string surfaces nowhere. This makes the
   "no code change when gate #9 flips on" design safe by construction, not by
   future diligence.
7. **`case_legal_references.raw_text` bound (S2, A1):** assert the served
   `JudicialLegalRef.citation` is exactly the stored extracted token (`raw_text`),
   never the surrounding `source_field` text — and rows with
   `source_field='solution_summary'` are excluded from the served projection (their
   `raw_text` is a substring of a forbidden column).

**Golden filters:** JD-1..JD-4 from the catalog as integration cases, including the
explicit **refusal/empty-coverage** cases for JD-1/JD-3/JD-4 (gated, empty in v1).

**Aggregate accuracy fixtures (catalog gate):** `get_court_caseload` /
`get_company_litigation` outputs match an independent SQL recomputation on a frozen
snapshot.

---

## 13. Open questions / risks

1. **`case_hearings.solution` exposure — DEFAULT-OUT in v1 (revised after review).**
   `solution` is raw uncontrolled free text; the catalog says "no person names in
   serving." The first draft exposed it on case-detail behind a `freeText` flag —
   the reviewer correctly flagged that a rendering hint is not redaction and
   default-deny means default-OUT. **v1 withholds `solution` from all surfaces**;
   `JudicialHearing` has no `solution` field. **User/architecture decision needed
   to PROMOTE it later:** run the scrapper's person-name-shape detector over a
   labeled `solution` sample; if it clears the bar (recorded in
   `etl.validation_results`), add `solution` to `JudicialHearing` (a deliberate type
   change + fresh leak audit), case-detail only. Until that decision + audit,
   `solution` stays out — no quiet flip.
2. **Publication fork (decision-review gate #14 — user decision).** Whether/when
   company profiles ever show cases, and the precision threshold (≥99% suggested)
   for promoting a candidate to `published`. v1 builds no publish path; the server
   surfaces are wired but empty. No engineering blocker; needs the precision sample
   (gate #9) + a product/legal decision.
3. **Person-name display fork (gate #15 — user decision).** Source parity
   (portal.just.ro shows persons) vs permanent redaction. This plan defaults to
   **redaction** (names null for person/unknown). The schema is invariant to the
   answer; flipping it would require a new gated method and a fresh privacy review —
   **not** a quiet config change.
4. **`case_id` reuse fragility (operational).** Prod `case_id` = reused raw
   `bigserial`; a raw truncate+rebuild reshuffles ids and forces a prod full reload
   (loader tier-1 reconciliation blocks drift). The server assumes `case_id`
   stability between loads; if a reload changes ids, cached cursors/links go stale
   — acceptable (TTL), but client deep links by `case_id` could 404 after a reload.
   **Mitigation:** prefer the natural-key lookup (`/cases/lookup`) for durable deep
   links; note in client contract.
5. **Court territory coverage.** `courts.county_code` is a soft link; 16 top-level
   courts have null parents and military courts may lack clean county mapping.
   Territory filters on courts must surface `coverage` and an `unmapped` bucket
   (catalog coverage gate), not silently drop courts.
6. **Search lane is in the scrapper, not the server.** The single largest privacy
   risk (person names in Meili/OpenSearch) is enforced by the **scrapper** search
   lane; the server can only verify (test #5) and read. If the scrapper ever writes
   a name into `search.documents`, the server's leak audit catches it at the index
   level but cannot prevent the write. **Recommendation:** the scrapper's
   search-docs lane must carry the same `PUBLISHABLE_RULES` gate + a structural
   validation check (decision-review gate #12) — coordinate as a cross-repo
   invariant.

```

```
