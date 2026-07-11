import { anonymizeUserData } from '../../core/usecases/anonymize-user-data.js';

import type { UserDataErasurePort } from '../../core/ports.js';
import type { CategoryRegistry } from '../../core/registry/registry.js';

export const makeUserDataStoreEraser = (deps: {
  erasurePort: UserDataErasurePort;
  registry: CategoryRegistry;
}) => ({
  eraseOwner(input: { ownerId: string; anonymizedOwnerId: string; now: Date }) {
    return anonymizeUserData(
      {
        erasurePort: deps.erasurePort,
        registry: deps.registry,
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      },
      input
    );
  },
});
