# Email Template Registry Single Source of Truth

**Status**: Draft
**Date**: 2026-03-29
**Author**: Codex

## Problem

The email template module introduced a registry, but it still had multiple sources of truth and one silent failure mode:

- **Manual registry enrollment**: adding a template still required editing a central `ALL_REGISTRATIONS` array in `src/modules/email-templates/shell/registry/index.ts`.
- **Manual template union maintenance**: `EmailTemplateProps` and `EmailTemplateType` were still hand-maintained in `src/modules/email-templates/core/types.ts`.
- **Silent duplicate shadowing**: duplicate template ids were overwritten when building the internal map, so `getAll()` and `get()` could disagree.

These issues mattered because the intended design goal was stricter than "put registrations in a folder". The same template registration should define:

- the runtime template id
- the runtime payload schema
- the render functions
- the compile-time template id and props mapping

Without that alignment, the registry is not the real source of truth and adding a template remains a multi-file change.

## Context

The module already had the right separation of concerns:

- `core/` owns types, schemas, and ports.
- `shell/` owns React Email rendering and template registrations.

The renderer API was already in use by notification delivery code, so the fix had to preserve:

- `EmailRenderer.render(props)`
- `EmailRenderer.getTemplates()`
- `EmailRenderer.getTemplate(type)`

The module also already had placeholder `Type.Unsafe` schemas for `alert_series` and `newsletter_entity`, and those placeholders needed to remain in place.

## Decision

Use a TypeScript-first template map plus eager runtime discovery.

### 1. Compile-time source of truth

`src/modules/email-templates/core/types.ts` now exposes:

```ts
export interface EmailTemplateMap {}
export type EmailTemplateType = keyof EmailTemplateMap;
export type EmailTemplateProps = EmailTemplateMap[EmailTemplateType];
```

Each registration file augments `EmailTemplateMap`, so the registration module owns the id-to-props mapping for its template.

### 2. Runtime source of truth

`src/modules/email-templates/shell/registry/index.ts` now discovers registration modules from `shell/registry/registrations/` at module startup and imports their exported `registration` symbol once.

The discovered registrations are then:

- validated for shape
- indexed into an array and map
- sorted deterministically by template id
- checked for duplicate ids with a fail-fast error that includes both conflicting file paths

`makeTemplateRegistry()` remains synchronous because discovery happens eagerly during module initialization, not during render calls.

### 3. Typed registration helper

`defineTemplate(...)` in `shell/registry/types.ts` binds together:

- template id
- payload schema
- full props type
- `createElement`
- `getSubject`
- `exampleProps` — realistic sample data for previewing the template

This keeps the registration file self-contained from both the runtime and TypeScript perspectives.

### Preview with `exampleProps`

Each registration includes `exampleProps`: a complete, valid set of props that can be
passed directly to the renderer to produce a realistic HTML preview without needing
real user or database data.

**Usage via the renderer API:**

```typescript
const renderer = makeEmailRenderer();

// List all templates with their example props
const templates = renderer.getTemplates();

// Preview a specific template
const meta = renderer.getTemplate('welcome');
if (meta) {
  const result = await renderer.render(meta.exampleProps);
  // result.value.html contains the full preview HTML
}
```

`exampleProps` must pass the template's `payloadSchema` validation and contain
realistic (not placeholder) values so the preview reflects the actual email layout.

## Why This Is Not Lazy Loading

This implementation does use dynamic import, but it is **not** lazy loading in the request-path sense.

- Discovery happens once at module startup.
- All registration modules are loaded eagerly.
- The renderer reads from an in-memory registry after startup.
- No render call triggers filesystem scanning or per-template import.

The goal is startup-time discovery, not on-demand template loading.

## Alternatives Considered

### Static central manifest

Rejected because it preserves a second manual step when adding a template. That leaves the registry file as a second source of truth and does not fix the review finding about manual enrollment.

### Code-generated manifest

Rejected for now because it adds a generation workflow, another artifact to keep in sync, and more build complexity than the module currently needs. The module already runs in a shell layer where filesystem discovery is acceptable.

### Keep duplicate shadowing and rely on convention

Rejected because duplicate ids violate the registry contract and create non-obvious behavior. Duplicate ids are now treated as a startup error instead of being silently accepted.

## Consequences

### Positive

- Adding a new template requires one registration file.
- Template ids and prop unions are derived from registration-owned type augmentation instead of a hand-maintained union.
- Duplicate ids fail fast.
- The `EmailRenderer` public contract stays unchanged for consumers.

### Trade-offs

- The shell registry now performs filesystem discovery at startup.
- The root module transitively depends on shell-layer discovery because it re-exports shell registry helpers.
- Registration modules must export the well-known `registration` symbol and augment `EmailTemplateMap` correctly.

## Compatibility

The implementation preserves the existing caller contract:

- `EmailRenderer` interface remains unchanged.
- Existing consumers such as notification delivery code do not need call-site changes.
- `alert_series` and `newsletter_entity` still use `Type.Unsafe` payload placeholders until their schemas are modeled fully.

## References

- `src/modules/email-templates/core/types.ts`
- `src/modules/email-templates/core/ports.ts`
- `src/modules/email-templates/shell/registry/types.ts`
- `src/modules/email-templates/shell/registry/index.ts`
- `src/modules/email-templates/shell/renderer/index.ts`
