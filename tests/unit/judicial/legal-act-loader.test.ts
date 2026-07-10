/**
 * Judicial — the cross-module LegalAct resolution on JudicialLegalRef.targetAct.
 * It must:
 *   - return null when target_act_id is null,
 *   - return null when the kernel legalActLoader is not registered (legal disabled),
 *   - tolerate a DANGLING act_id (loader returns null) → null, never throw,
 *   - return the LegalActRef when the loader resolves it.
 */

import { describe, expect, it, vi } from 'vitest';

import { makeJudicialResolvers } from '@/modules/judicial/shell/graphql/resolvers.js';

import type { JudicialRepos } from '@/modules/judicial/core/usecases.js';
import type { LegalActByIdLoader, LegalActRef } from '@/modules/shared/index.js';

const repos = {} as unknown as JudicialRepos; // targetAct resolver doesn't touch repos

const targetActResolver = (loader: () => LegalActByIdLoader | undefined) => {
  const resolvers = makeJudicialResolvers({ repos, legalActLoader: loader }) as {
    JudicialLegalRef: { targetAct: (p: { targetActId: string | null }) => Promise<unknown> };
  };
  return resolvers.JudicialLegalRef.targetAct;
};

describe('JudicialLegalRef.targetAct — kernel legalActLoader, dangling-tolerant', () => {
  it('targetActId null → null (no loader call)', async () => {
    const load = vi.fn();
    const resolve = targetActResolver(() => ({ load, loadMany: vi.fn() }));
    expect(await resolve({ targetActId: null })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('no loader registered (legal disabled) → null', async () => {
    const resolve = targetActResolver(() => undefined);
    expect(await resolve({ targetActId: '42' })).toBeNull();
  });

  it('dangling act_id (loader returns null) → null', async () => {
    const load = vi.fn(async () => null);
    const resolve = targetActResolver(() => ({ load, loadMany: vi.fn() }));
    expect(await resolve({ targetActId: '999999' })).toBeNull();
    expect(load).toHaveBeenCalledWith('999999');
  });

  it('resolved act_id → the LegalActRef', async () => {
    const ref: LegalActRef = {
      actId: '66150',
      title: 'Codul Fiscal',
      actType: 'lege',
      resolutionStatus: 'resolved',
    };
    const load = vi.fn(async () => ref);
    const resolve = targetActResolver(() => ({ load, loadMany: vi.fn() }));
    expect(await resolve({ targetActId: '66150' })).toEqual(ref);
  });
});
