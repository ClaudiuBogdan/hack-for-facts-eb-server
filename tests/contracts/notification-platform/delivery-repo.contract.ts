import { expect, it } from 'vitest';

import { expectOk, type PortContractCases } from '../../support/index.js';

import type { DeliveryRepo } from '@/modules/notification-platform/core/delivery/ports.js';
import type { CreateDeliveryInput } from '@/modules/notification-platform/core/delivery/types.js';

export const DELIVERY_LOGICAL_PARENT_ID = '00000000-0000-4000-8000-000000000100';
export const DELIVERY_OTHER_LOGICAL_PARENT_ID = '00000000-0000-4000-8000-000000000101';

const NOW = new Date('2026-07-10T10:00:00.000Z');
const LATER = new Date('2026-07-10T10:02:00.000Z');

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;

const deliveryInput = (
  id: string,
  overrides: Partial<CreateDeliveryInput> = {}
): CreateDeliveryInput => ({
  id,
  deliveryKey: `logical:${id}:email:1`,
  logicalNotificationId: DELIVERY_LOGICAL_PARENT_ID,
  digestBatchId: null,
  kindId: 'contract.kind',
  userId: 'contract-user',
  channel: 'email',
  destinationFingerprint: 'fingerprint-1',
  destinationGeneration: 1,
  templateId: 'template',
  templateVersion: 'v1',
  status: 'pending_render',
  notBefore: null,
  expiresAt: null,
  streamKey: null,
  streamSequence: null,
  senderMode: 'active',
  now: NOW,
  retentionExpiresAt: new Date('2028-07-10T10:00:00.000Z'),
  ...overrides,
});

const makeReady = async (
  repo: DeliveryRepo,
  id: string,
  overrides: Partial<CreateDeliveryInput> = {}
): Promise<void> => {
  expectOk(await repo.insertIdempotent(deliveryInput(id, overrides)));
  const claimToken = uuid(9000 + Number(id.slice(-3)));
  expect(
    expectOk(
      await repo.claimForRender({
        deliveryId: id,
        claimToken,
        leaseSeconds: 60,
        now: NOW,
      })
    )
  ).not.toBeNull();
  expectOk(
    await repo.saveRenderedContent({
      deliveryId: id,
      expectedClaimToken: claimToken,
      subject: 'subject',
      html: '<p>body</p>',
      text: 'body',
      contentHash: 'content-hash',
      templateId: 'template',
      templateVersion: 'v1',
      nextStatus: 'ready',
    })
  );
};

export const deliveryRepoContractCases: PortContractCases<DeliveryRepo> = ({ getPort }) => {
  it('claims a ready delivery exclusively under concurrent races', async () => {
    const repo = getPort();
    const deliveryId = uuid(1);
    await makeReady(repo, deliveryId);

    const claims = await Promise.all([
      repo.claimForSending({
        deliveryId,
        claimToken: uuid(101),
        leaseSeconds: 60,
        now: NOW,
      }),
      repo.claimForSending({
        deliveryId,
        claimToken: uuid(102),
        leaseSeconds: 60,
        now: NOW,
      }),
    ]);
    const winners = claims.map((result) => expectOk(result)).filter((row) => row !== null);
    expect(winners).toHaveLength(1);
  });

  it('retakes an expired sending lease but not a live lease', async () => {
    const repo = getPort();
    const deliveryId = uuid(2);
    await makeReady(repo, deliveryId);
    expectOk(
      await repo.claimForSending({
        deliveryId,
        claimToken: uuid(201),
        leaseSeconds: 60,
        now: NOW,
      })
    );

    expect(
      expectOk(
        await repo.claimForSending({
          deliveryId,
          claimToken: uuid(202),
          leaseSeconds: 60,
          now: new Date('2026-07-10T10:00:30.000Z'),
        })
      )
    ).toBeNull();
    expect(
      expectOk(
        await repo.claimForSending({
          deliveryId,
          claimToken: uuid(203),
          leaseSeconds: 60,
          now: LATER,
        })
      )?.claimToken
    ).toBe(uuid(203));
  });

  it('increments attempt_count on every successful send claim', async () => {
    const repo = getPort();
    const deliveryId = uuid(9);
    await makeReady(repo, deliveryId);
    const firstToken = uuid(901);
    const first = expectOk(
      await repo.claimForSending({
        deliveryId,
        claimToken: firstToken,
        leaseSeconds: 60,
        now: NOW,
      })
    );
    expect(first?.attemptCount).toBe(1);
    expect(
      expectOk(
        await repo.transition({
          deliveryId,
          from: ['sending'],
          to: 'retry_wait',
          expectedClaimToken: firstToken,
          patch: { nextAttemptAt: NOW, claimToken: null, claimExpiresAt: null },
          now: NOW,
        })
      )
    ).toBe(true);
    const second = expectOk(
      await repo.claimForSending({
        deliveryId,
        claimToken: uuid(902),
        leaseSeconds: 60,
        now: LATER,
      })
    );
    expect(second?.attemptCount).toBe(2);
  });

  it('fences stale workers after render and sending lease retakes', async () => {
    const repo = getPort();
    const renderDeliveryId = uuid(10);
    expectOk(await repo.insertIdempotent(deliveryInput(renderDeliveryId)));
    const oldRenderToken = uuid(1001);
    const newRenderToken = uuid(1002);
    expectOk(
      await repo.claimForRender({
        deliveryId: renderDeliveryId,
        claimToken: oldRenderToken,
        leaseSeconds: 60,
        now: NOW,
      })
    );
    expectOk(
      await repo.claimForRender({
        deliveryId: renderDeliveryId,
        claimToken: newRenderToken,
        leaseSeconds: 60,
        now: LATER,
      })
    );
    expect(
      expectOk(
        await repo.saveRenderedContent({
          deliveryId: renderDeliveryId,
          expectedClaimToken: oldRenderToken,
          subject: 'stale',
          html: '<p>stale</p>',
          text: 'stale',
          contentHash: 'stale-hash',
          templateId: 'template',
          templateVersion: 'v1',
          nextStatus: 'ready',
        })
      )
    ).toBe(false);

    const sendDeliveryId = uuid(11);
    await makeReady(repo, sendDeliveryId);
    const oldSendToken = uuid(1101);
    const newSendToken = uuid(1102);
    expectOk(
      await repo.claimForSending({
        deliveryId: sendDeliveryId,
        claimToken: oldSendToken,
        leaseSeconds: 60,
        now: NOW,
      })
    );
    expectOk(
      await repo.claimForSending({
        deliveryId: sendDeliveryId,
        claimToken: newSendToken,
        leaseSeconds: 60,
        now: LATER,
      })
    );
    expect(
      expectOk(
        await repo.transition({
          deliveryId: sendDeliveryId,
          from: ['sending'],
          to: 'accepted',
          expectedClaimToken: oldSendToken,
          now: LATER,
        })
      )
    ).toBe(false);
  });

  it('does not claim before not_before or next_attempt_at is due', async () => {
    const repo = getPort();
    const notBeforeId = uuid(12);
    await makeReady(repo, notBeforeId, {
      notBefore: new Date('2026-07-10T10:01:00.000Z'),
    });
    expect(
      expectOk(
        await repo.claimForSending({
          deliveryId: notBeforeId,
          claimToken: uuid(1201),
          leaseSeconds: 60,
          now: NOW,
        })
      )
    ).toBeNull();

    const retryId = uuid(13);
    await makeReady(repo, retryId);
    const firstToken = uuid(1301);
    expectOk(
      await repo.claimForSending({
        deliveryId: retryId,
        claimToken: firstToken,
        leaseSeconds: 60,
        now: NOW,
      })
    );
    expectOk(
      await repo.transition({
        deliveryId: retryId,
        from: ['sending'],
        to: 'retry_wait',
        expectedClaimToken: firstToken,
        patch: {
          nextAttemptAt: new Date('2026-07-10T10:01:00.000Z'),
          claimToken: null,
          claimExpiresAt: null,
        },
        now: NOW,
      })
    );
    expect(
      expectOk(
        await repo.claimForSending({
          deliveryId: retryId,
          claimToken: uuid(1302),
          leaseSeconds: 60,
          now: NOW,
        })
      )
    ).toBeNull();
  });

  it('gates a stream successor while its predecessor is sending and releases it on accepted', async () => {
    const repo = getPort();
    const predecessorId = uuid(3);
    const successorId = uuid(4);
    await makeReady(repo, predecessorId, { streamKey: 'stream-a', streamSequence: 1 });
    await makeReady(repo, successorId, { streamKey: 'stream-a', streamSequence: 2 });

    expect(
      expectOk(
        await repo.claimForSending({
          deliveryId: successorId,
          claimToken: uuid(401),
          leaseSeconds: 60,
          now: NOW,
        })
      )
    ).toBeNull();

    const predecessorToken = uuid(301);
    expectOk(
      await repo.claimForSending({
        deliveryId: predecessorId,
        claimToken: predecessorToken,
        leaseSeconds: 60,
        now: NOW,
      })
    );
    expect(
      expectOk(
        await repo.transition({
          deliveryId: predecessorId,
          from: ['sending'],
          to: 'accepted',
          expectedClaimToken: predecessorToken,
          now: NOW,
        })
      )
    ).toBe(true);
    expect(
      expectOk(
        await repo.claimForSending({
          deliveryId: successorId,
          claimToken: uuid(402),
          leaseSeconds: 60,
          now: NOW,
        })
      )
    ).not.toBeNull();
  });

  it('never claims shadow-mode deliveries for sending', async () => {
    const repo = getPort();
    const deliveryId = uuid(5);
    await makeReady(repo, deliveryId, { senderMode: 'shadow' });
    expect(
      expectOk(
        await repo.claimForSending({
          deliveryId,
          claimToken: uuid(501),
          leaseSeconds: 60,
          now: NOW,
        })
      )
    ).toBeNull();
  });

  it('enforces monotonic state transitions and caller-provided from states', async () => {
    const repo = getPort();
    const deliveryId = uuid(6);
    await makeReady(repo, deliveryId);
    const claimToken = uuid(601);
    expectOk(await repo.claimForSending({ deliveryId, claimToken, leaseSeconds: 60, now: NOW }));
    expectOk(
      await repo.transition({
        deliveryId,
        from: ['sending'],
        to: 'accepted',
        expectedClaimToken: claimToken,
        now: NOW,
      })
    );

    const backward = await repo.transition({
      deliveryId,
      from: ['accepted'],
      to: 'ready',
      now: NOW,
    });
    if (backward.isOk()) {
      expect(backward.value).toBe(false);
    } else {
      expect(backward.error.type).toBe('InvalidDeliveryTransition');
    }
    expect(expectOk(await repo.findById(deliveryId))?.status).toBe('accepted');

    expect(
      expectOk(
        await repo.transition({
          deliveryId,
          from: ['sending'],
          to: 'retry_wait',
          now: NOW,
        })
      )
    ).toBe(false);
  });

  it('uses delivery_key as its idempotency identity', async () => {
    const repo = getPort();
    const deliveryKey = 'logical:contract:email:1';
    const [first, second] = await Promise.all([
      repo.insertIdempotent(deliveryInput(uuid(7), { deliveryKey })),
      repo.insertIdempotent(deliveryInput(uuid(8), { deliveryKey })),
    ]);
    const outcomes = [expectOk(first), expectOk(second)];
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.delivery.id)).size).toBe(1);
  });

  it('lists only deliveries belonging to the requested logical notification', async () => {
    const repo = getPort();
    const firstId = uuid(20);
    const secondId = uuid(21);
    const otherId = uuid(22);
    expectOk(await repo.insertIdempotent(deliveryInput(firstId)));
    expectOk(await repo.insertIdempotent(deliveryInput(secondId)));
    expectOk(
      await repo.insertIdempotent(
        deliveryInput(otherId, { logicalNotificationId: DELIVERY_OTHER_LOGICAL_PARENT_ID })
      )
    );

    const deliveries = expectOk(await repo.listByLogicalNotification(DELIVERY_LOGICAL_PARENT_ID));
    expect(deliveries.map((delivery) => delivery.id)).toEqual([firstId, secondId]);
  });

  it('pages shadow recipients by kind and excludes active deliveries', async () => {
    const repo = getPort();
    const firstId = uuid(30);
    const secondId = uuid(31);
    const thirdId = uuid(32);
    expectOk(
      await repo.insertIdempotent(
        deliveryInput(firstId, {
          deliveryKey: 'shadow:contract:01',
          userId: 'shadow-user-1',
          senderMode: 'shadow',
        })
      )
    );
    expectOk(
      await repo.insertIdempotent(
        deliveryInput(secondId, {
          deliveryKey: 'shadow:contract:02',
          userId: 'shadow-user-2',
          senderMode: 'shadow',
        })
      )
    );
    expectOk(
      await repo.insertIdempotent(
        deliveryInput(thirdId, {
          deliveryKey: 'shadow:contract:03',
          userId: 'shadow-user-3',
          senderMode: 'shadow',
        })
      )
    );
    expectOk(
      await repo.insertIdempotent(
        deliveryInput(uuid(33), {
          deliveryKey: 'active:contract',
          userId: 'active-user',
        })
      )
    );
    expectOk(
      await repo.insertIdempotent(
        deliveryInput(uuid(34), {
          deliveryKey: 'shadow:other-kind',
          kindId: 'other.kind',
          senderMode: 'shadow',
        })
      )
    );

    const firstPage = expectOk(
      await repo.listShadowRecipients({ kindId: 'contract.kind', limit: 2, cursor: null })
    );
    expect(firstPage).toEqual({
      items: [
        {
          userId: 'shadow-user-1',
          contentHash: null,
          deliveryKey: 'shadow:contract:01',
        },
        {
          userId: 'shadow-user-2',
          contentHash: null,
          deliveryKey: 'shadow:contract:02',
        },
      ],
      nextCursor: 'shadow:contract:02',
    });
    const secondPage = expectOk(
      await repo.listShadowRecipients({
        kindId: 'contract.kind',
        limit: 2,
        cursor: firstPage.nextCursor,
      })
    );
    expect(secondPage).toEqual({
      items: [
        {
          userId: 'shadow-user-3',
          contentHash: null,
          deliveryKey: 'shadow:contract:03',
        },
      ],
      nextCursor: null,
    });
  });
};
