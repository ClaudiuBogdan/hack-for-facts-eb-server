import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch"; // Or use the built-in fetch
import { mcpDefinition } from "../routes/mcp";

// --- Configuration ---
const GRAPHQL_ENDPOINT_URL = "http://localhost:3000/graphql"; // UPDATE THIS!

// --- MCP Server Setup ---
const server = new McpServer({
  name: "Demo Public Spending API Client", // Updated name for clarity
  version: "1.0.0",
});

// --- Existing Tools/Resources (Example) ---
server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));
server.resource(
  "greeting",
  new ResourceTemplate("greeting://{name}", { list: undefined }),
  async (uri, { name }) => ({
    contents: [
      {
        uri: uri.href,
        text: `Hello, ${name}!`,
      },
    ],
  })
);

// --- GraphQL Query Tool with Enhanced Descriptions ---

server.tool(
  // Tool name
  "graphqlQuery",
  // Input Schema using Zod with detailed descriptions
  {
    query: z.string().describe(JSON.stringify(mcpDefinition)),
    variables: z
      .record(z.any())
      .optional()
      .describe(
        'OPTIONAL: A JSON object containing variables for the GraphQL query, used for parameterization (like filters, limits, offsets). Example: { "year": 2023, "entityFilter": { "region": "West" } }'
      ),
    operationName: z
      .string()
      .optional()
      .describe(
        "OPTIONAL: The operation name if the 'query' string contains multiple named operations. Example: 'GetReports'"
      ),
  },
  // Tool Handler Function (same logic as before)
  async ({ query, variables, operationName }) => {
    console.log("Executing GraphQL Query:");
    console.log(`Query: ${JSON.stringify(query)}`);
    console.log(`Variables: ${JSON.stringify(variables)}`);
    console.log(`OperationName: ${JSON.stringify(operationName)}`);

    try {
      const response = await fetch(GRAPHQL_ENDPOINT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // Add Auth headers here if needed later
        },
        body: JSON.stringify({
          query,
          variables,
          operationName,
        }),
      });

      if (!response.ok) {
        // Try to get more error info from the response body if possible
        let errorBody = `Status ${response.status}: ${response.statusText}`;
        try {
          const textBody = await response.text();
          errorBody += `\nResponse: ${textBody.substring(0, 500)}${
            textBody.length > 500 ? "..." : ""
          }`; // Limit long error responses
        } catch (e) {
          /* Ignore error reading body */
        }
        throw new Error(`GraphQL request failed. ${errorBody}`);
      }

      const result = await response.json();

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: any) {
      console.error("Error executing GraphQL query:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error executing GraphQL query: ${
              error.message || "Unknown error"
            }`,
          },
        ],
      };
    }
  }
  // Add the main tool description here
);

// --- Server Connection ---
const transport = new StdioServerTransport();
server.connect(transport);
