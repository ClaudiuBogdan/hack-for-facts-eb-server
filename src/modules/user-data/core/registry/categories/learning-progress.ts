import { type CategoryDefinition } from '../types.js';
import { InteractiveStatePayloadSchema } from './interactive-state-schema.js';

export const LEARNING_PROGRESS_CATEGORY: CategoryDefinition = {
  category: 'learning.progress',
  schemaVersions: [
    {
      version: 1,
      schema: InteractiveStatePayloadSchema,
      schemaHash: '644762dc623aeaef7d93d7ccbd0822cb3d089c80cd93e28b84d1538ec6f6c92d',
      readable: true,
      writeEnabled: true,
    },
  ],
  maxPayloadBytes: 65_536,
  logicalKey: { pattern: /^(?!internal:)\S+$/, maxLength: 512 },
  target: null,
  redactor: () => ({}),
  queryFields: [],
  annotationNamespaces: [],
  maxRecordsPerOwner: 2000,
  writeRateLimitPerMinute: 120,
  adminPermission: null,
};
