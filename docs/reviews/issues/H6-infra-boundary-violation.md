# H6 — Infra imports a module's core (layer inversion), and the ESLint boundary rule that should catch it is globally inert

|                       |                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | High                                                                                                                                                                                                                                         |
| **Verified verdict**  | Confirmed · Severity unchanged (the specific import is type-only, but the systemic enforcement hole it exposes is worse than reported)                                                                                                       |
| **Confidence**        | CONFIRMED                                                                                                                                                                                                                                    |
| **Domain**            | architecture                                                                                                                                                                                                                                 |
| **Modules / files**   | `src/infra/unsubscribe/token.ts:12,14`; `eslint.config.mjs:63-78,180-224`; masked siblings in `src/modules/legal/core`, `src/modules/shared/core/filters`, `src/modules/institution-correspondence/core`, `src/modules/resend-webhooks/core` |
| **Fix effort**        | M (S for the single import; M once you also close the ESLint hole and fix the other violations it unmasks)                                                                                                                                   |
| **Merge-blocker?**    | owner-call — the single type-only import is low runtime risk, but the discovery that `boundaries/dependencies` enforces _nothing_ is a merge-blocker-grade defect for a codebase whose CLAUDE.md sells "strict enforcement via ESLint"       |

## TL;DR

`src/infra/unsubscribe/token.ts` imports and re-exports `UnsubscribeTokenSigner` from `@/modules/notifications/core/ports.js` — infra reaching up into a module's core, which the dependency table forbids. The reported finding is real. Digging into _why ESLint missed it_ uncovered the bigger problem: the `boundaries/dependencies` rule is a **global no-op**. It resolves imports through `eslint-module-utils`, which reads `settings['import/resolver']`, but the config only sets `settings['import-x/resolver']`. With no resolver it classifies _no_ internal (or even external) import, so **every** layer rule silently passes. This masks at least four other real violations, two of them _runtime_ (not type-only): `kysely` imported into `shared/core`, and `legal/core` importing its own `shell/repo`. Fix direction: relocate the token signer so infra stops importing the module (recommended: move the impl into the `notifications` module), **and** add `import/resolver` so the whole class of violation is caught going forward.

## Evidence (re-verified against current code)

**The reported violation — confirmed (`src/infra/unsubscribe/token.ts`):**

```ts
12  import type { UnsubscribeTokenSigner } from '@/modules/notifications/core/ports.js';
14  export type { UnsubscribeTokenSigner } from '@/modules/notifications/core/ports.js';
36  export const makeUnsubscribeTokenSigner = (secret: string): UnsubscribeTokenSigner => {
```

Both the import (:12) and the re-export (:14) are **type-only** (`import type` / `export type`). The interface itself (`src/modules/notifications/core/ports.ts:22-25`) is a pure two-method contract (`sign(userId): string`, `verify(token): {userId}|null`) — no notifications-domain coupling.

**The rule that _should_ fire (`eslint.config.mjs:197-201`):**

```js
{ from: { type: 'infra' },
  allow:    { to: { type: 'common' } },
  disallow: { to: { type: ['core', 'shell'] } },
  message: 'Infra must be generic.' },
```

Element patterns are defined (`eslint.config.mjs:71-77`), including `{ type: 'core', pattern: 'src/modules/*/core/**/*' }` and `{ type: 'infra', pattern: 'src/infra/**/*' }`.

**But ESLint passes clean.** Direct runs (all exit 0, zero boundary diagnostics):

```
npx eslint src/infra/unsubscribe/token.ts                       -> exit 0
npx eslint src/modules/shared/core/filters/composer.ts          -> exit 0   (imports kysely `sql`)
npx eslint src/modules/legal/core/usecases.ts                   -> exit 0   (imports ../shell/repo/citation.js)
npx eslint src/modules/institution-correspondence/core/ports.ts -> exit 0   (imports @/infra/email/client.js)
```

**Mechanistic root cause — confirmed in installed sources:**

- `eslint-plugin-boundaries/dist/Elements/Elements.js:11` → `require("eslint-module-utils/resolve")`.
- `eslint-module-utils/resolve.js:192-193`:
  ```js
  const configResolvers = settings['import/resolver'] || { node: settings['import/resolve'] }; // backward compatibility
  ```
  The plugin reads **`import/resolver`**, not `import-x/resolver`.
- `eslint.config.mjs:63-69` only defines **`import-x/resolver`** (for `eslint-plugin-import-x`). There is no `import/resolver` anywhere in the config (grepped).
- Consequence: `configResolvers = { node: undefined }`. With no usable resolver config, `fullResolve` returns `{ found: false }` for imports, so boundaries cannot resolve `@/…` aliases, `.js`→`.ts` extensions, or even external packages to classify their element/origin. Any `disallow` keyed on the _target's_ element type can never match, and `default: 'allow'` (`eslint.config.mjs:183`) lets it through. (`eslint-import-resolver-node` is present in the store but is **not resolvable from the project root** — `require.resolve` → `MODULE_NOT_FOUND` — so even the backward-compat node path is dead.)

Net: `boundaries/dependencies` currently enforces **nothing** for internal cross-layer imports. The `import type` on token.ts:12 is therefore _not_ why it slipped through — the rule would have missed a plain runtime import just the same, as the siblings below prove.

## Root cause

Two independent defects stacked:

1. **Layout defect:** unsubscribe-token signing lives in `src/infra/` but its contract is owned by `src/modules/notifications/core`. Infra re-exporting a module-owned interface inverts the dependency direction (infra → module/core).
2. **Enforcement defect:** the ESLint config wires the TypeScript path/extension resolver only under `import-x/resolver`. `eslint-plugin-boundaries` (via `eslint-module-utils`) needs it under `import/resolver`. The mismatch silently disables all element-type boundary checks, so defect #1 was never surfaced.

## Blast radius & impact

- **This import specifically:** type-only, so `tsc`/esbuild erase it entirely — **no runtime edge**, the bundler does **not** pull `notifications` into infra. Impact is architectural/type-level: infra is no longer type-portable without the notifications module present, and the layering intent is violated.
- **The enforcement hole (the real blast radius):** every architectural guarantee CLAUDE.md attributes to ESLint ("ESLint will block violations", "Core must remain I/O-free and portable") is currently unenforced for internal imports. Confirmed masked violations, all passing lint today:
  - `src/modules/shared/core/filters/derive.ts:16`, `composer.ts:11`, `territory.ts:25` — `import { sql } from 'kysely'` in **core**. **Runtime** import of an I/O library that `eslint.config.mjs:208` explicitly names as forbidden in core. (`types.ts:15` is type-only.)
  - `src/modules/legal/core/usecases.ts:16` — `import { parseCitation } from '../shell/repo/citation.js'` — **core → shell, runtime**.
  - `src/modules/institution-correspondence/core/ports.ts:14` — `import type { EmailSender, ReceivedEmailFetcher } from '@/infra/email/client.js'` — core → infra (type-only).
  - `src/modules/resend-webhooks/core/ports.ts:3` — `import type { SvixHeaders, WebhookVerifier } from '@/infra/email/client.js'` — core → infra (type-only).
  - `src/infra/unsubscribe/token.ts:12,14` — infra → core (type-only) — this finding.
  - (`src/modules/legal/core/usecases.ts:16` and the `kysely` cases are the genuinely severe ones — runtime core purity breaks — arguably more impactful than H6 itself.)
- **What still works:** the external-lib subrules do not fire either (kysely-in-core is not caught), so do **not** assume any part of `boundaries/dependencies` is live. What _is_ still enforced is everything that doesn't depend on module-graph resolution: `no-restricted-imports` (the anonymizer guard), `no-restricted-syntax` (JSON.parse / sql.raw / throw-in-core), strict booleans, filename-case, etc.

## Reproduction / falsifiable scenario

1. `grep -rn "@/modules/" src/infra/` → prints only `token.ts:12` and `:14` (the sole infra→module import).
2. `npx eslint src/infra/unsubscribe/token.ts` → exit 0, no `boundaries/*` diagnostic, despite rule at `eslint.config.mjs:197-201`.
3. Decisive control: `npx eslint src/modules/shared/core/filters/composer.ts` → exit 0 even though it does `import { sql } from 'kysely'`, which `eslint.config.mjs:208` disallows for core. Proves the rule is inert, not merely lenient on type-only imports.
4. To confirm the fix will re-arm the rule: add `settings['import/resolver'] = { typescript: { alwaysTryTypes: true, project: './tsconfig.json' } }` and re-run — the five imports above should now be flagged.

## Additional context discovered

- **Ownership map.** Four notification-ish modules exist; first commits: `notifications` **2025-12-09** (oldest/legacy), `notification-delivery` 2026-01-15, `campaign-admin-notifications` 2026-04-12, `notification-platform` **2026-07-10** (newest). The `UnsubscribeTokenSigner` **interface is defined in the legacy `notifications` module** (`core/ports.ts:22`, re-exported from `notifications/index.ts:83`). The **impl** (`makeUnsubscribeTokenSigner`) lives in `src/infra/unsubscribe/token.ts`. Consumers import the **type from infra** (not from the module): `notification-platform/shell/channel/email-channel-adapter.ts:21`, and five files under `notification-delivery/shell/queue/…` (`delivery-runtime.ts:28`, `workers/compose-worker.ts:21`, `compose-subscription.ts:39`, `compose-outbox.ts:75`, `send-worker.ts:48`). Wiring/construction is in `app/build-app.ts:54,1366`; tests reference the infra path (`tests/fixtures/fakes.ts:15,4116`, `tests/unit/infra/unsubscribe-token.test.ts`, plus two integration/unit tests).
- So the effective graph is: **infra defines the impl and re-exports the module's interface; newer modules then import that interface back _out of infra_.** infra is being used as a contract hub for a domain concept it shouldn't own. There is no import _cycle_ (ports.ts pulls only `./errors`, `./types`, `neverthrow`; `import-x/no-cycle` is on and green), so this is a layering/ownership smell, not a cycle.
- **`src/common/**`is clean** — grep for`@/modules/` there returns nothing. The only infra→module edge in the tree is this one file.

## Fix options

**Part 1 — remove the infra→module edge (pick one):**

- **Option A — move the signer into the `notifications` module (recommended).** Relocate `token.ts` to `src/modules/notifications/shell/token/unsubscribe-token-signer.ts`; it imports the interface from its own `core/ports.js` (shell→core, legal). Delete `src/infra/unsubscribe/`. Update `build-app.ts` to import `makeUnsubscribeTokenSigner` from `@/modules/notifications` (app may import anything), and point the two consumer modules + tests at `@/modules/notifications` instead of `@/infra/unsubscribe/token.js`. Rationale: an unsubscribe token is a notifications-domain concept, not generic infra; this makes infra genuinely portable and keeps the contract with its owner. Churn: ~9 import sites + build-app + fixtures. **Recommended.**
- **Option B — promote the interface to `common`.** Move `UnsubscribeTokenSigner` to `src/common/types/…`; have `notifications/core/ports.ts` re-export it (backward compat) and `infra/unsubscribe/token.ts` import it from `@/common/…` (infra→common, legal). Lower churn (only the two files that touch the interface change), and infra keeps the impl. Downside: infra still _owns the impl_ of a domain concept, and "a token signer contract" is a slightly awkward fit for `common` ("pure shared types, no business logic"). Use this if minimizing churn now matters more than domain placement.
- **Option C — leave the impl in infra, drop the type dependency.** Have infra define `makeUnsubscribeTokenSigner` returning an inline structural type and let the module keep its own interface (structurally compatible). Least principled — duplicates the contract — not recommended.

**Part 2 — close the ESLint hole (required regardless of Part 1, else the class recurs):**

- Add to `eslint.config.mjs` settings (alongside the existing `import-x/resolver`):
  ```js
  'import/resolver': {
    typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
  },
  ```
  This is what `eslint-module-utils`/`boundaries` actually read; it re-arms every element-type rule. **Land Part 2 together with fixes for the masked violations** (the `kysely`-in-core and `legal` core→shell runtime imports, and the two core→infra type imports), because turning the resolver on will make CI red until those are resolved. Consider also enabling `boundaries/no-unknown` / `boundaries/no-unknown-files` so an unresolvable import fails loudly instead of silently passing.
- Optional hardening: pin the signer path with a `no-restricted-imports` pattern (the config already uses that pattern for the anonymizer at `eslint.config.mjs:243-283`) so infra can never re-import a module path even if the resolver regresses again.

**Tests to pin it:** add a tiny lint-fixture assertion (or a CI grep) that `src/infra/**` contains no `@/modules/` import; and, after Part 2, a deliberate throwaway core-imports-kysely fixture proving `boundaries/dependencies` now errors.

## Related

- Sibling arch review: [rev-B4-arch] (whole-architecture pass) and the main review's architecture section.
- Directly overlaps the masked core-purity violations that belong with any "Core must stay I/O-free" finding (kysely-in-`shared/core`, `legal/core`→shell) — flag to whoever owns the correctness/architecture cluster.
