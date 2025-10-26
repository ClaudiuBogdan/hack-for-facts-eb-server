## Specification: MCP Search Filters Tool (`search_filters`)

**Version:** 1.0
**Last Updated:** 2025-10-26
**Status:** Proposed
**Purpose:** Define a simple, precise, and AI-friendly search tool that returns machine-usable filter values for downstream analytics queries.

---

## 1. Overview & Goals

The `search_filters` tool lets external AI agents find the exact, machine-readable IDs used in analytics filters. It is designed to be:

- Simple: minimal input surface, single category per call.
- Precise: returns the exact filter field (`filterKey`) and value (`filterValue`).
- Agent-friendly: includes a relevance score and a `bestMatch` for confident auto-selection.

This tool supersedes earlier drafts of search functionality and is complementary to `generate_chart_data` (analytics tool).

---

## 2. Tool Definition

### Tool Name

- `search_filters`

### Input Schema

```typescript
export type SearchFiltersCategory =
  | 'entity'
  | 'uat'
  | 'functional_classification'
  | 'economic_classification';

export interface SearchFiltersInput {
  category: SearchFiltersCategory;
  query: string;
  limit?: number; // default 10, max 50
}
```

### Output Schema

```typescript
export type FilterKey =
  | 'entity_cuis'
  | 'uat_ids'
  | 'functional_prefixes'
  | 'functional_codes'
  | 'economic_prefixes'
  | 'economic_codes';

export interface BaseResult {
  name: string;                 // Human-readable name
  category: SearchFiltersCategory;
  context?: string;             // Short descriptor for disambiguation
  score: number;                // 0..1 relevance
  filterKey: FilterKey;         // Field to use in analytics filters
  filterValue: string;          // Value to pass (always string)
  metadata?: unknown;           // Category-specific details (see below)
}

export interface SearchFiltersResponse {
  ok: boolean;
  results: BaseResult[];        // Sorted by score desc
  bestMatch?: BaseResult;       // Present when score >= threshold (e.g., 0.85)
  totalMatches?: number;        // Optional; approximate counts are acceptable
  error?: string;
}
```

### Suggested Metadata Shapes (optional)

- entity
```typescript
{ cui: string; entityType?: string; uatId?: string; countyCode?: string }
```

- uat
```typescript
{ uatId: string; countyCode?: string; population?: number; isCounty?: boolean }
```

- functional_classification | economic_classification
```typescript
{ code: string; level?: number; levelName?: string; codeKind: 'prefix' | 'exact', chapterCode?: string, chapterName?: string, subchapterCode?: string, subchapterName?: string }
```

---

## 3. Agent Usage Flow

High-level agent workflow using `search_filters` + `generate_chart_data`:

1) Parse user intent → identify category, target, time, normalization
2) Call `search_filters` with `category` and `query`
3) Use `bestMatch` (or top result) to build analytics filter
4) Call `generate_chart_data` with the constructed series definition(s)
5) Analyze `data_series` and present insights with `chart_url`

### Pseudocode

```typescript
const searchRes = await search_filters({ category: 'uat', query: 'Cluj', limit: 5 });
if (!searchRes.ok || !searchRes.results.length) throw new Error('No matches');
const pick = searchRes.bestMatch ?? searchRes.results[0];
const filter = { [pick.filterKey]: [pick.filterValue] };

await generate_chart_data({
  title: 'Education Spending — Cluj (2020-2024)',
  chart_type: 'line',
  series_definitions: [{
    label: 'Cluj — Education',
    filter: {
      report_period: {
        type: 'YEAR',
        selection: { interval: { start: '2020', end: '2024' } }
      },
      account_category: 'ch',
      ...filter,
      functional_prefixes: ['70.']
    }
  }]
});
```

---

## 4. Examples

### Example A — UAT (County) Search

Input
```json
{
  "category": "uat",
  "query": "Cluj",
  "limit": 5
}
```

Output
```json
{
  "ok": true,
  "results": [
    {
      "name": "JUDEȚUL CLUJ",
      "category": "uat",
      "context": "County: CJ | Population: 691,106 | Type: County",
      "score": 0.97,
      "filterKey": "uat_ids",
      "filterValue": "123",
      "metadata": { "uatId": "123", "countyCode": "CJ", "population": 691106, "isCounty": true }
    }
  ],
  "bestMatch": {
    "name": "JUDEȚUL CLUJ",
    "category": "uat",
    "context": "County: CJ | Population: 691,106 | Type: County",
    "score": 0.97,
    "filterKey": "uat_ids",
    "filterValue": "123"
  },
  "totalMatches": 1
}
```

### Example B — Entity (Institution) Search

Input
```json
{
  "category": "entity",
  "query": "Primăria Cluj-Napoca"
}
```

Output
```json
{
  "ok": true,
  "results": [
    {
      "name": "PRIMĂRIA MUNICIPIULUI CLUJ-NAPOCA",
      "category": "entity",
      "context": "Type: city_hall | Location: Cluj-Napoca",
      "score": 0.95,
      "filterKey": "entity_cuis",
      "filterValue": "4305857",
      "metadata": { "cui": "4305857", "entityType": "city_hall" }
    }
  ],
  "bestMatch": {
    "name": "PRIMĂRIA MUNICIPIULUI CLUJ-NAPOCA",
    "category": "entity",
    "context": "Type: city_hall | Location: Cluj-Napoca",
    "score": 0.95,
    "filterKey": "entity_cuis",
    "filterValue": "4305857"
  }
}
```

### Example C — Functional Classification (Prefix)

Input
```json
{
  "category": "functional_classification",
  "query": "educație"
}
```

Output
```json
{
  "ok": true,
  "results": [
    {
      "name": "Învățământ",
      "category": "functional_classification",
      "context": "COFOG: 70. | Chapter: 70 Învățământ",
      "score": 0.99,
      "filterKey": "functional_prefixes",
      "filterValue": "70.",
      "metadata": { "code": "70.", "levelName": "Chapter", "codeKind": "prefix", "chapterCode": "70", "chapterName": "Învățământ" }
    }
  ],
  "bestMatch": {
    "name": "Învățământ",
    "category": "functional_classification",
    "context": "COFOG: 70. | Chapter: 70 Învățământ",
    "score": 0.99,
    "filterKey": "functional_prefixes",
    "filterValue": "70."
  }
}
```

### Example D — Economic Classification (Exact Code)

Input
```json
{
  "category": "economic_classification",
  "query": "20.30"
}
```

Output
```json
{
  "ok": true,
  "results": [
    {
      "name": "Cheltuieli de personal (Contribuții)",
      "category": "economic_classification",
      "context": "Economic: 20.30 | Chapter: 20 Bunuri si servicii",
      "score": 0.93,
      "filterKey": "economic_codes",
      "filterValue": "20.30",
      "metadata": { "code": "20.30", "levelName": "Paragraph", "codeKind": "exact", "chapterCode": "20", "chapterName": "Bunuri si servicii" }
    }
  ],
  "bestMatch": {
    "name": "Cheltuieli de personal (Contribuții)",
    "category": "economic_classification",
    "context": "Economic Code: 20.30 | Level: Paragraph",
    "score": 0.93,
    "filterKey": "economic_codes",
    "filterValue": "20.30"
  }
}
```

### Example E — Ambiguous Query Handling

Input
```json
{
  "category": "entity",
  "query": "primaria cluj"
}
```

Output (top 3 with scores)
```json
{
  "ok": true,
  "results": [
    {
      "name": "PRIMĂRIA MUNICIPIULUI CLUJ-NAPOCA",
      "category": "entity",
      "context": "Type: city_hall | Location: Cluj-Napoca",
      "score": 0.92,
      "filterKey": "entity_cuis",
      "filterValue": "4305857"
    },
    {
      "name": "PRIMĂRIA COMUNEI CLUJANA",
      "category": "entity",
      "context": "Type: city_hall | Location: (dummy)",
      "score": 0.74,
      "filterKey": "entity_cuis",
      "filterValue": "9012345"
    },
    {
      "name": "CONSILIUL JUDEȚEAN CLUJ",
      "category": "entity",
      "context": "Type: county_council | Location: Cluj",
      "score": 0.70,
      "filterKey": "entity_cuis",
      "filterValue": "7654321"
    }
  ],
  "totalMatches": 15
}
```

---

## 5. Error Handling

- Validation errors
```json
{ "ok": false, "error": "category is required" }
```

- No results
```json
{ "ok": true, "results": [] }
```

- Internal errors
```json
{ "ok": false, "error": "internal_error" }
```

---

## 6. Implementation Notes

- Always return `filterValue` as a string, even when the underlying ID is numeric (e.g., UAT IDs).
- Sort results by `score` descending and include `bestMatch` when above a confidence threshold (e.g., 0.85).
- `totalMatches` can be omitted if computing counts is expensive; an estimate is acceptable.
- Search stack: PostgreSQL `pg_trgm` with full Romanian diacritics support; exact/prefix code matching for classifications.
- For classifications, populate `metadata.codeKind` as `prefix` when the returned code ends with a dot (e.g., `70.`), otherwise `exact`.

---

## 7. Integration With Analytics

The values returned by `search_filters` map directly to analytics filters in `generate_chart_data`:

- entity → `filterKey: 'entity_cuis'` → `filterValue: '<CUI>'`
- uat → `filterKey: 'uat_ids'` → `filterValue: '<UAT_ID>'`
- functional (prefix) → `filterKey: 'functional_prefixes'` → `filterValue: '70.'`
- functional (exact) → `filterKey: 'functional_codes'` → `filterValue: '70.11.01'`
- economic (prefix) → `filterKey: 'economic_prefixes'` → `filterValue: '20.'`
- economic (exact) → `filterKey: 'economic_codes'` → `filterValue: '20.30'`

---

## 8. Future Enhancements (Non-breaking)

- Optional `hint` field in input (e.g., `hint: 'county' | 'city'`) to slightly bias ranking without filtering.
- Optional `includeMetadata?: boolean` to reduce payload size when not needed.
- Optional `locale` to support multi-language names/contexts in responses.

---

For related tools and end-to-end workflows, see:
- Analytics tool: `src/services/data-analytics-agent/specs/data-analysis-agent-spec.md`
- Chart schema guide: `src/services/data-analytics-agent/specs/chart-schema-guide.md`
