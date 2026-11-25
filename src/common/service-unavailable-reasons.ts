/**
 * Why a service is unavailable, from a fixed list. The API attaches one to a refusal so the
 * GraphQL error log can tell a deliberate refusal from a fault, as a category (never free text);
 * no response carries it. One frozen list, read by the errors kernel and the log formatter.
 */
export const SERVICE_UNAVAILABLE_REASONS = Object.freeze([
  'legacy_retired',
  'not_readable',
  'not_deployed',
  'not_enabled',
  'republished',
  'no_data',
] as const);

export type ServiceUnavailableReason = (typeof SERVICE_UNAVAILABLE_REASONS)[number];
