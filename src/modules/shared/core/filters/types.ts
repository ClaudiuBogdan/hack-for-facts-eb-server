/**
 * Shared Kernel — Filter spec types (foundation §14.2, §15.6).
 *
 * A `CollectionFilterSpec` is declared ONCE per collection. From it the kernel
 * derives the three surfaces (so they never drift):
 *   - TypeBox schema   (REST validation)         via `toTypeBox`
 *   - GraphQL input SDL (GraphQL filter input)   via `toGraphQLInput`
 *   - condition builders (parameterized SQL)      via `toConditionBuilders`
 * plus a stable `canonicalizeFilters` key that backs the cache key, the cursor
 * `fhash`, and the tri-surface equivalence test.
 *
 * Per-source plans only DECLARE specs — they never invent a DSL.
 */

/** The set of operators a field may support. */
export type FilterOp =
  | 'eq'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'prefix'
  | 'contains'
  | 'isNull';

/**
 * `money` is a precision-safe decimal: validated/compiled as a STRING (never a
 * JS float), so value/amount-range filters over `numeric(18,2)` columns stay
 * exact. Surfaces it as the GraphQL `Money` scalar and compiles comparisons as
 * `column::numeric <op> $value::numeric`.
 */
export type FilterFieldType = 'string' | 'int' | 'number' | 'money' | 'date' | 'bool' | 'enum';

/**
 * A safe column reference. `alias` is the table alias used in the query (e.g.
 * `'f'` for `flows.money_flows f`); `column` is the physical column. Both are
 * trusted internal values validated by `safeColumnRef`. `arrayColumn` marks a
 * Postgres array/jsonb-array column so `in`/`contains` compile to membership
 * (`@>`/overlap), not a trigram substring (§15.6).
 */
export interface FilterColumn {
  readonly alias: string;
  readonly column: string;
  /** Cast applied to the column before comparison, e.g. `'::text'`. */
  readonly cast?: string;
  /**
   * Treat the column as a SQL array for membership ops (`in`/`contains` → §15.6).
   * Set `arrayKind` to pick the operator family:
   *  - `'text'`  (default when `arrayColumn` is true): native `text[]` → `&&`/`@>`.
   *  - `'jsonb'`: jsonb array → `?|` (overlap) / `@> to_jsonb(array[…])` (contains).
   */
  readonly arrayColumn?: boolean;
  readonly arrayKind?: 'text' | 'jsonb';
}

export interface FilterFieldSpec {
  /** REST query param name + GraphQL input field name. */
  readonly name: string;
  readonly type: FilterFieldType;
  /** Allowed operators for this field. */
  readonly ops: readonly FilterOp[];
  /** Driving column (partition/index-aware; declared by the source plan). */
  readonly column: FilterColumn;
  readonly enumValues?: readonly string[];
  /** Supports IN / GraphQL list inputs. */
  readonly array?: boolean;
  /** May appear under `exclude:` (negation). Else not negatable. */
  readonly exclude?: boolean;
  readonly default?: unknown;
  /** Human description surfaced in generated SDL / OpenAPI. */
  readonly description?: string;
  /**
   * A VIRTUAL field is surfaced on the REST/GraphQL/MCP filter inputs (and may
   * carry a default for documentation), but `toConditionBuilders` does NOT
   * compile it to SQL and does NOT apply its `default` on compose — the repo
   * intercepts it and translates it into partition keys, joins, or rollup
   * selection itself. This lets sources declare a unified filter surface while
   * the repo owns the physical predicate (budget/reference/companies pattern).
   * A non-virtual field with no real column would otherwise emit broken SQL.
   */
  readonly virtual?: boolean;
}

export interface CollectionFilterSpec {
  readonly collection: string;
  readonly fields: readonly FilterFieldSpec[];
  readonly sort: { readonly default: string; readonly allowed: readonly string[] };
}

/**
 * A validated filter input: per-field operator → value, plus an optional
 * `exclude` sub-object mirroring the same field shape.
 *
 * Field value shapes by op:
 *   eq:        scalar
 *   in:        scalar[]
 *   gt/gte/lt/lte: scalar
 *   between:   { from, to }
 *   prefix/contains: string (or string[] for array columns)
 *   isNull:    boolean (true = IS NULL, false = IS NOT NULL)
 */
export type FilterValue =
  | string
  | number
  | boolean
  | readonly (string | number)[]
  | { readonly from?: string | number; readonly to?: string | number };

export type FieldFilter = Readonly<Record<string, FilterValue>>;

export interface FilterInput {
  readonly [field: string]: FieldFilter | Readonly<Record<string, FieldFilter>> | undefined;
  readonly exclude?: Readonly<Record<string, FieldFilter>>;
}
