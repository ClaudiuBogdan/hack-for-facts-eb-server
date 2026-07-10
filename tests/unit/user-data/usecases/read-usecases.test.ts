import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { type UserDataErasurePort } from '@/modules/user-data/core/ports.js';
import { makeCategoryRegistry } from '@/modules/user-data/core/registry/registry.js';
import { decodeSyncCursor } from '@/modules/user-data/core/sync-cursor.js';
import { adminGetRecordHistory } from '@/modules/user-data/core/usecases/admin-get-record-history.js';
import { adminListRecords } from '@/modules/user-data/core/usecases/admin-list-records.js';
import { anonymizeUserData } from '@/modules/user-data/core/usecases/anonymize-user-data.js';
import { cleanupReceipts } from '@/modules/user-data/core/usecases/cleanup-receipts.js';
import { findRecordsByTarget } from '@/modules/user-data/core/usecases/find-records-by-target.js';
import { getRecordHistory } from '@/modules/user-data/core/usecases/get-record-history.js';
import { getRecord } from '@/modules/user-data/core/usecases/get-record.js';
import { listRecords } from '@/modules/user-data/core/usecases/list-records.js';
import { syncRecords } from '@/modules/user-data/core/usecases/sync-records.js';

import {
  makePlannedMutation,
  makeReceiptClaim,
  makeRecordIdentity,
} from '../../../fixtures/user-data/index.js';
import { expectErr, expectOk } from '../../../support/index.js';
import { makeDefinition } from '../fixtures.js';
import { logger, makeUsecaseHarness } from './harness.js';

const seed = async (h: ReturnType<typeof makeUsecaseHarness>, suffix: number, target = false) => {
  const identity = makeRecordIdentity({
    category: 'test.category',
    logicalKey: `record:${String(suffix)}`,
  });
  expectOk(
    await h.store.commit(
      makePlannedMutation({
        operation: 'create',
        identity,
        recordId: `record-${String(suffix)}`,
        eventId: `event-${String(suffix)}`,
        target: target ? { targetType: 'entity', targetId: 'target-1' } : null,
        receipt: makeReceiptClaim({
          idempotencyKeyHash: `key-${String(suffix)}`,
          canonicalRequestHash: `request-${String(suffix)}`,
        }),
      })
    )
  );
};

describe('owner read usecases', () => {
  it('getRecord supports key and id without leaking other owners', async () => {
    const h = makeUsecaseHarness();
    await seed(h, 1);
    const deps = { readPort: h.store, logger };
    expect(
      expectOk(
        await getRecord(deps, {
          by: 'key',
          ownerId: 'owner-1',
          category: 'test.category',
          logicalKey: 'record:1',
        })
      )?.recordId
    ).toBe('record-1');
    expect(
      expectOk(await getRecord(deps, { by: 'id', ownerId: 'owner-1', recordId: 'record-1' }))
        ?.logicalKey
    ).toBe('record:1');
    expect(
      expectOk(await getRecord(deps, { by: 'id', ownerId: 'other', recordId: 'record-1' }))
    ).toBeNull();
  });
  it('listRecords, findRecordsByTarget, and getRecordHistory map port rows', async () => {
    const h = makeUsecaseHarness();
    await seed(h, 2);
    await seed(h, 1, true);
    const deps = { readPort: h.store, registry: h.registry, logger };
    const first = expectOk(
      await listRecords(deps, {
        ownerId: 'owner-1',
        category: 'test.category',
        limit: 1,
        cursor: null,
      })
    );
    expect(first.items[0]?.logicalKey).toBe('record:1');
    expect(first.nextCursor).toBe('record:1');
    expect(
      expectOk(
        await findRecordsByTarget(deps, {
          ownerId: 'owner-1',
          category: 'test.category',
          target: { targetType: 'entity', targetId: 'target-1' },
        })
      )
    ).toHaveLength(1);
    expect(
      expectOk(
        await getRecordHistory(deps, {
          ownerId: 'owner-1',
          recordId: 'record-1',
          limit: 10,
          beforeRevision: null,
        })
      ).items
    ).toHaveLength(1);
  });
});

describe('syncRecords', () => {
  it('runs a multi-page bounded cycle and starts the next cycle at the bound', async () => {
    const h = makeUsecaseHarness();
    await seed(h, 1);
    await seed(h, 2);
    await seed(h, 3);
    const deps = { readPort: h.store, logger };
    const first = expectOk(
      await syncRecords(deps, { ownerId: 'owner-1', rawCursor: null, limit: 2, category: null })
    );
    expect(first.hasMore).toBe(true);
    expect(first.items.map((item) => item.logicalKey)).toEqual(['record:1', 'record:2']);
    const firstCursor = expectOk(decodeSyncCursor(first.nextCursor));
    expect(firstCursor).toEqual({ lastSeq: '2', cycleHighWater: '3', category: null });
    const second = expectOk(
      await syncRecords(deps, {
        ownerId: 'owner-1',
        rawCursor: first.nextCursor,
        limit: 2,
        category: null,
      })
    );
    expect(second.hasMore).toBe(false);
    expect(second.items.map((item) => item.logicalKey)).toEqual(['record:3']);
    expect(expectOk(decodeSyncCursor(second.nextCursor))).toEqual({
      lastSeq: '3',
      cycleHighWater: null,
      category: null,
    });
  });
  it('does not duplicate a row changed after the cycle high-water and rejects category mismatch', async () => {
    const h = makeUsecaseHarness();
    await seed(h, 1);
    await seed(h, 2);
    const deps = { readPort: h.store, logger };
    const first = expectOk(
      await syncRecords(deps, { ownerId: 'owner-1', rawCursor: null, limit: 1, category: null })
    );
    expectOk(
      await h.store.commit(
        makePlannedMutation({
          operation: 'replace',
          identity: makeRecordIdentity({ category: 'test.category', logicalKey: 'record:1' }),
          recordId: 'record-1',
          expectedRevision: 1,
          nextRevision: 2,
          eventId: 'changed',
          receipt: makeReceiptClaim({
            idempotencyKeyHash: 'changed',
            canonicalRequestHash: 'changed',
          }),
        })
      )
    );
    const second = expectOk(
      await syncRecords(deps, {
        ownerId: 'owner-1',
        rawCursor: first.nextCursor,
        limit: 10,
        category: null,
      })
    );
    expect(second.items.map((item) => item.logicalKey)).toEqual(['record:2']);
    expectErr(
      await syncRecords(deps, {
        ownerId: 'owner-1',
        rawCursor: first.nextCursor,
        category: 'test.category',
      }),
      'InvalidCursor'
    );
  });
});

describe('admin read usecases', () => {
  const input = {
    category: 'test.category',
    grantedPermission: 'test:admin',
    filters: {},
    limit: 10,
    cursor: null,
  };
  it('fails closed for unknown, unconfigured, and wrong permissions in order', async () => {
    const h = makeUsecaseHarness();
    const deps = { adminReadPort: h.store, registry: h.registry, logger };
    expectErr(
      await adminListRecords(deps, { ...input, category: 'missing' }),
      'AdminAccessNotConfigured'
    );
    const noAdmin = expectOk(
      makeCategoryRegistry([{ ...makeDefinition(), adminPermission: null }])
    );
    expectErr(
      await adminListRecords({ ...deps, registry: noAdmin }, input),
      'AdminAccessNotConfigured'
    );
    expectErr(await adminListRecords(deps, { ...input, grantedPermission: 'wrong' }), 'Forbidden');
  });
  it('validates registered filters and delegates list and history', async () => {
    const h = makeUsecaseHarness();
    await seed(h, 1);
    const definition = {
      ...makeDefinition(),
      queryFields: [
        {
          name: 'value',
          path: ['value'],
          scalar: 'string' as const,
          operators: ['eq'] as const,
          requiredIndex: 'idx_value',
        },
      ],
    };
    const registry = expectOk(makeCategoryRegistry([definition]));
    const deps = { adminReadPort: h.store, registry, logger };
    expect(
      expectOk(
        await adminListRecords(deps, {
          ...input,
          filters: { query: { value: { operator: 'eq', value: 'revision-1' } } },
        })
      ).items
    ).toHaveLength(1);
    expectErr(
      await adminListRecords(deps, {
        ...input,
        filters: { query: { unknown: { operator: 'eq', value: 1 } } },
      }),
      'InvalidPayload'
    );
    expect(
      expectOk(
        await adminGetRecordHistory(deps, {
          category: 'test.category',
          grantedPermission: 'test:admin',
          recordId: 'record-1',
          limit: 10,
          beforeRevision: null,
        })
      ).items
    ).toHaveLength(1);
  });
});

describe('maintenance usecases', () => {
  it('anonymizeUserData builds payload and namespace redactors for every category', async () => {
    const first = makeDefinition();
    const second = {
      ...makeDefinition(),
      category: 'second.category',
      logicalKey: { pattern: /^record:\S+$/, maxLength: 128 },
    };
    const registry = expectOk(makeCategoryRegistry([first, second]));
    let categoryNames: string[] = [];
    let namespaceNames: string[] = [];
    const erasurePort: UserDataErasurePort = {
      eraseOwner: async (request) => {
        categoryNames = Object.keys(request.redactors.payloadByCategory);
        namespaceNames = Object.keys(
          request.redactors.annotationsByCategory['second.category'] ?? {}
        );
        return ok({ records: 2, events: 2, receipts: 2 });
      },
    };
    expectOk(
      await anonymizeUserData(
        { erasurePort, registry, logger },
        { ownerId: 'owner', anonymizedOwnerId: 'anon', now: new Date() }
      )
    );
    expect(categoryNames).toEqual(['test.category', 'second.category']);
    expect(namespaceNames).toEqual(['review']);
  });
  it('cleanupReceipts delegates and returns the deleted count', async () => {
    const h = makeUsecaseHarness();
    expect(
      await cleanupReceipts({ mutationPort: h.store, logger }, { now: h.clock.now() })
    ).toEqual(ok(0));
  });
});
