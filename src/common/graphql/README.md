# Common GraphQL Module

This module provides reusable GraphQL schema definitions shared across different modules in the application.

## Structure

- **directives.ts** - Common GraphQL directives (e.g., `@oneOf`)
- **enums.ts** - Shared enum types (e.g., `SortDirection`, `Currency`, `ReportType`)
- **scalars.ts** - Custom scalar types (e.g., `Date`, `DateTime`, `PeriodDate`)
- **types.ts** - Reusable types and inputs (e.g., `SortOrder`, `PageInfo`, filter inputs)
- **resolvers.ts** - Enum value resolvers for mapping internal values to GraphQL enums
- **schema.ts** - Combines all common schemas and resolvers
- **index.ts** - Public API for importing common GraphQL definitions

## Usage

### Import the complete common schema and resolvers

```typescript
import { CommonGraphQLSchema } from '@/common/graphql';
import { commonGraphQLResolvers } from '@/common/graphql/schema';

// In app.ts schema composition
const schema = [BaseSchema, CommonGraphQLSchema, healthSchema, ExecutionAnalyticsSchema];
const resolvers = mergeResolvers([commonGraphQLResolvers, healthResolvers, analyticsResolvers]);
```

### Import individual components

```typescript
import { CommonEnums, CommonTypes } from '@/common/graphql';

// Use in module-specific schema
export const MyModuleSchema = /* GraphQL */ `
  ${CommonEnums}

  extend type Query {
    myQuery(sort: SortOrder): [Result!]!
  }
`;
```

## Available Components

### Directives

- `@oneOf` - Ensures exactly one field is set on an input object

### Enums

- `SortDirection` - ASC | DESC
- `Currency` - RON | EUR | USD
- `ReportType` - PRINCIPAL_AGGREGATED | SECONDARY_AGGREGATED | DETAILED
  - Includes enum resolvers for mapping Romanian text to enum values

### Scalars

- `Date` - ISO 8601 date (YYYY-MM-DD)
- `DateTime` - ISO 8601 datetime with timezone
- `PeriodDate` - Year (YYYY), Year-Month (YYYY-MM), or Year-Quarter (YYYY-Q[1-4])
- `JSON` - Arbitrary JSON value

### Types & Inputs

#### Sorting

- `SortOrder` - Input for field sorting with direction

#### Pagination

- `PageInfo` - Relay-style cursor pagination info
- `PaginationInput` - Cursor-based pagination arguments

#### Filtering

- `DateRangeInput` - Filter by date range
- `NumericRangeInput` - Filter by numeric range
- `StringFilterInput` - Advanced string filtering (equals, contains, startsWith, etc.)

## Best Practices

1. **Use common types when possible** - Don't redefine `SortDirection`, `Currency`, or `ReportType` in module schemas
2. **Extend, don't duplicate** - If you need module-specific enums/types, define only those in your module
3. **Keep it generic** - Only add types to this module if they're truly reusable across multiple modules
4. **Document new additions** - Update this README when adding new common types
5. **Enum resolvers** - When adding enum resolvers, map internal values (database strings) to GraphQL enum values

## Enum Resolvers

The `ReportType` enum includes value resolvers that map internal Romanian text strings to GraphQL enum values:

```typescript
// If your resolver returns this Romanian text string:
return 'Executie bugetara agregata la nivel de ordonator principal';

// GraphQL will serialize it as:
// PRINCIPAL_AGGREGATED
```

This allows your database or internal code to use descriptive Romanian strings while the GraphQL API maintains stable, language-independent enum identifiers.

### Adding New Enum Resolvers

When adding a new enum that needs value mapping:

1. Define the enum in `enums.ts` with descriptive comments
2. Add the value mapping in `resolvers.ts` under `EnumResolvers`
3. Export the resolver from `schema.ts` via `commonGraphQLResolvers`

```typescript
// enums.ts
enum MyEnum {
  VALUE_ONE
  VALUE_TWO
}

// resolvers.ts
export const EnumResolvers = {
  MyEnum: {
    VALUE_ONE: 'internal_representation_one',
    VALUE_TWO: 'internal_representation_two',
  },
};
```

## Examples

### Using common sorting

```graphql
query GetTransactions($sort: SortOrder) {
  transactions(sort: $sort) {
    id
    amount
    date
  }
}
```

```json
{
  "sort": {
    "by": "date",
    "direction": "DESC"
  }
}
```

### Using common pagination

```graphql
query GetItems($pagination: PaginationInput) {
  items(pagination: $pagination) {
    edges {
      node {
        id
        name
      }
      cursor
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

### Using common filters

```graphql
query SearchEntities($name: StringFilterInput, $amountRange: NumericRangeInput) {
  entities(filters: { name: $name, amount: $amountRange }) {
    id
    name
    amount
  }
}
```

```json
{
  "name": {
    "contains": "Ministry"
  },
  "amountRange": {
    "min": 1000000,
    "max": 5000000
  }
}
```
