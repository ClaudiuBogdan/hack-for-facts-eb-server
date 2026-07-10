import { FUNKY_CAMPAIGN_ADMIN_PERMISSION } from '@/common/campaign-keys.js';

import { type CategoryDefinition } from '../types.js';
import { InteractiveStatePayloadSchema } from './interactive-state-schema.js';

export const FUNKY_INTERACTION_CATEGORY: CategoryDefinition = {
  category: 'funky.interaction',
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
  logicalKey: { pattern: /^funky:interaction:\S+$/, maxLength: 512 },
  target: { required: false, allowedTypes: ['entity'] },
  redactor: () => ({}),
  queryFields: [
    {
      name: 'interactionId',
      path: ['interactionId'],
      scalar: 'string',
      operators: ['eq', 'in'],
      requiredIndex: 'user_data_records_funky_interaction_id_idx',
    },
    {
      name: 'phase',
      path: ['phase'],
      scalar: 'string',
      operators: ['eq', 'in'],
      requiredIndex: 'user_data_records_funky_phase_idx',
    },
  ],
  annotationNamespaces: [],
  maxRecordsPerOwner: 500,
  writeRateLimitPerMinute: 60,
  adminPermission: FUNKY_CAMPAIGN_ADMIN_PERMISSION,
};
