/**
 * Shared Kernel — GraphQL schema merge + conflict gate (foundation §14.8).
 *
 * Modules contribute `typeDefs` (SDL) that EXTEND the root `Query`/`Entity`.
 * Before stitching we run a conflict gate:
 *  - no module may re-declare a kernel base type (Entity, Organization,
 *    Territory, MoneyFlow, Document, PageInfo + the scalars) — the §14.8
 *    EXEMPTION makes these reusable but not redeclarable;
 *  - no two modules may define the same object/enum/input type name;
 *  - no two modules may add the same field to a shared `extend type` (Query/Entity).
 * A colliding module fails here (build/CI), not at boot.
 */

import { Kind, parse, type DefinitionNode, type DocumentNode } from 'graphql';

/** Kernel base types reused un-prefixed; modules must not re-declare them. */
export const KERNEL_BASE_TYPES = new Set([
  'CUI',
  'SIRUTA',
  'BigInt',
  'Money',
  'Date',
  'DateTime',
  'JSON',
  'Entity',
  'Organization',
  'OrgIdentifier',
  'Territory',
  'MoneyFlow',
  'FlowTypeBreakdown',
  'FlowSummary',
  'Document',
  'SearchHit',
  'OrgNameMatch',
  'SourcePresence',
  'PageInfo',
  'GlobalSearchResult',
  'ServiceStatus',
  'HealthReport',
  'Query',
]);

/** A named module SDL slice. */
export interface GraphqlSlice {
  readonly source: string;
  readonly typeDefs: string;
}

export interface MergeResult {
  readonly typeDefs: string;
}

const isTypeDefinition = (def: DefinitionNode): boolean =>
  def.kind === Kind.OBJECT_TYPE_DEFINITION ||
  def.kind === Kind.ENUM_TYPE_DEFINITION ||
  def.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION ||
  def.kind === Kind.INTERFACE_TYPE_DEFINITION ||
  def.kind === Kind.UNION_TYPE_DEFINITION ||
  def.kind === Kind.SCALAR_TYPE_DEFINITION;

const isTypeExtension = (def: DefinitionNode): boolean =>
  def.kind === Kind.OBJECT_TYPE_EXTENSION ||
  def.kind === Kind.ENUM_TYPE_EXTENSION ||
  def.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION ||
  def.kind === Kind.INTERFACE_TYPE_EXTENSION ||
  def.kind === Kind.UNION_TYPE_EXTENSION ||
  def.kind === Kind.SCALAR_TYPE_EXTENSION;

const namedDefName = (def: DefinitionNode): string | undefined =>
  'name' in def && def.name !== undefined ? def.name.value : undefined;

const fieldsOf = (def: DefinitionNode): string[] => {
  if (
    (def.kind === Kind.OBJECT_TYPE_EXTENSION || def.kind === Kind.OBJECT_TYPE_DEFINITION) &&
    def.fields !== undefined
  ) {
    return def.fields.map((f) => f.name.value);
  }
  return [];
};

/**
 * Validate module slices against the conflict gate. Throws a descriptive Error
 * on the first collision. Returns the merged SDL when clean.
 */
export const mergeGraphqlSlices = (base: string, slices: readonly GraphqlSlice[]): MergeResult => {
  const definedTypes = new Map<string, string>(); // typeName -> source
  const fieldOwners = new Map<string, string>(); // `Type.field` -> source

  for (const baseType of KERNEL_BASE_TYPES) definedTypes.set(baseType, 'kernel');

  // Seed the kernel's own fields (on Query, Entity, and every base object type)
  // so a module that does `extend type Entity { cui: ... }` or
  // `extend type Query { health: ... }` collides HERE with a clear message,
  // not later inside makeExecutableSchema (§14.8, R-codex/GLM B5).
  try {
    for (const def of parse(base).definitions) {
      if (def.kind === Kind.OBJECT_TYPE_DEFINITION) {
        const typeName = def.name.value;
        for (const field of fieldsOf(def)) fieldOwners.set(`${typeName}.${field}`, 'kernel');
      }
    }
  } catch (error) {
    throw new Error(
      `kernel base SDL is not valid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  for (const slice of slices) {
    let doc: DocumentNode;
    try {
      doc = parse(slice.typeDefs);
    } catch (error) {
      throw new Error(
        `graphql slice '${slice.source}' is not valid SDL: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }

    for (const def of doc.definitions) {
      if (isTypeDefinition(def)) {
        const name = namedDefName(def);
        if (name === undefined) continue;
        if (KERNEL_BASE_TYPES.has(name)) {
          throw new Error(
            `graphql conflict: module '${slice.source}' re-declares kernel base type '${name}' (use 'extend type ${name}')`
          );
        }
        const existing = definedTypes.get(name);
        if (existing !== undefined) {
          throw new Error(
            `graphql conflict: type '${name}' defined by both '${existing}' and '${slice.source}'`
          );
        }
        definedTypes.set(name, slice.source);
      }

      if (isTypeExtension(def)) {
        const typeName = namedDefName(def);
        if (typeName === undefined) continue;
        for (const field of fieldsOf(def)) {
          const key = `${typeName}.${field}`;
          const owner = fieldOwners.get(key);
          if (owner !== undefined) {
            throw new Error(
              `graphql conflict: field '${key}' added by both '${owner}' and '${slice.source}'`
            );
          }
          fieldOwners.set(key, slice.source);
        }
      }
    }
  }

  return { typeDefs: [base, ...slices.map((s) => s.typeDefs)].join('\n\n') };
};
