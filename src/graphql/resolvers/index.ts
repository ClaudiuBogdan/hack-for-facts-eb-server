import { entityResolver } from "./entityResolver";
import { uatResolver } from "./uatResolver";
import { classificationsResolver } from "./classificationsResolver";
import { executionLineItemResolver } from "./executionLineItemResolver";
import { reportResolver } from "./reportResolver";
import { analyticsResolver } from "./analyticsResolver";
import { fundingSourcesResolver } from "./fundingSourcesResolver";
import { budgetSectorResolver } from "./budgetSectorResolver";

export const resolvers = [
  entityResolver,
  uatResolver,
  classificationsResolver,
  executionLineItemResolver,
  reportResolver,
  analyticsResolver,
  fundingSourcesResolver,
  budgetSectorResolver,
];

