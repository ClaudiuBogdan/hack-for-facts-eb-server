import { sourceWatermarkRepoContractCases } from '../../../contracts/notification-platform/source-watermark-repo.contract.js';
import { makeFakeSourceWatermarkRepo } from '../../../fixtures/notification-platform/fakes.js';
import { describePortContract } from '../../../support/index.js';

describePortContract('SourceWatermarkRepo', sourceWatermarkRepoContractCases, {
  fake: () => {
    const fake = makeFakeSourceWatermarkRepo();
    return {
      port: fake,
      reset: () => {
        fake.store.clear();
      },
    };
  },
});
