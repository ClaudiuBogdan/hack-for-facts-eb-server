import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makePublicDebateSelfSendContextLookup } from '@/app/public-debate-self-send-context-lookup.js';
import { DEBATE_REQUEST_INTERACTION_ID } from '@/common/public-debate-request.js';
import { createConfig, parseEnv } from '@/infra/config/index.js';
import { initDatabases } from '@/infra/database/client.js';
import { buildSelfSendInteractionKey } from '@/modules/institution-correspondence/index.js';

import { dockerAvailable } from './setup.js';
import { createTestInteractiveRecord } from '../fixtures/fakes.js';

const USER_INTERACTIONS_SCHEMA = `
CREATE SEQUENCE userinteractions_updated_seq;

CREATE TABLE UserInteractions (
  user_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  record JSONB NOT NULL,
  audit_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_seq BIGINT NOT NULL DEFAULT nextval('userinteractions_updated_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, record_key)
);
`;

const testLogger = pinoLogger({ level: 'silent' });

interface StartedTestDatabase {
  connectionString: string;
  userDb: ReturnType<typeof initDatabases>['userDb'];
  stop: () => Promise<void>;
}

interface InsertInteractionInput {
  userId: string;
  recordKey: string;
  entityCui: string;
  ngoSenderEmail: string;
  preparedSubject: string;
  institutionEmail?: string;
  submittedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

async function withPgClient<T>(
  connectionString: string,
  callback: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function startTestDatabase(): Promise<StartedTestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const connectionString = container.getConnectionUri();

  await withPgClient(connectionString, async (client) => {
    await client.query(USER_INTERACTIONS_SCHEMA);
  });

  const config = createConfig(
    parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      BUDGET_DATABASE_URL: connectionString,
      INS_DATABASE_URL: connectionString,
      USER_DATABASE_URL: connectionString,
      API_BASE_URL: 'https://api.transparenta.test',
    })
  );
  const clients = initDatabases(config);

  return {
    connectionString,
    userDb: clients.userDb,
    stop: async () => {
      await clients.budgetDb.destroy();
      await clients.insDb.destroy();
      await clients.userDb.destroy();
      await container.stop();
    },
  };
}

async function insertSendYourselfInteraction(
  client: pg.Client,
  input: InsertInteractionInput
): Promise<void> {
  const institutionEmail = input.institutionEmail ?? 'contact@primarie.ro';
  const updatedAt = input.updatedAt ?? '2026-04-01T10:00:00.000Z';
  const submittedAt = input.submittedAt ?? updatedAt;
  const createdAt = input.createdAt ?? updatedAt;

  const record = createTestInteractiveRecord({
    key: input.recordKey,
    interactionId: DEBATE_REQUEST_INTERACTION_ID,
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui: input.entityCui },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          primariaEmail: institutionEmail,
          isNgo: true,
          organizationName: 'Asociatia Test',
          ngoSenderEmail: input.ngoSenderEmail,
          preparedSubject: input.preparedSubject,
          threadKey: null,
          submissionPath: 'send_yourself',
          submittedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt,
  });

  await client.query(
    `
      INSERT INTO UserInteractions (user_id, record_key, record, audit_events, created_at, updated_at)
      VALUES ($1, $2, $3::jsonb, '[]'::jsonb, $4::timestamptz, $5::timestamptz)
    `,
    [input.userId, input.recordKey, JSON.stringify(record), createdAt, updatedAt]
  );
}

describe('Public debate self-send context lookup', () => {
  it('resolves a hashed Funky interaction key', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const subject = 'Cerere organizare dezbatere publica - Oras Test - buget local 2026';
    const hashedKey = buildSelfSendInteractionKey('ngo@example.com', subject);

    try {
      await withPgClient(database.connectionString, async (client) => {
        await insertSendYourselfInteraction(client, {
          userId: 'user-hashed',
          recordKey: 'funky:interaction:public_debate_request::entity:12345678::hashed',
          entityCui: '12345678',
          ngoSenderEmail: 'ngo@example.com',
          preparedSubject: subject,
        });
      });

      const lookup = makePublicDebateSelfSendContextLookup({
        db: database.userDb,
        logger: testLogger,
      });
      const result = await lookup.findByInteractionKey(hashedKey);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({
        context: expect.objectContaining({
          userId: 'user-hashed',
          recordKey: 'funky:interaction:public_debate_request::entity:12345678::hashed',
          entityCui: '12345678',
          ngoSenderEmail: 'ngo@example.com',
          preparedSubject: subject,
        }),
        interactionKey: hashedKey,
        matchCount: 1,
      });
    } finally {
      await database.stop();
    }
  });

  it('returns null for a legacy newline interaction key', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const subject = 'Cerere organizare dezbatere publica - Oras Test - buget local 2026';
    const legacyKey =
      'ngo@example.com\ncerere organizare dezbatere publica - oras test - buget local 2026';

    try {
      await withPgClient(database.connectionString, async (client) => {
        await insertSendYourselfInteraction(client, {
          userId: 'user-legacy',
          recordKey: 'funky:interaction:public_debate_request::entity:12345678::legacy',
          entityCui: '12345678',
          ngoSenderEmail: 'ngo@example.com',
          preparedSubject: subject,
        });
      });

      const lookup = makePublicDebateSelfSendContextLookup({
        db: database.userDb,
        logger: testLogger,
      });
      const result = await lookup.findByInteractionKey(legacyKey);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    } finally {
      await database.stop();
    }
  });

  it('returns null for an unmatched hashed interaction key', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();

    try {
      const lookup = makePublicDebateSelfSendContextLookup({
        db: database.userDb,
        logger: testLogger,
      });
      const result = await lookup.findByInteractionKey(
        buildSelfSendInteractionKey('missing@example.com', 'Missing subject')
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    } finally {
      await database.stop();
    }
  });

  it('prefers the newest submitted match when duplicate self-send contexts exist', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const subject = 'Cerere organizare dezbatere publica - Duplicat';
    const hashedKey = buildSelfSendInteractionKey('ngo@example.com', subject);

    try {
      await withPgClient(database.connectionString, async (client) => {
        await insertSendYourselfInteraction(client, {
          userId: 'user-older',
          recordKey: 'funky:interaction:public_debate_request::entity:12345678::older',
          entityCui: '12345678',
          ngoSenderEmail: 'ngo@example.com',
          preparedSubject: subject,
          submittedAt: '2026-04-01T09:00:00.000Z',
          createdAt: '2026-04-01T09:00:00.000Z',
          updatedAt: '2026-04-01T09:00:00.000Z',
        });
        await insertSendYourselfInteraction(client, {
          userId: 'user-newer',
          recordKey: 'funky:interaction:public_debate_request::entity:12345678::newer',
          entityCui: '12345678',
          ngoSenderEmail: 'ngo@example.com',
          preparedSubject: subject,
          submittedAt: '2026-04-02T09:00:00.000Z',
          createdAt: '2026-03-31T09:00:00.000Z',
          updatedAt: '2026-03-31T09:00:00.000Z',
        });
      });

      const lookup = makePublicDebateSelfSendContextLookup({
        db: database.userDb,
        logger: testLogger,
      });
      const result = await lookup.findByInteractionKey(hashedKey);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({
        context: expect.objectContaining({
          userId: 'user-newer',
          recordKey: 'funky:interaction:public_debate_request::entity:12345678::newer',
        }),
        interactionKey: hashedKey,
        matchCount: 2,
      });
    } finally {
      await database.stop();
    }
  });
});
