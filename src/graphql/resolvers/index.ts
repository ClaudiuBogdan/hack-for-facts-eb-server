import { entityResolver } from "./entityResolver";
import { uatResolver } from "./uatResolver";
import { classificationsResolver } from "./classificationsResolver";
import { executionLineItemResolver } from "./executionLineItemResolver";
import { reportResolver } from "./reportResolver";
import { analyticsResolver } from "./analyticsResolver";
import { fundingSourcesResolver } from "./fundingSourcesResolver";
import { budgetSectorResolver } from "./budgetSectorResolver";
import { datasetResolver } from "./datasetResolver";
import { aggregatedLineItemsResolver } from "./aggregatedLineItemsResolver";
import { scalarResolvers } from "./scalars";
import { enumResolvers } from "./enums";

export const resolvers = [
  scalarResolvers,
  enumResolvers,
  entityResolver,
  uatResolver,
  classificationsResolver,
  executionLineItemResolver,
  reportResolver,
  analyticsResolver,
  fundingSourcesResolver,
  budgetSectorResolver,
  datasetResolver,
  aggregatedLineItemsResolver,
];

