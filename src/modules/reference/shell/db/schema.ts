/**
 * Reference module — NO schema augmentation (deliberate).
 *
 * Unlike a source module that introduces a new schema (e.g. pnrr augments
 * `ProdDatabase` with `pnrr.*`), the reference module reads ONLY `core.*` tables
 * that the KERNEL already declares in `shared/shell/db/types.ts`
 * (`core.public_entities`, `core.territories`, `core.classification_codes`,
 * `core.organizations`, `core.organization_identifiers`). Re-declaring them here
 * would be a duplicate-declaration clash. So the module's repos use the kernel's
 * typed `Kysely<ProdDatabase>` instance directly — this file intentionally exports
 * nothing and adds no `declare module` block.
 *
 * Kept as a placeholder so the module's `shell/db/` layout mirrors the pnrr
 * template and future reference-only tables (e.g. a `core.public_entity_contacts`
 * projection, §1/§13 Q1) have an obvious home.
 */

export {};
