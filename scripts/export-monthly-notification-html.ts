import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import createPinoLogger, { type Logger } from 'pino';

import { makeDeliveryRepo, getErrorMessage } from '../src/modules/notification-delivery/index.js';

import type { UserDatabase } from '../src/infra/database/user/types.js';

const { Pool } = pg;

const DEFAULT_USER_ID = 'user_id';
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOT_ENV_FILE = path.join(PROJECT_ROOT, '.env');
const DEFAULT_OUTPUT_ROOT = path.join(PROJECT_ROOT, 'scripts', 'output', 'notification-previews');

const getArgValue = (name: string): string | undefined => {
  const arg = process.argv.find((entry) => entry.startsWith(`${name}=`));
  return arg?.slice(name.length + 1);
};

const createDbClient = <T>(connectionString: string, ssl: boolean): Kysely<T> => {
  return new Kysely<T>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 5,
        connectionTimeoutMillis: 30_000,
        idleTimeoutMillis: 60_000,
        ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      }),
    }),
  });
};

const sanitizePathSegment = (value: string): string => {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '_');
};

const main = async (): Promise<void> => {
  if (existsSync(ROOT_ENV_FILE)) {
    process.loadEnvFile(ROOT_ENV_FILE);
  }

  const logger: Logger = createPinoLogger({ level: process.env['LOG_LEVEL'] ?? 'info' });
  const userDbUrl = process.env['USER_DATABASE_URL'];
  if (userDbUrl === undefined || userDbUrl.length === 0) {
    throw new Error('USER_DATABASE_URL is required');
  }

  const periodKey = getArgValue('--period-key');
  if (periodKey === undefined || periodKey.length === 0) {
    throw new Error('--period-key is required');
  }

  const userId = getArgValue('--user-id') ?? DEFAULT_USER_ID;
  const outputRoot = getArgValue('--output-dir') ?? DEFAULT_OUTPUT_ROOT;
  const ssl = process.env['DATABASE_SSL'] === 'true';
  const deliveryKey = `digest:anaf_forexebug:${userId}:${periodKey}`;

  const userDb = createDbClient<UserDatabase>(userDbUrl, ssl);
  const deliveryRepo = makeDeliveryRepo({ db: userDb, logger });

  try {
    const outboxResult = await deliveryRepo.findByDeliveryKey(deliveryKey);
    if (outboxResult.isErr()) {
      throw new Error(getErrorMessage(outboxResult.error));
    }

    const outbox = outboxResult.value;
    if (outbox === null) {
      throw new Error(
        `No monthly digest outbox found for user '${userId}' and period '${periodKey}'`
      );
    }

    if (outbox.renderedHtml === null || outbox.renderedSubject === null) {
      throw new Error(`Outbox ${outbox.id} exists for '${periodKey}' but has no rendered HTML yet`);
    }

    const targetDir = path.join(
      outputRoot,
      sanitizePathSegment(userId),
      sanitizePathSegment(periodKey),
      sanitizePathSegment(outbox.id)
    );
    await mkdir(targetDir, { recursive: true });

    const htmlPath = path.join(targetDir, 'index.html');
    const textPath = path.join(targetDir, 'index.txt');
    const metaPath = path.join(targetDir, 'meta.json');

    await writeFile(htmlPath, outbox.renderedHtml, 'utf8');
    await writeFile(textPath, outbox.renderedText ?? '', 'utf8');
    await writeFile(
      metaPath,
      `${JSON.stringify(
        {
          userId,
          periodKey,
          deliveryKey,
          outboxId: outbox.id,
          status: outbox.status,
          subject: outbox.renderedSubject,
          templateName: outbox.templateName,
          templateVersion: outbox.templateVersion,
          resendEmailId: outbox.resendEmailId,
          sentAt: outbox.sentAt?.toISOString() ?? null,
          lastError: outbox.lastError,
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    console.log(
      JSON.stringify(
        {
          userId,
          periodKey,
          outboxId: outbox.id,
          status: outbox.status,
          subject: outbox.renderedSubject,
          htmlPath,
          textPath,
          metaPath,
        },
        null,
        2
      )
    );
  } finally {
    await userDb.destroy();
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
