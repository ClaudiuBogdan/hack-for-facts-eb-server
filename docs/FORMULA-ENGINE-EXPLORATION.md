# Formula Engine Exploration

**Status:** Research
**Last Updated:** 2025-12-09

---

## 1. The Vision

Enable powerful, Excel-like data transformations for budget analytics. Users should be able to express complex computations like:

```
if(own_revenue < personnel_expense, "Not Viable",
   if(own_revenue < personnel + goods, "Partially Viable", "Fully Viable"))
```

Or even:

```
growth_rate(fiscal_autonomy, 2020, 2024) * 100
```

---

## 2. How Notion Formulas Work

Notion's formula system is a good reference because it's modern, well-designed, and operates on database rows — similar to our entity-based data.

### 2.1 Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Formula String                          │
│        if(prop("Status") == "Done", "✅", "⏳")              │
└─────────────────────────┬───────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                        LEXER                                │
│   Tokenizes into: IF, LPAREN, PROP, LPAREN, STRING, ...    │
└─────────────────────────┬───────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                        PARSER                               │
│   Builds Abstract Syntax Tree (AST)                         │
│                                                             │
│   IfExpr {                                                  │
│     condition: BinaryExpr { op: "==", left: ..., right: }   │
│     then: StringLiteral("✅")                               │
│     else: StringLiteral("⏳")                               │
│   }                                                         │
└─────────────────────────┬───────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                    TYPE CHECKER                             │
│   Validates: condition is boolean, branches are same type   │
└─────────────────────────┬───────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                      EVALUATOR                              │
│   Walks AST with row context, returns computed value        │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Property References

The key insight: `prop("FieldName")` creates a **lazy reference** to a column value. The evaluator resolves it against the current row context.

```typescript
// Conceptual model
interface EvaluationContext {
  row: Record<string, unknown>; // Current entity/row data
  resolve(propertyName: string): Value;
}

// prop("income") becomes:
class PropReference {
  constructor(private name: string) {}
  evaluate(ctx: EvaluationContext): Value {
    return ctx.resolve(this.name);
  }
}
```

### 2.3 Type System

Notion has these types:

| Type      | Examples     | Operations              |
| --------- | ------------ | ----------------------- |
| `number`  | 42, 3.14     | Arithmetic, comparison  |
| `string`  | "hello"      | Concat, contains, slice |
| `boolean` | true, false  | Logical ops             |
| `date`    | 2024-01-15   | Date math, formatting   |
| `list`    | [1, 2, 3]    | Map, filter, reduce     |
| `null`    | empty values | Coalesce                |

Functions are **strongly typed** — `abs("hello")` is a type error at parse time.

### 2.4 Function Categories

**Math:** `abs`, `ceil`, `floor`, `round`, `min`, `max`, `sqrt`, `pow`, `log`, `exp`, `sign`

**String:** `concat`, `contains`, `replace`, `lower`, `upper`, `length`, `slice`, `split`, `join`, `test` (regex)

**Date:** `now`, `dateAdd`, `dateSubtract`, `dateBetween`, `formatDate`, `year`, `month`, `day`

**Logical:** `if`, `ifs`, `switch`, `and`, `or`, `not`, `empty`

**List:** `map`, `filter`, `find`, `some`, `every`, `sort`, `unique`, `sum`, `average`, `min`, `max`, `count`

### 2.5 Aggregation Across Rows

Notion's **Rollups** aggregate values from related records:

```
rollup(prop("Tasks"), "Status", "percent_checked")
```

This is similar to what we need for:

- National averages
- County aggregates
- Percentile calculations

---

## 3. How Excel Differs

Excel is more powerful but also more complex:

### 3.1 Cell References vs. Property References

| Notion            | Excel                           |
| ----------------- | ------------------------------- |
| `prop("Revenue")` | `B2` or `Revenue` (named range) |
| Row context       | Cell context                    |
| Database model    | Spreadsheet grid                |

### 3.2 Array Formulas

Excel can operate on ranges:

```excel
=SUM(A1:A10 * B1:B10)   // Element-wise multiply, then sum
=FILTER(A:C, B:B > 100)  // Filter rows where B > 100
```

This maps to our need for:

- Operating on time series (multiply each year's value)
- Filtering entities by computed conditions

### 3.3 Lambda Functions (Modern Excel)

```excel
=LAMBDA(x, y, x + y)(5, 3)  // Returns 8
=LET(total, SUM(A:A), avg, total/COUNT(A:A), avg)
```

`LET` is particularly useful — it allows naming intermediate calculations.

---

## 4. Applying to Transparenta

### 4.1 Current State

We have a simple JSON-based expression tree:

```json
{ "op": "subtract", "args": ["income", "expense"] }
```

**Limitations:**

- No functions beyond basic arithmetic
- No conditionals (we have `if` but it's awkward)
- No aggregations (avg, percentile)
- No time-aware operations (growth rate, YoY)
- No type checking

### 4.2 Design Goals

1. **Expressive:** Support complex business logic
2. **Type-safe:** Catch errors at definition time, not runtime
3. **Performant:** Handle 13K entities efficiently
4. **Dual execution:** Evaluate in JS or compile to SQL
5. **Aligned with client:** Compatible with chart formula system

### 4.3 Proposed Formula Language

Two options for syntax:

**Option A: String DSL (Human-Friendly)**

```
percent(own_revenue, total_income)
if(fiscal_autonomy < 20, "Critical", "OK")
growth(personnel_expense, "2020", "2024")
```

**Option B: JSON AST (Machine-Friendly)**

```json
{ "fn": "percent", "args": [{ "ref": "own_revenue" }, { "ref": "total_income" }] }
```

**Recommendation:** Support both. String DSL for admin UI input, JSON AST for storage and evaluation. Parser converts string → AST.

---

## 5. Technical Design

### 5.1 Abstract Syntax Tree (AST)

```typescript
type Expression =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | SeriesReference // Reference to a base series
  | PropertyReference // Reference to entity property
  | BinaryOperation // a + b, a > b, a and b
  | UnaryOperation // not a, -a
  | FunctionCall // fn(arg1, arg2, ...)
  | ConditionalExpr // if(cond, then, else)
  | LetExpr; // let x = expr1 in expr2

interface NumberLiteral {
  kind: 'number';
  value: number;
}

interface SeriesReference {
  kind: 'series_ref';
  seriesId: string; // References computed series value
}

interface PropertyReference {
  kind: 'prop_ref';
  property: string; // Entity property: "population", "county_code"
}

interface FunctionCall {
  kind: 'function';
  name: string;
  args: Expression[];
}

interface ConditionalExpr {
  kind: 'if';
  condition: Expression;
  thenBranch: Expression;
  elseBranch: Expression;
}

interface LetExpr {
  kind: 'let';
  bindings: Array<{ name: string; value: Expression }>;
  body: Expression;
}
```

### 5.2 Type System

```typescript
type FormulaType =
  | { kind: 'number'; unit?: Unit }
  | { kind: 'string' }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'list'; element: FormulaType }
  | { kind: 'series'; unit: Unit }; // Time series

type Unit = 'RON' | 'EUR' | 'people' | 'RON/capita' | '%' | 'index' | 'dimensionless';

// Type inference rules
function inferType(expr: Expression, ctx: TypeContext): FormulaType {
  switch (expr.kind) {
    case 'number':
      return { kind: 'number', unit: 'dimensionless' };

    case 'series_ref':
      return ctx.getSeriesType(expr.seriesId);

    case 'function':
      return inferFunctionReturnType(expr.name, expr.args, ctx);

    // ... etc
  }
}
```

### 5.3 Evaluation Contexts

Three levels of context during evaluation:

```typescript
interface EvaluationContext {
  // Level 1: Global (same for all entities)
  global: {
    currentYear: number;
    allEntities: EntitySummary[]; // For aggregates
    nationalAverages: Map<string, number>;
  };

  // Level 2: Series (same for all entities in a series computation)
  series: {
    seriesId: string;
    baseSeries: Map<string, SeriesData>; // Resolved base series
  };

  // Level 3: Entity (changes per entity)
  entity: {
    cui: string;
    name: string;
    county_code: string;
    population: number | null;
    values: Map<string, number>; // This entity's computed values
  };
}
```

### 5.4 Function Registry

```typescript
interface FunctionDefinition {
  name: string;
  signatures: FunctionSignature[]; // Overloads
  evaluate: (args: Value[], ctx: EvaluationContext) => Value;
  compileToSql?: (args: SqlExpr[], ctx: SqlContext) => SqlExpr;
}

interface FunctionSignature {
  params: ParamType[];
  returnType: FormulaType;
}

// Example: percent function
const percentFn: FunctionDefinition = {
  name: 'percent',
  signatures: [{ params: ['number', 'number'], returnType: { kind: 'number', unit: '%' } }],
  evaluate: ([numerator, denominator], ctx) => {
    if (denominator === 0) return null; // Handle division by zero
    return (numerator / denominator) * 100;
  },
  compileToSql: ([num, denom], ctx) => sql`(${num} / NULLIF(${denom}, 0)) * 100`,
};
```

---

## 6. Function Catalog

### 6.1 Arithmetic

| Function         | Signature        | Description            |
| ---------------- | ---------------- | ---------------------- |
| `add(a, b)`      | (num, num) → num | Addition               |
| `subtract(a, b)` | (num, num) → num | Subtraction            |
| `multiply(a, b)` | (num, num) → num | Multiplication         |
| `divide(a, b)`   | (num, num) → num | Division (null if b=0) |
| `mod(a, b)`      | (num, num) → num | Modulo                 |
| `power(a, b)`    | (num, num) → num | Exponentiation         |
| `negate(a)`      | (num) → num      | Negation               |

### 6.2 Math

| Function              | Signature         | Description         |
| --------------------- | ----------------- | ------------------- |
| `abs(x)`              | (num) → num       | Absolute value      |
| `round(x, decimals?)` | (num, num?) → num | Round to N decimals |
| `floor(x)`            | (num) → num       | Round down          |
| `ceil(x)`             | (num) → num       | Round up            |
| `min(a, b, ...)`      | (...num) → num    | Minimum value       |
| `max(a, b, ...)`      | (...num) → num    | Maximum value       |
| `sqrt(x)`             | (num) → num       | Square root         |
| `log(x)`              | (num) → num       | Natural logarithm   |

### 6.3 Comparison

| Function    | Signature         | Description           |
| ----------- | ----------------- | --------------------- |
| `eq(a, b)`  | (any, any) → bool | Equal                 |
| `neq(a, b)` | (any, any) → bool | Not equal             |
| `lt(a, b)`  | (num, num) → bool | Less than             |
| `lte(a, b)` | (num, num) → bool | Less than or equal    |
| `gt(a, b)`  | (num, num) → bool | Greater than          |
| `gte(a, b)` | (num, num) → bool | Greater than or equal |

### 6.4 Logical

| Function               | Signature        | Description    |
| ---------------------- | ---------------- | -------------- |
| `if(cond, then, else)` | (bool, T, T) → T | Conditional    |
| `and(a, b, ...)`       | (...bool) → bool | Logical AND    |
| `or(a, b, ...)`        | (...bool) → bool | Logical OR     |
| `not(a)`               | (bool) → bool    | Logical NOT    |
| `coalesce(a, b, ...)`  | (...T) → T       | First non-null |
| `isNull(a)`            | (any) → bool     | Check if null  |

### 6.5 Aggregation (Cross-Entity)

| Function                | Signature             | Description             |
| ----------------------- | --------------------- | ----------------------- |
| `avg(scope, series)`    | (scope, series) → num | Average across entities |
| `sum(scope, series)`    | (scope, series) → num | Sum across entities     |
| `min(scope, series)`    | (scope, series) → num | Minimum across entities |
| `max(scope, series)`    | (scope, series) → num | Maximum across entities |
| `count(scope)`          | (scope) → num         | Count entities          |
| `percentile(series, p)` | (series, num) → num   | P-th percentile         |
| `rank(series)`          | (series) → num        | Entity's rank           |

**Scope:** `"national"`, `"county"`, `"entity_type"`, or filter expression

### 6.6 Time Series

| Function                  | Signature                | Description                 |
| ------------------------- | ------------------------ | --------------------------- |
| `valueAt(series, period)` | (series, str) → num      | Value at specific period    |
| `growth(series, p1, p2)`  | (series, str, str) → num | Growth rate between periods |
| `yoy(series, period)`     | (series, str) → num      | Year-over-year change       |
| `cumulative(series)`      | (series) → series        | Running total               |
| `lag(series, n)`          | (series, num) → series   | Shift by N periods          |
| `trend(series)`           | (series) → num           | Linear trend slope          |
| `movingAvg(series, n)`    | (series, num) → series   | N-period moving average     |

### 6.7 Budget-Specific

| Function                | Signature        | Description                       |
| ----------------------- | ---------------- | --------------------------------- |
| `percent(num, denom)`   | (num, num) → %   | Percentage (num/denom \* 100)     |
| `perCapita(amount)`     | (num) → num/cap  | Divide by entity population       |
| `deflate(amount, year)` | (num, str) → num | Adjust for inflation to base year |
| `toEuro(amount, year)`  | (num, str) → num | Convert RON to EUR                |

---

## 7. SQL Compilation

For performance, formulas can compile to SQL instead of evaluating in JavaScript.

### 7.1 Compilation Example

**Formula:**

```
percent(own_revenue, total_income)
```

**Compiled SQL:**

```sql
SELECT
  entity_cui,
  (own_revenue / NULLIF(total_income, 0)) * 100 AS result
FROM (
  SELECT
    entity_cui,
    SUM(CASE WHEN economic_prefix ~ '^(01|02|03|30)\.' THEN amount ELSE 0 END) AS own_revenue,
    SUM(amount) AS total_income
  FROM execution_line_items
  WHERE account_category = 'vn'
    AND year BETWEEN 2020 AND 2024
  GROUP BY entity_cui
) sub
```

### 7.2 SQL Compilation Strategy

```typescript
interface SqlCompiler {
  compile(expr: Expression, ctx: SqlContext): SqlFragment;
}

class DefaultSqlCompiler implements SqlCompiler {
  compile(expr: Expression, ctx: SqlContext): SqlFragment {
    switch (expr.kind) {
      case 'number':
        return sql`${expr.value}`;

      case 'series_ref':
        return sql`${ctx.getColumnRef(expr.seriesId)}`;

      case 'function':
        return this.compileFunction(expr, ctx);
    }
  }

  private compileFunction(expr: FunctionCall, ctx: SqlContext): SqlFragment {
    const fn = functionRegistry.get(expr.name);
    if (fn.compileToSql) {
      const compiledArgs = expr.args.map((a) => this.compile(a, ctx));
      return fn.compileToSql(compiledArgs, ctx);
    }
    throw new Error(`Function ${expr.name} cannot be compiled to SQL`);
  }
}
```

### 7.3 Hybrid Execution

Some functions can run in SQL, others require JS:

| Function                | SQL | JS  | Notes                       |
| ----------------------- | --- | --- | --------------------------- |
| `add`, `subtract`, etc. | ✅  | ✅  | Basic arithmetic            |
| `if`, `coalesce`        | ✅  | ✅  | CASE WHEN in SQL            |
| `percent`               | ✅  | ✅  | Division with null handling |
| `percentile`            | ✅  | ✅  | PERCENTILE_CONT in SQL      |
| `trend`                 | ❌  | ✅  | Linear regression in JS     |
| `movingAvg`             | ⚠️  | ✅  | Window functions, complex   |

**Strategy:** Compile as much as possible to SQL, fall back to JS for unsupported functions.

---

## 8. Implementation Phases

### Phase 1: Enhanced Expression Engine

- Extend current JSON AST with more operations
- Add math functions (`abs`, `round`, `min`, `max`)
- Add conditional functions (`if`, `coalesce`)
- Type checking for unit compatibility
- **No parser** — continue with JSON AST

### Phase 2: Aggregation Functions

- Implement `avg`, `sum`, `count` across entities
- Add scope parameter (`national`, `county`)
- Pre-compute aggregates during batch processing
- Enable comparative metrics ("vs county average")

### Phase 3: Time Series Functions

- Add `valueAt`, `growth`, `yoy`
- Support period-specific computations
- Enable trend analysis

### Phase 4: String DSL Parser

- Implement lexer and parser
- Convert string formulas to JSON AST
- Enable human-readable formula input
- Add syntax highlighting in admin UI

### Phase 5: SQL Compilation

- Implement SQL compiler for common functions
- Hybrid execution (SQL where possible, JS fallback)
- Performance optimization for large computations

---

## 9. Example Formulas

### Basic Metrics

```
// Fiscal autonomy percentage
percent(own_revenue, total_income)

// Budget deficit
subtract(total_income, total_expense)

// Personnel burden
percent(personnel_expense, total_expense)
```

### Conditional Classification

```
// Viability category
if(gte(own_revenue, add(personnel, goods_services)),
   "Fully Viable",
   if(gte(own_revenue, personnel),
      "Partially Viable",
      "Not Viable"))
```

### Comparative Analysis

```
// Difference from county average
subtract(fiscal_autonomy, avg("county", fiscal_autonomy))

// Percentile rank
percentile(fiscal_autonomy)

// Above/below median
if(gte(fiscal_autonomy, percentile(fiscal_autonomy, 50)),
   "Above Median",
   "Below Median")
```

### Time-Based Analysis

```
// Growth rate 2020-2024
growth(fiscal_autonomy, "2020", "2024")

// Year-over-year change
yoy(personnel_expense, "2024")

// Is improving?
gt(growth(fiscal_autonomy, "2020", "2024"), 0)
```

### Complex Business Logic

```
// Risk score (0-100)
let(
  autonomy_score = multiply(fiscal_autonomy, 0.4),
  coverage_score = if(gte(own_revenue, personnel), 30, 0),
  trend_score = if(gt(growth(fiscal_autonomy, "2020", "2024"), 0), 30, 0),

  add(autonomy_score, coverage_score, trend_score)
)
```

---

## 10. Open Questions

1. **Parser complexity:** Is a string DSL worth the implementation cost, or is JSON AST sufficient?

2. **SQL compilation scope:** Which functions must support SQL compilation for acceptable performance?

3. **Error handling:** How to surface formula errors to users? (Type errors, division by zero, null values)

4. **Versioning:** How to handle formula changes when stored results exist?

5. **Security:** If users can write formulas, how to prevent injection or DoS?

6. **Caching strategy:** Cache parsed AST? Compiled SQL? Intermediate results?

---

## 11. References

- [Notion Formula Documentation](https://www.notion.so/help/formulas)
- [Excel LAMBDA Function](https://support.microsoft.com/en-us/office/lambda-function)
- [Pratt Parsing for Expression Languages](https://matklad.github.io/2020/04/13/simple-but-powerful-pratt-parsing.html)
- [Type Inference Algorithms](https://en.wikipedia.org/wiki/Hindley%E2%80%93Milner_type_system)

---

## 12. Alternative Architectures (Re-evaluation)

In light of the complexity of building a custom language engine from scratch, the following alternative architectures were evaluated to reduce maintenance burden and leverage existing standards.

### 12.1 The "Standardized AST" Approach (JsonLogic + MathJS)

Instead of a custom JSON AST, we can use **JsonLogic** as the storage format and **MathJS** (or similar) as the parser.

- **Core Idea:**
  1.  **Frontend:** User inputs string `if(revenue > 100, "High", "Low")`.
  2.  **Parser:** `mathjs.parse()` converts string → MathJS Node Tree.
  3.  **Transformer:** A lightweight adapter converts MathJS Tree → JsonLogic Object.
  4.  **Storage:** Save `{ "if": [{">": [{"var": "revenue"}, 100]}, "High", "Low"] }`.
  5.  **Execution:** Use standard `json-logic-js` libraries for JS execution.
  6.  **SQL Compilation:** Write a compiler that maps JsonLogic operators to Kysely expressions.

- **Pros:**
  - **No Parser Code:** Eliminates the need to write and maintain a lexer/parser.
  - **Standard Format:** JsonLogic is language-agnostic, portable, and secure (data, not code).
  - **Ecosystem:** Existing libraries for frontend (JS) and backend (Node/Python/etc).

- **Cons:**
  - Requires a mapping layer between MathJS AST and JsonLogic.

### 12.2 The "Excel-Native" Approach (HyperFormula)

Use **HyperFormula** (by Handsontable), a headless Excel calculation engine.

- **Core Idea:** Treat the backend data as a virtual spreadsheet.
- **Pros:**
  - **Complete Feature Set:** Supports 400+ Excel functions, array formulas, and dependency graphs out of the box.
  - **Reliability:** Battle-tested enterprise solution.
- **Cons:**
  - **Licensing:** **GPLv3**. Incompatible with this project's MIT license without commercial purchase.
  - **Performance:** All calculations must happen in-memory (Node.js). Cannot easily compile to SQL for database-level aggregation of 13k+ entities.

### 12.3 The "SQL-First" Approach (Wasm)

Abandon the requirement for dual execution (JS + SQL) by moving the JS execution environment closer to the database paradigm.

- **Core Idea:**
  - **Backend:** Map formula strings directly to SQL.
  - **Frontend/Preview:** Use **DuckDB Wasm** or **SQLite Wasm** in the browser. Load single entity data into in-memory DB and run the exact same SQL fragment.
- **Pros:**
  - **Single Truth:** Logic defined only in SQL. No drift between JS and SQL implementations.
  - **Performance:** SQL engines are optimized for vector operations.
- **Cons:**
  - **Complexity:** Setting up Wasm DBs in the client is non-trivial.
  - **UX Latency:** Loading Wasm/Data for quick previews is slower than pure JS functions.

---

## 13. Recommended Strategy

**Adoption of the "Standardized AST" (Option 12.1)**

We will pivot from a custom AST to **JsonLogic** as the canonical storage format.

### Why?

1.  **Reduced Scope:** We avoid writing a parser and type checker from scratch.
2.  **Security:** JsonLogic is safe by design (no `eval`).
3.  **Portability:** The logic is stored as JSON data, making it easy to migrate or consume by other services.
4.  **SQL Compatibility:** JsonLogic's constrained set of operators maps cleanly to SQL (e.g., `{ "if": ... }` -> `CASE WHEN ...`).

### Revised Roadmap

1.  **Define Schema:** Adopt JsonLogic as the schema for `Calculation` objects.
2.  **Implement Parser (Frontend):** Use `mathjs` to parse user input strings and transform to JsonLogic.
3.  **Implement Compiler (Backend):** Create `JsonLogicToKysely` compiler.
4.  **Implement Executor (Backend/Preview):** Use `json-logic-js` for immediate feedback loops where SQL is overkill.
