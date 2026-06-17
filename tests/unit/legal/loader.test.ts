/**
 * Legal — `LegalActByIdLoader` dangling tolerance (kernel §15.4). Parliament (04)
 * + judicial (08) depend on this: a missing/unknown act_id MUST return null (never
 * throw), and a DB error MUST degrade to null (never break a dangling-FK consumer).
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { makeLegalActLoader } from '@/modules/legal/shell/loader/legal-act-loader.js';
import { databaseError, type ApiError } from '@/modules/shared/index.js';

import type { LegalActsRepo } from '@/modules/legal/core/ports.js';
import type { LegalAct } from '@/modules/legal/core/types.js';

const act = (actId: string, citation: string): LegalAct => ({
  actId,
  actNaturalKey: `lege:${actId}:2015:`,
  actType: 'lege',
  actNumber: actId,
  actYear: 2015,
  issuerSlug: 'parlamentul',
  canonicalDocumentId: `doc-${actId}`,
  displayCitation: citation,
  status: 'in-vigoare',
  statusEvidence: {},
  entryIntoForce: '2015-01-01',
  inDegree: 1,
});

/** A minimal LegalActsRepo stub exposing only the two loader methods. */
const stubRepo = (over: Partial<LegalActsRepo>): LegalActsRepo =>
  ({
    findActById: async (id: string): Promise<Result<LegalAct | null, ApiError>> =>
      ok(id === '66150' ? act('66150', 'Legea nr. 227/2015') : null),
    findActsByIds: async (ids: readonly string[]): Promise<Result<readonly LegalAct[], ApiError>> =>
      ok(ids.filter((i) => i === '66150').map((i) => act(i, 'Legea nr. 227/2015'))),
    ...over,
  }) as unknown as LegalActsRepo;

describe('LegalActByIdLoader — dangling tolerance', () => {
  it('load(real) → resolved ref', async () => {
    const loader = makeLegalActLoader({ acts: stubRepo({}) });
    await expect(loader.load('66150')).resolves.toEqual({
      actId: '66150',
      title: 'Legea nr. 227/2015',
      actType: 'lege',
      resolutionStatus: 'resolved',
    });
  });

  it('load(missing) → null (NEVER a fabricated dangling ref)', async () => {
    const loader = makeLegalActLoader({ acts: stubRepo({}) });
    await expect(loader.load('999999999')).resolves.toBeNull();
  });

  it('load() degrades a DB error to null (never throws)', async () => {
    const loader = makeLegalActLoader({
      acts: stubRepo({ findActById: async (): Promise<Result<LegalAct | null, ApiError>> => err(databaseError('boom')) }),
      logger: { warn: vi.fn() },
    });
    await expect(loader.load('66150')).resolves.toBeNull();
  });

  it('loadMany preserves order + arity (dangling slots → null)', async () => {
    const loader = makeLegalActLoader({ acts: stubRepo({}) });
    const out = await loader.loadMany(['999', '66150', '888']);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeNull();
    expect(out[1]?.actId).toBe('66150');
    expect(out[2]).toBeNull();
  });

  it('loadMany([]) → []', async () => {
    const loader = makeLegalActLoader({ acts: stubRepo({}) });
    await expect(loader.loadMany([])).resolves.toEqual([]);
  });

  it('loadMany degrades a DB error to all-null', async () => {
    const loader = makeLegalActLoader({
      acts: stubRepo({ findActsByIds: async (): Promise<Result<readonly LegalAct[], ApiError>> => err(databaseError('boom')) }),
    });
    await expect(loader.loadMany(['66150', '1'])).resolves.toEqual([null, null]);
  });

  it('load() NEVER rejects even if the repo promise throws (Codex P0 fix)', async () => {
    const loader = makeLegalActLoader({
      acts: stubRepo({
        findActById: async (): Promise<Result<LegalAct | null, ApiError>> => {
          throw new Error('pool exploded');
        },
      }),
      logger: { warn: vi.fn() },
    });
    await expect(loader.load('66150')).resolves.toBeNull();
  });

  it('loadMany() NEVER rejects even if the repo promise throws', async () => {
    const loader = makeLegalActLoader({
      acts: stubRepo({
        findActsByIds: async (): Promise<Result<readonly LegalAct[], ApiError>> => {
          throw new Error('pool exploded');
        },
      }),
    });
    await expect(loader.loadMany(['66150', '1'])).resolves.toEqual([null, null]);
  });
});
