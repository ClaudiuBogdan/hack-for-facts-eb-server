import { beforeEach, expect, it } from 'vitest';

import { makeCategoryRegistry } from '@/modules/user-data/core/registry/registry.js';
import { makeUserDataAdminReadRepo } from '@/modules/user-data/shell/repo/kysely-user-data-admin-read-repo.js';
import { makeUserDataMutationRepo } from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';

import { truncateUserDataTables } from './contract-db.js';
import {
  makePlannedMutation,
  makeReceiptClaim,
  makeRecordIdentity,
  userDataEventId,
  userDataRecordId,
} from '../../fixtures/user-data/index.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { expectOk, makeTestClock } from '../../support/index.js';
import { makeDefinition } from '../../unit/user-data/fixtures.js';

const START = new Date('2026-01-01T00:00:00.000Z');

beforeEach(async () => {
  const { userDb } = await setupTestDatabase();
  await truncateUserDataTables(userDb);
});

it('keeps category scope while applying registered payload and annotation filters', async () => {
  const { userDb } = await setupTestDatabase();
  const clock = makeTestClock(START);
  const mutation = makeUserDataMutationRepo({ db: userDb, clock });
  const definition = {
    ...makeDefinition(),
    queryFields: [
      {
        name: 'value',
        path: ['value'],
        scalar: 'string' as const,
        operators: ['eq', 'in'] as const,
        requiredIndex: 'idx_test_value',
      },
      {
        name: 'reviewStatus',
        path: ['annotations', 'review', 'status'],
        scalar: 'string' as const,
        operators: ['eq'] as const,
        requiredIndex: 'idx_test_review_status',
      },
    ],
  };
  const registry = expectOk(makeCategoryRegistry([definition]));
  const adminRead = makeUserDataAdminReadRepo({ db: userDb, registry });

  for (const suffix of [90, 91]) {
    const result = expectOk(
      await mutation.commit(
        makePlannedMutation({
          operation: 'create',
          identity: makeRecordIdentity({
            ownerId: `owner-${String(suffix)}`,
            logicalKey: `record:${String(suffix)}`,
          }),
          recordId: userDataRecordId(suffix),
          eventId: userDataEventId(suffix),
          target: { targetType: 'entity', targetId: suffix === 90 ? 'target-a' : 'target-b' },
          afterImage: {
            status: 'active',
            payload: { value: suffix === 90 ? 'match' : 'other' },
            annotations: { review: { status: suffix === 90 ? 'approved' : 'pending' } },
            schemaVersion: 1,
            schemaHash: 'schema-hash-1',
          },
          receipt: makeReceiptClaim({
            requesterId: `owner-${String(suffix)}`,
            idempotencyKeyHash: `admin-${String(suffix)}`,
            canonicalRequestHash: `admin-${String(suffix)}`,
          }),
        })
      )
    );
    expect(result.kind).toBe('committed');
  }

  const filtered = expectOk(
    await adminRead.adminListByCategory(
      'test.category',
      {
        status: 'active',
        target: { targetType: 'entity', targetId: 'target-a' },
        createdAtFrom: START,
        createdAtTo: START,
        query: {
          value: { operator: 'in', value: ['match', 'also-match'] },
          reviewStatus: { operator: 'eq', value: 'approved' },
        },
      },
      { limit: 10, cursor: null }
    )
  );
  expect(filtered.items.map((record) => record.recordId)).toEqual([userDataRecordId(90)]);

  const wrongCategory = expectOk(
    await adminRead.adminListByCategory(
      'other.category',
      { query: { value: { operator: 'eq', value: 'match' } } },
      { limit: 10, cursor: null }
    )
  );
  expect(wrongCategory.items).toEqual([]);
  expect(
    expectOk(
      await adminRead.adminHistoryByCategory('other.category', userDataRecordId(90), {
        limit: 10,
        beforeRevision: null,
      })
    ).items
  ).toEqual([]);
});
