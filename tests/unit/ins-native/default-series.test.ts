import { describe, expect, it } from 'vitest';

import { buildDefaultSeries } from '@/modules/ins-native/core/default-series.js';

import { CLUJ_NAPOCA, CNTTEST, DIMENSIONS, POPTEST, RO, makeFakeRepo } from './fake-repo.js';

import type { InsDefaultPin } from '@/modules/ins-native/core/ports.js';

const prepare = async (preferred: readonly number[] = []) => {
  const repo = makeFakeRepo();
  const dimensions = DIMENSIONS['POPTEST'] ?? [];
  const defaults = (await repo.defaultPins(['POPTEST']))._unsafeUnwrap();
  const members = (
    await repo.membersByIds('POPTEST', [...defaults.map((pin) => pin.nomItemId), ...preferred])
  )._unsafeUnwrap();
  return { dimensions, defaults, members };
};

describe('native INS default preparation', () => {
  it('pins only non-geographic dimensions and preserves the actual selected national node', async () => {
    const { dimensions, defaults, members } = await prepare();
    for (const node of [CLUJ_NAPOCA, RO]) {
      const value = buildDefaultSeries(
        POPTEST,
        dimensions,
        defaults,
        members,
        [],
        node
      )._unsafeUnwrap();
      expect(value?.request.nonGeographicPins).toEqual(
        new Map([
          [1, 1],
          [2, 105],
        ])
      );
      expect(value?.request.unitNomItemId).toBe(9685);
      expect(value?.request.geoScope).toEqual({ kind: 'modern', territoryIds: [node.territoryId] });
    }
  });
  it('ignores geographic TOTAL defaults before checking their references', async () => {
    const { dimensions, defaults, members } = await prepare();
    const brokenGeography = defaults.map((pin) =>
      pin.dimIndex === 2 || pin.dimIndex === 3
        ? { ...pin, nomItemId: 999999, policy: 'unknown-geography-policy' }
        : pin
    );
    expect(
      buildDefaultSeries(POPTEST, dimensions, brokenGeography, members, [], CLUJ_NAPOCA).isOk()
    ).toBe(true);
  });
  it('uses one preferred member without changing geography and ignores IDs absent in this dataset', async () => {
    const { dimensions, defaults, members } = await prepare([106, 999999]);
    const value = buildDefaultSeries(
      POPTEST,
      dimensions,
      defaults,
      members,
      [106, 106, 999999],
      CLUJ_NAPOCA
    )._unsafeUnwrap();
    expect(value?.strategy).toBe('PREFERRED_CLASSIFICATION');
    expect(value?.request.nonGeographicPins).toEqual(
      new Map([
        [1, 1],
        [2, 106],
      ])
    );
  });
  it('rejects competing preferred members in one dimension instead of choosing by order', async () => {
    const { dimensions, defaults, members } = await prepare([106, 107]);
    for (const preferred of [
      [106, 107],
      [107, 106],
    ]) {
      expect(
        buildDefaultSeries(POPTEST, dimensions, defaults, members, preferred, RO)._unsafeUnwrapErr()
          .type
      ).toBe('InvalidInput');
    }
  });
  it('rejects geographic preferred members even if a non-geographic preference is also present', async () => {
    const { dimensions, defaults, members } = await prepare([106, 931]);
    expect(
      buildDefaultSeries(POPTEST, dimensions, defaults, members, [106, 931], RO)._unsafeUnwrapErr()
    ).toMatchObject({
      type: 'InvalidInput',
      field: 'preferredClassificationCodes',
    });
  });
  it('reports no default when unit policy is absent instead of choosing a unit', async () => {
    const repo = makeFakeRepo();
    const defaults = (await repo.defaultPins(['CNTTEST']))._unsafeUnwrap();
    const members = (
      await repo.membersByIds(
        'CNTTEST',
        defaults.map((pin) => pin.nomItemId)
      )
    )._unsafeUnwrap();
    expect(
      buildDefaultSeries(
        CNTTEST,
        DIMENSIONS['CNTTEST'] ?? [],
        defaults,
        members,
        [],
        RO
      )._unsafeUnwrap()
    ).toBeNull();
  });
  it('distinguishes missing policy from a broken referenced default', async () => {
    const { dimensions, defaults, members } = await prepare();
    expect(
      buildDefaultSeries(
        POPTEST,
        dimensions,
        defaults.filter((pin) => pin.dimIndex !== 0),
        members,
        [],
        RO
      )._unsafeUnwrap()
    ).toBeNull();
    expect(
      buildDefaultSeries(
        POPTEST,
        dimensions,
        defaults,
        members.filter((member) => member.nomItemId !== 1),
        [],
        RO
      )._unsafeUnwrapErr().type
    ).toBe('ServiceUnavailable');
    expect(
      buildDefaultSeries(
        POPTEST,
        dimensions,
        defaults,
        members.filter((member) => member.nomItemId !== 9685),
        [],
        RO
      )._unsafeUnwrapErr().type
    ).toBe('ServiceUnavailable');
  });
  it('accepts a preferred member when that dimension has no default policy', async () => {
    const { dimensions, defaults, members } = await prepare([2]);
    const value = buildDefaultSeries(
      POPTEST,
      dimensions,
      defaults.filter((pin) => pin.dimIndex !== 0),
      members,
      [2],
      RO
    )._unsafeUnwrap();
    expect(value?.request.nonGeographicPins.get(1)).toBe(2);
  });
  it('does not let another dataset supply a missing reference with the same dimension and id', async () => {
    const { dimensions, defaults, members } = await prepare();
    const wrongDataset = members.map((member) =>
      member.nomItemId === 1 ? { ...member, datasetCode: 'OTHER' } : member
    );
    expect(
      buildDefaultSeries(POPTEST, dimensions, defaults, wrongDataset, [], RO)._unsafeUnwrapErr()
        .type
    ).toBe('ServiceUnavailable');
  });
  it('validates policy meaning rather than treating every referenced member as a default', async () => {
    const { dimensions, defaults, members } = await prepare([2]);
    const badPolicies: InsDefaultPin[][] = [
      [...defaults, defaults[0]!],
      defaults.map((pin) => (pin.dimIndex === 0 ? { ...pin, nomItemId: 2 } : pin)),
      defaults.map((pin) => (pin.dimIndex === 5 ? { ...pin, policy: 'TOTAL_MEMBER' } : pin)),
    ];
    for (const pins of badPolicies)
      expect(
        buildDefaultSeries(POPTEST, dimensions, pins, members, [], RO)._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
    const manifest = defaults.map((pin) =>
      pin.dimIndex === 0 ? { ...pin, nomItemId: 2, policy: 'MANIFEST' } : pin
    );
    expect(
      buildDefaultSeries(POPTEST, dimensions, manifest, members, [], RO)
        ._unsafeUnwrap()
        ?.request.nonGeographicPins.get(1)
    ).toBe(2);
  });
  it('allows certified non-geographic data only in national context with no invented tuple', async () => {
    const { dimensions, defaults, members } = await prepare();
    const nonGeographic = dimensions.map((dimension) => ({ ...dimension, isTerritorial: false }));
    expect(
      buildDefaultSeries(POPTEST, nonGeographic, defaults, members, [], RO)._unsafeUnwrap()?.request
        .geoScope
    ).toEqual({ kind: 'nonGeographic' });
    expect(
      buildDefaultSeries(POPTEST, nonGeographic, defaults, members, [], CLUJ_NAPOCA)._unsafeUnwrap()
    ).toBeNull();
  });
  it('fails catalog dimension defects before they can produce an empty series', async () => {
    const { dimensions, defaults, members } = await prepare();
    for (const broken of [
      dimensions.slice(1),
      dimensions.map((dimension) =>
        dimension.dimIndex === 1 ? { ...dimension, slotIndex: 1 } : dimension
      ),
    ]) {
      expect(
        buildDefaultSeries(POPTEST, broken, defaults, members, [], RO)._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
    }
  });
});
