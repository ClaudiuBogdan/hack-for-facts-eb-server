import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { observationGeoScope } from '@/modules/ins-native/core/geography.js';
import { classificationPins, listObservations } from '@/modules/ins-native/core/usecases.js';

import { DIMENSIONS, makeFakeRepo } from './fake-repo.js';

const dimensions = DIMENSIONS['POPTEST'] ?? [];

describe('paired native source pins', () => {
  it('preserves pairs when both source members exist in both geographic dimensions', async () => {
    const repo = makeFakeRepo();
    const original = (await repo.membersByIds('POPTEST', [3075, 931]))._unsafeUnwrap();
    repo.membersByIds = async () =>
      ok(original.flatMap((m) => [m, { ...m, dimIndex: m.dimIndex === 2 ? 3 : 2 }]));
    for (const pairs of [
      [
        [2, 3075],
        [3, 931],
      ],
      [
        [2, 931],
        [3, 3075],
      ],
    ]) {
      const result = (
        await classificationPins(repo, 'POPTEST', dimensions, {
          sourcePins: pairs.map(([dimensionIndex, id]) => ({
            dimensionIndex: dimensionIndex!,
            memberCode: String(id),
          })),
        })
      )._unsafeUnwrap();
      expect([...result.pins.values()]).toEqual(pairs.map(([, id]) => [id]));
      expect(observationGeoScope(dimensions, null, result.explicitPins)._unsafeUnwrap()).toEqual({
        kind: 'explicitSource',
        pairs: [pairs],
      });
    }
  });
  it('validates membership in the requested dimension, not only dataset membership', async () => {
    const result = await classificationPins(makeFakeRepo(), 'POPTEST', dimensions, {
      sourcePins: [{ dimensionIndex: 2, memberCode: '931' }],
    });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'sourcePins' });
  });
  it.each(['TOTAL', '01', '-0', ' 1', '+1', '1e0', '2147483648', '-2147483649'])(
    'rejects noncanonical source member %s',
    async (memberCode) => {
      expect(
        (
          await classificationPins(makeFakeRepo(), 'POPTEST', dimensions, {
            sourcePins: [{ dimensionIndex: 0, memberCode }],
          })
        ).isErr()
      ).toBe(true);
    }
  );
  it.each([-2147483648, 0, 2147483647])('accepts actual signed source member %s', async (id) => {
    const repo = makeFakeRepo();
    const template = (await repo.membersByIds('POPTEST', [1]))._unsafeUnwrap()[0]!;
    repo.membersByIds = async () => ok([{ ...template, nomItemId: id }]);
    expect(
      (
        await classificationPins(repo, 'POPTEST', dimensions, {
          sourcePins: [{ dimensionIndex: 0, memberCode: String(id) }],
        })
      )
        ._unsafeUnwrap()
        .pins.get(1)
    ).toEqual([id]);
  });
  it.each([-1, 1.5, 4, 5, 6, 7])(
    'rejects undeclared or nonclassification dimension %s',
    async (dimensionIndex) => {
      expect(
        (
          await classificationPins(makeFakeRepo(), 'POPTEST', dimensions, {
            sourcePins: [{ dimensionIndex, memberCode: '1' }],
          })
        ).isErr()
      ).toBe(true);
    }
  );
  it('rejects duplicate dimensions even when their member is equal', async () => {
    expect(
      (
        await classificationPins(makeFakeRepo(), 'POPTEST', dimensions, {
          sourcePins: [
            { dimensionIndex: 0, memberCode: '1' },
            { dimensionIndex: 0, memberCode: '1' },
          ],
        })
      ).isErr()
    ).toBe(true);
  });
  it('rejects mixed exact and legacy selections even if legacy lists are empty', async () => {
    for (const legacy of [
      { classificationTypeCodes: [] },
      { classificationValueCodes: ['TOTAL'] },
    ]) {
      expect(
        (
          await classificationPins(makeFakeRepo(), 'POPTEST', dimensions, {
            ...legacy,
            sourcePins: [],
          })
        ).isErr()
      ).toBe(true);
    }
  });
  it('requires complete source geography unless a canonical territory is selected', async () => {
    const repo = makeFakeRepo();
    expect(
      (
        await listObservations(repo, 'POPTEST', {
          sourcePins: [{ dimensionIndex: 2, memberCode: '3075' }],
        })
      ).isErr()
    ).toBe(true);
    expect(repo.factQueries).toHaveLength(0);
  });
  it('permits bounded canonical inspection with a partial non-geographic selection', async () => {
    const repo = makeFakeRepo();
    const rows = (
      await listObservations(repo, 'POPTEST', {
        sourcePins: [{ dimensionIndex: 0, memberCode: '1' }],
        sirutaCodes: ['54975'],
      })
    )._unsafeUnwrap().nodes;
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.territory?.sirutaCode === '54975')).toBe(true);
  });

  it('intersects complete source pins with canonical geography without broadening', async () => {
    const sourcePins = [
      { dimensionIndex: 0, memberCode: '1' },
      { dimensionIndex: 1, memberCode: '105' },
      { dimensionIndex: 2, memberCode: '3075' },
      { dimensionIndex: 3, memberCode: '931' },
    ];
    const repo = makeFakeRepo();
    expect(
      (
        await listObservations(repo, 'POPTEST', { sourcePins, sirutaCodes: ['54975'] })
      )._unsafeUnwrap().nodes
    ).toHaveLength(3);
    expect(
      (
        await listObservations(repo, 'POPTEST', { sourcePins, sirutaCodes: ['1017'] })
      )._unsafeUnwrap().nodes
    ).toEqual([]);
  });
});
