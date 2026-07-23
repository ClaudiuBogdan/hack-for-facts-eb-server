# M-A6M3 — buyerRegion accepted raw (canonicalization regression)

|                       |                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | Medium                                                                                                                                                                                        |
| **Verified verdict**  | Confirmed · Severity unchanged                                                                                                                                                                |
| **Confidence**        | CONFIRMED                                                                                                                                                                                     |
| **Domain**            | procurement / correctness                                                                                                                                                                     |
| **Modules / files**   | `src/modules/procurement/core/analysis-scope.ts:134-149`; `src/modules/procurement/shell/repo/analysis-repo.ts:104-112,160-162`; `src/modules/procurement/core/combinations.ts:78-79,222-234` |
| **Fix effort**        | S                                                                                                                                                                                             |
| **Merge-blocker?**    | owner-call                                                                                                                                                                                    |

## TL;DR

`buyerRegion` is a **served** analysis dimension (scope + breakdown) but is parsed with `readString` only — any non-empty string passes. It flows unvalidated into `buyer_region = <value>` SQL. An unknown/miscased/diacritic-variant region (`'cluj'`, `'atlantis'`, `'sud-vest oltenia'` lowercase) silently matches **zero rollup rows** while the answer envelope reports `answerability: 'served'` with `counts.rows: 0`. This is a regression from the now-deleted MCP filter usecase, which canonicalized `authorityRegion` against an 8-value allowlist with NFKD diacritic-folding and rejected unknowns. Restore the allowlist + fold.

## Evidence (re-verified against current code)

- `analysis-scope.ts:134-149` — `buyerRegion` is in the plain loop that only runs `readString` (non-empty-string check, `.trim()`). No allowlist, no case/diacritic normalization. Compare CUI fields (`:124-132`) which ARE normalized via `normalizeCui` and rejected if invalid — asymmetry within the same parser.
- `analysis-repo.ts:104-112` — `DIM_COLUMNS` maps `buyerRegion → 'buyer_region'`.
- `analysis-repo.ts:160-162` — `compileScope` emits `sql`${sql.ref(column)} = ${value}``for`buyerRegion`, so the raw string becomes a literal equality against `buyer_region`.
- `combinations.ts:78-79` — the `buyerRegion×cpvDivision` rollup declares `scopeDims: ['buyerRegion','cpvDivision']` and `breakdownDims: ['buyerRegion','cpvDivision']` → **buyerRegion is a first-class served dimension.**
- **Asymmetry (the other geo fields ARE rejected):** `combinations.ts:222-234` — `supplierRegion`/`supplierCounty` are hard-rejected (`missing capability: supplier geo = M3`), and `buyerCounty` is hard-rejected (`buyer_county rollup not built, wave-2`). Only `buyerRegion` is servable — and it is the one with no value validation.
- **Recovered deleted allowlist** (`git show 37a71f56:src/modules/mcp/core/usecases/query-procurement-filters.ts`):
  - `AUTHORITY_REGION_CANONICAL_VALUES = ['Bucuresti-Ilfov','Centru','Nord-Est','Nord-Vest','Sud-Est','Sud-Muntenia','Sud-Vest Oltenia','Vest']` (the 8 Romanian development regions).
  - `normalizeRegionKey` = `foldDiacriticsLocal` (explicit `ă/â/î/ș/ț…`→ascii map + `NFKD` + strip `̀-ͯ` + lowercase) then hyphen/space normalization.
  - `AUTHORITY_REGION_BY_FOLDED` mapped both the folded canonical and its space-for-hyphen variant back to the canonical value; `normalizeAuthorityRegion` returned `null` for anything unmatched, and the caller rejected with `authorityRegion must be one of: …`.
    None of this survives in `analysis-scope.ts`.

## Root cause

When the analysis scope parser was written to replace the MCP filter usecase, the region allowlist + diacritic-fold was not carried over. `readString` treats `buyerRegion` like free text, but downstream it is an **exact** SQL equality against a canonicalized `buyer_region` column, so any input that is not byte-identical to the stored canonical form silently misses.

## Blast radius & impact

- **Silent wrong answer, not an error.** Envelope says `served`; a tri-surface agent (GraphQL/MCP) presenting `counts.rows: 0` / null sums will conclude "no procurement in <region>" for a typo, wrong case, or missing diacritic — exactly the inputs an LLM naturally emits (`'Sud-Vest Oltenia'` vs `'sud-vest oltenia'` vs `'Sud Vest Oltenia'`).
- Fires whenever `buyerRegion` is set on `stats`/`series`/`breakdown`/`concentration`/`share`/`facets` scopes with anything other than the stored canonical spelling.
- Bounded: no data is leaked or corrupted; it degrades answer _correctness_/trust, not integrity. Entity-anchored queries are unaffected. Cacheable scopes (`analysis-repo.ts:290`) would even memoize the empty result under the raw key.

## Reproduction / falsifiable scenario

`procurementStats(scope: { buyerRegion: "atlantis" })` → routes to the buyerRegion rollup, `shapeGate` runs `geo` (may allow/degrade), `statsFor` runs `… where buyer_region = 'atlantis'` → 0 rows, block returns `recordCount: "0"`, `meta.answerability: 'served'`. Same for `buyerRegion: "nord-est"` (lowercase) when stored value is `Nord-Est`.

## Additional context discovered

- The deleted file was iterated specifically for this: commits `37a71f56 fix(mcp): Canonicalize procurement regions`, `c05bc658`, `e279c0f3` — the canonicalization was hard-won and then dropped in the analysis rewrite (`915e26e2 feat(procurement): Harden analysis API`).
- `breakdownDims` includes `buyerRegion`, so region also appears as an **output** key — a canonical allowlist should be the same source of truth for validating input and (optionally) labeling output buckets.
- No test pins region validation in the analysis path (the coverage lived with the deleted MCP usecase).

## Fix options

- **A (recommended):** Reintroduce `REGION_CANONICAL_VALUES` + `foldDiacritics`/`normalizeRegionKey` (lift from the deleted file) into `analysis-scope.ts`; in `parseAnalysisScope`, canonicalize `buyerRegion` and return `invalidInput('buyerRegion must be one of: …', 'buyerRegion')` on no match — mirroring the CUI-normalization branch. Add a unit test for `'nord-est'`, `'Nord Est'`, `'Nord-Est'` → canonical, and `'atlantis'` → rejected.
- **B (weaker):** Only reject unknowns (no fold). Rejects typos but still fails on legitimate case/diacritic variants an agent will emit — not recommended.

Keep at Medium: silent-wrong-answer on a served, agent-facing dimension.

## Related

Sibling MCP-cluster findings ([A6 review](../…)); shares the "envelope says served while the read is empty" failure mode with the metadata issue [M-B1F1](M-B1F1-series-counts-double-count.md). Main report: A6-M3.
