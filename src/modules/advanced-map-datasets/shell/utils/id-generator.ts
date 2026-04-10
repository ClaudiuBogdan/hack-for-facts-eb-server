import { randomUUID } from 'node:crypto';

export interface AdvancedMapDatasetIdGenerator {
  generateId(): string;
  generatePublicId(): string;
}

export const defaultAdvancedMapDatasetIdGenerator: AdvancedMapDatasetIdGenerator = {
  generateId: () => randomUUID(),
  generatePublicId: () => randomUUID(),
};
