import { readFileSync } from 'node:fs';

import { buildSchema, Kind, parse, print, validateSchema } from 'graphql';
import { describe, expect, it } from 'vitest';

import { CommonTypes } from '@/infra/graphql/common/types.js';
import { commitmentDashboardTypeDefs } from '@/modules/budget/shell/graphql/commitment-dashboard.js';
import { commitmentPeriodTypeDefs } from '@/modules/budget/shell/graphql/commitment-periods.js';
import { budgetGroupedTypeDefs } from '@/modules/budget/shell/graphql/legacy/grouped-typedefs.js';
import {
  budgetLegacyCollisionTypeDefs,
  budgetLegacyTypeDefs,
} from '@/modules/budget/shell/graphql/legacy/typedefs.js';
import {
  BUDGET_SERIES_COMMON_SDL_PROVENANCE,
  budgetSeriesCommonTypeDefs,
} from '@/modules/budget/shell/graphql/series-common.js';
import { budgetTypeDefs } from '@/modules/budget/shell/graphql/typedefs.js';
import { baseTypeDefs, mergeGraphqlSlices } from '@/modules/shared/index.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/national-budget/${name}`, import.meta.url), 'utf8');

/** Reviewed v3 national SDL plus the CONTRACT_DELTAS additive `authorityCode` field. */
const NATIONAL_SDL = fixture('schema-v3.graphql');
const REFERENCE_SDL = fixture('shared-series-reference.graphql');

/** The budget slice exactly as `src/modules/budget/index.ts` composes it today. */
const CURRENT_BUDGET_SLICE = [
  budgetTypeDefs,
  budgetLegacyTypeDefs,
  budgetLegacyCollisionTypeDefs,
  budgetGroupedTypeDefs,
  commitmentPeriodTypeDefs,
  commitmentDashboardTypeDefs,
].join('\n');

const objectTypes = (sdl: string): Map<string, string> => {
  const types = new Map<string, string>();
  for (const def of parse(sdl).definitions) {
    if (def.kind === Kind.OBJECT_TYPE_DEFINITION) types.set(def.name.value, print(def));
  }
  return types;
};

const definitionCount = (sdl: string, name: string): number =>
  parse(sdl).definitions.filter(
    (def) => 'name' in def && def.name?.value === name && def.kind === Kind.OBJECT_TYPE_DEFINITION
  ).length;

describe('budget-registered canonical series SDL', () => {
  it('is exactly the canonical common DataPoint/DataSeries (AST and approved reference)', () => {
    const extracted = objectTypes(budgetSeriesCommonTypeDefs);
    const canonical = objectTypes(CommonTypes);
    const reference = objectTypes(REFERENCE_SDL);
    expect([...extracted.keys()]).toEqual(['DataPoint', 'DataSeries']);
    for (const name of ['DataPoint', 'DataSeries']) {
      expect(extracted.get(name)).toBe(canonical.get(name));
      expect(extracted.get(name)).toBe(reference.get(name));
    }
    expect(CommonTypes).toContain(budgetSeriesCommonTypeDefs.split('\n\n')[0]);
    expect(BUDGET_SERIES_COMMON_SDL_PROVENANCE).toEqual({
      'src/infra/graphql/common/types.ts': ['type DataPoint', 'type DataSeries'],
    });
  });

  it('depends on budget-carried PeriodType, so it cannot be a kernel definition', () => {
    expect(() =>
      buildSchema(`type Query { ping: Boolean }\n${budgetSeriesCommonTypeDefs}`)
    ).toThrow(/PeriodType/u);
    expect(baseTypeDefs).not.toMatch(/\btype DataSeries\b/u);
    expect(baseTypeDefs).not.toMatch(/\btype DataPoint\b/u);
  });

  it('composes once with budget enabled, including the approved national SDL', () => {
    const merged = mergeGraphqlSlices(baseTypeDefs, [
      {
        source: 'budget',
        typeDefs: [CURRENT_BUDGET_SLICE, budgetSeriesCommonTypeDefs, NATIONAL_SDL].join('\n'),
      },
    ]).typeDefs;
    expect(validateSchema(buildSchema(merged))).toEqual([]);
    expect(definitionCount(merged, 'DataPoint')).toBe(1);
    expect(definitionCount(merged, 'DataSeries')).toBe(1);
    const schema = buildSchema(merged);
    const series = schema.getType('BudgetNationalSeries');
    expect(
      series !== undefined && 'getFields' in series
        ? String(series.getFields()['series']?.type)
        : ''
    ).toBe('DataSeries!');
    const cell = schema.getType('BudgetApprovedTotalCell');
    expect(
      cell !== undefined && 'getFields' in cell
        ? String(cell.getFields()['authorityCode']?.type)
        : ''
    ).toBe('String');
  });

  it('leaves a valid schema without series types when budget is excluded', () => {
    const merged = mergeGraphqlSlices(baseTypeDefs, []).typeDefs;
    const schema = buildSchema(merged);
    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getType('DataSeries')).toBeUndefined();
    expect(schema.getType('DataPoint')).toBeUndefined();
  });

  it('does not change the current budget slice (registration is not wired yet)', () => {
    expect(definitionCount(CURRENT_BUDGET_SLICE, 'DataSeries')).toBe(0);
    expect(definitionCount(CURRENT_BUDGET_SLICE, 'DataPoint')).toBe(0);
    const current = mergeGraphqlSlices(baseTypeDefs, [
      { source: 'budget', typeDefs: CURRENT_BUDGET_SLICE },
    ]).typeDefs;
    expect(validateSchema(buildSchema(current))).toEqual([]);
  });
});
