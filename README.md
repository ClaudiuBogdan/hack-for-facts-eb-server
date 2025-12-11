# Transparenta.eu Server

Backend service for analyzing and visualizing Romanian public budget data (working on more public data).

## Overview

Transparenta.eu Server provides a GraphQL API for querying public budget execution data across Romanian institutions. It enables real-time budget tracking, multi-dimensional analytics, and data normalization (inflation-adjusted, per-capita, currency conversion).

**Key Capabilities:**

- Budget execution tracking across 13,000+ public institutions
- Multi-dimensional filtering (by classification, geography, funding source)
- County and UAT-level heatmap analytics
- Normalization modes: total, per-capita, % of GDP, EUR conversion
- File-based macroeconomic datasets (GDP, inflation, population)

## Tech Stack

| Component      | Technology                     |
| :------------- | :----------------------------- |
| Runtime        | Node.js 20+, TypeScript (ESM)  |
| HTTP Framework | Fastify 5.x                    |
| API            | GraphQL (Mercurius)            |
| Database       | PostgreSQL 16+ (Kysely)        |
| Caching        | Redis / In-Memory (pluggable)  |
| Math           | decimal.js (no floats allowed) |
| Validation     | TypeBox                        |
| Error Handling | neverthrow (Result types)      |

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- pnpm >= 10.24.0
- PostgreSQL 16+
- Redis (optional, for caching)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/transparenta-eu-server.git
cd transparenta-eu-server

# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your database credentials
```

### Environment Variables

```bash
# Server
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=debug

# Database (required)
DATABASE_URL=postgresql://user:pass@localhost:5432/budget_db
USER_DATABASE_URL=postgresql://user:pass@localhost:5432/user_db

# Caching (optional)
REDIS_URL=redis://localhost:6379
CACHE_BACKEND=memory  # memory | redis | multi | disabled
```

### Run the Server

```bash
# Development (with hot reload)
pnpm dev

# Production build
pnpm build
pnpm start
```

The GraphQL endpoint is available at `http://localhost:3000/graphql`

## API

### GraphQL Endpoint

**URL:** `http://localhost:3000/graphql`

The API is GraphQL-first. Use the GraphQL Playground or introspection to explore the schema:

```graphql
query {
  __schema {
    types {
      name
    }
  }
}
```

**Main Query Categories:**

- `entities` / `entity` - Public institutions
- `executionAnalytics` - Budget execution time series
- `aggregatedLineItems` - Spending by classification
- `countyHeatmap` / `uatHeatmap` - Geographic analytics
- `datasets` - Macroeconomic indicators
- `budgetSectors` / `fundingSources` - Reference data
- `functionalClassifications` / `economicClassifications` - COFOG codes

### Health Endpoints

```bash
GET /health/live   # Liveness probe (always 200)
GET /health/ready  # Readiness probe (checks DB/cache)
```

## Development

### Commands

```bash
# Quality checks
pnpm typecheck        # TypeScript type checking
pnpm lint             # ESLint (zero warnings tolerance)
pnpm lint:fix         # Auto-fix linting issues
pnpm format           # Format with Prettier

# Testing
pnpm test             # Run all tests
pnpm test:unit        # Unit tests only
pnpm test:integration # Integration tests
pnpm test:e2e         # E2E tests (requires Docker)
pnpm test:coverage    # Coverage report (80% threshold)

# Data validation
pnpm validate-datasets  # Validate YAML dataset files

# CI pipeline
pnpm ci               # typecheck → lint → test → build
```

### Git Workflow

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
feat(datasets): add validation for annual budgets
fix(health): return correct status codes
chore(deps): update fastify to 5.6.2
```

Pre-commit hooks run ESLint, Prettier, and TypeScript checks automatically.

## Architecture

This codebase follows **Functional Core / Imperative Shell** (Hexagonal Architecture):

```
┌─────────────────────────────────────────────────────────────┐
│               IMPERATIVE SHELL (I/O Layer)                  │
│   GraphQL Resolvers │ REST Handlers │ Database Repositories │
└──────────────────────────┬──────────────────────────────────┘
                           │ Calls
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  FUNCTIONAL CORE (Pure)                     │
│        Use-cases │ Domain Types │ Business Rules            │
│           No I/O │ No side effects │ 100% testable          │
└─────────────────────────────────────────────────────────────┘
```

### Project Structure

```
src/
├── api.ts                    # Server entry point
├── app/
│   └── build-app.ts          # Composition root (wires dependencies)
├── common/                   # Shared types and utilities
├── infra/                    # Infrastructure (DB, config, logger)
└── modules/
    └── {feature}/            # Feature modules
        ├── core/             # Pure business logic
        │   ├── types.ts
        │   ├── ports.ts      # Dependency interfaces
        │   └── usecases/
        └── shell/            # I/O adapters
            ├── repo/         # Database queries
            └── graphql/      # Resolvers + schema
```

### Critical Rules

1. **No Floats** - All financial calculations use `decimal.js`
2. **Result Pattern** - Core returns `Result<T, E>`, no throwing
3. **Strict Booleans** - Must check `amount !== 0`, not `if (amount)`
4. **Layer Boundaries** - Core cannot import Shell or Infra

For detailed architecture documentation, see:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - Architecture specification
- [`docs/TECHNICAL-REFERENCE.md`](docs/TECHNICAL-REFERENCE.md) - Technical details

## Documentation

| Document                                                         | Description                           |
| :--------------------------------------------------------------- | :------------------------------------ |
| [`CLAUDE.md`](CLAUDE.md)                                         | AI development guide (full reference) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                   | Architectural principles and patterns |
| [`docs/CACHE.md`](docs/CACHE.md)                                 | Caching layer specification           |
| [`docs/DATASETS.md`](docs/DATASETS.md)                           | Dataset format and validation         |
| [`docs/NORMALIZATION-FACTORS.md`](docs/NORMALIZATION-FACTORS.md) | Data normalization logic              |

## Testing

The project uses a testing pyramid approach:

| Type        | Coverage | Description                         |
| :---------- | :------- | :---------------------------------- |
| Unit        | 70-80%   | Pure functions with in-memory fakes |
| Integration | 15-25%   | HTTP/GraphQL routes with fakes      |
| E2E         | 5-10%    | Full stack with Testcontainers      |

```bash
# Run tests
pnpm test              # Unit + Integration
pnpm test:e2e          # E2E (requires Docker)
pnpm test:watch        # Watch mode for TDD
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Make your changes following the architecture guidelines
4. Run the CI pipeline (`pnpm ci`)
5. Commit with conventional commit format
6. Open a Pull Request

## License

[MIT](LICENSE)
