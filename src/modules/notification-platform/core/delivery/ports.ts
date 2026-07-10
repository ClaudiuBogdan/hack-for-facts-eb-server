import type { PlatformDeliveryError } from './errors.js';
import type { RenderJobPayload, SendJobPayload } from './schemas.js';
import type {
  ChannelDestination,
  CreateDeliveryInput,
  Delivery,
  DeliveryAttempt,
  DeliveryPatch,
  DeliveryState,
  AttemptResult,
  ResolvedDestination,
} from './types.js';
import type { DeadLetterSearchFilter } from '../admin/types.js';
import type { ContentProjection, KindDefinition } from '../registry/kind-definition.js';
import type { QueueError } from '../shared/errors.js';
import type { ExternalChannel, Page } from '../shared/types.js';
import type { Result } from 'neverthrow';

export interface DeliveryRepo {
  insertIdempotent(
    input: CreateDeliveryInput
  ): Promise<Result<{ delivery: Delivery; created: boolean }, PlatformDeliveryError>>;
  findById(id: string): Promise<Result<Delivery | null, PlatformDeliveryError>>;
  findByProviderRef(providerRef: string): Promise<Result<Delivery | null, PlatformDeliveryError>>;
  claimForRender(input: {
    deliveryId: string;
    claimToken: string;
    leaseSeconds: number;
    now: Date;
  }): Promise<Result<Delivery | null, PlatformDeliveryError>>;
  claimForSending(input: {
    deliveryId: string;
    claimToken: string;
    leaseSeconds: number;
    now: Date;
  }): Promise<Result<Delivery | null, PlatformDeliveryError>>;
  saveRenderedContent(input: {
    deliveryId: string;
    expectedClaimToken: string;
    subject: string | null;
    html: string | null;
    text: string | null;
    contentHash: string;
    templateId: string;
    templateVersion: string;
    nextStatus: 'scheduled' | 'ready';
  }): Promise<Result<boolean, PlatformDeliveryError>>;
  transition(input: {
    deliveryId: string;
    from: readonly DeliveryState[];
    to: DeliveryState;
    expectedClaimToken?: string;
    patch?: DeliveryPatch;
    now: Date;
  }): Promise<Result<boolean, PlatformDeliveryError>>;
  cancelPendingForUser(input: {
    userId: string;
    channels?: readonly ExternalChannel[];
    onlyOptionalKinds: boolean;
    reason: string;
    now: Date;
  }): Promise<Result<number, PlatformDeliveryError>>;
  findDueUnqueued(input: {
    olderThan: Date;
    limit: number;
  }): Promise<Result<Delivery[], PlatformDeliveryError>>;
  findExpiredClaims(input: {
    now: Date;
    limit: number;
  }): Promise<Result<Delivery[], PlatformDeliveryError>>;
  findDueForExpiry(input: {
    now: Date;
    limit: number;
  }): Promise<Result<Delivery[], PlatformDeliveryError>>;
  searchDeadLetters(
    input: DeadLetterSearchFilter & { cursor: string | null; limit: number }
  ): Promise<Result<Page<Delivery>, PlatformDeliveryError>>;
}

export interface DeliveryAttemptRepo {
  create(input: {
    id: string;
    deliveryId: string;
    attemptNumber: number;
    startedAt: Date;
    providerIdempotencyKey: string;
    destinationFingerprint: string | null;
    requestCorrelationId: string | null;
  }): Promise<Result<DeliveryAttempt, PlatformDeliveryError>>;
  complete(input: {
    attemptId: string;
    completedAt: Date;
    result: AttemptResult;
    errorCode?: string;
    errorMessage?: string;
    providerRef?: string;
    latencyMs?: number;
    retryAfterMs?: number;
  }): Promise<Result<void, PlatformDeliveryError>>;
  listByDelivery(deliveryId: string): Promise<Result<DeliveryAttempt[], PlatformDeliveryError>>;
}

export interface ChannelDestinationRepo {
  getCurrent(input: {
    userId: string;
    channel: ExternalChannel;
  }): Promise<Result<ChannelDestination | null, PlatformDeliveryError>>;
  ensureCurrent(input: {
    userId: string;
    channel: ExternalChannel;
    fingerprint: string;
    now: Date;
  }): Promise<Result<ChannelDestination, PlatformDeliveryError>>;
  suppressByFingerprint(input: {
    fingerprint: string;
    channel: ExternalChannel;
    reason: string;
    now: Date;
  }): Promise<Result<number, PlatformDeliveryError>>;
  listSuppressed(input: {
    userId?: string;
    cursor: string | null;
    limit: number;
  }): Promise<Result<Page<ChannelDestination>, PlatformDeliveryError>>;
}

export interface ChannelAdapterPort {
  readonly channel: ExternalChannel;
  resolveDestination(
    userId: string
  ): Promise<
    Result<{ fingerprint: string; destination: ResolvedDestination } | null, PlatformDeliveryError>
  >;
  render(input: {
    delivery: Delivery;
    kind: KindDefinition;
    projection: ContentProjection;
    unsubscribeContext: { userId: string; kindId: string };
  }): Promise<
    Result<
      { subject: string; html: string; text: string; contentHash: string },
      PlatformDeliveryError
    >
  >;
  send(input: {
    delivery: Delivery;
    attempt: DeliveryAttempt;
    destination: ResolvedDestination;
  }): Promise<
    Result<
      | { classification: 'accepted'; providerRef: string }
      | {
          classification: 'transient_failure' | 'permanent_failure' | 'ambiguous';
          errorCode: string;
          errorMessage: string;
          retryAfterMs?: number;
        },
      PlatformDeliveryError
    >
  >;
  reconcile(input: {
    providerIdempotencyKey: string;
    providerRef: string | null;
  }): Promise<
    Result<{ known: boolean; state?: 'accepted' | 'delivered' | 'bounced' }, PlatformDeliveryError>
  >;
}

export interface SendJobScheduler {
  enqueue(
    payload: SendJobPayload,
    options?: { delayMs?: number }
  ): Promise<Result<void, QueueError>>;
}

export interface RenderJobScheduler {
  enqueue(payload: RenderJobPayload): Promise<Result<void, QueueError>>;
}
