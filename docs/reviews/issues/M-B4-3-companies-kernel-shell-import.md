# B4-#3 — Cross-module deep import of `foldDiacritics` from another module's `shell/repo`

|                       |                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Original severity** | Low/Medium                                                                                                                                                         |
| **Verified verdict**  | Confirmed · Revised → **Low** (consistency/architecture; no runtime bug)                                                                                           |
| **Confidence**        | CONFIRMED                                                                                                                                                          |
| **Domain**            | architecture                                                                                                                                                       |
| **Modules / files**   | `src/modules/companies/shell/repo/filter-helpers.ts`, `src/modules/companies/shell/repo/companies-repo.ts`, `src/modules/parliament/shell/repo/parliament-repo.ts` |
| **Fix effort**        | S                                                                                                                                                                  |
| **Merge-blocker?**    | no                                                                                                                                                                 |

## TL;DR

Three files import `foldDiacritics` via the deep path `@/modules/shared/shell/repo/fold.js` — reaching into another module's `shell/repo` internals — instead of the public barrel `@/modules/shared/index.js`, which re-exports it at `index.ts:334` **precisely so modules don't reach into shell/repo** (its comment says so). Pure encapsulation nit: same function, same behavior, no runtime difference. The finding's premise that "budget/pnrr/primarii import it from the public index" is **not accurate** — they don't import `foldDiacritics` at all; the actual clean consumers are `parliament/core/usecases.ts` and `legal/mo/*`, which import it from the barrel. ESLint's `boundaries` plugin can't catch this because it models all modules' `shell` as one element type. Fix: change three import lines to the barrel.

## Evidence (re-verified against current code)

Public re-export (the intended entry point) — `src/modules/shared/index.ts:333-334`:

```ts
// Diacritic folding (§15.7) — re-exported so modules don't reach into shell/repo.
export { foldDiacritics } from './shell/repo/fold.js';
```

Deep-import violators (bypass the barrel):

- `src/modules/companies/shell/repo/filter-helpers.ts:20` — `import { foldDiacritics } from '@/modules/shared/shell/repo/fold.js';`
- `src/modules/companies/shell/repo/companies-repo.ts:37` — same.
- `src/modules/parliament/shell/repo/parliament-repo.ts:38` — same. (The reviewer's suspicion that parliament also does it is **confirmed.**)

Clean consumers (use the barrel) — for contrast:

- `src/modules/parliament/core/usecases.ts:15` — imports `foldDiacritics` from the shared barrel (grouped with `invalidInput`, `normalizeOffset`, …). Note parliament is **inconsistent with itself**: core uses the barrel, the repo deep-imports.
- `src/modules/legal/mo/contributor.ts:17` and `src/modules/legal/mo/repo.ts:23` — barrel.

## Root cause

`fold.js` lives under `shared/shell/repo/`. The barrel re-exports it so consumers get a stable public surface, but nothing **enforces** that consumers use the barrel — so three repo files took the shorter, deeper path. The `eslint-plugin-boundaries` config (`eslint.config.mjs:71-77`) defines element types by directory pattern only:

```js
{ type: 'shell', pattern: 'src/modules/*/shell/**/*', mode: 'file' },
```

Every module's `shell/**` collapses into the single `shell` element type. The dependency rule (`:180-243`) allows `shell → shell` (`default: 'allow'`, and the `from: shell` rule allows `to: core|common|infra` without disallowing `shell`). Because the plugin has no notion of _which_ module a `shell` file belongs to, a `companies` shell file importing a `shared` shell file is indistinguishable from importing its own shell — so cross-module deep imports are **structurally invisible** to the current lint setup. No `no-restricted-imports` rule targets `@/modules/*/shell/` cross-boundary paths either.

## Blast radius & impact

- **Runtime:** none. Both paths resolve to the identical `foldDiacritics` implementation (`shared/shell/repo/fold.ts:26`). No behavioral or performance difference.
- **Maintainability:** the deep imports couple `companies`/`parliament` repos to `shared`'s internal file layout. If `fold.ts` is ever moved/renamed inside `shared/shell/repo/`, the barrel could preserve the public export while these three call sites break — the exact fragility the barrel comment warns against.
- **Consistency:** it's a split-brain convention (parliament core = barrel, parliament repo = deep) that invites copy-paste propagation.
- Severity revised **Medium → Low**: no correctness/security/precision impact; it's a lint-gap + encapsulation cleanup.

## Reproduction / falsifiable scenario

Not a runtime repro. Static: `grep -rn "@/modules/shared/shell/repo/fold" src` returns the three offending lines. To demonstrate the fragility: rename `shared/shell/repo/fold.ts` → `.../diacritics.ts` and update only the barrel's re-export target; the three deep-import files fail to compile while every barrel consumer keeps working.

## Additional context discovered — **full deep-import inventory**

`grep -rn "@/modules/shared/shell" src --include=*.ts` (excluding `shared`'s own files):

**Runtime code deep imports (`foldDiacritics` — the actual violations to fix):**

1. `src/modules/companies/shell/repo/filter-helpers.ts:20`
2. `src/modules/companies/shell/repo/companies-repo.ts:37`
3. `src/modules/parliament/shell/repo/parliament-repo.ts:38`

**TypeScript declaration-merge deep imports (`declare module '@/modules/shared/shell/db/types.js'`)** — a **separate, benign** category: each data module augments the shared Kysely `DB` interface with its own tables. This is a module-augmentation idiom that _must_ name the real declaring module (a barrel can't re-export an `interface` augmentation target), so these are **not** violations, but they explain why a naive "ban `@/modules/shared/shell`" rule would over-fire:

- `src/modules/pnrr/shell/db/schema.ts:218`
- `src/modules/judicial/shell/db/schema.ts:177`
- `src/modules/procurement/shell/db/schema.ts:210`
- `src/modules/parliament/shell/db/schema.ts:404`
- `src/modules/legal/mo/db-schema.ts:98`
- `src/modules/legal/shell/db/schema.ts:176`
- `src/modules/companies/shell/db/schema.ts:128`
- `src/modules/budget/shell/db/schema.ts:292`
- `src/modules/primarii-transparency/shell/db/schema.ts:176`

So: **3 real value-import violations, all of `foldDiacritics`**; 9 declaration-merge references that should be excluded from any lint rule.

## Fix options

- **Option A (recommended):** rewrite the three imports to the barrel:
  ```ts
  import { foldDiacritics } from '@/modules/shared/index.js';
  ```
  (In `companies/*` and `parliament-repo.ts`, merge into the existing `@/modules/shared/index.js` import group already present in each file.) Zero runtime risk; restores single-consistent convention.
- **Option B (recommended as follow-up, pairs with A):** add a `no-restricted-imports` rule so this can't regress. Because `boundaries` can't distinguish modules, use a path pattern that bans reaching into a module's `shell/repo`/`shell/api` internals while **allowing** the `shell/db/types` augmentation target, e.g. an override on `src/modules/*/**` restricting `@/modules/*/shell/repo/*` and `@/modules/*/shell/**` value imports with `patterns` that carve out `**/shell/db/types.js`. Verify it doesn't fire on the 9 declaration-merge sites above.
- **Do not** attempt to encode this in `eslint-plugin-boundaries` element types alone — its current single-`shell`-type model fundamentally can't express "another module's shell"; `no-restricted-imports` path patterns are the pragmatic lever.

## Related

- Barrel definition: `src/modules/shared/index.ts:334`.
- Boundaries config gap: `eslint.config.mjs:71-77` (elements), `:180-243` (dependencies).
- Main report: B4 (architecture) findings.
