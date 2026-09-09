/**
 * Redesign entrypoint config (foundation §10).
 *
 * Validates ONLY the kernel-owned env. The redesign server must NOT require the
 * legacy BUDGET/INS/USER/Clerk envs. Throws on a missing required var so boot
 * fails fast. Secrets are never logged.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { parseTrustProxy, type TrustProxySetting } from './trust-proxy.js';

const RedesignEnvSchema = Type.Object({
  // Postgres is the only hard requirement — the server must boot and /health
  // must be able to report aux services down rather than crashing at boot.
  PROD_DATABASE_URL: Type.String({ minLength: 1 }),
  PROD_MEILI_HOST: Type.String({ default: '' }),
  PROD_MEILI_API_KEY: Type.String({ default: '' }),
  /** Search-only Meili key (preferred over the master key for read paths). */
  PROD_MEILI_SEARCH_API_KEY: Type.Optional(Type.String()),
  /** Comma-separated Meili index names the global search queries (default `entities`). */
  PROD_MEILI_INDEXES: Type.Optional(Type.String()),
  PROD_OPENSEARCH_URL: Type.String({ default: '' }),
  PROD_OPENSEARCH_USERNAME: Type.Optional(Type.String()),
  PROD_OPENSEARCH_PASSWORD: Type.Optional(Type.String()),
  /** Private CA PEM path for authenticated HTTPS OpenSearch. */
  PROD_OPENSEARCH_CA_FILE: Type.Optional(Type.String()),
  /** Certificate SAN used when the private endpoint hostname is not in the node certificate. */
  PROD_OPENSEARCH_TLS_SERVERNAME: Type.Optional(Type.String()),
  PORT: Type.Optional(Type.String()),
  HOST: Type.Optional(Type.String()),
  // Optional AI surface (ask/embeddings). Disabled when unset.
  PROD_SYNTHETIC_BASE_URL: Type.Optional(Type.String()),
  PROD_SYNTHETIC_API_KEY: Type.Optional(Type.String()),
  PROD_EMBEDDING_MODEL: Type.Optional(Type.String()),
  PROD_AI_MODEL: Type.Optional(Type.String()),
  PROD_CLIENT_BASE_URL: Type.Optional(Type.String()),
  /** Extra browser origins allowed cross-origin in prod (comma-separated). */
  PROD_ALLOWED_ORIGINS: Type.Optional(Type.String()),
  PROD_DB_POOL_MAX: Type.Optional(Type.String()),
  PROD_DB_SSL: Type.Optional(Type.String()),
  LOG_LEVEL: Type.Optional(Type.String()),
  USER_DATA_DATABASE_URL: Type.Optional(Type.String({ minLength: 1 })),
  USER_DATA_DB_CA_FILE: Type.Optional(Type.String({ minLength: 1 })),
  USER_DATA_DB_TLS_SERVERNAME: Type.Optional(Type.String({ minLength: 1 })),
  CLERK_WEBHOOK_SIGNING_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  CLERK_SECRET_KEY: Type.Optional(Type.String({ minLength: 1 })),
  CLERK_JWT_KEY: Type.Optional(Type.String({ minLength: 1 })),
  CLERK_ISSUER: Type.Optional(Type.String({ minLength: 1 })),
  CLERK_AUTHORIZED_PARTIES: Type.Optional(Type.String({ minLength: 1 })),
  // ── behind-proxy client identity (review X/F15) ─────────────────────────
  // Rate limits key on the client IP; trusting X-Forwarded-For is only correct
  // behind a gateway that sets it. Same contract as the legacy server
  // (`trust-proxy.ts`): true/false, hop count, or a proxy list; default on.
  TRUST_PROXY: Type.Optional(Type.String()),
  // ── procurement analytics + record-list search (review X/F13) ──────────
  PROD_CLICKHOUSE_URL: Type.Optional(Type.String()),
  PROD_CLICKHOUSE_DATABASE: Type.Optional(Type.String({ minLength: 1 })),
  PROD_CLICKHOUSE_USER: Type.Optional(Type.String({ minLength: 1 })),
  PROD_CLICKHOUSE_PASSWORD: Type.Optional(Type.String()),
  PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS: Type.Optional(Type.String()),
  PROCUREMENT_SEARCH_OPENSEARCH_URL: Type.Optional(Type.String()),
  PROCUREMENT_SEARCH_OPENSEARCH_INDEXES: Type.Optional(Type.String()),
  PROCUREMENT_SEARCH_OPENSEARCH_CA_FILE: Type.Optional(Type.String()),
  PROCUREMENT_SEARCH_OPENSEARCH_USERNAME: Type.Optional(Type.String()),
  PROCUREMENT_SEARCH_OPENSEARCH_PASSWORD: Type.Optional(Type.String()),
  PROCUREMENT_SEARCH_OPENSEARCH_TLS_SERVERNAME: Type.Optional(Type.String()),
  // ── legal search engine (review X/F13) ──────────────────────────────────
  LEGAL_SEARCH_OPENSEARCH_URL: Type.Optional(Type.String()),
  LEGAL_SEARCH_OPENSEARCH_ACTS_INDEX: Type.Optional(Type.String()),
  LEGAL_SEARCH_OPENSEARCH_SECTIONS_INDEX: Type.Optional(Type.String()),
  LEGAL_SEARCH_OPENSEARCH_CA_FILE: Type.Optional(Type.String()),
  LEGAL_SEARCH_OPENSEARCH_USERNAME: Type.Optional(Type.String()),
  LEGAL_SEARCH_OPENSEARCH_PASSWORD: Type.Optional(Type.String()),
  LEGAL_SEARCH_OPENSEARCH_TLS_SERVERNAME: Type.Optional(Type.String()),
});

export type RedesignEnv = Static<typeof RedesignEnvSchema>;

/** An OpenSearch connection for a module's own search index(es); CA is a file path, read by the composer. */
export interface ModuleSearchConnection {
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  readonly caFile?: string;
  readonly tlsServername?: string;
}

/** Procurement composition settings (validated here, threaded through the app deps). */
export interface ProcurementComposition {
  readonly daListMaxWindowDays?: number;
  readonly clickhouse?: {
    readonly url: string;
    readonly database: string;
    readonly user?: string;
    readonly password?: string;
  };
  /** Present only when the per-grain index map names at least one grain. */
  readonly search?: ModuleSearchConnection & { readonly indexes: Readonly<Record<string, string>> };
}

/** Legal search composition: present only when an acts or sections alias is named. */
export interface LegalSearchComposition extends ModuleSearchConnection {
  readonly actsIndex?: string;
  readonly sectionsIndex?: string;
}

export interface RedesignConfig {
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  /** Fastify `trustProxy` (boolean, hop count, or proxy list); default true behind the gateway. */
  readonly trustProxy: TrustProxySetting;
  readonly procurement: ProcurementComposition;
  readonly legalSearch?: LegalSearchComposition;
  /** Extra browser origins allowed cross-origin in prod (from PROD_ALLOWED_ORIGINS). */
  readonly corsAllowedOrigins: readonly string[];
  readonly auth?: {
    readonly jwtKey: string;
    readonly issuer: string;
    readonly authorizedParties: readonly string[];
  };
  readonly userData?: {
    readonly url: string;
    readonly caFile: string;
    readonly tlsServername?: string;
    readonly webhookSigningSecret: string;
    readonly clerkSecretKey?: string;
  };
  readonly kernel: {
    readonly prodDatabaseUrl: string;
    readonly meiliHost: string;
    readonly meiliApiKey: string;
    /** Search-only Meili key; the kernel falls back to `meiliApiKey` when unset. */
    readonly meiliSearchApiKey?: string;
    /** Meili indexes the global search queries (from PROD_MEILI_INDEXES). */
    readonly meiliIndexes?: readonly string[];
    readonly opensearchUrl: string;
    readonly opensearchUsername?: string;
    readonly opensearchPassword?: string;
    readonly opensearchCaFile?: string;
    readonly opensearchTlsServername?: string;
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
  const converted = Value.Convert(RedesignEnvSchema, { ...env });
  const defaulted = Value.Default(RedesignEnvSchema, converted);
  const cleaned = Value.Clean(RedesignEnvSchema, defaulted);
  if (!Value.Check(RedesignEnvSchema, cleaned)) {
    const errors = [...Value.Errors(RedesignEnvSchema, cleaned)].map(
      (e) => `${e.path}: ${e.message}`
    );
    throw new Error(`Invalid redesign env:\n${errors.join('\n')}`);
  }
  const e = cleaned;

  const splitCsv = (raw: string | undefined): readonly string[] =>
    raw === undefined
      ? []
      : raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
  const meiliIndexes = splitCsv(e.PROD_MEILI_INDEXES);
  const authConfigured =
    e.CLERK_JWT_KEY !== undefined ||
    e.CLERK_ISSUER !== undefined ||
    e.CLERK_AUTHORIZED_PARTIES !== undefined;
  const authorizedParties = splitCsv(e.CLERK_AUTHORIZED_PARTIES);
  const isOrigin = (value: string): boolean => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  };
  let auth: RedesignConfig['auth'];
  if (authConfigured) {
    const jwtKey = e.CLERK_JWT_KEY;
    const issuer = e.CLERK_ISSUER;
    if (jwtKey === undefined || issuer === undefined || authorizedParties.length === 0)
      throw new Error('Clerk auth requires a JWT public key, issuer and authorized parties');
    if (!isOrigin(issuer) || authorizedParties.some((origin) => !isOrigin(origin)))
      throw new Error(
        'Clerk issuer and authorized parties must be explicit HTTPS or loopback origins'
      );
    auth = { jwtKey, issuer, authorizedParties };
  }

  let userData: RedesignConfig['userData'];
  if (
    [
      e.USER_DATA_DATABASE_URL,
      e.USER_DATA_DB_CA_FILE,
      e.USER_DATA_DB_TLS_SERVERNAME,
      e.CLERK_WEBHOOK_SIGNING_SECRET,
    ].some((value) => value !== undefined)
  ) {
    if (
      auth === undefined ||
      e.USER_DATA_DATABASE_URL === undefined ||
      e.USER_DATA_DB_CA_FILE === undefined ||
      e.CLERK_WEBHOOK_SIGNING_SECRET === undefined
    )
      throw new Error(
        'User data requires Clerk auth, a dedicated database URL, CA and webhook secret'
      );
    userData = {
      ...(e.CLERK_SECRET_KEY === undefined ? {} : { clerkSecretKey: e.CLERK_SECRET_KEY }),
      url: e.USER_DATA_DATABASE_URL,
      caFile: e.USER_DATA_DB_CA_FILE,
      webhookSigningSecret: e.CLERK_WEBHOOK_SIGNING_SECRET,
      ...(e.USER_DATA_DB_TLS_SERVERNAME !== undefined && {
        tlsServername: e.USER_DATA_DB_TLS_SERVERNAME,
      }),
    };
  }

  // Module search connections: a dedicated *_URL overrides the kernel-wide
  // PROD_OPENSEARCH_* connection; the path turns on only when its index map /
  // aliases are named explicitly. TLS: *_CA_FILE pins the private CA and
  // *_TLS_SERVERNAME must be a cert SAN.
  const nonEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value === '' ? undefined : value;
  const searchConnection = (dedicated: {
    readonly url?: string;
    readonly caFile?: string;
    readonly username?: string;
    readonly password?: string;
    readonly tlsServername?: string;
  }): ModuleSearchConnection | undefined => {
    const url = nonEmpty(dedicated.url ?? e.PROD_OPENSEARCH_URL);
    if (url === undefined) return undefined;
    const caFile = nonEmpty(dedicated.caFile ?? e.PROD_OPENSEARCH_CA_FILE);
    const username = dedicated.username ?? e.PROD_OPENSEARCH_USERNAME;
    const password = dedicated.password ?? e.PROD_OPENSEARCH_PASSWORD;
    const tlsServername = dedicated.tlsServername ?? e.PROD_OPENSEARCH_TLS_SERVERNAME;
    return {
      url,
      ...(username !== undefined && { username }),
      ...(password !== undefined && { password }),
      ...(caFile !== undefined && { caFile }),
      ...(tlsServername !== undefined && { tlsServername }),
    };
  };
  const procurementIndexes = Object.fromEntries(
    splitCsv(e.PROCUREMENT_SEARCH_OPENSEARCH_INDEXES)
      .map((pair) => pair.split(':').map((s) => s.trim()))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== '' && kv[1] !== '')
  );
  const procurementSearch = searchConnection({
    ...(e.PROCUREMENT_SEARCH_OPENSEARCH_URL !== undefined && {
      url: e.PROCUREMENT_SEARCH_OPENSEARCH_URL,
    }),
    ...(e.PROCUREMENT_SEARCH_OPENSEARCH_CA_FILE !== undefined && {
      caFile: e.PROCUREMENT_SEARCH_OPENSEARCH_CA_FILE,
    }),
    ...(e.PROCUREMENT_SEARCH_OPENSEARCH_USERNAME !== undefined && {
      username: e.PROCUREMENT_SEARCH_OPENSEARCH_USERNAME,
    }),
    ...(e.PROCUREMENT_SEARCH_OPENSEARCH_PASSWORD !== undefined && {
      password: e.PROCUREMENT_SEARCH_OPENSEARCH_PASSWORD,
    }),
    ...(e.PROCUREMENT_SEARCH_OPENSEARCH_TLS_SERVERNAME !== undefined && {
      tlsServername: e.PROCUREMENT_SEARCH_OPENSEARCH_TLS_SERVERNAME,
    }),
  });
  const daWindow = parseIntOr(e.PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS, 0);
  const clickhouseUrl = nonEmpty(e.PROD_CLICKHOUSE_URL);
  const procurement: ProcurementComposition = {
    ...(daWindow > 0 && { daListMaxWindowDays: daWindow }),
    ...(clickhouseUrl !== undefined && {
      clickhouse: {
        url: clickhouseUrl,
        database: e.PROD_CLICKHOUSE_DATABASE ?? 'proto',
        ...(e.PROD_CLICKHOUSE_USER !== undefined && { user: e.PROD_CLICKHOUSE_USER }),
        ...(e.PROD_CLICKHOUSE_PASSWORD !== undefined && { password: e.PROD_CLICKHOUSE_PASSWORD }),
      },
    }),
    ...(procurementSearch !== undefined &&
      Object.keys(procurementIndexes).length > 0 && {
        search: { ...procurementSearch, indexes: procurementIndexes },
      }),
  };
  const legalActsIndex = nonEmpty(e.LEGAL_SEARCH_OPENSEARCH_ACTS_INDEX);
  const legalSectionsIndex = nonEmpty(e.LEGAL_SEARCH_OPENSEARCH_SECTIONS_INDEX);
  const legalConnection = searchConnection({
    ...(e.LEGAL_SEARCH_OPENSEARCH_URL !== undefined && { url: e.LEGAL_SEARCH_OPENSEARCH_URL }),
    ...(e.LEGAL_SEARCH_OPENSEARCH_CA_FILE !== undefined && {
      caFile: e.LEGAL_SEARCH_OPENSEARCH_CA_FILE,
    }),
    ...(e.LEGAL_SEARCH_OPENSEARCH_USERNAME !== undefined && {
      username: e.LEGAL_SEARCH_OPENSEARCH_USERNAME,
    }),
    ...(e.LEGAL_SEARCH_OPENSEARCH_PASSWORD !== undefined && {
      password: e.LEGAL_SEARCH_OPENSEARCH_PASSWORD,
    }),
    ...(e.LEGAL_SEARCH_OPENSEARCH_TLS_SERVERNAME !== undefined && {
      tlsServername: e.LEGAL_SEARCH_OPENSEARCH_TLS_SERVERNAME,
    }),
  });
  const legalSearch: LegalSearchComposition | undefined =
    legalConnection !== undefined &&
    (legalActsIndex !== undefined || legalSectionsIndex !== undefined)
      ? {
          ...legalConnection,
          ...(legalActsIndex !== undefined && { actsIndex: legalActsIndex }),
          ...(legalSectionsIndex !== undefined && { sectionsIndex: legalSectionsIndex }),
        }
      : undefined;
  return {
    ...(auth !== undefined && { auth }),
    ...(userData !== undefined && { userData }),
    trustProxy: parseTrustProxy(e.TRUST_PROXY) ?? true,
    procurement,
    ...(legalSearch !== undefined && { legalSearch }),
    port: parseIntOr(e.PORT, 3010),
    host: e.HOST ?? '0.0.0.0',
    logLevel: e.LOG_LEVEL ?? 'info',
    corsAllowedOrigins:
      e.PROD_ALLOWED_ORIGINS === undefined
        ? []
        : e.PROD_ALLOWED_ORIGINS.split(',')
            .map((o) => o.trim())
            .filter((o) => o !== ''),
    kernel: {
      prodDatabaseUrl: e.PROD_DATABASE_URL,
      meiliHost: e.PROD_MEILI_HOST,
      meiliApiKey: e.PROD_MEILI_API_KEY,
      ...(e.PROD_MEILI_SEARCH_API_KEY !== undefined && {
        meiliSearchApiKey: e.PROD_MEILI_SEARCH_API_KEY,
      }),
      ...(meiliIndexes.length > 0 && { meiliIndexes }),
      opensearchUrl: e.PROD_OPENSEARCH_URL,
      ...(e.PROD_OPENSEARCH_USERNAME !== undefined && {
        opensearchUsername: e.PROD_OPENSEARCH_USERNAME,
      }),
      ...(e.PROD_OPENSEARCH_PASSWORD !== undefined && {
        opensearchPassword: e.PROD_OPENSEARCH_PASSWORD,
      }),
      ...(e.PROD_OPENSEARCH_CA_FILE !== undefined && {
        opensearchCaFile: e.PROD_OPENSEARCH_CA_FILE,
      }),
      ...(e.PROD_OPENSEARCH_TLS_SERVERNAME !== undefined && {
        opensearchTlsServername: e.PROD_OPENSEARCH_TLS_SERVERNAME,
      }),
      ...(e.PROD_DB_POOL_MAX !== undefined && { poolMax: parseIntOr(e.PROD_DB_POOL_MAX, 15) }),
      ...(e.PROD_DB_SSL !== undefined && { dbSsl: e.PROD_DB_SSL === 'true' }),
      ...(e.PROD_SYNTHETIC_BASE_URL !== undefined && {
        syntheticBaseUrl: e.PROD_SYNTHETIC_BASE_URL,
      }),
      ...(e.PROD_SYNTHETIC_API_KEY !== undefined && { syntheticApiKey: e.PROD_SYNTHETIC_API_KEY }),
      ...(e.PROD_EMBEDDING_MODEL !== undefined && { embeddingModel: e.PROD_EMBEDDING_MODEL }),
      ...(e.PROD_AI_MODEL !== undefined && { chatModel: e.PROD_AI_MODEL }),
      ...(e.PROD_CLIENT_BASE_URL !== undefined && { clientBaseUrl: e.PROD_CLIENT_BASE_URL }),
    },
  };
};
