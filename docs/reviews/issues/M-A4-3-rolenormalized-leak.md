# A4-MED3 — `roleNormalized` is projected for name-withheld parties with no server-side vocabulary allowlist

|                       |                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | Medium                                                                                                                                                                                                           |
| **Verified verdict**  | Confirmed · Severity unchanged (Medium)                                                                                                                                                                          |
| **Confidence**        | CONFIRMED (projection + absence of allowlist); PLAUSIBLE (that PII lands in the column)                                                                                                                          |
| **Domain**            | privacy                                                                                                                                                                                                          |
| **Modules / files**   | `src/modules/judicial/core/usecases.ts:143-150`, `src/modules/judicial/shell/repo/children-repo.ts:139-155`, `src/modules/judicial/shell/db/schema.ts:100`, `src/modules/judicial/shell/graphql/typedefs.ts:111` |
| **Fix effort**        | S–M                                                                                                                                                                                                              |
| **Merge-blocker?**    | owner-call                                                                                                                                                                                                       |

## TL;DR

The whole judicial module is built as a defence-in-depth name gate: `case_parties` has **no name column**, and `display_name` only escapes through one gated repo that re-asserts the publishable predicate. But `roleNormalized` is projected verbatim for **every** party — including `person`/`unknown` rows whose name is deliberately withheld — and there is **no server-side allowlist** validating that the value is drawn from the intended controlled vocabulary. It is loaded by an external scraper into a `justice.` schema that this repo does not even create, so the "controlled vocab" property is an unenforced upstream assumption. A single loader value like `role_normalized = 'Reprezentant legal Ion Popescu'` surfaces a person's name for exactly the party the gate is trying to protect. Fix: map `role_normalized` through a server-side allowlist, coercing unrecognized values to `null`/`'other'` before projection.

## Evidence (re-verified against current code)

`roleNormalized` is projected for **all** parties, unconditionally — `usecases.ts:137-150`:

```
const partyViews: JudicialPartyView[] = parties.map((p) => {
  const pub = p.publishable && p.nameKeyId !== null ? names.get(p.nameKeyId) : undefined;
  if (p.partyKind === 'person' || p.partyKind === 'unknown') personPartyCount += 1;
  return {
    partyIndex: p.partyIndex,
    partyKind: p.partyKind,
    roleNormalized: p.roleNormalized,   // ← no gate; person/unknown included
    nameKeyId: pub?.nameKeyId ?? null,  // ← these three ARE gated
    name: pub?.displayName ?? null,
    legalForm: pub?.legalForm ?? null,
  };
});
```

Note the asymmetry: `name`/`nameKeyId`/`legalForm` pass through the `pub` gate; `roleNormalized` bypasses it entirely.

The repo selects the column raw — `children-repo.ts:140-153`:

```
select p.case_id::text as case_id, p.party_index, p.party_kind,
       p.role_normalized, p.name_key_id::text as name_key_id, ...
from justice.case_parties p
...
roleNormalized: row.role_normalized,
```

No coercion, no allowlist, no CHECK re-assertion (contrast `rowPublishable` at `children-repo.ts:129-131`, which _does_ re-assert the rule/version predicate for the name gate).

The "controlled vocab" claim is only a comment, enforced nowhere in this repo:

- `schema.ts:100` — `role_normalized: string | null; // controlled vocab; role_raw is NOT in prod at all`
- `core/types.ts:110` — same comment.
- `grep -rni "role.*vocab|allowedRoles|ROLE_ALLOW|normalizedRole"` over `src/modules/judicial/` → only these comments; **no allowlist constant, no CHECK constraint**.
- The `justice.` schema is not created anywhere in `src/infra/database/` (`grep` for `justice.`/`CREATE SCHEMA` in that tree → no matches), confirming `case_parties`/`role_normalized` are populated by an out-of-repo loader whose discipline is unverifiable from here.

Exposed to clients via GraphQL — `typedefs.ts:111`: `roleNormalized: String`.

## Root cause

The privacy gate was designed around the _name_ columns (`display_name`, `name_key_id`) and enforced meticulously for them, but `role_normalized` was trusted as inherently non-identifying ("controlled vocab"). That trust is placed on an external loader with no server-side backstop, violating the module's own stated defence-in-depth principle ("re-assert the predicate on the server, don't trust upstream"). The name gate has a self-disabling failure mode (unrecognized classifier_version ⇒ name withheld); `role_normalized` has **no** equivalent — an unrecognized/PII value flows straight through.

## Blast radius & impact

- Affected: any `case_parties` row where the loader wrote a `role_normalized` value that contains or implies a person's identity, for a party whose `display_name` is otherwise correctly withheld (`person`/`unknown`, or non-publishable classifier).
- Precondition: loader emits an out-of-vocabulary value carrying PII (free-text role, "legal rep <Name>", a party label that names the individual). Given `role_raw` is asserted "NOT in prod", `role_normalized` is the _only_ role field, increasing the chance a loader stuffs specifics into it.
- On fire: the GraphQL `roleNormalized` field leaks the identity the entire gate exists to protect — a direct bypass of the name-withholding guarantee, on the exact rows (`person`/`unknown`) that are most sensitive.
- Bounding: if the loader is in fact disciplined and only ever writes a small enum (`parat`, `reclamant`, `intervenient`, …), there is no live leak — hence Medium/PLAUSIBLE, not High. But the server currently has zero visibility or control over that, and the static leak-audit test (A4-MED2 / H5) does **not** cover `role_normalized` at all.

## Reproduction / falsifiable scenario

1. Loader (or a crafted test fixture) writes a `case_parties` row: `party_kind='person'`, `name_key_id=NULL`, `role_normalized='Reprezentant legal Ion Popescu'`.
2. Query `getCase` for that case via GraphQL.
3. `parties[].name` is `null` (gate works) but `parties[].roleNormalized` returns `'Reprezentant legal Ion Popescu'` — the withheld person is named.
   A unit test can pin this with a fake `parties` repo returning that row and asserting the projected `roleNormalized` is coerced to a safe value.

## Additional context discovered

- The module already has the ingredients for a fix: it maintains server-side allowlist sets (`PUBLISHABLE_RULES`, `PUBLISHABLE_PARTY_KINDS`, `CLASSIFIER_VERSION` in `constants.ts`) and re-asserts them defensively. A `ROLE_NORMALIZED_VOCAB` set in the same file is idiomatic and cheap.
- The leak-audit test (`tests/unit/judicial/leak-audit.test.ts`) enumerates forbidden columns (`display_name`, `solution`, `raw_text`, candidate PII) but **not** `role_normalized` — so this surface is unguarded by both the static and (nonexistent) runtime audits.
- Same class as A4-MED2: a projected column the privacy design assumed safe without server enforcement.

## Fix options

**Option A (recommended) — server-side vocabulary allowlist with safe coercion.**
Define `ROLE_NORMALIZED_VOCAB` (the intended controlled set) in `judicial/shell/repo/constants.ts`. In `children-repo.ts` mapping (or in `usecases.ts` projection), coerce: `roleNormalized: ROLE_NORMALIZED_VOCAB.has(row.role_normalized) ? row.role_normalized : null` (or `'other'`). This gives `role_normalized` the same self-disabling failure mode the name gate already has: an unrecognized value is dropped, not leaked. Trade-off: requires enumerating the real vocab (confirm with the loader owner); an over-narrow set silently nulls legitimate roles (a UX, not privacy, regression).

**Option B — gate `roleNormalized` behind publishability (weaker).**
Only project `roleNormalized` when `p.publishable` (i.e. mirror the name gate). Simpler, but throws away role info for legitimately non-name-bearing parties and still trusts the vocab for publishable rows. Prefer A.

Pin with a unit test: a `person` party with an out-of-vocab `role_normalized` → projected value is coerced; an in-vocab value passes through.

## Related

- [A4-MED2 — missing runtime SQL-log audit](M-A4-2-missing-runtime-audit.md) and [H5](H5-...md) — neither audit covers `role_normalized`; this finding is the concrete column that slips past them.
- Main report: judicial privacy-gate coverage section.
