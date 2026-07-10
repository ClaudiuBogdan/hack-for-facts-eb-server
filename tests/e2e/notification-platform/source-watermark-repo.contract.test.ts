import { makeSourceWatermarkRepo } from '@/modules/notification-platform/shell/repo/source-watermark-repo.js';

import { isDockerAvailable, truncatePlatformTables } from './contract-db.js';
import { sourceWatermarkRepoContractCases } from '../../contracts/notification-platform/source-watermark-repo.contract.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { describePortContract } from '../../support/index.js';

describePortContract('SourceWatermarkRepo', sourceWatermarkRepoContractCases, {
  real: {
    when: isDockerAvailable,
    make: async () => {
      const { userDb } = await setupTestDatabase();
      return { port: makeSourceWatermarkRepo(userDb), reset: () => truncatePlatformTables(userDb) };
    },
  },
});
