export const INTERNAL_NAMESPACE_PREFIX = 'internal:' as const;
export const INTERNAL_FUNKY_WEEKLY_DIGEST_KEY = 'internal:funky:weekly_digest' as const;
export const INTERNAL_FUNKY_WEEKLY_DIGEST_INTERACTION_ID = 'internal:funky:weekly_digest' as const;

export function isInternalRecordKey(recordKey: string): boolean {
  return recordKey.startsWith(INTERNAL_NAMESPACE_PREFIX);
}

export function isInternalInteractionId(interactionId: string): boolean {
  return interactionId.startsWith(INTERNAL_NAMESPACE_PREFIX);
}
