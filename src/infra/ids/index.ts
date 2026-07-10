import type { IdGenerator } from '@/common/ports/id-generator.js';

/** Production IdGenerator adapter. Composed into core deps by the shell. */
export const uuidIds: IdGenerator = {
  newId: () => crypto.randomUUID(),
};
