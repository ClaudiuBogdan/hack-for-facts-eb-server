import { z } from 'zod';

import { GRAPHQL_ERROR_CODE, type KernelMcpTool } from '@/modules/shared/index.js';

import { getNgoProfileOverview } from '../../core/usecases.js';

import type { NgoProfileRepository } from '../../core/ports.js';

export const makeNgoProfileMcpTools = (
  repo: NgoProfileRepository,
  clientBaseUrl: string
): readonly KernelMcpTool[] => [
  {
    name: 'get_ngo_profile_overview',
    description:
      'Current accepted RNONG CUI links and dated ANAF fiscal observations. Fiscal inactivity is not legal dissolution. Unavailable fiscal data is not a confirmed negative; unreleased sections contain no financial or funding totals.',
    inputShape: { cui: z.string().regex(/^[1-9][0-9]{1,9}$/) },
    async handler(args) {
      const cui = typeof args['cui'] === 'string' ? args['cui'] : '';
      const result = await getNgoProfileOverview(repo, cui);
      return result.isErr()
        ? {
            ok: false,
            kind: 'ngo_profile_overview',
            error: result.error.message,
            errorType: result.error.type,
            errorCode: GRAPHQL_ERROR_CODE[result.error.type],
          }
        : {
            ok: true,
            kind: 'ngo_profile_overview',
            item: result.value,
            link: `${clientBaseUrl}/ong-uri/${encodeURIComponent(cui)}`,
          };
    },
  },
];
