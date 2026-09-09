/**
 * The procurement contributor (review M/M10): entity-360 presence and the
 * profile slice from the bounded presence counts; withheld identifiers
 * contribute nothing; absence is null, never an error.
 */
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  makeProcurementContributor,
  procurementPresenceSummary,
} from '@/modules/procurement/shell/contributor.js';
import { databaseError } from '@/modules/shared/core/errors.js';

import type { ProcurementPresence } from '@/modules/procurement/core/types.js';

const presence = (over: Partial<ProcurementPresence> = {}): ProcurementPresence => ({
  asAuthority: { procedures: 2, contracts: 5, directAcquisitions: 40 },
  asSupplier: { contracts: 0, directAcquisitions: 0 },
  capped: false,
  ...over,
});

const repoWith = (answer: ProcurementPresence | null) => {
  const asked: string[] = [];
  return {
    asked,
    repo: {
      presenceCounts: (cui: string) => {
        asked.push(cui);
        return Promise.resolve(ok(answer));
      },
    },
  };
};

describe('procurement contributor', () => {
  it('registers as procurement and reports presence with role badges and the total', async () => {
    const { repo } = repoWith(presence());
    const c = makeProcurementContributor(repo);
    expect(c.source).toBe('procurement');
    const p = (await c.presenceFor('4305857'))._unsafeUnwrap();
    expect(p).toMatchObject({
      source: 'procurement',
      present: true,
      label: 'Public procurement',
      count: 47,
      badges: ['contracting-authority'],
    });
    expect(p?.attrs).toEqual({
      asAuthority: { procedures: 2, contracts: 5, directAcquisitions: 40 },
      asSupplier: { contracts: 0, directAcquisitions: 0 },
      capped: false,
    });
  });

  it('badges both roles when the entity buys and sells', async () => {
    const { repo } = repoWith(presence({ asSupplier: { contracts: 1, directAcquisitions: 0 } }));
    const p = (await makeProcurementContributor(repo).presenceFor('1'))._unsafeUnwrap();
    expect(p?.badges).toEqual(['contracting-authority', 'supplier']);
    expect(p?.count).toBe(48);
  });

  it('never publishes a capped total as a plain count: the lower bound rides on the label', async () => {
    const { repo } = repoWith(
      presence({
        asAuthority: { procedures: 0, contracts: 10000, directAcquisitions: 0 },
        asSupplier: { contracts: 0, directAcquisitions: 0 },
        capped: true,
      })
    );
    const p = (await makeProcurementContributor(repo).presenceFor('1'))._unsafeUnwrap();
    expect(p?.count).toBeUndefined();
    expect(p?.label).toBe('Public procurement (10000+ records)');
    expect(p?.attrs?.['capped']).toBe(true);
  });

  it('is absent (null) for a CUI with no records, on both legs', async () => {
    const { repo } = repoWith(null);
    const c = makeProcurementContributor(repo);
    expect((await c.presenceFor('1'))._unsafeUnwrap()).toBeNull();
    expect((await c.profileSlice?.('1'))?._unsafeUnwrap()).toBeNull();
  });

  it('contributes nothing for a withheld identifier without touching the repo', async () => {
    const { repo, asked } = repoWith(presence());
    const c = makeProcurementContributor(repo);
    expect((await c.presenceFor('1234567890123'))._unsafeUnwrap()).toBeNull();
    expect((await c.profileSlice?.('1234567890123'))?._unsafeUnwrap()).toBeNull();
    expect(asked).toEqual([]);
  });

  it('propagates a repo failure as the error, never as absence', async () => {
    const c = makeProcurementContributor({
      presenceCounts: () => Promise.resolve(err(databaseError('down'))),
    });
    expect((await c.presenceFor('1')).isErr()).toBe(true);
  });

  it('writes a one-sentence summary per role, marking capped totals', () => {
    expect(procurementPresenceSummary(presence())).toBe(
      'Public procurement: contracting authority on 47 record(s) (2 procedures, 5 contracts, 40 direct acquisitions).'
    );
    expect(
      procurementPresenceSummary(
        presence({
          asAuthority: { procedures: 0, contracts: 0, directAcquisitions: 0 },
          asSupplier: { contracts: 10000, directAcquisitions: 3 },
          capped: true,
        })
      )
    ).toBe(
      'Public procurement: supplier on 10003+ record(s) (10000 contracts, 3 direct acquisitions).'
    );
  });

  it('profileSlice carries the counts as data with the procurementPresence kind', async () => {
    const { repo } = repoWith(presence());
    const slice = (await makeProcurementContributor(repo).profileSlice?.('1'))?._unsafeUnwrap();
    expect(slice).toMatchObject({ source: 'procurement', kind: 'procurementPresence' });
    expect(slice?.data).toEqual({
      asAuthority: { procedures: 2, contracts: 5, directAcquisitions: 40 },
      asSupplier: { contracts: 0, directAcquisitions: 0 },
      capped: false,
    });
  });
});
