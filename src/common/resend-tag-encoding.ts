import { createHash } from 'node:crypto';

const RESEND_TAG_ENCODED_PREFIX = 'b64_' as const;

export const sanitizeResendTagValue = (value: string): string => {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
};

export const hashResendTagValue = (value: string): string => {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
};

export const encodeThreadKeyForTag = (threadKey: string): string => {
  return `${RESEND_TAG_ENCODED_PREFIX}${Buffer.from(threadKey, 'utf-8').toString('base64url')}`;
};

export const decodeThreadKeyFromTag = (value: string): string | null => {
  if (!value.startsWith(RESEND_TAG_ENCODED_PREFIX)) {
    return value;
  }

  try {
    return Buffer.from(value.slice(RESEND_TAG_ENCODED_PREFIX.length), 'base64url').toString(
      'utf-8'
    );
  } catch {
    return null;
  }
};
