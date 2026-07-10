import type { SubscriptionError } from './errors.js';
import type { Subscription, SubscriptionState } from './types.js';
import type { Page } from '../shared/types.js';
import type { Result } from 'neverthrow';

export interface SubscriptionRepo {
  createOrReactivate(input: {
    id: string;
    userId: string;
    kindId: string;
    subjectType: string;
    subjectId: string;
    config: Record<string, unknown>;
    normalizedKey: string;
    now: Date;
  }): Promise<Result<Subscription, SubscriptionError>>;
  findByIdForUser(
    id: string,
    userId: string
  ): Promise<Result<Subscription | null, SubscriptionError>>;
  listByUser(input: {
    userId: string;
    kindId?: string;
    cursor?: string;
    limit: number;
  }): Promise<Result<Page<Subscription>, SubscriptionError>>;
  listActiveByKindAndSubject(input: {
    kindId: string;
    subjectType: string;
    subjectId: string;
    afterId: string | null;
    limit: number;
  }): Promise<Result<Subscription[], SubscriptionError>>;
  setState(input: {
    id: string;
    userId: string;
    state: SubscriptionState;
    now: Date;
  }): Promise<Result<boolean, SubscriptionError>>;
}

export interface SubjectAuthorizationPort {
  authorizeSubject(input: {
    userId: string;
    kindId: string;
    subjectType: string;
    subjectId: string;
  }): Promise<Result<{ allowed: boolean; denyReason?: string }, SubscriptionError>>;
}
