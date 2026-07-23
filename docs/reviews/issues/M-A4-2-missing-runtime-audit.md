# A4-MED2 — Advertised "runtime SQL-log audit (test 2)" does not exist

|                       |                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | Medium                                                                                                                     |
| **Verified verdict**  | Confirmed · Severity unchanged (Medium)                                                                                    |
| **Confidence**        | CONFIRMED                                                                                                                  |
| **Domain**            | privacy · testing                                                                                                          |
| **Modules / files**   | `src/modules/judicial/shell/repo/party-dictionary-repo.ts` (header, lines 13-15), `tests/unit/judicial/leak-audit.test.ts` |
| **Fix effort**        | M                                                                                                                          |
| **Merge-blocker?**    | no (documentation/defence-in-depth gap, not a live leak)                                                                   |

## TL;DR

The gated dictionary repo's header and the leak-audit test file both advertise a two-layer guard: a static source grep (test 1) **and** a "runtime SQL-log audit (test 2)" that asserts `display_name` is SELECTed only by the gated queries. Only the static layer exists. No test intercepts Kysely's query log (`onQuery`/`log`) to inspect emitted SQL, so the runtime layer that would actually catch a `display_name` projection built dynamically (or via a helper the static residue scan can't see) is absent. The static scan is real but string-based, so this is the missing second layer behind H5. Fix: add a Kysely query-logging integration test that drives the resolvers and asserts `display_name` appears only in queries originating from `party-dictionary-repo.ts`.

## Evidence (re-verified against current code)

Doc claim in the gated repo — `party-dictionary-repo.ts:14-16`:

```
 * The static leak-audit test (§12 test 1) greps the module source and asserts
 * `display_name` appears ONLY in this file. The runtime SQL-log audit (test 2)
 * asserts it is SELECTed only by these queries.
```

The leak-audit file header repeats the "test 2" framing (`leak-audit.test.ts:1-22`), but every actual test in it is **static**:

- `it('display_name survives ONLY in the gated repo ...')` — operates on `projectionResidue(readFileSync(...))`, i.e. string analysis of source (`leak-audit.test.ts:80-93`).
- The other `it(...)` blocks (`solution_summary`, candidate PII, `raw_text` spans) are likewise `readFileSync` + regex on residue (lines 67-122).
- The "structural type invariants" describe block parses the SDL AST and reads `schema.ts` text (lines 125-163) — still no DB, no query log.

Grep confirms the runtime layer is absent repo-wide:

```
grep -rn "onQuery\|queryLog\|sql\.log\|query log" tests/   → (no matches)
```

The comment's `projectionResidue` note even concedes it "removes everything that CANNOT be a projection ... and keeps what CAN be a projection" — an explicitly heuristic, source-text guard, not a runtime observation of what SQL actually ran.

## Root cause

The privacy design specified a belt-and-suspenders pair (static residue scan + runtime SQL-log assertion). Only the static half was implemented; the header prose was written as if both shipped, so the codebase _documents_ a guarantee it does not enforce.

## Blast radius & impact

- No live data leak by itself — the gated repo's SQL is correct today, and the static test does flag `display_name` outside the gated repo.
- The gap is the safety-net: any future code path that emits `display_name` in SQL that the _string_ residue scan misses — e.g. a column selected via a computed/aliased identifier, a `select('*')`-style projection, a shared query builder, or a name reaching SQL through a variable rather than the literal token `display_name` — would pass CI. The static scan matches the literal `\bdisplay_name\b` in template literals; it cannot see a column pulled in dynamically.
- This is precisely the second, independent layer that would close **H5** (the static-only audit blind spot): a runtime audit observes the _actual_ SQL text Postgres receives, regardless of how the source constructed it.

## Reproduction / falsifiable scenario

Add a repo query elsewhere in the module that projects the display name without the literal token, e.g. build the column list from a variable (`const col = 'display' + '_name'`) or `select k.*`. The static test's `\bdisplay_name\b` residue check does not fire; there is no runtime test to catch the emitted `SELECT ... display_name ...`. CI stays green while a non-gated query reads the gated column.

## Additional context discovered

- Kysely already supports the hook needed: a `log`/`onQuery` callback (or a `KyselyPlugin` `transformQuery`) can capture compiled SQL. The project's E2E harness (`tests/infra/test-db.ts`, Testcontainers) is the natural home for a real-SQL variant; a lighter version can assert on `db.getExecutor()` compiled queries without a live DB.
- The static test is otherwise strong (AST checks on the SDL, type-shape guards). The runtime layer is complementary, not redundant.
- Coordinate with **H5** — treat this file as the "layer 2" remediation for that finding; H5 documents why layer 1 alone is insufficient, this documents that layer 2 was never built.

## Fix options

**Option A (recommended) — runtime SQL-log audit test.**
Instantiate the app/repos against a query-logging Kysely (attach `log(event)` capturing `event.query.sql`, or a plugin recording compiled SQL). Exercise the judicial read paths (getCase, listForCase → dictionary lookups, resolveCompanyName). Assert: any captured SQL containing `display_name` was issued from the gated code path (tag queries, or assert the only statements touching `justice.party_name_keys.display_name` are the two known gated statements). Trade-off: needs a DB or a compile-only executor harness; medium effort but directly fulfils the documented guarantee and closes H5's layer-2.

**Option B — downgrade the docs to match reality (stopgap).**
If the runtime test is deferred, edit the two headers to stop claiming a "test 2" that doesn't exist, so the code doesn't over-state its guarantees. Cheap, but leaves the actual defence-in-depth gap open — do this only as an interim honesty fix, not the resolution.

## Related

- [H5 — judicial leak-audit static-only blind spot](H5-...md) — this is its missing second layer; link bidirectionally.
- Sibling: [A4-MED3 roleNormalized leak](M-A4-3-rolenormalized-leak.md) — another surface the current static audit does not cover (a _different_ column entirely).
- Main report: judicial privacy-gate assurance section.
