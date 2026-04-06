/**
 * BullMQ custom ids cannot contain arbitrary colon-separated segments.
 * Keep every custom id at exactly three segments by encoding dynamic values.
 */
export const buildBullmqJobId = (prefix: string, scope: string, uniquenessKey: string): string => {
  const encodeSegment = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

  return `${prefix}:${encodeSegment(scope)}:${encodeSegment(uniquenessKey)}`;
};
