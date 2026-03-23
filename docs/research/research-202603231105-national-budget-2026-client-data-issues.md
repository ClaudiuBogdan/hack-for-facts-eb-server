# National Budget 2026 Client Data Issues

## Summary

This note captures the issues we found while validating the `budget-2026` client data against the server-side Anexa 3 extraction, what was fixed, and what still requires explicit interpretation rather than silent synthesis.

Relevant code and artifacts:

- [scripts/extract_pdf_tables.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/extract_pdf_tables.py)
- [scripts/validate_pdf_totals.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/validate_pdf_totals.py)
- [scripts/validate_budget_indicator_consistency.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/validate_budget_indicator_consistency.py)
- [scripts/output/anexa-3-batch/national-budget-indicator-summary.csv](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/output/anexa-3-batch/national-budget-indicator-summary.csv)
- [scripts/process-budget-2026.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/scripts/process-budget-2026.ts)
- [src/assets/data/budget-2026/national-budget-indicator-summary.csv](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/assets/data/budget-2026/national-budget-indicator-summary.csv)

## The Problems We Found

### 1. The client was mixing budget universes

The first important error was conceptual, not just technical.

The client originally treated the broader `Sinteza / 5000` consolidation as the national topline. That aggregation includes multiple source tables:

- `5001` state budget
- `5008` fonduri externe nerambursabile
- `5010` venituri proprii
- `5006` credite externe

That is not the same thing as the state-budget topline the page was expected to show.

For the current page, the correct headline universe is:

- `table_type = Buget pe capitole - buget de stat`
- `credit_type = II.Credite bugetare`
- `capitol = 5001`

After the extraction fixes, that total is:

- `527,413,262` mii lei
- `527.413262` mld lei

### 2. The server extractor was dropping values on wide pages

The main extraction bug in `budget_indicator_summary` was numeric-column assignment.

Symptoms:

- blank `propuneri_2026`
- blank `estimari_2029`
- values shifted into the wrong numeric columns

Root cause:

- numeric matching used “closest header start”
- on compressed `Sinteza` and `Buget pe capitole` pages, a value could be closer to the previous header marker than to its true column
- that caused collisions and dropped values

Examples we confirmed directly from the PDFs:

- `Ministerul Afacerilor Interne`, `Sinteza`, `5000 / II.Credite bugetare`
- `Ministerul Finantelor`, `Sinteza`, `5000 / II.Credite bugetare`
- the six missing `5001` state-budget totals that suppressed the legal `527.4` bn topline

### 3. The server extractor was folding later annex entities into the current PDF entity

`Ministerul_Culturii.pdf` includes a later ORDA annex.

Without a title-prefix continuity check, those later pages were being emitted under the `ministerul-culturii` entity.

That created:

- duplicate `5000 / Sinteza` rows
- merged-entity contamination

This was fixed by locking the expected institution title prefix for the `budget_indicator_summary` family and ignoring later pages whose explicit title switches to a different institution.

### 4. Continuation pages were promoting child economic rows into top groups

Some detailed budget pages continue a large `56 / 58 / 60 / 61` block across pages.

The extractor was mistakenly treating mixed-case continuation rows like:

- `58 Fondul pentru azil...`
- `59 Fondul pentru securitate...`
- `60 Instrumentul de sprijin...`

as new top-level economic groups instead of children under the active title block.

That polluted:

- `economic` paths
- cross-table comparison against `Sinteza`
- client economic aggregations

This was fixed by:

- remapping mixed-case continuation rows from promoted `grupa_titlu` to child article rows
- keeping their following `01 / 02 / 03` rows as alineate under that same promoted article

### 5. The client generator was inventing values

The original client generator used:

- residual buckets
- scaling
- backfilling from totals
- synthetic `unclassified` / `Neclasificat` / `Nespecificat in sursa` rows

This made some charts reconcile numerically, but those values did not exist in the source CSV.

That violated the main rule we locked:

- client data files must only contain values that come from source rows

## Extraction Fixes Applied

### Column shift detection (`extract_pdf_tables.py`)

`detect_and_correct_budget_indicator_shift()` — When the DP column mapper assigns the first value to `realizari_2024` instead of `executie_preliminata_2025`, all columns shift left by one. The percentage column `crestere_descrestere` provides a ground-truth check: if `(propuneri - executie) / executie * 100 ≈ crestere` holds after shifting right, the correction is applied. Works for both credit types.

### Sparse first-value correction (`extract_pdf_tables.py`)

`correct_budget_indicator_sparse_first_value()` — For credit lines with very few values (e.g. only 5 out of 7 columns), a small value like `5` or `6` can land between column 1 and column 2 positions. The function uses right-edge anchors derived from full credit lines on the same page to determine whether the value belongs in `realizari_2024` rather than `executie_preliminata_2025`.

### Header regex for `4=3/2` format (`extract_pdf_tables.py`)

`extract_budget_indicator_numeric_starts()` — Some wide-layout PDFs (e.g. ORDA) label column 4 as `4=3/2` instead of `4`. The header detection regex and position extraction now handle this variant.

### Code zone boundary corrections (`extract_pdf_tables.py`)

`BUDGET_INDICATOR_CODE_ZONES` — Two boundaries were tightened to match the actual PDF column headers:

- subcapitol/paragraph: `(6,12)/(12,17)` → `(6,11)/(11,17)` — the "Pa-" header starts at position 11
- articol/alineat: `(22,27)/(27,30)` → `(22,26)/(26,30)` — sub-item codes at position 26 are alineat, not articol

### Same-code articol remapping (`extract_pdf_tables.py`)

`normalize_budget_indicator_codes()` — When a detected `grupa_titlu` code matches the current group (e.g. both `56`) and the description is not a group header, the code is remapped to `articol`. Previously this case was silently ignored, creating duplicate `56.00.00` entries.

### Sub-entity page skipping (`extract_pdf_tables.py`)

Added `"BUGETUL"` and `"(sumele alocate"` to `BUDGET_INDICATOR_TITLE_MARKERS`, plus a `skip_foreign_entity` flag that persists across continuation pages. This prevents sub-entity data (e.g. DIRECTIA NATIONALA ANTICORUPTIE within Ministerul Public) from bleeding into the parent entity's extraction.

### "Partea" grouping row exclusion (`validate_pdf_totals.py`)

`_is_sinteza_partea_row()` — In the Sinteza table, rows like "Partea I-a SERVICII PUBLICE GENERALE" (capitol ending in `00`, subcapitol ≠ `00`) aggregate multiple chapters across a funding source. Including them in the functional rollup creates false parent-child relationships. These are now excluded from the functional rollup groups.

### Source-PDF duplicate detection (`validate_pdf_totals.py`)

`_all_children_duplicate_parent()` — Some Romanian budget PDFs repeat the chapter total on every subcapitol credit line. When all children carry the exact same non-zero values as the parent, the rollup check is skipped as a known source-data artefact.

## Final Source-Only Rules

### Totals

Use only direct state-budget total rows:

- `table_type = Buget pe capitole - buget de stat`
- `credit_type = II.Credite bugetare`
- `capitol = 5001`

### Functional breakdown

Use only direct chapter totals:

- state-budget rows only
- `economic = 00.00.00`
- `subcapitol = 00`
- `paragraph = 00`
- chapter rows only, not `5001`

This direct-source functional slice does reconcile to the headline total.

### Economic breakdown

Use only direct chapter-level economic title rows:

- state-budget rows only
- chapter functional rows only, not `functional = 5001.00.00`
- `economic != 00.00.00`
- `economic` must end with `.00.00`
- exclude known aggregators that double count:
  - `01`
  - `70`
  - `79`
  - `84`
  - `85`
- keep only actual title/group descriptions from source:
  - `TITLUL ...`
  - `PLATI ...`
  - `OPERATIUNI ...`
  - `DOBANZI ...`

This is source-backed, but it is not forced to equal the headline total.

Current result after the source-only cleanup:

- headline `2026`: `527,413,262`
- economic breakdown `2026`: `527,404,048`
- gap: `9,214`

That gap is preserved instead of being “fixed” with invented residuals.

### Entity functional / economic matrices

Use only direct source-backed rows:

- no synthetic residual institution rows
- no scaling to force matrix totals to match entity totals

### Sankey

Use only direct source-backed functional/economic intersections.

Do not:

- add unclassified links
- scale flows to force alignment
- backfill missing combinations

If the direct-source Sankey subset does not reconcile to the page headline, that is acceptable and must be described honestly in the UI.

## Validation Layers

### Existing validator

[scripts/validate_pdf_totals.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/validate_pdf_totals.py) checks parent/child rollups inside one table.

This answers:

- do hierarchy totals add up inside a single extracted table?

### New validator

[scripts/validate_budget_indicator_consistency.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/validate_budget_indicator_consistency.py) compares:

- `Sinteza`
- against the corresponding detailed table for the same funding universe

It checks:

- top totals
- chapter totals
- main-group totals

It is now wired into the batch output reports in:

- [scripts/extract_pdf_tables_batch.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/extract_pdf_tables_batch.py)

Each per-document report now has:

- rollup validation
- consistency validation

## Current Residual Validation State

After all extraction and validation fixes, the batch reports:

- **0 consistency mismatches** (Sinteza vs detail table)
- **220 rollup mismatches** (parent vs sum-of-children within one table)
- **24 clean entities** out of 55

### Rollup mismatch breakdown

| Category                             | Count | Root cause                                                     | Fixable?                               |
| ------------------------------------ | ----: | -------------------------------------------------------------- | -------------------------------------- |
| Off-by-one rounding                  |   162 | PDF decimal truncation (e.g. `3,80` displayed for `3.7974...`) | No — inherent to source                |
| Economic 56.xx (project financing)   |    31 | See "Known limitation" below                                   | Partially — needs context-aware parser |
| Economic 85.xx (prior-year payments) |    13 | Same positional ambiguity as 56.xx                             | Same                                   |
| Economic 58.xx (FEN projects)        |     6 | Same positional ambiguity                                      | Same                                   |
| Other small differences              |     8 | Minor PDF artefacts (max diff 1,485 mii lei)                   | No — source data                       |

### Known limitation: project financing sub-item codes at position 22–25

Economic codes `56`, `58`, and `85` use a three-level hierarchy:

```
56            TITLUL VIII PROIECTE CU FINANTARE DIN FEN    (grupa_titlu, pos 17)
     48       Programe finantate din FED                    (articol,    pos 22)
          01  Finantare nationala                           (alineat,    pos 27)
          02  Finantare externa nerambursabila              (alineat,    pos 27)
          03  Cheltuieli neeligibile                        (alineat,    pos 27)
     49       Programe finantate din FSE+                   (articol,    pos 21→grupa_titlu)
```

Sub-items `01 Finantare nationala`, `02 Finantare externa`, `03 Cheltuieli neeligibile` are structurally always alineat-level children of the fund code above them (e.g. children of `48`). They should produce economic codes like `56.48.01`, `56.48.02`, `56.48.03`.

However, `pdftotext -layout` sometimes places these codes at character position 22–25 (the articol zone) instead of position 26+ (the alineat zone). When that happens, the parser classifies them as new articol codes, producing `56.01.00`, `56.02.00`, `56.03.00` — which are siblings of `48` rather than children.

The zone boundary was already tightened from `(22, 27)` to `(22, 26)` to capture codes at position 26. But codes at positions 22–25 cannot be safely reclassified without context because legitimate articol codes (e.g. `01 Active fixe` under TITLUL XV, or `01 Programe din FEDR` under TITLUL X) also appear at those positions.

A context-aware fix would need to:

1. Detect that the current `grupa_titlu` is `56`/`58`/`85` (a project-financing title)
2. Recognize that a code `01`/`02`/`03` following a fund articol is always an alineat sub-item in this context
3. Promote it to alineat under the active articol

This requires teaching the parser about the Romanian budget project-financing structure specifically. The risk of false positives on other economic titles (where `01` at position 22 is a real articol) makes a generic approach unsafe.

**Impact**: these mismatches affect only the internal economic hierarchy under project financing codes. They do not affect:

- the headline `5001` total (527,413,262 mii lei)
- functional chapter totals
- Sinteza-vs-detail consistency
- any economic group at the `XX.00.00` level

### Surfacing

All mismatches are surfaced in the batch reports under:

- [scripts/output/anexa-3-batch](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/output/anexa-3-batch)

Important:

- these mismatches are now explicit validation findings
- they should be investigated case by case
- the client must not synthesize values to smooth them over

## Client-State Conclusions

The current client data should follow these rules:

- headline total must equal the state-budget `5001` aggregate
- functional data may be required to reconcile exactly if it comes from direct chapter totals
- economic data may remain a direct-source subset and therefore not reconcile exactly
- no generated file may contain invented residual categories
- UI copy must describe partial direct-source datasets honestly

## Commands We Used

Server verification:

```bash
python3 scripts/extract_pdf_tables_batch.py --source-dir scripts/input/anexa-3
python3 scripts/merge_budget_indicator_summaries.py
python3 scripts/validate_budget_indicator_consistency.py --input scripts/output/anexa-3-batch/national-budget-indicator-summary.csv
```

Client regeneration:

```bash
cp /Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/output/anexa-3-batch/national-budget-indicator-summary.csv \
  /Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/assets/data/budget-2026/national-budget-indicator-summary.csv

npx tsx scripts/process-budget-2026.ts
```

## Practical Rule For Future Work

If a client budget file does not come from:

- a direct source row, or
- a pure sum of direct source rows at the same semantic level,

it should not be generated.

If a chart cannot be made truthful without invented values:

- either keep only the direct-source subset and label it as such
- or hide the chart

but do not synthesize missing amounts.
