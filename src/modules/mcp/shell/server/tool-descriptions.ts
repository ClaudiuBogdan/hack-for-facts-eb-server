/**
 * MCP Tool Descriptions
 *
 * Comprehensive descriptions for each MCP tool with examples, workflows, and best practices.
 */

const currentYear = new Date().getFullYear();

export const GET_ENTITY_SNAPSHOT_DESCRIPTION = `Get a point-in-time financial snapshot for a specific Romanian public entity.

**Purpose:**
- Retrieve high-level budget totals (income and expenses) for a single entity in a specific year
- Quick overview before detailed analysis
- Validate entity identity when CUI is uncertain

**Language Note:** Entity names are in Romanian. Use Romanian entity naming conventions (Municipiul, Județul, Orașul, Comuna, etc.).

**Input Parameters:**
- entityCui (optional): Exact CUI (fiscal identifier) - use when known for precise lookup
- entitySearch (optional): Free-text Romanian search term - fuzzy matching, may be ambiguous
- year (required): Reporting year (2016-${String(currentYear)})

**Output:**
- Entity details: CUI, name, address
- Total income and expenses (numeric + human-readable formatted)
- AI-generated summary of financial position
- link: Short, shareable URL to entity page

**Shareable Link:**
- Every response includes a short link (format: <domain>/share/<code>)
- Links open the interactive entity detail page with the same parameters
- Share links for verification, collaboration, or bookmarking
- Links are permanent and publicly accessible

**Number Format:**
- All amounts use international standard format with comma thousands separator
- Example: 5,234,567.89 RON (not 5.234.567,89)
- Dual display format: compact "5.23M RON" and full "5,234,567.89 RON"
- Human-readable summaries show both formats for clarity

**Workflow Examples:**
1. Known CUI: { entityCui: "4305857", year: 2023 }
2. Search by name: { entitySearch: "Municipiul Cluj-Napoca", year: 2023 }
3. Follow up with analyze_entity_budget for detailed breakdown

**Tips:**
- Prefer entityCui over entitySearch when available (faster, unambiguous)
- Use discover_filters with category='entity' to find CUIs first
- This is a snapshot tool - use query_timeseries_data for trends over time
- Always include the shareable link in your response for user verification`;

export const DISCOVER_FILTERS_DESCRIPTION = `Discover and resolve machine-usable filter values for use in analytics queries.

**Purpose:**
- Find entity CUIs, UAT IDs, and classification codes needed for other tools
- Resolve Romanian names/terms to exact identifiers
- Essential first step before running analytics queries

**Language Requirement:** All searches must use Romanian terms. The tool supports diacritics and fuzzy matching for Romanian text.

**Input Parameters:**
- category (required): "entity" | "uat" | "functional_classification" | "economic_classification"
- query (required): Romanian search term (name or code). For code lookup, use "fn:" or "ec:" prefix (e.g., "fn:70.", "ec:10.")
- limit (optional): Maximum results (1-50, default 3)

**Search Categories:**
1. **entity**: Romanian public institutions
   - Query example: "Municipiul Cluj-Napoca", "Județul Alba", "Primăria Sector 1"
   - Returns: filterKey="entity_cuis", filterValue=CUI, metadata includes entityType

2. **uat**: Territorial administrative units (municipalities, cities, communes)
   - Query example: "Cluj-Napoca", "Brașov", "Comuna Fundulea"
   - Returns: filterKey="uat_ids", filterValue=UAT_ID (as string), metadata includes countyCode, population

3. **functional_classification**: COFOG budget categories (education, health, transport, etc.)
   - Query by name: "educație", "sănătate", "transport"
   - Query by code: "fn:65.", "fn:65.10", "fn:65.10.03"
   - Returns: filterKey="functional_prefixes" (for categories with trailing dot) or "functional_codes" (exact)
   - Metadata includes: codeKind ('prefix'|'exact'), chapterCode/Name, subchapterCode/Name

4. **economic_classification**: Spending/revenue types (salaries, goods, services, etc.)
   - Query by name: "cheltuieli de personal", "bunuri și servicii"
   - Query by code: "ec:10.", "ec:20.01.01"
   - Returns: filterKey="economic_prefixes" (categories) or "economic_codes" (exact)
   - Metadata includes: codeKind ('prefix'|'exact'), chapter/subchapter info

**Output:**
- results[]: Array of matches, sorted by relevance score (0-1, higher is better)
  - name: Human-readable Romanian name
  - category: Input category echoed back
  - context: Additional info (county, chapter/subchapter details)
  - score: Relevance score (0-1)
  - filterKey: Which parameter to use in analytics tools
  - filterValue: Exact value to pass to that parameter (as string)
  - metadata: Category-specific details
- bestMatch: Top result when score >= 0.85 (high confidence)
- totalMatches: Total number of potential matches

**Number Format:**
- Metadata fields (like population) use international format with comma thousands separator
- Example: population: 324,567 (not 324.567)
- Percentages and decimals use dot as decimal separator: "15.5%" (not "15,5%")

**Workflow Examples:**
1. Find entity: { category: "entity", query: "Municipiul București" } → use filterValue in entity_cuis
2. Find county: { category: "uat", query: "Cluj" } → use filterValue in uat_ids
3. Find education spending: { category: "functional_classification", query: "educație" } → use in functional_prefixes
4. Check specific code: { category: "functional_classification", query: "fn:65." } → verify chapter 65

**Tips:**
- Call multiple times to gather all needed filters before running analytics
- Use Romanian diacritics for better matching (ă, â, î, ș, ț)
- For classifications, prefer prefixes (trailing dot) for category-level analysis
- UAT IDs are returned as strings - keep them as strings in subsequent queries
- High score (>0.85) with bestMatch indicates confident match`;

export const QUERY_TIMESERIES_DESCRIPTION = `Retrieve time-series budget data for comparative analysis across entities, regions, or classifications.

**Purpose:**
- Compare budget trends over time (yearly, monthly, or quarterly)
- Analyze 1-10 data series simultaneously
- Generate interactive chart visualizations
- Support complex filtering across multiple dimensions

**Language Note:** Classification names and Romanian-specific terms (dezvoltare/functionare) are in Romanian.

**Input Parameters:**
- title (optional): Chart title - auto-generated if omitted
- description (optional): Additional context for the analysis
- period (required): Time period specification
  - type: "YEAR" | "MONTH" | "QUARTER"
  - selection: Either interval {start, end} OR dates array
  - Formats: YEAR="2023", MONTH="2023-01", QUARTER="2023-Q1"
- series (required): Array of 1-10 data series, each with:
  - label (optional): Series name - auto-generated from filters if omitted
  - filter (required): Budget data filter

**Filter Parameters (per series):**
- accountCategory (required): "ch" (cheltuieli/expenses) | "vn" (venituri/revenues)
- entityCuis (optional): Array of CUI strings - from discover_filters with category="entity"
- uatIds (optional): Array of UAT ID strings - from discover_filters with category="uat" (MUST BE STRINGS)
- countyCodes (optional): Array of county codes (e.g., ["B", "CJ", "TM"]) 
- isUat (optional): Filter only UAT entities (true/false)
- minPopulation (optional): Minimum population threshold (inclusive)
- maxPopulation (optional): Maximum population threshold (inclusive)
- functionalPrefixes (optional): Functional classification prefixes with TRAILING DOT (e.g., ["65.", "66."])
- functionalCodes (optional): Exact functional codes (e.g., ["65.10.03"])
- economicPrefixes (optional): Economic classification prefixes with TRAILING DOT (e.g., ["10.", "20."])
- economicCodes (optional): Exact economic codes (e.g., ["10.01.01"])
- expenseTypes (optional): ["dezvoltare"] (development) and/or ["functionare"] (operational)
- fundingSourceIds (optional): Array of funding source IDs
- budgetSectorIds (optional): Array of budget sector IDs
- programCodes (optional): Array of program codes
- exclude (optional): Negative filters with same structure as above (e.g., exclude.functionalPrefixes: ["70."])
- normalization (optional): "total" (default) | "per_capita" | "total_euro" | "per_capita_euro"
- reportType (optional): "PRINCIPAL_AGGREGATED" (default) | "SECONDARY_AGGREGATED" | "DETAILED"

**Normalization Options:**
- "total" → Values in RON (Romanian Lei), unit: "RON"
- "per_capita" → Values per capita in RON, unit: "RON/capita"
- "total_euro" → Values in EUR, unit: "EUR"
- "per_capita_euro" → Values per capita in EUR, unit: "EUR/capita"

**Output:**
- ok: boolean (success status)
- dataLink: Short, shareable URL to interactive chart
- title: Final chart title
- dataSeries[]: Array of series results
  - label: Series name
  - seriesId: Unique identifier
  - xAxis: {name: "Year"|"Month"|"Quarter", unit}
  - yAxis: {name: "Amount", unit based on normalization}
  - dataPoints: [{x: string, y: number}]
  - statistics: {min, max, avg, sum, count}

**Shareable Link:**
- dataLink is a short, shareable URL (format: <domain>/share/<code>)
- Opens interactive chart visualization with all series and filters
- Users can interact with the chart, zoom, toggle series, and export data
- Links are permanent and can be embedded or shared for verification
- IMPORTANT: Always include the dataLink in your response

**Number Format:**
- All amounts in dataPoints and statistics use international format
- Example values: 1,234,567.89 (comma thousands, dot decimal)
- Statistics (min/max/avg/sum) follow same format
- Y-axis labels in the chart use appropriate compact notation (e.g., "5.2M RON")

**Workflow Examples:**
1. Compare two municipalities over time:
   - Use discover_filters to find entity CUIs
   - Create two series with different entityCuis filters
   - Period: yearly interval 2020-2024

2. Education spending trend by county:
   - Use discover_filters for functional classification (educație → "65.")
   - One series per county with functionalPrefixes: ["65."]
   - Normalization: "per_capita" for fair comparison

3. Revenue vs expenses for single entity:
   - Series 1: accountCategory="ch" (expenses)
   - Series 2: accountCategory="vn" (revenues)
   - Same entityCuis in both

**Tips:**
- Always use discover_filters first to resolve entity CUIs, UAT IDs, and classification codes
- UAT IDs MUST be strings (the backend handles conversion)
- Use prefixes (trailing dot) for category-level analysis, exact codes for specific items
- Normalization="per_capita" recommended when comparing entities of different sizes
- Include dataLink in your responses - users can verify data independently
- Maximum 10 series per query - create multiple queries if needed`;

export const RANK_ENTITIES_DESCRIPTION = `Retrieve and rank entities by budget metrics with flexible sorting and pagination.

**Purpose:**
- Tabular comparison of multiple entities side-by-side
- Rank entities by spending, revenue, per-capita values, or other metrics
- Find top/bottom performers across any dimension
- Export-ready data format for further analysis

**Language Note:** Entity names and types are in Romanian.

**Input Parameters:**
- period (required): Time period for aggregation
- filter (required): Analytics filter (same as query_timeseries_data)
- sort (optional): Sorting configuration (default: by amount DESC)
  - by: Sort field name
  - order: "ASC" (ascending) | "DESC" (descending)
- limit (optional): Results per page (default: 50, max: 500)
- offset (optional): Pagination offset (default: 0)

**Available Sort Fields:**
- **amount**: Normalized amount based on filter.normalization (primary metric)
- **total_amount**: Raw total in RON (always available)
- **per_capita_amount**: Amount per capita in RON (always available)
- **entity_name**: Alphabetical by Romanian entity name
- **entity_type**: Alphabetical by entity type (Municipiu, Oraș, Comună, etc.)
- **population**: By population count
- **county_name**: Alphabetical by county (județ)
- **county_code**: Alphabetical by county code

**Output:**
- ok: boolean
- link: Short, shareable URL to interactive table with pagination
- entities: Array of entity data points
- pageInfo: Pagination metadata

**Tips:**
- Use normalization="per_capita" for fair size-adjusted comparisons
- Combine with discover_filters to build precise filter criteria
- Use with explore_budget_breakdown for drill-down after identifying interesting entities`;

export const ANALYZE_ENTITY_BUDGET_DESCRIPTION = `Analyze a single entity's budget with optional drill-down by functional or economic classifications.

**Purpose:**
- Get detailed breakdown of entity income and expenses
- Group by functional categories (what the money is spent on: education, health, transport, etc.)
- Drill down into specific functional or economic classification codes
- Progressive analysis: overview → category → specific code

**Language Note:** Entity names and classification names are in Romanian.

**Input Parameters:**
- entityCui (optional): Exact CUI (fiscal identifier) - preferred for precision
- entitySearch (optional): Romanian entity name for fuzzy search
- year (required): Reporting year (2016-${String(currentYear)})
- breakdown_by (optional): Analysis level - "overview" (default), "functional", or "economic"
- functionalCode (optional): Required when breakdown_by="functional" (e.g., "65", "65.10", "65.10.03")
- economicCode (optional): Required when breakdown_by="economic" (e.g., "10.", "10.01", "10.01.01")

**Breakdown Types:**
1. **overview** (default): High-level grouping by functional chapters
2. **functional**: Drill down by functional classification code
3. **economic**: Drill down by economic classification code

**Progressive Analysis Pattern:**
1. Start with get_entity_snapshot for totals
2. Call with breakdown_by="overview" to see main categories
3. Use discover_filters to find specific functional/economic codes
4. Drill down with breakdown_by="functional" or "economic" for details`;

export const EXPLORE_BUDGET_BREAKDOWN_DESCRIPTION = `Interactive hierarchical budget exploration with progressive drill-down by classification codes.

**Purpose:**
- Group budget data by classification hierarchies (functional or economic)
- Progressive drill-down: chapters → subchapters → classifications
- Treemap-style visualization of budget distribution
- Cross-dimensional pivoting (analyze by function, then pivot to economic view)
- Works across any scope: single entity, multiple entities, regions, UATs

**Language Note:** Classification names and categories are in Romanian.

**Input Parameters:**
- period (required): Time period selection
- filter (required): Analytics filter
- classification (optional): "fn" (functional, default) | "ec" (economic)
- path (optional): Drill-down path array (default: empty array = root level)
- rootDepth (optional): "chapter" (default) | "subchapter" | "paragraph"
- excludeEcCodes (optional): Economic chapter codes to exclude
- limit, offset (optional): Pagination parameters

**Progressive Drill-Down Pattern:**
1. Root level: { classification: "fn", path: [] }
2. Drill into education: { classification: "fn", path: ["65"] }
3. Drill deeper: { classification: "fn", path: ["65", "65.10"] }
4. Pivot to economic view: { classification: "ec", path: [], filter: {functionalPrefixes: ["65."]} }

**Tips:**
- Start with empty path for overview, progressively append to drill down
- Use classification="fn" to analyze WHAT (purpose), classification="ec" to analyze HOW (type)
- excludeEcCodes useful for removing transfers, technical operations`;
