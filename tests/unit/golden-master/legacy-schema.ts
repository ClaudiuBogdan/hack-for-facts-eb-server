/**
 * The legacy `/graphql` schema built OFFLINE from the same 18 SDL constants
 * `src/app/build-app.ts` hands to Mercurius (no resolvers, no server), so the
 * corpus can be validated against today's contract without a database.
 */

import { buildSchema, type GraphQLSchema } from 'graphql';

import { CommonGraphQLSchema } from '../../../src/infra/graphql/common/schema.js';
import { BaseSchema } from '../../../src/infra/graphql/schema.js';
import { AggregatedLineItemsSchema } from '../../../src/modules/aggregated-line-items/shell/graphql/schema.js';
import { BudgetSectorSchema } from '../../../src/modules/budget-sector/shell/graphql/schema.js';
import { ClassificationSchema } from '../../../src/modules/classification/shell/graphql/schema.js';
import { CommitmentsSchema } from '../../../src/modules/commitments/shell/graphql/schema.js';
import { CountyAnalyticsSchema } from '../../../src/modules/county-analytics/shell/graphql/schema.js';
import { DatasetsSchema } from '../../../src/modules/datasets/shell/graphql/schema.js';
import { EntitySchema } from '../../../src/modules/entity/shell/graphql/schema.js';
import { EntityAnalyticsSchema } from '../../../src/modules/entity-analytics/shell/graphql/schema.js';
import { ExecutionAnalyticsSchema } from '../../../src/modules/execution-analytics/shell/graphql/schema.js';
import { ExecutionLineItemSchema } from '../../../src/modules/execution-line-items/shell/graphql/schema.js';
import { FundingSourceSchema } from '../../../src/modules/funding-sources/shell/graphql/schema.js';
import { schema as healthSchema } from '../../../src/modules/health/shell/graphql/schema.js';
import { InsSchema } from '../../../src/modules/ins/shell/graphql/schema.js';
import { ReportSchema } from '../../../src/modules/report/shell/graphql/schema.js';
import { UATSchema } from '../../../src/modules/uat/shell/graphql/schema.js';
import { UATAnalyticsSchema } from '../../../src/modules/uat-analytics/shell/graphql/schema.js';

/** Same order as `build-app.ts`. */
export const LEGACY_SDL_PARTS: readonly string[] = [
  BaseSchema,
  CommonGraphQLSchema,
  healthSchema,
  ExecutionAnalyticsSchema,
  AggregatedLineItemsSchema,
  CommitmentsSchema,
  EntityAnalyticsSchema,
  DatasetsSchema,
  BudgetSectorSchema,
  FundingSourceSchema,
  ExecutionLineItemSchema,
  EntitySchema,
  UATSchema,
  ReportSchema,
  UATAnalyticsSchema,
  CountyAnalyticsSchema,
  ClassificationSchema,
  InsSchema,
];

export function buildLegacySchema(): GraphQLSchema {
  return buildSchema(LEGACY_SDL_PARTS.join('\n'));
}
