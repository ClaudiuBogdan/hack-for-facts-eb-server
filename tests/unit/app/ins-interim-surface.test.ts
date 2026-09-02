/**
 * S1-7 interim: the legacy INS SDL mounted on the kernel surface with the two
 * scalar renames and the design-13 `PageInfo` extension
 * (src/app/ins-interim-surface.ts). Pins the merge preconditions, the rename
 * set, the PageInfo field coverage and the legacy scalar serialization, so a
 * later edit to either side cannot silently change what /api/v1/graphql serves.
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import { buildSchema, isObjectType, Kind, parse, validateSchema, visit } from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  INS_INTERIM_SCALAR_RENAMES,
  INS_INTERIM_SLICE_SOURCE,
  InsDateScalar,
  InsDateTimeScalar,
  makeInsInterimSurface,
  makeInsInterimTypeDefs,
} from '@/app/ins-interim-surface.js';
import { CommonTypes } from '@/infra/graphql/common/index.js';
import { budgetLegacyTypeDefs } from '@/modules/budget/shell/graphql/legacy/typedefs.js';
import { budgetTypeDefs } from '@/modules/budget/shell/graphql/typedefs.js';
import { InsSchema, makeInsResolvers, type InsRepository } from '@/modules/ins/index.js';
import { baseTypeDefs, mergeGraphqlSlices, type GraphqlSlice } from '@/modules/shared/index.js';

/** The ten legacy INS roots (src/modules/ins/shell/graphql/schema.ts `extend type Query`). */
const INS_ROOTS = [
  'insDatasets',
  'insDataset',
  'insDatasetDimensionValues',
  'insTerritories',
  'insContexts',
  'insObservations',
  'insUatIndicators',
  'insCompare',
  'insUatDashboard',
  'insLatestDatasetValues',
] as const;

const budgetSlice: GraphqlSlice = {
  source: 'budget',
  typeDefs: `${budgetTypeDefs}\n${budgetLegacyTypeDefs}`,
};

const INTERIM_SDL = makeInsInterimTypeDefs();

const surface = () => makeInsInterimSurface(makeInsResolvers({ insRepo: {} as InsRepository }));

/** Every name node in an SDL string. */
const namesIn = (sdl: string): Set<string> => {
  const names = new Set<string>();
  visit(parse(sdl), {
    enter(node) {
      if (node.kind === Kind.NAME) names.add(node.value);
      return undefined;
    },
  });
  return names;
};

/** Field names of an object type in a merged/built schema. */
const objectFields = (sdl: string, typeName: string): string[] => {
  const type = buildSchema(sdl).getType(typeName);
  return isObjectType(type) ? Object.keys(type.getFields()) : [];
};

describe('S1-7 interim INS surface — SDL', () => {
  it('renames exactly the two scalars and touches no other name', () => {
    const legacyNames = namesIn(InsSchema);
    const interimNames = namesIn(INTERIM_SDL);
    for (const [from, to] of Object.entries(INS_INTERIM_SCALAR_RENAMES)) {
      expect(legacyNames.has(from)).toBe(true);
      expect(interimNames.has(from)).toBe(false);
      expect(interimNames.has(to)).toBe(true);
    }
    const added = new Set(['PageInfo', 'totalCount', 'hasPreviousPage', 'startCursor']);
    const expected = new Set([...legacyNames].map((n) => INS_INTERIM_SCALAR_RENAMES[n] ?? n));
    for (const n of interimNames) expect(expected.has(n) || added.has(n)).toBe(true);
  });

  it('renames type positions only: no INS field, argument or enum value shares a renamed name', () => {
    const offenders: string[] = [];
    visit(parse(InsSchema), {
      enter(node) {
        if (
          (node.kind === Kind.FIELD_DEFINITION ||
            node.kind === Kind.INPUT_VALUE_DEFINITION ||
            node.kind === Kind.ENUM_VALUE_DEFINITION) &&
          INS_INTERIM_SCALAR_RENAMES[node.name.value] !== undefined
        ) {
          offenders.push(`${node.kind}:${node.name.value}`);
        }
        return undefined;
      },
    });
    expect(offenders).toEqual([]);
  });

  it('uses InsDate / InsDateTime in output positions only (their input parsing is unreachable)', () => {
    const inputRefs: string[] = [];
    visit(parse(INTERIM_SDL), {
      enter(node) {
        if (node.kind !== Kind.INPUT_VALUE_DEFINITION) return undefined;
        visit(node.type, {
          enter(t) {
            if (t.kind === Kind.NAMED_TYPE && /^InsDate(Time)?$/.test(t.name.value)) {
              inputRefs.push(node.name.value);
            }
            return undefined;
          },
        });
        return undefined;
      },
    });
    expect(inputRefs).toEqual([]);
  });

  it('exposes the slice under its own name', () => {
    expect(surface().graphqlSlices).toEqual([
      { source: INS_INTERIM_SLICE_SOURCE, typeDefs: INTERIM_SDL },
    ]);
  });

  it('passes the kernel merge gate beside the budget module and builds a valid schema', () => {
    const merged = mergeGraphqlSlices(baseTypeDefs, [budgetSlice, ...surface().graphqlSlices]);
    const schema = buildSchema(merged.typeDefs);
    expect(validateSchema(schema)).toEqual([]);
    const queryFields = Object.keys(schema.getQueryType()?.getFields() ?? {});
    for (const root of INS_ROOTS) expect(queryFields).toContain(root);
  });

  it('extends the kernel PageInfo to cover every legacy PageInfo field, keeping the type name', () => {
    const merged = mergeGraphqlSlices(baseTypeDefs, [budgetSlice, ...surface().graphqlSlices]);
    const kernelPageInfo = objectFields(merged.typeDefs, 'PageInfo');
    const legacyPageInfo = Object.keys(
      (
        parse(CommonTypes).definitions.find(
          (d) => d.kind === Kind.OBJECT_TYPE_DEFINITION && d.name.value === 'PageInfo'
        ) as { fields?: { name: { value: string } }[] }
      ).fields?.reduce((acc, f) => ({ ...acc, [f.name.value]: true }), {}) ?? {}
    );
    expect(legacyPageInfo.length).toBeGreaterThan(0);
    for (const f of legacyPageInfo) expect(kernelPageInfo).toContain(f);
    // Extended, never re-declared (the merge gate would reject a re-declaration).
    expect(INTERIM_SDL).not.toMatch(/^\s*type PageInfo\b/m);
    expect(INTERIM_SDL).toMatch(/^\s*extend type PageInfo\b/m);
  });

  it('depends on the budget legacy slice for ReportPeriodInput / PeriodDate (documented precondition)', () => {
    // The merge gate only checks names; the dangling references surface at build time.
    const merged = mergeGraphqlSlices(baseTypeDefs, surface().graphqlSlices);
    expect(() => buildSchema(merged.typeDefs)).toThrow(/ReportPeriodInput|PeriodDate/);
  });
});

describe('S1-7 interim INS surface — resolvers', () => {
  it('wires every INS root and both interim scalars into the executable schema', () => {
    const { graphqlSlices, graphqlResolvers } = surface();
    const merged = mergeGraphqlSlices(baseTypeDefs, [budgetSlice, ...graphqlSlices]);
    const schema = makeExecutableSchema({
      typeDefs: merged.typeDefs,
      resolvers: graphqlResolvers as Record<string, never>,
    });
    const fields = schema.getQueryType()?.getFields() ?? {};
    for (const root of INS_ROOTS) expect(fields[root]?.resolve).toBeTypeOf('function');
    // makeExecutableSchema clones scalar types: assert the wired BEHAVIOUR.
    const when = new Date('2026-09-02T15:11:25.956Z');
    for (const name of ['InsDate', 'InsDateTime']) {
      const scalar = schema.getType(name) as { serialize?: (v: unknown) => unknown } | undefined;
      expect(scalar?.serialize).toBeTypeOf('function');
      expect(scalar?.serialize?.(when)).toBe(when.toJSON());
    }
  });

  it('serializes a JS Date exactly as the legacy endpoint does (JSON.stringify → toJSON)', () => {
    const when = new Date('2026-09-02T15:11:25.956Z');
    expect(JSON.stringify({ t: InsDateTimeScalar.serialize(when) })).toBe(
      JSON.stringify({ t: when })
    );
    expect(InsDateScalar.serialize(when)).toBe('2026-09-02T15:11:25.956Z');
    expect(InsDateScalar.serialize('2026-09-02')).toBe('2026-09-02');
    expect(InsDateTimeScalar.serialize(null)).toBeNull();
  });
});
