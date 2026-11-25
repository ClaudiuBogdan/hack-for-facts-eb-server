/**
 * The contract-award snapshot's after-read rule and the log reason it gives (25 Nov). The
 * answer to a client is the same retryable refusal either way; the reason tells a changed
 * release (`republished`) from a grant lost during the read (`not_readable`), and a missing
 * view (`not_deployed`) from a missing grant (`not_readable`).
 */

import { describe, expect, it } from 'vitest';

import { makeCaRecordsRepo } from '@/modules/procurement/shell/repo/ca-records-repo.js';

import { makeCapturingDb } from '../../fixtures/capturing-db.js';

const P1 = '2026-11-18T03:10:00.000000Z';
const P2 = '2026-11-19T03:10:00.000000Z';

interface World {
  views: boolean;
  deployed: boolean;
  names: boolean;
  disclosure: boolean;
  release: boolean;
  asOf: string;
}

const WORLD: World = {
  views: true,
  deployed: true,
  names: true,
  disclosure: true,
  release: true,
  asOf: P1,
};

/** One snapshot; `after` changes the world once the read is done. */
const snapshot = async (start: Partial<World>, after: (world: World) => void = () => undefined) => {
  const world: World = { ...WORLD, ...start };
  const db = makeCapturingDb([], {
    respond: (text) => {
      if (text.includes('as views'))
        return [
          {
            views: world.views,
            deployed: world.deployed,
            names: world.names,
            registry: true,
            disclosure: world.disclosure,
            release: world.release,
          },
        ];
      if (text.includes('as as_of')) return [{ as_of: world.release ? world.asOf : null }];
      return [];
    },
  });
  return makeCaRecordsRepo(db, true).snapshot(async (reader) => {
    const asOf = await reader.dataAsOf();
    after(world);
    return asOf;
  });
};

const failure = (result: { _unsafeUnwrapErr: () => object }) =>
  result._unsafeUnwrapErr() as { type: string; message: string; reason?: string };

describe('contract-award snapshot reasons', () => {
  it('answers when nothing moved', async () => {
    expect((await snapshot({}))._unsafeUnwrap()).toBe(P1);
  });

  it('logs a changed release as republished', async () => {
    const error = failure(await snapshot({}, (w) => (w.asOf = P2)));
    expect(error.type).toBe('ServiceUnavailable');
    expect(error.message).toContain('republished');
    expect(error.reason).toBe('republished');
  });

  it.each([
    ['the release column', (w: World) => (w.release = false)],
    ['the views', (w: World) => (w.views = false)],
    ['the names view', (w: World) => (w.names = false)],
    ['the D6 view', (w: World) => (w.disclosure = false)],
  ])('logs %s lost during the read as not_readable, with the same answer', async (_, lose) => {
    const error = failure(await snapshot({}, lose));
    expect(error.type).toBe('ServiceUnavailable');
    expect(error.message).toContain('republished');
    expect(error.reason).toBe('not_readable');
  });

  it('tells a missing view from a missing grant before any read', async () => {
    const missing = failure(await snapshot({ views: false, deployed: false }));
    const denied = failure(await snapshot({ views: false, deployed: true }));
    expect(missing.message).toBe(denied.message);
    expect(missing.reason).toBe('not_deployed');
    expect(denied.reason).toBe('not_readable');
  });
});
