/**
 * Redesign entrypoint config (foundation §10).
 *
 * Validates ONLY the kernel-owned env. The redesign server must NOT require the
 * legacy BUDGET/INS/USER/Clerk envs. Throws on a missing required var so boot
 * fails fast. Secrets are never logged.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const RedesignEnvSchema = Type.Object({
  // Postgres is the only hard requirement — the server must boot and /health
  // must be able to report aux services down rather than crashing at boot.
  PROD_DATABASE_URL: Type.String({ minLength: 1 }),
  PROD_MEILI_HOST: Type.String({ default: '' }),
  PROD_MEILI_API_KEY: Type.String({ default: '' }),
  PROD_OPENSEARCH_URL: Type.String({ default: '' }),
  PORT: Type.Optional(Type.String()),
  HOST: Type.Optional(Type.String()),
  // Optional AI surface (ask/embeddings). Disabled when unset.
  PROD_SYNTHETIC_BASE_URL: Type.Optional(Type.String()),
  PROD_SYNTHETIC_API_KEY: Type.Optional(Type.String()),
  PROD_EMBEDDING_MODEL: Type.Optional(Type.String()),
  PROD_AI_MODEL: Type.Optional(Type.String()),
  PROD_CLIENT_BASE_URL: Type.Optional(Type.String()),
  PROD_DB_POOL_MAX: Type.Optional(Type.String()),
  PROD_DB_SSL: Type.Optional(Type.String()),
  LOG_LEVEL: Type.Optional(Type.String()),
});

export type RedesignEnv = Static<typeof RedesignEnvSchema>;

export interface RedesignConfig {
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly kernel: {
    readonly prodDatabaseUrl: string;
    readonly meiliHost: string;
    readonly meiliApiKey: string;
    readonly opensearchUrl: string;
    readonly poolMax?: number;
    readonly dbSsl?: boolean;
    readonly syntheticBaseUrl?: string;
    readonly syntheticApiKey?: string;
    readonly embeddingModel?: string;
    readonly chatModel?: string;
    readonly clientBaseUrl?: string;
  };
}

const parseIntOr = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const loadRedesignConfig = (env: NodeJS.ProcessEnv): RedesignConfig => {
  const cleaned = Value.Clean(RedesignEnvSchema, Value.Convert(RedesignEnvSchema, { ...env }));
  if (!Value.Check(RedesignEnvSchema, cleaned)) {
    const errors = [...Value.Errors(RedesignEnvSchema, cleaned)].map(
      (e) => `${e.path}: ${e.message}`
    );
    throw new Error(`Invalid redesign env:\n${errors.join('\n')}`);
  }
  const e = cleaned;

  return {
    port: parseIntOr(e.PORT, 3010),
    host: e.HOST ?? '0.0.0.0',
    logLevel: e.LOG_LEVEL ?? 'info',
    kernel: {
      prodDatabaseUrl: e.PROD_DATABASE_URL,
      meiliHost: e.PROD_MEILI_HOST,
      meiliApiKey: e.PROD_MEILI_API_KEY,
      opensearchUrl: e.PROD_OPENSEARCH_URL,
      ...(e.PROD_DB_POOL_MAX !== undefined && { poolMax: parseIntOr(e.PROD_DB_POOL_MAX, 15) }),
      ...(e.PROD_DB_SSL !== undefined && { dbSsl: e.PROD_DB_SSL === 'true' }),
      ...(e.PROD_SYNTHETIC_BASE_URL !== undefined && { syntheticBaseUrl: e.PROD_SYNTHETIC_BASE_URL }),
      ...(e.PROD_SYNTHETIC_API_KEY !== undefined && { syntheticApiKey: e.PROD_SYNTHETIC_API_KEY }),
      ...(e.PROD_EMBEDDING_MODEL !== undefined && { embeddingModel: e.PROD_EMBEDDING_MODEL }),
      ...(e.PROD_AI_MODEL !== undefined && { chatModel: e.PROD_AI_MODEL }),
      ...(e.PROD_CLIENT_BASE_URL !== undefined && { clientBaseUrl: e.PROD_CLIENT_BASE_URL }),
    },
  };
};
