# A5-M2 — `fallbackTextSearch` lacks visibility/soft-delete pins & entity allowlist

|                       |                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| **Original severity** | Medium (dormant)                                                                                 |
| **Verified verdict**  | Confirmed · Severity unchanged (dormant latent leak)                                             |
| **Confidence**        | CONFIRMED                                                                                        |
| **Domain**            | privacy                                                                                          |
| **Modules / files**   | `src/modules/shared/shell/repo/search-repo.ts:34-69`, `src/modules/shared/core/ports.ts:120-124` |
| **Fix effort**        | S                                                                                                |
| **Merge-blocker?**    | no (dormant) — owner-call whether to delete now                                                  |

## TL;DR

`fallbackTextSearch` (`search-repo.ts:34-69`) queries `search.documents` with **no `visibility='public'` pin, no `deleted_at is null` pin, and no entity-grade `doc_type` allowlist** — it filters `doc_type` only when a caller passes a non-empty list. Its sibling `searchEntities` (:71-163) has all three. It is currently **dormant** (no `src/` caller), but it is a method on the **public `SearchRepo` port** and is **e2e-tested**, so a future wiring would silently return restricted + soft-deleted documents of any doc_type. Fix: add the two pins + entity allowlist, or delete the dead method.

## Evidence (re-verified against current code)

`search-repo.ts:43-52` — the entire WHERE:

```ts
let query = db
  .selectFrom('search.documents')
  .select(['doc_id', 'doc_type', 'title', 'body', 'attrs'])
  .where(sql`title ilike ${'%' + escapedRaw + '%'} escape '\\'`);
if (docTypes.length > 0) query = query.where('doc_type', 'in', [...docTypes]);
const rows = await query.limit(capped).execute();
```

No `visibility`, no `deleted_at`, no entity-grade set. `doc_type` is filtered **only if a non-empty `docTypes` is passed** — an empty array (the common "no narrowing" call) matches every doc_type.

Contrast `searchEntities` (`:115-117`):

```ts
.where('doc_type', 'in', allowlist)      // allowlist ⊆ SEARCH_ENTITY_DOC_TYPES
.where('visibility', '=', 'public')
.where('deleted_at', 'is', null);
```

and its allowlist logic (:86-91) intersects requested doc types with `SEARCH_ENTITY_DOC_TYPES`, returning `[]` (no rows) if the request narrows to nothing.

**Dormancy confirmed:** `grep -rn fallbackTextSearch src/` →

- `core/ports.ts:120` (port declaration)
- `shell/repo/search-repo.ts:34,67` (impl)
- no usecase/resolver/route caller. The live degrade path is `searchEntities` (`core/usecases/global-search.ts:200`), **not** `fallbackTextSearch`.

**Latent-leak surface confirmed:** it is a first-class method on the exported `SearchRepo` port (`ports.ts:120-124`), and `tests/e2e/search-repo-entities.test.ts:347-369` exercises it — including `:360-362` which **explicitly asserts it returns `judicial_case:1`** (a restricted doc type) via the comment _"Unlike searchEntities, fallbackTextSearch does NOT pin visibility — it is the engines-down path."_ So the leak-by-design is codified in a passing test, not an oversight the tests would catch.

## Root cause

`fallbackTextSearch` predates / sits beside the visibility-scoped `searchEntities` (the port doc at `ports.ts:119` labels it the pre-T2 bounded fallback). The safety pins were added to `searchEntities` but never back-ported, and the method was left on the port instead of being removed once `searchEntities` became the real degrade path.

## Blast radius & impact

- **Today: zero runtime exposure** — nothing calls it. Purely latent.
- **If wired** (any future "engines down → fallbackTextSearch" hookup, or a new consumer picking the port method by name): returns **soft-deleted** rows (`deleted_at` set) and **non-public** rows (`visibility != 'public'`) of **any** doc_type — including restricted/PII-bearing types like `judicial_case` — to an unauthenticated global-search surface. The e2e test would stay green, masking the regression.
- Bounded only by `limit` (capped 1–50) and the ILIKE title match.

## Reproduction / falsifiable scenario

Wire `fallbackTextSearch(q, [], 50)` behind a search resolver, seed a `search.documents` row with `visibility='internal'` or `deleted_at = now()` and a title matching `q` → it is returned. The existing e2e at `:360-362` already demonstrates a restricted `judicial_case` doc coming back.

## Additional context discovered

- The in-memory fake (`tests/unit/shared/merge-registry.test.ts:130`) stubs it to `ok([])`, so unit consumers never notice the missing pins.
- `searchEntities` is the correct template — its allowlist + two pins are exactly what `fallbackTextSearch` should adopt if kept.
- No config gate guards a future wiring; the method is freely callable.

## Fix options

- **Option A (recommended — delete):** remove `fallbackTextSearch` from the port (`ports.ts:120-124`), the impl (`search-repo.ts:34-69`), the fake, and the e2e block (`:347-369`). It is dead and `searchEntities` fully supersedes it. Eliminates the latent leak with no behavior change.
- **Option B (harden if a use is planned):** add `.where('visibility','=','public').where('deleted_at','is',null)` and default `doc_type` to `SEARCH_ENTITY_DOC_TYPES` (intersect on request, `[]`→no rows) exactly like `searchEntities:86-117`. Then **update the e2e** — the `:360-362` assertion that expects `judicial_case` back must be inverted, or it will fail (and it currently encodes the leak as intended behavior).

Either way, add/adjust a test that asserts restricted/soft-deleted rows are **excluded**.

## Related

- Sibling: [M-A5M1](M-A5M1-array-contains-empty-guard.md).
- Same visibility-pin pattern discussed for judicial leak-audit (H5).
