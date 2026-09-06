import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { prepareInsMapSelection } from '@/modules/ins-native/core/map-selection.js';

import { CJ, CLUJ_NAPOCA, DIMENSIONS, POPTEST, makeFakeRepo } from './fake-repo.js';

const input = {
  datasetCode: 'POPTEST',
  granularity: 'UAT' as const,
  territoryCodes: ['54975', '179141'],
};

describe('INS map selection', () => {
  it('uses certified non-geographic defaults and keeps unsupported sectors as gaps', async () => {
    const result = (await prepareInsMapSelection(makeFakeRepo(), input))._unsafeUnwrap();
    expect(result.request).toMatchObject({
      unitNomItemId: 9685,
      periodicity: 'ANNUAL',
      territories: [{ code: '54975', territoryId: CLUJ_NAPOCA.territoryId }],
    });
    expect(result.request.nonGeographicPins).toEqual(
      new Map([
        [1, 1],
        [2, 105],
      ])
    );
    expect(result.unresolvedTerritoryCodes).toEqual(['179141']);
  });
  it('resolves counties at NUTS3 rather than interpreting them as UATs', async () => {
    const result = (
      await prepareInsMapSelection(makeFakeRepo(), {
        ...input,
        granularity: 'County',
        territoryCodes: ['CJ'],
      })
    )._unsafeUnwrap();
    expect(result.request.territories).toEqual([{ code: 'CJ', territoryId: CJ.territoryId }]);
  });
  it('changes only the paired dimension even when the same member ID exists elsewhere', async () => {
    const repo = makeFakeRepo();
    const base = repo.membersByIds.bind(repo);
    repo.membersByIds = async (code, ids) => {
      const result = await base(code, [...ids, 106]);
      if (result.isErr()) return result;
      const member = result.value.find((item) => item.nomItemId === 106)!;
      return ok([...result.value, { ...member, dimIndex: 0 }, { ...member, dimIndex: 2 }]);
    };
    const result = (
      await prepareInsMapSelection(repo, {
        ...input,
        sourcePins: [{ dimensionIndex: 1, memberCode: '106' }],
      })
    )._unsafeUnwrap();
    expect(result.request.nonGeographicPins).toEqual(
      new Map([
        [1, 1],
        [2, 106],
      ])
    );
  });
  it('rejects geography, repeated axes, wrong membership and noncanonical codes', async () => {
    for (const sourcePins of [
      [{ dimensionIndex: 2, memberCode: '931' }],
      [
        { dimensionIndex: 1, memberCode: '106' },
        { dimensionIndex: 1, memberCode: '105' },
      ],
      [{ dimensionIndex: 0, memberCode: '106' }],
      [{ dimensionIndex: 1, memberCode: '0106' }],
    ])
      expect((await prepareInsMapSelection(makeFakeRepo(), { ...input, sourcePins })).isErr()).toBe(
        true
      );
  });
  it('requires a selected unit when certified defaults do not choose one', async () => {
    const request = {
      datasetCode: 'CNTTEST',
      granularity: 'County' as const,
      territoryCodes: ['CJ'],
    };
    expect((await prepareInsMapSelection(makeFakeRepo(), request))._unsafeUnwrapErr().type).toBe(
      'InvalidInput'
    );
    const selected = (
      await prepareInsMapSelection(makeFakeRepo(), { ...request, unitCode: '9507' })
    )._unsafeUnwrap();
    expect(selected.unit.nomItemId).toBe(9507);
    for (const unitCode of ['09507', '106', '999999'])
      expect((await prepareInsMapSelection(makeFakeRepo(), { ...request, unitCode })).isErr()).toBe(
        true
      );
  });
  it('requires selection for an axis with no certified default', async () => {
    const repo = makeFakeRepo();
    const defaults = repo.defaultPins.bind(repo);
    repo.defaultPins = async (codes) => {
      const result = await defaults(codes);
      return result.map((pins) => pins.filter((pin) => pin.dimIndex !== 0));
    };
    expect((await prepareInsMapSelection(repo, input))._unsafeUnwrapErr().type).toBe(
      'InvalidInput'
    );
    expect(
      (
        await prepareInsMapSelection(repo, {
          ...input,
          sourcePins: [{ dimensionIndex: 0, memberCode: '2' }],
        })
      ).isOk()
    ).toBe(true);
  });
  it('never hides a corrupt certified default behind an explicit override', async () => {
    const repo = makeFakeRepo();
    repo.defaultPins = async () =>
      ok([{ datasetCode: 'POPTEST', dimIndex: 0, nomItemId: 999999, policy: 'MANIFEST' }]);
    expect(
      (
        await prepareInsMapSelection(repo, {
          ...input,
          sourcePins: [{ dimensionIndex: 0, memberCode: '2' }],
          unitCode: '9685',
        })
      )._unsafeUnwrapErr().type
    ).toBe('ServiceUnavailable');
  });
  it('requires frequency selection for datasets with multiple published frequencies', async () => {
    const repo = makeFakeRepo();
    repo.getDataset = async () => ok({ ...POPTEST, periodicities: ['ANNUAL', 'MONTHLY'] });
    expect((await prepareInsMapSelection(repo, input))._unsafeUnwrapErr().type).toBe(
      'InvalidInput'
    );
    expect((await prepareInsMapSelection(repo, { ...input, periodicity: 'ANNUAL' })).isOk()).toBe(
      true
    );
    expect(
      (await prepareInsMapSelection(repo, { ...input, periodicity: 'QUARTERLY' })).isErr()
    ).toBe(true);
  });
  it('rejects duplicate, wrong-level and unexpected returned identities', async () => {
    for (const nodes of [
      [CLUJ_NAPOCA, CLUJ_NAPOCA],
      [CJ],
      [{ ...CLUJ_NAPOCA, code: 'unexpected' }],
    ]) {
      const repo = makeFakeRepo();
      repo.territoriesByCodes = async () => ok(nodes);
      expect((await prepareInsMapSelection(repo, input))._unsafeUnwrapErr().type).toBe(
        'ServiceUnavailable'
      );
    }
    expect(
      (
        await prepareInsMapSelection(makeFakeRepo(), {
          ...input,
          territoryCodes: ['54975', '54975'],
        })
      ).isErr()
    ).toBe(true);
  });
  it('rejects uncertified publications and inconsistent layouts', async () => {
    const repo = makeFakeRepo();
    repo.getDataset = async () => ok({ ...POPTEST, publicationStatus: 'UNCERTIFIED' });
    expect((await prepareInsMapSelection(repo, input))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
    const broken = makeFakeRepo();
    broken.listDimensions = async () => ok((DIMENSIONS['POPTEST'] ?? []).slice(1));
    expect((await prepareInsMapSelection(broken, input))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
  });
});
