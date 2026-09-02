/**
 * The frozen surface (docs/server-redesign/13 §1, §3 rule 1): every definition
 * the kernel slice carries must be BYTE-IDENTICAL to the legacy source. Both
 * sides are re-extracted through the parser (`loc` slices, descriptions
 * included, `#` comments excluded), so reordering is immaterial and any
 * whitespace / description / `@deprecated` drift fails here.
 *
 * Two references (codex 2026-09-02 finding 6):
 *  1. the PINNED fixture `fixtures/legacy-execution-analytics.graphql`,
 *     extracted from the live legacy SDL on 2026-09-02 and committed — the
 *     evidence that survives the legacy modules' deletion;
 *  2. until retirement, the LIVE legacy SDL as well — so the fixture itself is
 *     proven current, and synchronized drift of slice + legacy cannot pass.
 *
 * Plus the boot gate: the slice passes the kernel merge gate and builds an
 * executable schema with the legacy resolvers wired (`@oneOf` redeclaration,
 * `PeriodDate`, the `ReportType` value map).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeExecutableSchema } from '@graphql-tools/schema';
import {
  buildSchema,
  validateSchema,
  type GraphQLEnumType,
  type GraphQLInputObjectType,
} from 'graphql';
import { describe, expect, it } from 'vitest';

import { extractDefinitions } from './extract-sdl.js';
import { renderLegacyFixture } from './gen-typedefs.js';
import { CommonDirectives } from '../../../../src/infra/graphql/common/directives.js';
import { CommonEnums } from '../../../../src/infra/graphql/common/enums.js';
import { CommonScalars } from '../../../../src/infra/graphql/common/scalars.js';
import { makeBudgetLegacyResolvers } from '../../../../src/modules/budget/shell/graphql/legacy/resolvers.js';
import {
  BUDGET_LEGACY_SDL_PROVENANCE,
  budgetLegacyCollisionTypeDefs,
  budgetLegacyTypeDefs,
} from '../../../../src/modules/budget/shell/graphql/legacy/typedefs.js';
import { budgetTypeDefs } from '../../../../src/modules/budget/shell/graphql/typedefs.js';
import { BudgetSectorSchema } from '../../../../src/modules/budget-sector/shell/graphql/schema.js';
import { ClassificationSchema } from '../../../../src/modules/classification/shell/graphql/schema.js';
import { ExecutionAnalyticsSchema } from '../../../../src/modules/execution-analytics/shell/graphql/schema.js';
import { FundingSourceSchema } from '../../../../src/modules/funding-sources/shell/graphql/schema.js';
import {
  baseTypeDefs,
  mergeGraphqlSlices,
  scalarResolvers,
} from '../../../../src/modules/shared/index.js';

const LEGACY_SOURCES: Record<keyof typeof BUDGET_LEGACY_SDL_PROVENANCE, string> = {
  'src/infra/graphql/common/directives.ts': CommonDirectives,
  'src/infra/graphql/common/scalars.ts': CommonScalars,
  'src/infra/graphql/common/enums.ts': CommonEnums,
  'src/modules/execution-analytics/shell/graphql/schema.ts': ExecutionAnalyticsSchema,
  'src/modules/budget-sector/shell/graphql/schema.ts': BudgetSectorSchema,
  'src/modules/funding-sources/shell/graphql/schema.ts': FundingSourceSchema,
  'src/modules/classification/shell/graphql/schema.ts': ClassificationSchema,
};

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'legacy-execution-analytics.graphql'
);

const CARRIED = new Set<string>(Object.values(BUDGET_LEGACY_SDL_PROVENANCE).flat());

describe('legacy executionAnalytics SDL — byte identity with the PINNED fixture', () => {
  const fixtureText = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const fixture = extractDefinitions(fixtureText);
  const slice = extractDefinitions(budgetLegacyTypeDefs);

  it('the fixture is non-empty and carries exactly the provenance keys', () => {
    expect(fixture.size).toBeGreaterThan(0);
    expect(new Set(fixture.keys())).toEqual(CARRIED);
    expect(CARRIED.size).toBe(40);
  });

  for (const key of CARRIED) {
    it(`${key} is byte-identical to the fixture`, () => {
      const expected = fixture.get(key);
      expect(expected, `fixture lacks ${key}`).toBeDefined();
      expect(expected?.length ?? 0).toBeGreaterThan(0);
      expect(slice.get(key)).toBe(expected);
    });
  }

  it('the slice carries nothing beyond the fixture', () => {
    for (const key of slice.keys()) expect(CARRIED.has(key), `unexpected ${key}`).toBe(true);
  });

  it('keeps the @deprecated markers on entity_types (the only allowed additions)', () => {
    expect(slice.get('input AnalyticsFilterInput')).toContain('@deprecated(reason:');
    expect(slice.get('input AnalyticsExcludeInput')).toContain('@deprecated(reason:');
  });
});

describe('legacy executionAnalytics SDL — the fixture is current with the LIVE legacy SDL (until retirement)', () => {
  const fixtureText = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const fixture = extractDefinitions(fixtureText);

  it('the committed fixture equals a fresh extraction of the legacy sources', () => {
    expect(fixtureText).toBe(renderLegacyFixture());
  });

  for (const [file, keys] of Object.entries(BUDGET_LEGACY_SDL_PROVENANCE)) {
    const legacy = extractDefinitions(LEGACY_SOURCES[file as keyof typeof LEGACY_SOURCES]);
    for (const key of keys) {
      it(`${key} in the fixture is byte-identical to ${file}`, () => {
        const expected = legacy.get(key);
        expect(expected, `legacy source lacks ${key}`).toBeDefined();
        expect(fixture.get(key)).toBe(expected);
      });
    }
  }

  it('the legacy execution-analytics schema has no definition the fixture lacks', () => {
    const legacy = extractDefinitions(ExecutionAnalyticsSchema);
    for (const key of legacy.keys()) expect(CARRIED.has(key), `missing ${key}`).toBe(true);
  });
});

describe('legacy executionAnalytics SDL — kernel boot gate', () => {
  const sliceTypeDefs = `${budgetTypeDefs}\n${budgetLegacyTypeDefs}\n${budgetLegacyCollisionTypeDefs}`;

  it('passes the kernel merge gate as part of the budget slice', () => {
    expect(() =>
      mergeGraphqlSlices(baseTypeDefs, [{ source: 'budget', typeDefs: sliceTypeDefs }])
    ).not.toThrow();
  });

  it('builds an executable schema with the legacy resolvers (PeriodDate, ReportType map, @oneOf)', () => {
    const merged = mergeGraphqlSlices(baseTypeDefs, [
      { source: 'budget', typeDefs: sliceTypeDefs },
    ]);
    const resolvers = {
      ...scalarResolvers,
      ...makeBudgetLegacyResolvers({
        aggregate: { legacyExecutionAggregate: () => Promise.reject(new Error('unused')) },
        factors: { yearly: () => Promise.reject(new Error('unused')) },
        population: { scopedPopulation: () => Promise.reject(new Error('unused')) },
        dimensions: {
          listSectors: () => Promise.reject(new Error('unused')),
          listFundingSources: () => Promise.reject(new Error('unused')),
          listClassifications: () => Promise.reject(new Error('unused')),
        },
      }),
    };
    const schema = makeExecutableSchema({ typeDefs: merged.typeDefs, resolvers });

    // Duck-typed (vitest may load two graphql instances; instanceof is unreliable).
    const reportType = schema.getType('ReportType') as GraphQLEnumType | undefined;
    expect(reportType?.toString()).toBe('ReportType');
    expect(reportType?.getValue('DETAILED')?.value).toBe('Executie bugetara detaliata');
    expect(reportType?.getValue('COMMITMENT_DETAILED')?.value).toBe(
      'Executie - Angajamente bugetare detaliat'
    );
    const selection = schema.getType('PeriodSelection') as GraphQLInputObjectType | undefined;
    expect(Object.keys(selection?.getFields() ?? {})).toEqual(['interval', 'dates']);
    expect(schema.getType('PeriodDate')?.toString()).toBe('PeriodDate');
    expect(schema.getQueryType()?.getFields()['executionAnalytics']).toBeDefined();

    // Full schema validation (dangling references, directive placement) on a
    // single-instance graphql build of the same merged SDL.
    expect(validateSchema(buildSchema(merged.typeDefs))).toEqual([]);
  });
});
