/**
 * GPT REST API - OpenAPI Configuration
 *
 * Configuration for @fastify/swagger to generate OpenAPI 3.0 spec.
 *
 * The spec is used for offline generation (see scripts/generate-openapi.ts)
 * and is not exposed as an HTTP route in production.
 */

import type { FastifyDynamicSwaggerOptions } from '@fastify/swagger';

/**
 * OpenAPI configuration for GPT REST API.
 */
export const gptOpenApiConfig: FastifyDynamicSwaggerOptions = {
  openapi: {
    openapi: '3.1.0',
    info: {
      title: 'Transparenta.eu Budget Analytics API',
      description: `
REST API for Romanian public budget analytics, designed for Custom GPT integration.

## Authentication
All endpoints require an API key passed via the \`X-API-Key\` header.

## Data Coverage
- **Entities**: 13,000+ public institutions (municipalities, ministries, schools, hospitals)
- **Years**: 2016 - present
- **Classifications**: Functional (COFOG) and Economic

## Key Concepts

### Identifiers
- **CUI** (Cod Unic de Identificare): Fiscal code uniquely identifying an entity
- **UAT** (Unitate Administrativ-Teritorială): Administrative unit (municipality, city, commune)

### Classifications
- **Functional**: What money is spent on (education, health, transport) - COFOG-based
- **Economic**: How money is spent (salaries, goods, services, investments)

### Account Categories
- **ch** (cheltuieli): Expenses
- **vn** (venituri): Income

### Period Formats
- **YEAR**: \`2023\` (yearly granularity)
- **MONTH**: \`2023-06\` (monthly granularity)
- **QUARTER**: \`2023-Q2\` (quarterly granularity)

### Normalization Modes
- **total**: Raw RON amounts
- **per_capita**: Amount per inhabitant (RON/capita)
- **total_euro**: Converted to EUR
- **per_capita_euro**: Per capita in EUR

## Response Format
All endpoints return responses in the format:
\`\`\`json
{
  "ok": true,
  "data": { ... }
}
\`\`\`

Errors return:
\`\`\`json
{
  "ok": false,
  "error": "ERROR_CODE",
  "message": "Human-readable message"
}
\`\`\`

## Language Note
All entity names, classification descriptions, and search queries use **Romanian** terminology.
      `.trim(),
      version: '1.0.0',
      contact: {
        name: 'Transparenta.eu',
        url: 'https://transparenta.eu',
      },
    },
    servers: [
      {
        url: 'https://api.transparenta.eu',
        description: 'Production',
      },
    ],
    tags: [
      {
        name: 'Budget Analytics',
        description: 'Query and analyze Romanian public budget data',
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API key for authentication',
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
  },
};
