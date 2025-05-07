import { entityResolver } from "./entityResolver";
import { reportResolver } from "./reportResolver";
import { executionLineItemResolver } from "./executionLineItemResolver";
import { classificationsResolver } from "./classificationsResolver";
import { uatResolver } from "./uatResolver";
import { analyticsResolver } from "./analyticsResolver"; // Import the new resolver

export const resolvers = {
  Query: {
    // Merge queries from all resolver files
    ...entityResolver.Query,
    ...reportResolver.Query,
    ...executionLineItemResolver.Query,
    ...classificationsResolver.Query,
    ...uatResolver.Query,
    ...analyticsResolver.Query, // Add the new analytics queries
  },
  // Merge type-specific resolvers
  Entity: entityResolver.Entity,
  Report: reportResolver.Report,
  ExecutionLineItem: executionLineItemResolver.ExecutionLineItem,
  FunctionalClassification: classificationsResolver.FunctionalClassification,
  EconomicClassification: classificationsResolver.EconomicClassification,
  FundingSource: classificationsResolver.FundingSource,
  UATAggregatedMetrics: analyticsResolver.UATAggregatedMetrics, // Add nested resolver for UAT metrics
  // Add other type resolvers if they exist in analyticsResolver (e.g., CategoryAggregatedMetrics)
};

