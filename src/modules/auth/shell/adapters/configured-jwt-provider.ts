/** Import the configured key at startup; verify signature, issuer and client on every request. */
import { importSPKI, jwtVerify } from 'jose';

import { makeJWTAdapter } from './jwt-adapter.js';

import type { AuthProvider } from '../../core/ports.js';

export const makeConfiguredJWTProvider = async (config: {
  readonly jwtKey: string;
  readonly issuer: string;
  readonly authorizedParties: readonly string[];
}): Promise<AuthProvider> => {
  const key = await importSPKI(config.jwtKey, 'RS256');
  return makeJWTAdapter({
    jwtVerify: async (token, _key, options) => {
      const verified = await jwtVerify(token, key, { ...options, algorithms: ['RS256'] });
      // Clerk browser origin is azp. An audience is not an alternate origin.
      if (
        typeof verified.payload['azp'] !== 'string' ||
        !config.authorizedParties.includes(verified.payload['azp'])
      )
        throw new Error('Clerk authorized party is missing or invalid');
      return verified;
    },
    importSPKI: () => Promise.resolve(key),
    publicKeyPEM: config.jwtKey,
    algorithm: 'RS256',
    issuer: config.issuer,
    authorizedParties: [...config.authorizedParties],
  });
};
