# Agent task: review the MCP and agentic-layer architecture

## Mission

Perform an evidence-first architectural review of the API's MCP and agentic layer. Determine whether the current design is a strong foundation for production, what should be kept, what should be changed while breaking changes are still affordable, and how MCP tools should be defined once and reused by the API's own agents and external MCP clients or MCP Apps.

The system has not been deployed to production yet. Backward compatibility is useful but is not a reason to preserve a weak architecture. Diagnose the current implementation before proposing or implementing changes.

## Project

Work in:

`/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server`

Read and follow the repository's `AGENTS.md`. Never read `.env` files or expose credentials. Preserve unrelated worktree changes.

## Goals

The review should answer these broad questions:

- Do we have one coherent MCP architecture or overlapping legacy and redesign implementations?
- Is there a reusable MCP core that can serve external MCP clients, MCP Apps, and the API's in-process agents without duplicating tool contracts or behavior?
- Can a domain module expose a capability as an MCP tool without rebuilding its validation, authorization, business logic, response mapping, and tests?
- For example, how should execution-line-items queries become safe, useful MCP tools while reusing the existing module rather than creating a parallel query implementation?
- What is the right tool-registration, discovery, feature-flag, authorization, and lifecycle strategy?
- Is the agentic layer sufficiently isolated, durable, observable, testable, and production-safe?
- Which changes should be made now, before deployment, and which can reasonably be deferred?

## Context to get started

Begin by tracing the actual implementation and repository history. Useful orientation points include:

- `src/modules/mcp/` — the older MCP module, schemas, use cases, repositories, server, REST/GPT surfaces, sessions, and rate limiting.
- `src/modules/shared/shell/mcp/` and `src/modules/shared/core/` — the newer shared-kernel MCP contracts, dispatcher, common outputs, filters, pagination, search, and contributor registry.
- `src/modules/agent/` — conversations, messages, model routing, quotas, REST streaming, prompts, and the adapter from shared MCP tools to AI SDK tools.
- `src/app/build-app.ts` and `src/app/build-redesign-app.ts` — feature flags, boot composition, module enablement, authentication boundaries, MCP endpoints, and agent wiring.
- Domain module entry points and their `shell/mcp/tools.ts` implementations, including budget, procurement, Parliament, PNRR, legal, companies, reference, and judicial modules.
- `src/modules/execution-line-items/`, its GraphQL surface, filter/query infrastructure, and any legacy MCP-specific execution repository.
- `docs/AGENT-MODULE-SPEC.md`, `docs/MCP-MODULE-SPEC.md`, `docs/MCP-PROMPTS.md`, and related architecture notes. Treat documents as design intent and verify them against code.

These are starting points, not a prescribed answer. Follow the real composition, request, authorization, and execution paths wherever they lead.

Consult current official documentation for MCP, MCP Apps, the MCP SDK used by the repository, and the AI SDK/tool interfaces in use. Distinguish protocol requirements from framework conveniences and from application-owned responsibilities.

## Investigation

Map the current architecture end to end:

- how tools are declared, named, described, validated, registered, enabled, and executed;
- which code paths serve legacy MCP, redesign MCP, GPT/REST consumers, and the in-process agent;
- where the same capability is implemented more than once or can drift;
- how request identity, tenant/user context, permissions, privacy rules, rate limits, quotas, audit data, cancellations, timeouts, and errors reach a tool handler;
- whether tool outputs are structured consistently and remain useful to models without leaking internal or sensitive data;
- how module enablement and feature flags affect tool visibility and endpoint availability;
- how sessions, transports, streaming, reconnects, idempotency, and graceful shutdown behave;
- how tools are tested, evaluated, observed, versioned, and deprecated;
- whether the current abstraction supports MCP Apps and multiple agent experiences, not just one chat endpoint.

Use execution line items as a concrete onboarding exercise. Trace what would be required today to expose useful read-only tools for discovery, filtered queries, and details. Identify unnecessary duplication or coupling, then use the exercise to test each proposed architecture.

Review security as part of the design, not as a final checklist. Pay particular attention to public versus authenticated tools, user-scoped data, tool-level authorization, confused-deputy risks, prompt/tool injection boundaries, denial-of-service through broad analytics queries, schema/output allowlists, and whether feature flags fail closed.

Where useful, run safe local tests or minimal non-mutating probes to confirm wiring and behavior. Do not deploy, enable production surfaces, mutate databases, or expose new endpoints during the review.

## Design work

After diagnosing the current state, propose a target architecture and credible alternatives. The proposal should determine from evidence:

- what belongs in an MCP core and what remains inside domain modules;
- whether there should be one canonical tool definition consumed by MCP servers and in-process agents;
- how tools call existing domain use cases instead of accessing GraphQL endpoints or duplicating repository logic;
- what context every tool receives for authorization, tenancy, tracing, budgets, cancellation, locale, and client capabilities;
- how module-owned tools are contributed to a registry and exposed selectively by surface, agent, role, environment, and feature flag;
- whether tools need stability levels or lifecycle states such as experimental, internal, public, deprecated, or disabled;
- how tool schemas, structured outputs, errors, deep links, resources, prompts, and MCP App UI metadata are represented;
- how expensive tools declare and enforce bounds, timeouts, pagination, result limits, and approval requirements;
- how the architecture supports multiple MCP-powered agents or apps with different allowed tool subsets while reusing the same core definitions;
- how legacy MCP and redesign MCP should be consolidated, migrated, or removed.

Do not assume that every GraphQL query should become a tool. Define a strategy for choosing tool granularity and model-friendly contracts. Explain when to reuse a domain use case, introduce an agent-oriented orchestration use case, expose a resource instead of a tool, or intentionally expose nothing.

## Interactive decisions

Do not silently choose architecture-critical behavior. When the diagnosis exposes an important choice, use the question tool to present a small number of concrete options, recommend one, and explain the trade-offs in plain language. Group related choices so the review remains efficient.

Likely decision areas include the canonical registry boundary, legacy migration strategy, public versus authenticated MCP surfaces, per-agent tool allowlists, tool versioning, feature-flag granularity, durable run/session scope, write-tool policy, and MCP App support. Ask only about choices that materially emerge from the evidence.

If the question tool is unavailable or I do not answer a non-blocking question, record the options, recommendation, provisional assumption, and consequences in the design file. Do not present an unapproved assumption as a settled decision.

## Output

Write a human-readable Markdown design note in the API repository, preferably:

`docs/architecture/MCP-AGENTIC-LAYER-ARCHITECTURE-REVIEW.md`

Let the evidence determine the document structure. It should make it easy to review:

- the current architecture and overlapping surfaces;
- strengths worth preserving and concrete problems to fix;
- gaps between the current scaffold and a production-ready agent platform;
- the execution-line-items onboarding exercise;
- target architecture options and their trade-offs;
- the recommended MCP core, tool contribution, reuse, authorization, feature-flag, and lifecycle strategy;
- decisions made through the question tool and unresolved choices;
- a practical migration and implementation sequence, including what can be deleted before production;
- validation, security, observability, and evaluation expectations.

Do not implement the redesign unless I explicitly approve the design and ask for implementation. The task is complete when we have a code-backed review and a decision-ready architecture that makes adding and reusing safe MCP tools predictable across modules, agents, and MCP Apps.
