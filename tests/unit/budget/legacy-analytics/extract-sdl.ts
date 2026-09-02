/**
 * Extract named SDL definitions (with their description strings, WITHOUT the
 * surrounding `#` comments) from a schema source string, byte-for-byte via the
 * parser's `loc` — the same extraction the identity test applies to both the
 * legacy source files and the kernel slice, so drift is impossible to miss.
 */

import { Kind, parse, type DefinitionNode } from 'graphql';

export interface ExtractedDefinition {
  /** `enum AxisDataType`, `input AnalyticsFilterInput`, `extend type Query`, `directive @oneOf` … */
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

export const extractDefinitions = (sdl: string): Map<string, string> => {
  const doc = parse(sdl, { noLocation: false });
  const out = new Map<string, string>();
  for (const def of doc.definitions) {
    const key = keyOf(def);
    if (key === null || def.loc === undefined) continue;
    out.set(key, sdl.slice(def.loc.start, def.loc.end));
  }
  return out;
};
