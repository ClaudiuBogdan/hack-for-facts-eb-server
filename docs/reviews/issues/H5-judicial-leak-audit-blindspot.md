# H5 — Judicial leak-audit is blind to fluent `.select()`, and its advertised second layer does not exist

|                       |                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | High                                                                                                                                            |
| **Verified verdict**  | Confirmed · Severity unchanged (latent)                                                                                                         |
| **Confidence**        | CONFIRMED                                                                                                                                       |
| **Domain**            | privacy                                                                                                                                         |
| **Modules / files**   | `tests/unit/judicial/leak-audit.test.ts`, `src/modules/judicial/shell/db/schema.ts`, `src/modules/judicial/shell/repo/party-dictionary-repo.ts` |
| **Fix effort**        | S                                                                                                                                               |
| **Merge-blocker?**    | owner-call (no current leak; latent gap in the module's centerpiece privacy guarantee)                                                          |

## TL;DR

The judicial privacy "gate" leans on a static leak-audit that greps the module's _projection residue_ for forbidden columns. The residue strips **all** single/double-quoted string literals globally, so any name projected via Kysely's fluent `.select(['k.display_name'])` (or the `const COLS = [...] as const; .select(COLS)` idiom already used elsewhere in the module) is invisible to the audit. Because `display_name` **is** declared on `JusticePartyNameKeysTable`, such a fluent select would ALSO compile — so a future ungated name projection would pass both guards. The second "runtime SQL-log audit" that the code comments advertise (`party-dictionary-repo.ts:14`) **does not exist**. No leak exists today (all `display_name` reads go through the gated raw-SQL repo); the gap is purely latent. One-line fix direction: remove `display_name` from the table type (the gated repo uses raw `sql<DictRow>` and does not need it), making an ungated fluent select a compile error — uniform with how every other sensitive column is already protected.

## Evidence (re-verified against current code)

**1. The residue strips all quoted strings globally** — `tests/unit/judicial/leak-audit.test.ts:52-59`:

```ts
const projectionResidue = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//gu, '') // block comments
    .replace(/^\s*\/\/.*$/gmu, '') // full-line comments
    .replace(/\/\/[^\n]*$/gmu, '') // trailing line comments
    .replace(/^\s*#.*$/gmu, '') // SDL `#` comments
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''") // single-quoted string literals → empty
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""'); // double-quoted string literals → empty
```

Template literals (`` sql`...` ``) and bare identifiers/object keys are **kept**; every `'...'` / `"..."` is blanked. The `display_name` assertion that consumes this residue is at `:80-93` (survives only in the gated repo + `schema.ts`).

**2. `display_name` IS declared on the table type** — `src/modules/judicial/shell/db/schema.ts:114`:

```ts
export interface JusticePartyNameKeysTable {
  name_key_id: string;
  display_name: string;   // ← declared, so a fluent .select(['display_name']) COMPILES
  ...
}
```

Contrast with the columns that are deliberately **omitted** from their table types — `solution` / `solution_summary` (`schema.ts:71-82`), `candidate_company_name` (`schema.ts:124-137`), `raw_text` / `span_start` / `span_end` (`schema.ts:141-156`). For those, a fluent `.select(['solution'])` is a **compile error** (the type has no such key). `display_name` is the _only_ sensitive column that is declared — which is exactly why it is the unique gap.

**3. The advertised runtime SQL-log audit does not exist** — `src/modules/judicial/shell/repo/party-dictionary-repo.ts:13-15`:

```
 * The static leak-audit test (§12 test 1) greps the module source and asserts
 * `display_name` appears ONLY in this file. The runtime SQL-log audit (test 2)
 * asserts it is SELECTed only by these queries.
```

`grep -rn 'onQuery\|queryLog\|sql\.log' tests/` → **NONE**. There is no Kysely `log`/`onQuery` hook anywhere in `src/` either. "Test 2" is vaporware; only the static "test 1" exists.

**4. Empirically proven blind spot** (reran the exact `projectionResidue` from the test against representative inputs):

| Input                                                               | Audit result |
| ------------------------------------------------------------------- | ------------ |
| `` sql`select k.display_name ...` `` (gated repo idiom)             | **CAUGHT**   |
| `.select(['k.display_name'])` (inline single-quote)                 | **MISSED**   |
| `.select(["k.display_name"])` (inline double-quote)                 | **MISSED**   |
| `const NAME_COLS = ['k.display_name'] as const; .select(NAME_COLS)` | **MISSED**   |
| `{ display_name: r.display_name }` (object key kept)                | CAUGHT       |
| ``.select(sql`k.display_name`.as('dn'))`` (template kept)           | CAUGHT       |

The last "MISSED" case is not hypothetical: `src/modules/judicial/shell/repo/courts-repo.ts:28-37,62` already uses exactly this idiom — `const COURT_COLUMNS = ['co.institution_code', …] as const;` … `db.selectFrom('justice.courts as co').select(COURT_COLUMNS)`. The established, blessed projection pattern in this very module is invisible to the audit.

## Root cause

The audit conflates two things that share a lexical form. SDL/MCP `description:` prose is written as quoted string literals and must be excluded (it is English, never a column). But Kysely fluent column arguments are **also** quoted string literals (`select('col')` / `select(['col'])`). A single global `'...' → ''` / `"..." → ""` pass cannot distinguish "prose to ignore" from "column projection to inspect", so it discards both. The audit therefore only sees columns that appear either as raw SQL inside `` sql`...` `` template literals or as bare identifiers/object keys — precisely the forms the _current_ code happens to use, which is why it passes today and gives false confidence. The type layer would normally backstop this, but `display_name` is the one sensitive column left in the table type (it has to be selectable by the gated repo), so the type backstop is absent for exactly this column.

## Blast radius & impact

- **Guarantee defeated:** the module's stated invariant is that `display_name` is named in exactly one gated SQL string, and every read re-asserts the publishable predicate (`party_kind IN (company,public_entity)` + an `EXISTS` on `case_parties` with `classifier_rule ∈ PUBLISHABLE_RULES` and a recognized `classifier_version`; `party-dictionary-repo.ts:74-86,116-130`). A future fluent `.select(['display_name'])` in, say, a join inside `cases-repo`/`children-repo` would project a name **without** re-asserting that predicate, and neither the compiler nor the audit would flag it.
- **Bound on severity:** `justice.party_name_keys` holds only `company`/`public_entity` rows by CHECK (`schema.ts:115`), and `justice.case_parties` has no name column at all (`schema.ts:94-105`). So the worst case is emitting an **unvetted company / public-entity name** (one that has not passed the publishable `EXISTS` gate), _not_ a person's name. This is a real breach of the "single gated path" guarantee, but it is not a person-PII leak. The team-lead's phrasing ("select of person names") slightly over-states the mechanism; the accurate statement is "an ungated company/public-entity name projection".
- **Present state:** **no current leak.** Every `display_name` read today is the gated repo's raw `sql<DictRow>` (`party-dictionary-repo.ts:74-86,116-130`); the only fluent `.select()` calls in the module (`courts-repo.ts:62,138`) touch courts/cases columns, never `display_name`. The finding is **purely latent** — a trap for a future change, plus a false advertisement of a non-existent second defense.
- **CI wiring confirmed:** the test matches the root `vitest.config.ts` include `tests/**/*.test.ts`; `test:unit` = `vitest run tests/unit`; and `.github/workflows/dev-branch.yaml:89-91` gates `build-push-update` on `needs: [typecheck, lint, validate, test-unit, test-integration]`. So this audit **is** a deploy gate on the `dev` branch — which is what makes its blind spot consequential: a future ungated fluent select ships green.

## Reproduction / falsifiable scenario

Add, anywhere in the judicial module except the gated repo, an ungated name projection using the module's own established idiom:

```ts
// e.g. inside cases-repo.ts, enriching a case with the party name directly:
const NAME_COLS = ['k.display_name'] as const;
const rows = await db
  .selectFrom('justice.party_name_keys as k')
  .select(NAME_COLS) // compiles: display_name is on the table type
  .where('k.name_key_id', '=', id)
  .execute(); // NO publishable EXISTS predicate
```

Result: `pnpm typecheck` passes (column is declared), `pnpm test:unit` passes (the string literal `'k.display_name'` is stripped from the residue → the leak-audit sees nothing), and the change deploys — silently projecting names that bypass the gate. Falsification would require the residue to retain that literal or the compiler to reject the select; neither holds (proven in Evidence #4).

Contrast — the same attempt on a _type-omitted_ column fails closed:

```ts
db.selectFrom('justice.case_hearings').select(['solution']); // ← compile error, no such key
```

This confirms the type-omission guard holds for `solution`/`solution_summary`/`candidate_company_name`/`raw_text`/`span_*`, and that `display_name` is the unique column where both guards are simultaneously absent.

## Additional context discovered

- **The idiom already exists in-module** (`courts-repo.ts:28-37,62`), so this is not a contrived pattern a reviewer would reject — it is the normal way projections are written here for non-name tables. A developer copying that pattern onto `party_name_keys` would introduce the leak with no friction.
- **The gated repo does not depend on the type slot.** Its query is `sql<DictRow>\`… k.display_name …\``with a *local*`DictRow` interface (`party-dictionary-repo.ts:36-41,74`). Raw `sql<T>`does not consult`ProdDatabase`table types, so removing`display_name`from`JusticePartyNameKeysTable` would **not** break the gated repo — Option B is safe.
- **Doc/comment conflict:** both `party-dictionary-repo.ts:14` and the header of `leak-audit.test.ts` ("test 1/…") imply a two-test defense; only the static test exists. The comment overstates the actual protection — worth correcting regardless of which fix is chosen.
- **Same bug class elsewhere?** No — `display_name` is the only sensitive-and-declared column. All other forbidden columns are type-omitted, so the fluent-select blind spot cannot reach them (verified against `schema.ts` table interfaces). The gap is singular.

## Fix options

**Option A — teach the residue to parse `.select([...])` args.** Before the global string-strip, extract quoted strings that appear inside `.select(...)` / `.selectAll(...)` calls and keep them as candidate columns. _Trade-off:_ brittle regex parsing of arbitrary fluent chains; defeated by the const-array indirection (`.select(COURT_COLUMNS)` — the literals live at a distant `const` declaration, not at the call site) unless you resolve identifiers, which regex cannot do. A real fix here needs an AST (ts-morph), which is heavy for a lint-style test. Partial and fragile. Not recommended.

**Option B — remove `display_name` from `JusticePartyNameKeysTable` (+ keep the local `DictRow`).** _(Recommended.)_ Delete the `display_name: string` field from `schema.ts:114`; the gated repo already reads it via raw `sql<DictRow>` and is unaffected. An ungated fluent `.select(['display_name'])` then becomes a **compile error**, identical to how `solution`/`candidate_company_name` are already protected — making the structural guarantee uniform across _all_ sensitive columns instead of special-casing one. Effort S. Update the now-moot `schema.ts` allowance in the audit (`leak-audit.test.ts:86`) and the "test 2" comment (`party-dictionary-repo.ts:14`) to match reality. **Pin it** with a `// @ts-expect-error` test asserting `db.selectFrom('justice.party_name_keys').select(['display_name'])` does not typecheck.

**Option C — implement the advertised runtime SQL-log audit.** Wire a Kysely `log`/`onQuery` hook that records compiled SQL, exercise every judicial read path in an integration/e2e test, and assert `display_name` appears only in SQL originating from the gated repo. _Trade-off:_ strongest defense-in-depth — it inspects the _actual_ SQL sent to Postgres, so it catches fluent, raw, and dynamically-built projections alike — but it only covers paths the tests actually drive, and it needs real wiring (hook + harness). Best as a **follow-up complement** to B, and it is the honest way to make the code comment true.

**Recommendation:** Ship **B** now (small, structural, uniform, zero new machinery, gated repo unaffected), and file **C** as defense-in-depth to fulfill the advertised second layer. Correct the overstated comments either way.

## Related

- Main report: judicial privacy-gate section.
- Sibling: [A4 judicial review](../..) (rev-A4-judicial) — architectural review of the same module's privacy mechanism.
