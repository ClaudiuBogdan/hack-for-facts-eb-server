import { entityResolver } from "./entityResolver";
import { reportResolver } from "./reportResolver";
import { executionLineItemResolver } from "./executionLineItemResolver";
import { classificationsResolver } from "./classificationsResolver";
import { uatResolver } from "./uatResolver";

export const resolvers = {
  Query: {
    // Merge queries from all resolver files
    ...entityResolver.Query,
    ...reportResolver.Query,
    ...executionLineItemResolver.Query,
    ...classificationsResolver.Query,
    ...uatResolver.Query,
  },
  // Merge type-specific resolvers
  Entity: entityResolver.Entity,
  Report: reportResolver.Report,
  ExecutionLineItem: executionLineItemResolver.ExecutionLineItem,
  FunctionalClassification: classificationsResolver.FunctionalClassification,
  EconomicClassification: classificationsResolver.EconomicClassification,
  FundingSource: classificationsResolver.FundingSource,
};

