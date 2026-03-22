# Academia Romana PDF Parsing Postmortem

## Summary

This document captures what we learned while building and iterating on the extraction pipeline for `Academia_Romana.pdf`.

The current pipeline consists of:

- [scripts/extract_pdf_tables.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/extract_pdf_tables.py)
- [scripts/validate_pdf_totals.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/validate_pdf_totals.py)
- [scripts/csvs_to_xlsx.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/csvs_to_xlsx.py)
- extractor fixtures and tests in [tests/unit/scripts/extract-pdf-tables.test.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/tests/unit/scripts/extract-pdf-tables.test.ts)
- validator tests in [tests/unit/scripts/validate-pdf-totals.test.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/tests/unit/scripts/validate-pdf-totals.test.ts)

The PDF is not a generic “extract all tables” problem. It is a document-specific parsing problem with multiple recurring layouts and non-uniform continuation pages.

## What The Document Actually Looks Like

### Good news

- The PDF is born-digital.
- `pdftotext -layout` preserves enough horizontal structure to recover table columns reliably.
- OCR is not needed.

### Less good news

The document contains several different table families, not one:

- `SINTEZA POLITICILOR SI A PROGRAMELOR BUGETARE FINANTATE PRIN BUGET`
- `SINTEZA` / `fondurilor alocate pe surse si pe titluri de cheltuieli`
- `Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate`
- `FISA PROIECTULUI`
- `SINTEZA FINANTARII PROGRAMELOR`
- `FISA PROGRAMULUI BUGETAR`
- `PROGRAMUL DE INVESTITII PUBLICE`

These layouts are similar enough to be confusing and different enough to break a one-size-fits-all parser.

## Core Design Decisions

### 1. Use `pdftotext -layout` as the primary backend

Why:

- It is already available through Poppler.
- It gives stable enough text columns for this PDF.
- It keeps the implementation lightweight.
- It avoids OCR and Java-heavy table tools.

Rejected alternatives:

- OCR: unnecessary and lower fidelity for this PDF.
- Generic PDF table extractors as the primary path: too brittle across the document’s mixed layouts.

### 2. Parse per table family, not globally

Why:

- Page title determines semantics.
- Numeric columns and hierarchy meaning differ by family.
- Continuation pages often omit title lines and must inherit context from the prior page.

Practical rule:

- `section` is the normalized table title for the active page family.
- Parser state must reset when the page title changes.

### 3. Treat `budget_indicator_summary` as a special case

This family needed the most domain logic:

- six hierarchy code columns
- functional path
- economic path
- continuation-page carry-forward
- page-title-derived section grouping
- numeric normalization
- totals validation

This family should be treated as its own parser subsystem, not as a small branch in a generic parser.

### 4. Keep `row_code`, but add explicit hierarchy columns

`row_code` is preserved because it reflects the visible code on the row.

For machine processing, it is not enough. We added:

- `capitol`
- `subcapitol`
- `paragraph`
- `grupa_titlu`
- `articol`
- `alineat`
- `functional`
- `economic`

This was the right decision. `row_code` is human-facing. The hierarchy columns are machine-facing.

### 5. Use padded hierarchy keys with `00`

Final rule:

- missing functional/economic levels are emitted as `00`
- derived keys always contain 3 segments

Examples:

- `5000.00.00`
- `6601.04.05`
- `51.02.00`
- `00.00.03`

Why this matters:

- grouping becomes stable
- downstream joins are simpler
- validators can reason about parent/child levels deterministically

## Parser Strategy By Family

### Policy program summary

Source title:

- `SINTEZA POLITICILOR SI A PROGRAMELOR BUGETARE FINANTATE PRIN BUGET`

Approach:

- description text on the left
- `I/II` markers in the middle
- fixed numeric columns to the right

This family is comparatively easy.

### Budget indicator summary

Source titles include:

- `SINTEZA`
- `Bugetul pe capitole, subcapitole, paragrafe, titluri de cheltuieli, articole si alineate`

Approach:

- detect the active table title from the page heading
- parse the left gutter separately from the description area
- detect the `1..7` ruler line and derive the numeric column positions per page
- maintain separate functional and economic state
- emit padded raw code columns and padded derived keys

This family is where most of the work and most of the bugs were.

### Project sheet financing

Source title:

- `FISA PROIECTULUI`

Approach:

- project metadata above
- section rows with repeated credit rows under them
- fixed numeric columns

Important:

- `I. Credite de angajament` and `II. Credite bugetare` rows are data rows, not headers

### Program financing summary

Source title:

- `SINTEZA FINANTARII PROGRAMELOR`

Approach:

- repeated program sections
- repeated funding rows
- values often appear on the next line after the label line

### Program budget financing

Source title:

- `FISA PROGRAMULUI BUGETAR`

Approach:

- do not parse the whole page family
- only parse the financing sections:
  - `SURSE DE FINANTARE ALE PROGRAMULUI`
  - `BUGETUL PROGRAMULUI`

Important:

- indicator pages in this family are not target tables for this extractor

### Public investments

Source title:

- `PROGRAMUL DE INVESTITII PUBLICE`

Approach:

- code + description + `I/II`
- multiline description rows
- numeric columns are stable enough once grouped by page family

## The Biggest Technical Lessons

### Lesson 1: fixed numeric starts are not enough for `budget_indicator_summary`

Early versions assumed one numeric layout for the entire family.

That caused:

- values landing in the wrong columns
- absurd totals validation results
- apparent hierarchy mismatches that were really parsing mistakes

Fix:

- derive numeric starts from the page’s own `A/B/1..7` ruler line

This reduced validator noise dramatically.

### Lesson 2: left-gutter parsing must be token-based, not pure slicing

Early versions used fixed substring slices for:

- `capitol`
- `subcapitol`
- `paragraph`
- `grupa_titlu`
- `articol`
- `alineat`

That failed when:

- wrapped rows shifted the first character of the description
- child codes like `03` sat one character earlier than expected

Fix:

- scan the left gutter for numeric tokens
- map the token’s start offset into a code zone

This fixed misread branches such as wrapped `alineat` rows.

### Lesson 3: continuation pages are where most bugs hide

Some continuation pages:

- omit the logical title
- start with lower-level rows
- start with value rows
- collapse institution name and annex metadata into one line

Practical implication:

- title extraction must ignore annex furniture robustly
- hierarchy state must carry across pages inside the same table
- state must reset only when the table title changes

### Lesson 4: blanks are not always zeros

This was the largest validator mistake.

A blank child value can mean:

- truly zero
- not printed in the document
- not applicable at that level
- continuation-page omission

For validation, treating every blank as numeric zero created false failures.

Fix:

- compare a numeric column only when the parent and all immediate children explicitly have a value for that column

This reduced the real-PDF validator output from a large noisy failure set to a much smaller targeted set.

### Lesson 5: `credit_type` must be part of the validation grouping

Without `credit_type`, the validator mixes:

- `I.Credite de angajament`
- `II.Credite bugetare`

This is invalid because they are separate hierarchies of amounts.

Validator grouping now uses:

- `section`
- `credit_type`
- the fixed opposite hierarchy key

## Numeric Normalization Rules

Final output rule:

- values are emitted as machine-friendly strings
- no thousands separator
- `.` as decimal separator

Examples:

- `535.943` -> `535943`
- `1.107,63` -> `1107.63`
- `32,08` -> `32.08`
- blank -> blank

Important caveat:

The parser does not infer units or semantic meaning from the numeric format. It only normalizes the printed value string.

## Validation Strategy

Validator script:

- [scripts/validate_pdf_totals.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/validate_pdf_totals.py)

Validation rules:

- one `section` at a time
- one `credit_type` at a time
- one opposite hierarchy key at a time
- immediate parent/child checks only
- additive columns only
- growth column excluded:
  - `crestere_descrestere_2026_2025`

Functional validation:

- fixed `economic`
- roll up `functional`

Economic validation:

- fixed `functional`
- roll up `economic`

### Current real-PDF state

The validator now reports a much smaller set of mismatches than earlier versions.

Interpretation of the remaining mismatches:

- some are likely genuine document inconsistencies
- some are likely remaining extraction edge cases
- they are no longer broad “column layout is wrong” failures

This is an important milestone: the validator is now useful as a debugging and audit tool rather than just a failure generator.

## XLSX Export Lessons

Script:

- [scripts/csvs_to_xlsx.py](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/scripts/csvs_to_xlsx.py)

Final behavior:

- normalized numeric value columns are written as numeric Excel cells
- codes and padded keys remain strings
- descriptions remain strings

This matters because:

- sorting works numerically in spreadsheet software
- formulas work naturally
- leading zeros in hierarchy components are preserved in code columns and keys

## Testing Strategy That Worked

### 1. Use `pdftotext -layout` fixtures, not full PDFs, for unit tests

Why:

- stable
- small
- readable in code review
- avoids checking large PDFs into the repo

### 2. Cover representative pages, not every page

Key fixtures that proved useful:

- first-page family headers
- continuation pages
- deeper economic hierarchy pages
- deeper functional hierarchy pages
- synthetic child-only hierarchy page for `00` fallback

### 3. Keep one real-PDF smoke run in the workflow

Synthetic tests prove parser logic.

The real PDF proves:

- continuation state
- family transitions
- title inheritance
- validator usefulness

Both are necessary.

## Tips And Tricks

### Tip: inspect the ruler line before changing numeric parsing

For `budget_indicator_summary`, the `1..7` ruler line is the source of truth for numeric positions.

If values look shifted, inspect that line first.

### Tip: inspect raw `pdftotext -layout` output, not only CSV output

When debugging a row:

1. print the raw page text
2. print the exact line
3. inspect token start offsets
4. only then inspect emitted CSV

Most bugs become obvious one level above the CSV.

### Tip: continuation pages often need previous-page context

If a page starts with:

- `II.Credite ...`
- `articol`
- `alineat`
- `subcapitol`

you almost always need prior page state to interpret it correctly.

### Tip: do not trust visual meaning without structural meaning

Some rows look visually nested but do not contain enough explicit structure on their own.

Always verify:

- which hierarchy the code belongs to
- whether a page title changed
- whether a row is data or only description continuation

### Tip: duplicate-looking rows may still be legitimate

Many families legitimately contain both:

- a hierarchy label row
- repeated `I/II` measure rows under it

Do not deduplicate naively.

## Common Failure Modes

### 1. Title extraction on continuation pages

Symptom:

- `section` becomes annex metadata or institution header

Fix:

- ignore `ACADEMIA ROMANA`, `Anexa nr.`, `Pag.`, and money-unit furniture robustly

### 2. Misclassified left-gutter code

Symptom:

- `articol` becomes blank
- `alineat` swallowed into description
- wrong `row_code`

Fix:

- token-based gutter parsing

### 3. Numeric values shifted by one column

Symptom:

- absurd validator output
- decimal growth values appearing as totals

Fix:

- derive numeric starts from the page-specific ruler line

### 4. False validation failures from blanks

Symptom:

- huge mismatch count
- parent values compared against child “zeros”

Fix:

- only validate columns present on parent and all immediate children

### 5. Mixed `credit_type` rollups

Symptom:

- totals look wildly wrong but hierarchies seem right

Fix:

- always group validations by `credit_type`

## Commands We Actually Use

Extract CSVs:

```bash
python3 scripts/extract_pdf_tables.py \
  --input /Users/claudiuconstantinbogdan/Downloads/Academia_Romana.pdf \
  --output-dir /tmp/academia-pdf-tables
```

Validate totals:

```bash
python3 scripts/validate_pdf_totals.py \
  --input /tmp/academia-pdf-tables/budget_indicator_summary.csv
```

Build workbook:

```bash
python3 scripts/csvs_to_xlsx.py \
  --input-dir /tmp/academia-pdf-tables \
  --output /tmp/academia-pdf-tables/academia-romana-tables.xlsx
```

Run focused tests:

```bash
pnpm vitest run \
  tests/unit/scripts/extract-pdf-tables.test.ts \
  tests/unit/scripts/validate-pdf-totals.test.ts
```

## Open Questions / Remaining Work

### 1. Remaining validator mismatches

The current validator output on the real PDF is small enough to investigate manually.

These should be triaged one by one into:

- confirmed document inconsistency
- parser bug
- validator rule too strict

### 2. Should the validator support tolerances?

Current behavior uses strict equality.

This is correct for finding extraction problems, but some tiny real-document deltas may justify an optional tolerance mode later.

### 3. Should title extraction become family-specific metadata?

Right now `section` is a normalized string.

If future downstream tooling needs more control, we may want:

- `section_family`
- `section_variant`
- `section_title`

### 4. Should we export validator results as CSV/JSON?

Current validator is CLI-text oriented.

If this becomes part of a pipeline, JSON output would help.

## Recommendations For Future Maintenance

If you need to modify this pipeline later:

1. Start from a failing real row, not from the code.
2. Check raw `pdftotext -layout` first.
3. Verify the page family and page title.
4. Verify left-gutter token positions.
5. Verify the `1..7` ruler-line positions on that page.
6. Add or update a fixture before changing parser logic.
7. Re-run the validator on the real generated CSV.

Do not:

- generalize too early
- merge all table families into one parser
- treat blanks as zero without checking the document semantics
- remove `row_code` just because hierarchy columns exist

## Final Takeaway

The biggest lesson is that this PDF is structurally parseable, but only with document-aware logic.

The successful pattern was:

- detect family
- preserve page-title/table context
- parse left gutter and numeric columns separately
- normalize output for machines
- validate with hierarchy-aware rollups

That combination turned the problem from “extract some tables” into a maintainable, testable data pipeline.
