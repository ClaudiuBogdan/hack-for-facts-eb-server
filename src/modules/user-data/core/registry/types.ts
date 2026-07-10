import { type TSchema } from '@sinclair/typebox';
import { type Result } from 'neverthrow';

export interface AnnotationNamespaceDefinition {
  namespace: string;
  schema: TSchema;
  schemaHash: string;
  maxBytes: number;
  allowedActorTypes: readonly ('system' | 'admin')[];
  redactor: (annotation: Record<string, unknown>) => Record<string, unknown>;
}
export interface QueryFieldDefinition {
  name: string;
  path: readonly string[];
  scalar: 'string' | 'integer' | 'boolean';
  operators: readonly ('eq' | 'in')[];
  requiredIndex: string;
}
export interface CategorySchemaVersion {
  version: number;
  schema: TSchema;
  schemaHash: string;
  readable: boolean;
  writeEnabled: boolean;
  migrateToNext?: (payload: Record<string, unknown>) => Result<Record<string, unknown>, string>;
}
export interface CategoryDefinition {
  category: string;
  schemaVersions: readonly CategorySchemaVersion[];
  maxPayloadBytes: number;
  logicalKey: { pattern: RegExp; maxLength: number };
  target: { required: boolean; allowedTypes: readonly string[] } | null;
  redactor: (payload: Record<string, unknown>) => Record<string, unknown>;
  queryFields: readonly QueryFieldDefinition[];
  annotationNamespaces: readonly AnnotationNamespaceDefinition[];
  maxRecordsPerOwner: number;
  writeRateLimitPerMinute: number;
  adminPermission: string | null;
}
export interface ResolvedCategory {
  definition: CategoryDefinition;
  schemaVersion: CategorySchemaVersion;
}
