/**
 * `legalActs.totalCount` — a count failure is a field error, not a silent null.
 *
 * The thunk used to answer `null` on any count error, so a timeout on the
 * full-scan count (the likeliest failure exactly when the total matters most)
 * looked identical to "unknown". `legalRecentChanges.totalCount` already
 * throws; both connections now share that rule (review M39). The list itself
 * still resolves — only the `totalCount` field carries the errors entry.
 */
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeLegalResolvers } from '@/modules/legal/shell/graphql/resolvers.js';
import { timeoutError } from '@/modules/shared/core/errors.js';

import type { LegalActsRepo } from '@/modules/legal/core/ports.js';
import type { LegalAct } from '@/modules/legal/core/types.js';

const act: LegalAct = {
  actId: '424242',
  actNaturalKey: 'lege/2001/17',
  actType: 'lege',
  actNumber: '17',
  actYear: 2001,
  issuerSlug: 'parlamentul',
  canonicalDocumentId: '100023',
  displayCitation: 'Legea nr. 17/2001',
  status: 'in-vigoare',
  statusEvidence: {},
  entryIntoForce: null,
  inDegree: 3,
};

interface Connection {
  edges: { node: LegalAct; cursor: string }[];
  totalCount: null | (() => Promise<number | null>);
}

const resolversWith = (acts: Partial<LegalActsRepo>) =>
  makeLegalResolvers({
    acts: {
      listActs: () => Promise.resolve(ok({ items: [act], next: null })),
      ...acts,
    } as never,
    graph: {} as never,
    outline: {} as never,
    render: {} as never,
    searchDeps: {} as never,
    resolveDeps: {} as never,
  }) as {
    Query: { legalActs: (r: unknown, args: Record<string, unknown>) => Promise<Connection> };
    LegalActConnection: { totalCount: (parent: Connection) => Promise<number | null> };
  };

describe('legalActs.totalCount', () => {
  it('surfaces a count failure as a field error with the reason', async () => {
    const resolvers = resolversWith({
      countActs: () => Promise.resolve(err(timeoutError('count timed out after 30000ms'))),
    });
    const connection = await resolvers.Query.legalActs(undefined, {});
    // The list resolved regardless of the count.
    expect(connection.edges).toHaveLength(1);
    await expect(resolvers.LegalActConnection.totalCount(connection)).rejects.toThrow(
      /count timed out/u
    );
  });

  it('answers the real count when the count succeeds', async () => {
    const resolvers = resolversWith({ countActs: () => Promise.resolve(ok(23_527)) });
    const connection = await resolvers.Query.legalActs(undefined, {});
    await expect(resolvers.LegalActConnection.totalCount(connection)).resolves.toBe(23_527);
  });

  it('never runs the count when totalCount is not selected (thunk stays lazy)', async () => {
    let counted = 0;
    const resolvers = resolversWith({
      countActs: () => {
        counted += 1;
        return Promise.resolve(ok(1));
      },
    });
    await resolvers.Query.legalActs(undefined, {});
    expect(counted).toBe(0);
  });
});
