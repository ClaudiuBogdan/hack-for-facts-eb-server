import { createHmac } from 'node:crypto';

export const computeDestinationFingerprint = (secret: string, address: string): string =>
  createHmac('sha256', secret).update(address.trim().toLowerCase()).digest('hex');
