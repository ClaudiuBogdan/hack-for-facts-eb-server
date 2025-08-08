// src/server.ts
import Fastify, { FastifyInstance } from "fastify";
import { types as graphqlTypes } from "../graphql/types";

// Import the schema definition string itself

// --- MCP Definition Structure ---
// This defines the structure of the information we provide
// about our "Model Context Protocol" (which is essentially our GraphQL API)
interface McpDefinition {
  protocolVersion: string; // Version your MCP definition format
  apiName: string;
  description: string;
  protocol: {
    type: "GraphQL"; // Clearly state it's GraphQL
    endpoint: string; // Where to send queries
    graphiqlEndpoint?: string; // Optional: Where the interactive UI is
    authentication?: {
      // Describe auth if needed (Example)
      type: "None" | "ApiKey" | "Bearer";
      details?: string; // e.g., "Include API key in 'X-API-KEY' header"
    };
  };
  schema: {
    type: "GraphQL_SDL";
    definition: string; // The full SDL string
  };
  usageNotes: {
    introduction: string;
    filtering: string;
    pagination: string;
    keyQueries: Array<{ name: string; description: string }>;
  };
}

export const mcpDefinition: McpDefinition = {
  protocolVersion: "1.0.0",
  apiName: "Public Spending Analysis API",
  description:
    "Provides access to public spending data, including entities, reports, execution line items, and anomaly detection features. Designed for analysis by public sector entities and journalists.",
  protocol: {
    type: "GraphQL",
    endpoint: "/graphql", // The actual query endpoint
    graphiqlEndpoint: "/graphiql", // The interactive explorer endpoint
    authentication: {
      // Example: Assuming no auth for now
      type: "None",
      details: "No authentication required for read access.",
    },
    // If you add auth later, update this section, e.g.:
    // authentication: {
    //   type: 'ApiKey',
    //   details: "Include your API key in the 'X-API-KEY' HTTP header."
    // }
  },
  schema: {
    type: "GraphQL_SDL",
    // Provide the full GraphQL schema definition
    definition: graphqlTypes,
  },
  usageNotes: {
    introduction:
      'Interact with this API by sending GraphQL queries to the /graphql endpoint using HTTP POST requests. The request body should be a JSON object with a "query" key containing the GraphQL query string, and optionally a "variables" key for parameterized queries.',
    filtering:
      'Many queries accept a "filter" argument (e.g., `entities(filter: {region: "West"})`). Refer to the Input types (like EntityFilter, ReportFilter) in the schema for available filter fields.',
    pagination:
      'Connections (e.g., EntityConnection, ReportConnection) support pagination using "limit" (number of items per page) and "offset" (number of items to skip) arguments. They return a PageInfo object with totalCount, hasNextPage, and hasPreviousPage.',
    keyQueries: [
      {
        name: "entities",
        description: "Query registered public entities, supports filtering.",
      },
      {
        name: "reports",
        description:
          "Query financial reports, supports filtering by entity, year, period, etc.",
      },
      {
        name: "executionLineItems",
        description:
          "Query individual spending/revenue line items, supports detailed filtering.",
      },
    ],
  },
};

export default async function mcpRoutes(fastify: FastifyInstance) {
  // --- >>> MCP Definition Endpoint <<< ---
  // This endpoint exposes the structure and capabilities of the API
  // for programmatic consumption (e.g., by LLMs).
  fastify.get("/mcp/v1/definition", {
    schema: {
      tags: ["AI"],
      summary: "Model Context Protocol description of the GraphQL API",
      response: {
        200: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply): Promise<McpDefinition> => {
    return reply.status(200).send(mcpDefinition);
  });

  return fastify;
}
