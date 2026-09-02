/**
 * Extract named SDL definitions (with their description strings, WITHOUT the
 * surrounding `#` comments) from a schema source string, byte-for-byte via the
 * parser's `loc` — the same extraction the identity test applies to both the
 * legacy source files and the kernel slice, so drift is impossible to miss.
 */

import { Kind, parse, type DefinitionNode } from 'graphql';

export interface ExtractedDefinition {
  /** `enum AxisDataType`, `input AnalyticsFilterInput`, `Query.executionAnalytics`, `directive @oneOf` … */
  readonly key: string;
  readonly text: string;
}

const keyOf = (def: DefinitionNode): string | null => {
  switch (def.kind) {
    case Kind.SCALAR_TYPE_DEFINITION:
      return `scalar ${def.name.value}`;
    case Kind.ENUM_TYPE_DEFINITION:
      return `enum ${def.name.value}`;
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
      return `input ${def.name.value}`;
    case Kind.OBJECT_TYPE_DEFINITION:
      return `type ${def.name.value}`;
    case Kind.OBJECT_TYPE_EXTENSION:
      return `extend type ${def.name.value}`;
    case Kind.DIRECTIVE_DEFINITION:
      return `directive @${def.name.value}`;
    default:
      return null;
  }
};

/**
 * `extend type Query` blocks are compared PER FIELD (`Query.<name>` keys, the
 * field's description included): the kernel slice composes one Query extension
 * from roots that live in several legacy files, so the block as a whole has no
 * single legacy twin while every root in it does.
 */
export const extractDefinitions = (sdl: string): Map<string, string> => {
  const doc = parse(sdl, { noLocation: false });
  const out = new Map<string, string>();
  for (const def of doc.definitions) {
    if (def.loc === undefined) continue;
    if (def.kind === Kind.OBJECT_TYPE_EXTENSION && def.name.value === 'Query') {
      for (const field of def.fields ?? []) {
        if (field.loc === undefined) continue;
        out.set(`Query.${field.name.value}`, sdl.slice(field.loc.start, field.loc.end));
      }
      continue;
    }
    const key = keyOf(def);
    if (key === null) continue;
    out.set(key, sdl.slice(def.loc.start, def.loc.end));
  }
  return out;
};
