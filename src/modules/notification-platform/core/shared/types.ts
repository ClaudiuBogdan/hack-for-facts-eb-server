export const CHANNELS = ['inbox', 'email'] as const;

export type Channel = (typeof CHANNELS)[number];
export type ExternalChannel = 'email';
export type Cadence = 'immediate' | 'daily' | 'weekly' | 'off';
export type Locale = 'ro';
export type PreferenceClass = 'subscription-required' | 'opt-out' | 'required';
export type SenderMode = 'legacy' | 'shadow' | 'active';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
