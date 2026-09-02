/**
 * The native slice's SDL must be the legacy `InsSchema` minus the two dropped
 * roots (decision D5) plus exactly the declared additions (three additive
 * `InsPeriodicity` values; `PageInfo` is extended by the budget legacy slice). Anything else is a
 * contract break the golden master cannot allowlist (13 §3 rule 1).
 */

import { Kind, parse, print, visit, type DefinitionNode, type DocumentNode } from 'graphql';
import { describe, expect, it } from 'vitest';

import { InsSchema } from '@/modules/ins/index.js';
import {
  INS_LEGACY_ROOTS,
  INS_LEGACY_ROOTS_DROPPED,
  insLegacyTypeDefs,
} from '@/modules/ins-native/index.js';

const ADDED_PERIODICITIES = new Set(['SEMESTRIAL', 'RANGE', 'OTHER']);

/** Normalise a document: drop descriptions, sort definitions and fields by name. */
const canonical = (doc: DocumentNode): string => {
  const stripped = visit(doc, {
    enter(node) {
      if ('description' in node && node.description !== undefined) {
        return { ...node, description: undefined };
      }
      return undefined;
    },
  });
  const defs = [...stripped.definitions].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return print({ ...stripped, definitions: defs });
};

const nameOf = (d: DefinitionNode): string =>
  'name' in d && d.name !== undefined ? `${d.kind}:${d.name.value}` : d.kind;

/** The legacy SDL as the native slice is allowed to differ from it. */
const legacyExpected = (): DocumentNode => {
  const dropped = new Set<string>(INS_LEGACY_ROOTS_DROPPED);
  return visit(parse(InsSchema), {
    enter(node) {
      if (node.kind === Kind.OBJECT_TYPE_EXTENSION && node.name.value === 'Query') {
        return { ...node, fields: node.fields?.filter((f) => !dropped.has(f.name.value)) };
      }
      if (node.kind === Kind.ENUM_TYPE_DEFINITION && node.name.value === 'InsPeriodicity') {
        return {
          ...node,
          values: [
            ...(node.values ?? []),
            ...[...ADDED_PERIODICITIES].map((v) => ({
              kind: Kind.ENUM_VALUE_DEFINITION as const,
              name: { kind: Kind.NAME as const, value: v },
            })),
          ],
        };
      }
      return undefined;
    },
  });
};

describe('ins-native legacy SDL identity', () => {
  it('equals the legacy InsSchema minus the dropped roots plus the declared additions', () => {
    const native = parse(insLegacyTypeDefs);
    expect(canonical(native)).toBe(canonical(legacyExpected()));
  });

  it('serves exactly the eight client-sent roots', () => {
    const native = parse(insLegacyTypeDefs);
    const roots = native.definitions.flatMap((d) =>
      d.kind === Kind.OBJECT_TYPE_EXTENSION && d.name.value === 'Query'
        ? (d.fields ?? []).map((f) => f.name.value)
        : []
    );
    expect(roots).toEqual([...INS_LEGACY_ROOTS]);
    for (const dropped of INS_LEGACY_ROOTS_DROPPED) expect(roots).not.toContain(dropped);
  });

  it('does NOT extend PageInfo (the budget legacy collision slice owns that extension)', () => {
    const native = parse(insLegacyTypeDefs);
    const ext = native.definitions.find(
      (d) => d.kind === Kind.OBJECT_TYPE_EXTENSION && d.name.value === 'PageInfo'
    );
    expect(ext).toBeUndefined();
  });
});
