# X/F6 — moving the native population and factor logic out of `src/app/`

Status: design for owner approval (2026-09-09). No code moved yet.

## What sits in the composition layer today (1,154 lines, 0 unit tests)

| file (`src/app/`)                                                                               | owns                                                                                                                                                            | should be owned by                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `native-budget-factors.ts`                                                                      | factor-set id `'2'` + digest, `requirePromotion`                                                                                                                | `budget` (a `NativeFactorPolicy`)      |
| `native-map-population.ts`                                                                      | POP107D admission (revision, custody + transform SHAs, dimension ids), the Bucharest sector admission (8 source SHAs, year set, rows SHA), BigInt union roll-up | `ins-native` (admission) + kernel port |
| `native-sector-population.ts`                                                                   | six sector SIRUTAs, three allowed year-set shapes, eleven-clause validation, tuple SHA-256 recomputation                                                        | `ins-native`                           |
| `native-population.ts`                                                                          | snapshot-bound cells: kernel territories → INS nodes → POP107D cells (+ sector supplement)                                                                      | `ins-native` (adapter)                 |
| `native-annual-scope-population.ts`                                                             | decimal totals per year over the grouped population anchors                                                                                                     | `budget` (consumer of the port)        |
| `native-budget-repo.ts`                                                                         | `populationRelation` (jsonb_to_recordset), "preload factors before borrowing a snapshot connection" (×4)                                                        | `budget`                               |
| `native-execution-series.ts`, `native-grouped-entities.ts`, `native-grouped-classifications.ts` | the same preload + snapshot pattern, a duplicated `jsonb_to_recordset` fragment                                                                                 | `budget`                               |
| `native-map-routes.ts`                                                                          | route wiring, auth bypass, buckets, result memo                                                                                                                 | stays (wiring)                         |
| `ins-graphql-session.ts`                                                                        | INS read-session lifecycle                                                                                                                                      | stays (wiring)                         |

`build-redesign-app.ts` passes the two admission constants into four adapters by hand.

## Target shape

1. **Kernel port** (`shared/core/ports.ts`):

   ```ts
   export interface AnnualPopulationPort {
     /** One cell per (territoryId, year); null population = not admitted / not published. */
     cells(
       trx: Kysely<ProdDatabase>,
       territoryIds: readonly number[],
       years: readonly number[]
     ): Promise<Result<readonly AnnualPopulationCell[], ApiError>>;
     /** Runs `fn` inside one repeatable-read snapshot shared by identity and population reads. */
     withSnapshot<T>(fn: (trx: Kysely<ProdDatabase>) => Promise<T>): Promise<T>;
   }
   ```

   The kernel never imports a source module: the port is a type; the registry gets one
   implementation at wiring time (like `contributors`).

2. **`ins-native` owns admission and the adapter.** `native-map-population.ts`'s two admission
   constants, `native-sector-population.ts` and `native-population.ts` move to
   `ins-native/shell/population/` (admission constants in `core/population-admission.ts` as
   data, validation in `core/` as pure functions with unit tests, the snapshot read in
   `shell/`). `makeInsNativeModule` returns `population: AnnualPopulationPort`. Pins stay in
   code (owner decision N/N3), now next to the module that knows what they mean.

3. **`budget` consumes the port.** `native-budget-repo.ts`, `native-execution-series.ts`,
   `native-grouped-entities.ts`, `native-grouped-classifications.ts` and
   `native-annual-scope-population.ts` become `budget/shell/native/*` taking
   `{ population: AnnualPopulationPort; factors: FactorSource }`. One shared
   `populationRelation(cells)` helper replaces the duplicated `jsonb_to_recordset` fragment;
   one `withPreloadedFactors(plan, fn)` helper replaces the four copies of the preload pattern.
   `makeBudgetModule` gains a required `native: { population, factors }` when the kernel
   build enables it (owner decision N/N6/N7: no silent fallback).

4. **`src/app/`** keeps `build-redesign-app.ts` (wiring: `insNative.population` → `budget`),
   `native-map-routes.ts`, `ins-graphql-session.ts`. The `native-*.ts` files are deleted.

## Tests that move with the code

- admission validation: every clause of the sector admission (year-set shapes, source format,
  duplicate sources, rows SHA, six sector SIRUTAs, no native precedence) — pure, table-driven;
- population cells: territory → INS node resolution, missing cell = null, sector supplement
  overrides, BigInt union roll-up with a null member → null;
- annual scope totals: decimal sums, incomplete year absent, negative/NaN refused;
- budget native adapters: SQL pins for the relation fragment and the preload order
  (factors resolved before the snapshot connection is borrowed);
- wiring: kernel build boots with `budget` only when `ins-native` supplies the port.

## Order and size

Four commits, each green on `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`:
(1) port + `ins-native` population package with tests, `src/app` files re-exporting;
(2) `budget/shell/native` with the two shared helpers and tests, `src/app` re-exporting;
(3) wiring switch + required native deps + delete `src/app/native-*.ts`;
(4) ESLint `boundaries` covering `src/app/**` (X/F5) now that nothing under it reaches
module internals. Estimated 1,200–1,500 lines moved, ~600 lines of new tests.
