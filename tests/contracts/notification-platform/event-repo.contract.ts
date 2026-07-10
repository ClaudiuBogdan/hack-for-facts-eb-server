import { expect, it } from 'vitest';

import { expectOk, type PortContractCases } from '../../support/index.js';

import type { NotificationEventRepo } from '@/modules/notification-platform/core/events/ports.js';

export const CONTRACT_EVENT_ID = '10000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-07-10T10:00:00.000Z');

const eventInput = (id: string, payloadHash = 'hash-a') => ({
  id,
  source: 'contract-source',
  eventType: 'contract.event',
  eventSchemaVersion: 1,
  occurrenceKey: 'occurrence-1',
  occurredAt: NOW,
  facts: { version: 1 },
  payloadHash,
  streamKey: null,
  streamSequence: null,
  retentionExpiresAt: new Date('2028-07-10T10:00:00.000Z'),
});

export const eventRepoContractCases: PortContractCases<NotificationEventRepo> = ({ getPort }) => {
  it('creates one event under concurrent identical inserts', async () => {
    const repo = getPort();
    const results = await Promise.all([
      repo.insertOrFind(eventInput(CONTRACT_EVENT_ID)),
      repo.insertOrFind(eventInput('10000000-0000-4000-8000-000000000002')),
    ]);
    const outcomes = results.map((result) => expectOk(result));
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.event.id)).size).toBe(1);
  });

  it('detects a payload hash conflict on the same event identity', async () => {
    const repo = getPort();
    expectOk(await repo.insertOrFind(eventInput(CONTRACT_EVENT_ID, 'hash-a')));
    const duplicate = expectOk(
      await repo.insertOrFind(eventInput('10000000-0000-4000-8000-000000000003', 'hash-b'))
    );
    expect(duplicate.created).toBe(false);
    expect(duplicate.payloadConflict).toBe(true);
  });

  it('claims pending events exclusively and retakes expired resolving leases', async () => {
    const repo = getPort();
    expectOk(await repo.insertOrFind(eventInput(CONTRACT_EVENT_ID)));
    expect(
      expectOk(
        await repo.claimForResolution({
          eventId: CONTRACT_EVENT_ID,
          claimToken: '10000000-0000-4000-8000-000000000101',
          leaseSeconds: 60,
          now: NOW,
        })
      )
    ).not.toBeNull();
    expect(
      expectOk(
        await repo.claimForResolution({
          eventId: CONTRACT_EVENT_ID,
          claimToken: '10000000-0000-4000-8000-000000000102',
          leaseSeconds: 60,
          now: new Date('2026-07-10T10:00:30.000Z'),
        })
      )
    ).toBeNull();
    expect(
      expectOk(
        await repo.claimForResolution({
          eventId: CONTRACT_EVENT_ID,
          claimToken: '10000000-0000-4000-8000-000000000103',
          leaseSeconds: 60,
          now: new Date('2026-07-10T10:02:00.000Z'),
        })
      )?.claimToken
    ).toBe('10000000-0000-4000-8000-000000000103');
  });

  it('fences cursor persistence and resolution by claim token', async () => {
    const repo = getPort();
    expectOk(await repo.insertOrFind(eventInput(CONTRACT_EVENT_ID)));
    const token = '10000000-0000-4000-8000-000000000201';
    expectOk(
      await repo.claimForResolution({
        eventId: CONTRACT_EVENT_ID,
        claimToken: token,
        leaseSeconds: 60,
        now: NOW,
      })
    );
    expect(
      expectOk(
        await repo.saveResolutionCursor({
          eventId: CONTRACT_EVENT_ID,
          cursor: 'page-2',
          expectedClaimToken: '10000000-0000-4000-8000-000000000202',
        })
      )
    ).toBe(false);
    expect(
      expectOk(
        await repo.saveResolutionCursor({
          eventId: CONTRACT_EVENT_ID,
          cursor: 'page-2',
          expectedClaimToken: token,
        })
      )
    ).toBe(true);
    expect(
      expectOk(
        await repo.markResolved({
          eventId: CONTRACT_EVENT_ID,
          expectedClaimToken: '10000000-0000-4000-8000-000000000202',
          now: NOW,
        })
      )
    ).toBe(false);
    expect(
      expectOk(
        await repo.markResolved({
          eventId: CONTRACT_EVENT_ID,
          expectedClaimToken: token,
          now: NOW,
        })
      )
    ).toBe(true);
  });
};
