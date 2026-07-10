import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  MAX_DATASET_REQUEST_NOTE_LENGTH,
  type InsDatasetRequest,
  type InsDatasetRequestInput,
} from '@/modules/ins/core/dataset-requests.js';
import { createInsDatasetRequest } from '@/modules/ins/core/usecases/create-ins-dataset-request.js';

import type {
  InsDatasetCatalogReader,
  InsDatasetRequestRepository,
} from '@/modules/ins/core/ports.js';

/** In-memory fake standing in for the user-database repository. */
const makeFakeRepo = (): InsDatasetRequestRepository & { created: InsDatasetRequestInput[] } => {
  const created: InsDatasetRequestInput[] = [];

  return {
    created,
    create: async (input) => {
      created.push(input);
      const request: InsDatasetRequest = {
        id: `req-${String(created.length)}`,
        dataset_code: input.dataset_code,
        siruta: input.siruta ?? null,
        created_at: new Date('2026-07-09T00:00:00.000Z'),
      };
      return ok(request);
    },
  };
};

/** In-memory catalog fake; knows POP107D and SOM103A only. */
const makeFakeCatalog = (
  known: readonly string[] = ['POP107D', 'SOM103A']
): InsDatasetCatalogReader => ({
  datasetExists: async (code) => ok(known.includes(code)),
});

const deps = (repo: InsDatasetRequestRepository, catalog?: InsDatasetCatalogReader) => ({
  datasetRequestRepo: repo,
  datasetCatalog: catalog ?? makeFakeCatalog(),
});

describe('createInsDatasetRequest', () => {
  it('normalizes the dataset code and persists the request', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), {
      datasetCode: '  pop107d  ',
      siruta: ' 54975 ',
      note: ' need this ',
      clerkUserId: 'user_1',
    });

    expect(result.isOk()).toBe(true);
    expect(repo.created).toEqual([
      { dataset_code: 'POP107D', siruta: '54975', note: 'need this', clerk_user_id: 'user_1' },
    ]);
  });

  it('drops contact_email and note on an anonymous submission', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), {
      datasetCode: 'POP107D',
      siruta: '54975',
      contactEmail: 'a@b.ro',
      note: 'I am Ana',
    });

    // Accepted, but the anonymizer could never reach this row's PII, so it is
    // never written. The aggregate signal survives.
    expect(result.isOk()).toBe(true);
    expect(repo.created).toEqual([{ dataset_code: 'POP107D', siruta: '54975' }]);
  });

  it('does not reject an anonymous submission carrying a malformed email', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), {
      datasetCode: 'POP107D',
      contactEmail: 'not-an-email',
      note: 'x'.repeat(5000),
    });

    expect(result.isOk()).toBe(true);
    expect(repo.created[0]).toEqual({ dataset_code: 'POP107D' });
  });

  it('allows an anonymous request with no contact email or user id', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), { datasetCode: 'POP107D' });

    expect(result.isOk()).toBe(true);
    expect(repo.created[0]).toEqual({ dataset_code: 'POP107D' });
  });

  it('attaches the Clerk user id when the caller is authenticated', async () => {
    const repo = makeFakeRepo();

    await createInsDatasetRequest(deps(repo), { datasetCode: 'POP107D', clerkUserId: 'user_123' });

    expect(repo.created[0]?.clerk_user_id).toBe('user_123');
  });

  it('rejects a blank dataset code without touching the repository', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), { datasetCode: '   ' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
    }
    expect(repo.created).toHaveLength(0);
  });

  it('rejects a note longer than the documented maximum', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), {
      datasetCode: 'POP107D',
      clerkUserId: 'user_1',
      note: 'x'.repeat(MAX_DATASET_REQUEST_NOTE_LENGTH + 1),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
      expect(result.error).toHaveProperty('field', 'note');
    }
    expect(repo.created).toHaveLength(0);
  });

  it('accepts a note exactly at the maximum length', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), {
      datasetCode: 'POP107D',
      clerkUserId: 'user_1',
      note: 'x'.repeat(MAX_DATASET_REQUEST_NOTE_LENGTH),
    });

    expect(result.isOk()).toBe(true);
  });

  it('accepts a well-formed contact email', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), {
      datasetCode: 'POP107D',
      clerkUserId: 'user_1',
      contactEmail: ' Ana@example.ro ',
    });

    expect(result.isOk()).toBe(true);
    expect(repo.created[0]?.contact_email).toBe('Ana@example.ro');
  });

  it('rejects a dataset code that is not in the catalog', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), { datasetCode: 'NOT_A_DATASET' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
      expect(result.error).toHaveProperty('field', 'datasetCode');
    }
    expect(repo.created).toHaveLength(0);
  });

  it('checks the catalog with the normalized upper-case code', async () => {
    const repo = makeFakeRepo();
    const seen: string[] = [];
    const catalog = {
      datasetExists: async (code: string) => {
        seen.push(code);
        return ok(true);
      },
    };

    await createInsDatasetRequest(deps(repo, catalog), { datasetCode: ' pop107d ' });

    expect(seen).toEqual(['POP107D']);
  });

  it.each(['a@b..com', 'a..b@c.ro', '.a@b.ro', 'a.@b.ro', 'a@.b.ro', 'a@b'])(
    'rejects the malformed contact email %s',
    async (email) => {
      const repo = makeFakeRepo();

      const result = await createInsDatasetRequest(deps(repo), {
        datasetCode: 'POP107D',
        clerkUserId: 'user_1',
        contactEmail: email,
      });

      expect(result.isErr()).toBe(true);
      expect(repo.created).toHaveLength(0);
    }
  );

  it('accepts a dotted local part and multi-label domain', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), {
      datasetCode: 'POP107D',
      clerkUserId: 'user_1',
      contactEmail: 'first.last@sub.example.co.uk',
    });

    expect(result.isOk()).toBe(true);
    expect(repo.created[0]?.contact_email).toBe('first.last@sub.example.co.uk');
  });

  it('rejects a malformed contact email', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), {
      datasetCode: 'POP107D',
      clerkUserId: 'user_1',
      contactEmail: 'not-an-email',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toHaveProperty('field', 'contactEmail');
    }
    expect(repo.created).toHaveLength(0);
  });

  it('treats a whitespace-only note and email as absent', async () => {
    const repo = makeFakeRepo();

    const result = await createInsDatasetRequest(deps(repo), {
      datasetCode: 'POP107D',
      clerkUserId: 'user_1',
      note: '   ',
      contactEmail: '  ',
    });

    expect(result.isOk()).toBe(true);
    expect(repo.created[0]).toEqual({ dataset_code: 'POP107D', clerk_user_id: 'user_1' });
  });
});
