/**
 * TypeBox to JSON Schema Adapter for MCP SDK
 *
 * MCP SDK requires JSON Schema for tool input/output validation.
 * TypeBox schemas ARE JSON Schema, but with additional TypeBox metadata.
 * This adapter strips the metadata for MCP registration.
 */

import type { TSchema, Static } from '@sinclair/typebox';

/**
 * Converts a TypeBox schema to plain JSON Schema.
 * Removes TypeBox-specific symbols and metadata.
 *
 * @param schema - TypeBox schema
 * @returns Plain JSON Schema object
 */
export function toJsonSchema(schema: TSchema): Record<string, unknown> {
  // TypeBox schemas are JSON Schema compliant
  // JSON stringify/parse removes Symbol properties
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

/**
 * Annotations for MCP tool definition.
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Tool definition for MCP registration.
 */
export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations | undefined;
}

/**
 * Creates an MCP tool definition from TypeBox schema.
 *
 * @param config - Tool configuration
 * @returns MCP-compatible tool definition
 */
export function createToolDefinition(config: {
  name: string;
  title: string;
  description: string;
  inputSchema: TSchema;
  annotations?: McpToolAnnotations;
}): McpToolDefinition {
  const result: McpToolDefinition = {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: toJsonSchema(config.inputSchema),
  };

  if (config.annotations !== undefined) {
    result.annotations = config.annotations;
  }

  return result;
}

/**
 * Resource definition for MCP registration.
 */
export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * Creates an MCP resource definition.
 */
export function createResourceDefinition(config: {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}): McpResourceDefinition {
  return {
    uri: config.uri,
    name: config.name,
    description: config.description,
    mimeType: config.mimeType ?? 'text/markdown',
  };
}

/**
 * Prompt argument definition.
 */
export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

/**
 * Prompt definition for MCP registration.
 */
export interface McpPromptDefinition {
  name: string;
  description: string;
  arguments: McpPromptArgument[];
}

/**
 * Creates an MCP prompt definition.
 */
export function createPromptDefinition(config: {
  name: string;
  description: string;
  arguments: McpPromptArgument[];
}): McpPromptDefinition {
  return {
    name: config.name,
    description: config.description,
    arguments: config.arguments,
  };
}

/**
 * Type helper to extract the static type from a TypeBox schema.
 */
export type InferInput<T extends TSchema> = Static<T>;
