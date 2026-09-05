/**
 * The native slice's SDL must be the legacy `InsSchema` minus the two dropped
 * roots (decision D5) plus exactly the declared additions (periodicities,
 * default-series evidence and paired source pins). PageInfo is extended by the
 * budget legacy slice. Anything else is a
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
const ADDITIVE_TYPES = parse(`
  input InsSourcePinInput { dimensionIndex: Int! memberCode: String! }
  extend input InsObservationFilterInput { sourcePins: [InsSourcePinInput!] }
  enum InsDefaultSeriesStatus { SERIES AMBIGUOUS_GEOGRAPHY }
  extend type InsLatestDatasetValue { geographicWitnesses: JSON! }
  extend type InsUatDatasetGroup { status: InsDefaultSeriesStatus! geographicWitnesses: JSON! truncated: Boolean! }
`);

const legacyExpected = (): DocumentNode => {
  const dropped = new Set<string>(INS_LEGACY_ROOTS_DROPPED);
  const legacy = visit(parse(InsSchema), {
    enter(node) {
      if (node.kind === Kind.OBJECT_TYPE_EXTENSION && node.name.value === 'Query') {
        return { ...node, fields: node.fields?.filter((f) => !dropped.has(f.name.value)) };
      }
      if (
        node.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION &&
        node.name.value === 'InsObservationFilterInput'
      ) {
        const addition = ADDITIVE_TYPES.definitions.find(
          (def) =>
            def.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION && def.name.value === node.name.value
        );
        if (addition?.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION)
          return { ...node, fields: [...(addition.fields ?? []), ...(node.fields ?? [])] };
      }
      if (node.kind === Kind.OBJECT_TYPE_DEFINITION) {
        const addition = ADDITIVE_TYPES.definitions.find(
          (def) => def.kind === Kind.OBJECT_TYPE_EXTENSION && def.name.value === node.name.value
        );
        if (addition?.kind === Kind.OBJECT_TYPE_EXTENSION) {
          const fields = [...(node.fields ?? [])];
          const before =
            node.name.value === 'InsUatDatasetGroup'
              ? fields.findIndex((field) => field.name.value === 'latestPeriod')
              : fields.length;
          fields.splice(before, 0, ...(addition.fields ?? []));
          return { ...node, fields };
        }
      }
      if (node.kind === Kind.ENUM_TYPE_DEFINITION && node.name.value === 'InsLatestMatchStrategy') {
        const values = [...(node.values ?? [])];
        values.splice(values.length - 1, 0, {
          kind: Kind.ENUM_VALUE_DEFINITION,
          name: { kind: Kind.NAME, value: 'AMBIGUOUS_GEOGRAPHY' },
        });
        return { ...node, values };
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
  return {
    ...legacy,
    definitions: [
      ...legacy.definitions,
      ...ADDITIVE_TYPES.definitions.filter(
        (def) =>
          def.kind === Kind.ENUM_TYPE_DEFINITION || def.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION
      ),
    ],
  };
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
