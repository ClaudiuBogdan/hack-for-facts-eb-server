/**
 * I-19: `LegalAct.versionCount` is the act's exact expression count. It used to
 * be the length of a document list capped at 200, so the Fiscal Code's 243
 * expressions read as 200.
 */
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { resolveVersionCount } from '@/modules/legal/shell/graphql/resolvers.js';
import { databaseError } from '@/modules/shared/index.js';

import type { LegalAct } from '@/modules/legal/core/types.js';

const act = (over: Record<string, unknown> = {}): LegalAct =>
  ({ actId: '66150', ...over }) as unknown as LegalAct;

describe('resolveVersionCount', () => {
  it('reads the exact count from the repository, past the old 200 cap', async () => {
    const calls: string[] = [];
    const count = await resolveVersionCount(act(), {
      countDocuments: (actId) => {
        calls.push(actId);
        return Promise.resolve(ok(243));
      },
    });
    expect(count).toBe(243);
    expect(calls).toEqual(['66150']);
  });

  it('uses the act card count when present, zero included, without a second read', async () => {
    const countDocuments = (): never => {
      throw new Error('the card count must be used');
    };
    expect(await resolveVersionCount(act({ versionCount: 0 }), { countDocuments })).toBe(0);
    expect(await resolveVersionCount(act({ versionCount: 243 }), { countDocuments })).toBe(243);
  });

  it('surfaces a repository failure instead of inventing a count', async () => {
    const failure = databaseError('countDocuments failed', new Error('boom'));
    await expect(
      resolveVersionCount(act(), { countDocuments: () => Promise.resolve(err(failure)) })
    ).rejects.toThrow('countDocuments failed');
  });
});
