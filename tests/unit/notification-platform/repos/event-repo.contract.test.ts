import { eventRepoContractCases } from '../../../contracts/notification-platform/event-repo.contract.js';
import { makeFakeNotificationEventRepo } from '../../../fixtures/notification-platform/fakes.js';
import { makeTestClock, describePortContract } from '../../../support/index.js';

describePortContract('NotificationEventRepo', eventRepoContractCases, {
  fake: () => {
    const fake = makeFakeNotificationEventRepo({ clock: makeTestClock() });
    return {
      port: fake,
      reset: () => {
        fake.store.clear();
      },
    };
  },
});
