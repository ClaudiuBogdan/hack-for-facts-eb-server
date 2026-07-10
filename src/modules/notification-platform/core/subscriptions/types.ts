export type SubscriptionState = 'active' | 'paused' | 'removed';

export interface Subscription {
  id: string;
  userId: string;
  kindId: string;
  subjectType: string;
  subjectId: string;
  config: Record<string, unknown>;
  normalizedKey: string;
  state: SubscriptionState;
  createdAt: Date;
  updatedAt: Date;
  removedAt: Date | null;
}
