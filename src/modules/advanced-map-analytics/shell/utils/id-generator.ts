import { randomBytes, randomUUID } from 'node:crypto';

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

export interface AdvancedMapAnalyticsIdGenerator {
  generateMapId: () => string;
  generateSnapshotId: () => string;
  generatePublicId: () => string;
}

export const defaultAdvancedMapAnalyticsIdGenerator: AdvancedMapAnalyticsIdGenerator = {
  generateMapId: () => `ama_${randomUUID().replaceAll('-', '')}`,
  generateSnapshotId: () => `amas_${randomUUID().replaceAll('-', '')}`,
  generatePublicId: () => randomBase64Url(9),
};
