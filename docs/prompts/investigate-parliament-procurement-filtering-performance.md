# Agent task: investigate Parliament and public-contracts filtering

## Mission

Investigate the latest Parliament and public-contracts/procurement integrations across the Client, API, and Scraper projects. Determine where current queries or data projections have performance problems, then propose a reusable filtering interface and implementation approach that can provide an experience as powerful and coherent as the execution-line-items filters.

This is a diagnosis and design task. Do not begin implementation before understanding the current behavior, data grains, query plans, and product choices.

## Projects

- Client: `/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client`
- API: `/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server`
- Scraper/data pipeline: `/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-scrapper`

Read and follow each repository's `AGENTS.md`. Never read `.env` files or expose credentials. Preserve existing worktree changes.

## Context to get started

The recent work added substantial Parliament and procurement GraphQL/client functionality. The filters are currently spread across client URL state and UI components, GraphQL inputs, API repositories, search fallbacks, production tables, and aggregate projections. Some large surfaces already have protective bounds or special handling, but the investigation must establish which problems are real and important before selecting a solution.

Begin by tracing the latest Parliament and procurement integrations through all three repositories. Useful areas include:

- Client features under `src/features/parliament/` and `src/features/procurement/`.
- The reusable execution-line-items filter experience under `src/components/filters/`, `src/schemas/charts.ts`, and `src/lib/filterUtils.ts` in the Client.
- The API modules under `src/modules/parliament/`, `src/modules/procurement/`, `src/modules/execution-line-items/`, and the shared filter/pagination infrastructure under `src/modules/shared/` and `src/infra/database/query-filters/`.
- Procurement production projections and loaders in the Scraper's public-contracts migrations and `src/sources/public-contracts/`.
- Parliament production schemas, migrations, loaders, and search projections in the Scraper.

These locations are orientation points, not a prescribed investigation checklist. Follow the real request path and repository history wherever the evidence leads.

## Investigation

First establish how the current functionality works end to end:

- Which user actions produce which Client and GraphQL queries?
- Which API code builds the database or search query?
- Which tables, materialized views, search indexes, and database indexes serve it?
- What is the intended answer grain, and where can joins or aggregation change that grain?
- Which filters, counts, sorts, pagination choices, payloads, or repeated requests are expensive?
- Which limitations are deliberate safety bounds, and which are accidental design constraints?

Inspect representative database behavior rather than diagnosing performance from code alone. If safe read-only database access is available, run bounded catalog queries and representative `EXPLAIN (ANALYZE, BUFFERS)` probes under an appropriate statement timeout. Measure relevant table/index sizes, cardinalities, selectivity, query duration, and materialized-view refresh behavior where possible. Do not mutate data, refresh views, create indexes, deploy, or run unbounded experiments. If access is unavailable, document the exact probes that remain to be run.

Keep semantic correctness separate from speed. Pay attention to Parliament and procurement data grains, canonical versus duplicate records, occurrence identity, unresolved links, cross-grain aggregation, data-quality gates, and projection freshness.

## Design process

After the diagnosis, propose the filter interface and the logic behind it. Consider the existing execution-line-items UX and the API's shared filter infrastructure as references, but decide from evidence whether they should be extended, adapted, or partially replaced.

The proposal should explain, at an appropriate level:

- the filter concepts users need and how they compose;
- how Client state, URLs, GraphQL, API validation, query planning, and data projections relate;
- which behavior can be reusable across datasets and which must remain source-specific;
- how lists, details, aggregates, facets, search, pagination, totals, caching, and freshness should behave;
- what database indexes, read models, materialized views, or search capabilities may be needed;
- how broad or unsafe filter combinations are handled;
- how the design can be introduced incrementally without breaking current links and queries.

Develop credible options rather than forcing an early answer. Explain the important trade-offs in product capability, correctness, latency, freshness, operational complexity, and migration cost.

## Interactive decisions

Do not silently choose architecture-critical product or technical behavior.

When the diagnosis reveals a meaningful design choice, use the question tool to ask me which direction to take. Present a small number of concrete options, recommend one, and explain the consequences and trade-offs in plain language. Group related decisions so the process remains efficient.

Examples may include the filter composition model, expected total-count behavior, cursor versus numbered-page UX, database versus search-engine responsibilities, freshness expectations, aggregate semantics, and how much cross-dataset consistency is worth additional complexity. These are examples only; ask about the choices that actually emerge from the investigation.

If the question tool is unavailable or I do not answer a non-blocking question, record the options, recommendation, assumptions, and unresolved decision in the design file. Continue only where a provisional assumption is safe, and clearly mark it for review rather than presenting it as approved.

## Output

Write a human-readable Markdown design note in the API repository, preferably:

`docs/architecture/PARLIAMENT-PROCUREMENT-FILTERING-DESIGN.md`

Let the evidence determine its structure. It should be useful for reviewing:

- what you found in the three projects and the database;
- confirmed performance problems versus hypotheses or missing measurements;
- the proposed filter interface and query/data logic;
- viable solution options and their trade-offs;
- the recommended direction and why;
- decisions I made through the question tool;
- unresolved questions, risks, and a practical incremental path forward.

Do not implement the solution unless I explicitly approve a design and ask for implementation. The work is complete when we have an evidence-backed diagnosis and a design we can review and make decisions from, not when every possible detail has been specified in advance.
