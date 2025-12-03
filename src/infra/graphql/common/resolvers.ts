/**
 * Enum resolvers for common GraphQL enums
 * Provides bidirectional mapping between GraphQL enum values and internal values
 *
 * With makeExecutableSchema from @graphql-tools/schema, these resolvers enable:
 * - Input deserialization: GraphQL enum -> Internal value
 * - Output serialization: Internal value -> GraphQL enum
 *
 * Format: Direct string mapping (GraphQL Tools automatically handles bidirectional conversion)
 */
export const EnumResolvers = {
  ReportType: {
    PRINCIPAL_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator principal',
    SECONDARY_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator secundar',
    DETAILED: 'Executie bugetara detaliata',
  },
};
