import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  insIdentityForTerritory,
  resolveInsEntityTerritory,
} from '@/modules/ins-native/core/entity-territory.js';
import { makeInsContributor } from '@/modules/ins-native/shell/contributor.js';

import { CJ, CLUJ_NAPOCA, makeFakeRepo } from './fake-repo.js';

import type { InsRepo } from '@/modules/ins-native/core/ports.js';
import type { InsTerritoryNode } from '@/modules/ins-native/core/types.js';
import type { ApiError, Territory } from '@/modules/shared/index.js';

const anchor = (fields: Partial<Territory> = {}): Territory => ({
  id: 7001,
  level: 'uat',
  kind: 'municipality',
  territoryKey: 'siruta:54975',
  parentId: null,
  nutsCode: null,
  territorialSirutaCode: '54975',
  sirutaCode: '54975',
  countySirutaCode: '54984',
  uatCode: null,
  name: 'Cluj-Napoca',
  countyCode: 'CJ',
  countyName: 'Cluj',
  region: null,
  population: null,
  ...fields,
});
const repoWithNodes = (
  exact: readonly InsTerritoryNode[],
  linked: readonly InsTerritoryNode[] = []
): InsRepo => ({
  ...makeFakeRepo(),
  territoriesByCodes: vi.fn(async () => ok(exact)),
  territoriesByCoreId: vi.fn(async () => ok(linked)),
});

describe('canonical entity area to INS identity', () => {
  it('keeps county identity independent of an optional SIRUTA', () => {
    expect(
      insIdentityForTerritory(
        anchor({
          level: 'county',
          kind: 'county',
          territoryKey: null,
          territorialSirutaCode: null,
          sirutaCode: null,
        })
      )
    ).toEqual({ code: 'CJ', level: 'NUTS3' });
  });
  it('keeps Bucharest county, city and six sector identities distinct', () => {
    const codes = ['179132', '179141', '179150', '179169', '179178', '179187', '179196'];
    const identities = codes.map((code, index) =>
      insIdentityForTerritory(
        anchor({
          level: index === 0 ? 'uat' : 'locality',
          kind: index === 0 ? 'municipality' : 'sector',
          territorialSirutaCode: code,
          sirutaCode: code,
          territoryKey: `siruta:${code}`,
          countyCode: 'B',
          countySirutaCode: '403',
        })
      )
    );
    expect(identities).toEqual(codes.map((code) => ({ code, level: 'LAU' })));
    expect(
      insIdentityForTerritory(
        anchor({
          level: 'county',
          kind: 'county',
          countyCode: 'B',
          territorialSirutaCode: '403',
          sirutaCode: null,
          countySirutaCode: '403',
          territoryKey: 'siruta:403',
        })
      )
    ).toEqual({ code: 'B', level: 'NUTS3' });
  });
  it.each([
    ['country', 'country', 'RO', 'NATIONAL'],
    ['macroregion', 'macroregion', 'RO1', 'NUTS1'],
    ['region', 'development_region', 'RO11', 'NUTS2'],
  ])('maps %s using its NUTS identity', (level, kind, code, expected) => {
    expect(
      insIdentityForTerritory(
        anchor({
          level,
          kind,
          nutsCode: code,
          territoryKey: `nuts:${code}`,
          sirutaCode: null,
          territorialSirutaCode: null,
        })
      )
    ).toEqual({ code, level: expected });
  });
  it.each<Partial<Territory>>([
    {
      level: 'county',
      kind: 'county',
      territorialSirutaCode: null,
      sirutaCode: '403',
      countySirutaCode: '54984',
    },
    {
      level: 'locality',
      kind: 'sector',
      territorialSirutaCode: '179132',
      sirutaCode: null,
      territoryKey: 'siruta:179132',
    },
    {
      level: 'locality',
      kind: 'sector',
      territorialSirutaCode: '179132',
      sirutaCode: '179132',
      territoryKey: 'siruta:179132',
    },
    { id: 0 },
    { id: Number.NaN },
    { level: 'future' },
    { kind: 'future' },
    { level: 'locality', kind: 'village' },
    { territorialSirutaCode: null },
    { sirutaCode: '1017' },
    { territoryKey: 'siruta:1017' },
    { territorialSirutaCode: '0' },
    { level: 'region', kind: 'development_region', nutsCode: 'RO1' },
    { level: 'country', kind: 'country', nutsCode: 'RO', territoryKey: 'nuts:RO1' },
    { level: 'county', kind: 'county', countyCode: null },
    { level: 'county', kind: 'county', countyCode: 'cj' },
    { level: 'county', kind: 'county', territorialSirutaCode: '54984' },
  ])('withholds unknown or contradictory kernel identity %j', (fields) => {
    expect(insIdentityForTerritory(anchor(fields))).toBeNull();
  });
});

describe('independent INS bridge consistency', () => {
  it('resolves by source identity without equating surrogate IDs or requiring a bridge link', async () => {
    const repo = repoWithNodes([CLUJ_NAPOCA]);
    expect((await resolveInsEntityTerritory(repo, anchor()))._unsafeUnwrap()).toEqual(CLUJ_NAPOCA);
    expect(repo.territoriesByCodes).toHaveBeenCalledWith(['54975'], ['LAU']);
    expect(repo.territoriesByCoreId).toHaveBeenCalledWith(7001);
  });
  it('accepts a matching forward and reverse link', async () => {
    const node = { ...CLUJ_NAPOCA, coreTerritoryId: 7001 };
    expect((await resolveInsEntityTerritory(repoWithNodes([node], [node]), anchor())).isOk()).toBe(
      true
    );
  });
  it('returns no presence only when both exact identity and reverse links are absent', async () => {
    const repo = repoWithNodes([]);
    expect((await resolveInsEntityTerritory(repo, anchor()))._unsafeUnwrap()).toBeNull();
    expect(repo.territoriesByCoreId).toHaveBeenCalledWith(7001);
  });
  it.each([
    { exact: [], linked: [{ ...CJ, coreTerritoryId: 7001 }] },
    { exact: [CLUJ_NAPOCA], linked: [{ ...CJ, coreTerritoryId: 7001 }] },
    { exact: [CLUJ_NAPOCA, CLUJ_NAPOCA], linked: [] },
    { exact: [{ ...CLUJ_NAPOCA, coreTerritoryId: 42 }], linked: [] },
    { exact: [CLUJ_NAPOCA], linked: [CLUJ_NAPOCA, CJ] },
    { exact: [{ ...CLUJ_NAPOCA, sirutaCode: null }], linked: [] },
    { exact: [{ ...CLUJ_NAPOCA, level: 'NUTS3' as const }], linked: [] },
  ])('rejects inconsistent source bridge %j', async ({ exact, linked }) => {
    expect(
      (await resolveInsEntityTerritory(repoWithNodes(exact, linked), anchor()))._unsafeUnwrapErr()
        .type
    ).toBe('ServiceUnavailable');
  });
  it('does not query INS for unrecognized kernel vocabulary', async () => {
    const repo = repoWithNodes([]);
    expect(
      (await resolveInsEntityTerritory(repo, anchor({ kind: 'future' })))._unsafeUnwrap()
    ).toBeNull();
    expect(repo.territoriesByCodes).not.toHaveBeenCalled();
    expect(repo.territoriesByCoreId).not.toHaveBeenCalled();
  });
});

describe('INS entity statistical context contributor', () => {
  it('uses one snapshot for source resolution, reverse links and exact certified coverage', async () => {
    const scoped = repoWithNodes([CLUJ_NAPOCA]);
    const coverage = vi.spyOn(scoped, 'datasetsForTerritory');
    const outer = repoWithNodes([]);
    outer.withSnapshot = (fn) => fn(scoped);
    const snapshot = vi.spyOn(outer, 'withSnapshot');
    const identity = vi.fn(async () => ok(anchor()));
    const result = (
      await makeInsContributor(outer, { territoryForCui: identity }).presenceFor('123')
    )._unsafeUnwrap();
    expect(identity).toHaveBeenCalledExactlyOnceWith('123');
    expect(snapshot).toHaveBeenCalledOnce();
    expect(outer.territoriesByCodes).not.toHaveBeenCalled();
    expect(scoped.territoriesByCodes).toHaveBeenCalledOnce();
    expect(scoped.territoriesByCoreId).toHaveBeenCalledOnce();
    expect(coverage).toHaveBeenCalledExactlyOnceWith(931);
    expect(result).toEqual({
      source: 'ins',
      present: true,
      label: 'Statistici INS',
      count: 1,
      badges: ['ins', 'lau'],
      attrs: {
        territoryCode: '54975',
        territoryName: 'MUNICIPIUL CLUJ-NAPOCA',
        territoryLevel: 'LAU',
        sirutaCode: '54975',
      },
    });
  });
  it('does not infer an area for missing or withheld kernel identities', async () => {
    const repo = repoWithNodes([]);
    const snapshot = vi.spyOn(repo, 'withSnapshot');
    expect((await makeInsContributor(repo).presenceFor('123'))._unsafeUnwrap()).toBeNull();
    expect(
      (
        await makeInsContributor(repo, { territoryForCui: async () => ok(null) }).presenceFor('123')
      )._unsafeUnwrap()
    ).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
  });
  it('does not claim coverage from other territories', async () => {
    const repo = repoWithNodes([CLUJ_NAPOCA]);
    repo.withSnapshot = (fn) => fn(repo);
    repo.datasetsForTerritory = async () => ok([]);
    expect(
      (
        await makeInsContributor(repo, { territoryForCui: async () => ok(anchor()) }).presenceFor(
          '123'
        )
      )._unsafeUnwrap()
    ).toBeNull();
  });
  it('propagates kernel and INS failures for the entity aggregator to handle', async () => {
    const error: ApiError = { type: 'ServiceUnavailable', message: 'unavailable' };
    const repo = repoWithNodes([CLUJ_NAPOCA]);
    expect(
      (
        await makeInsContributor(repo, { territoryForCui: async () => err(error) }).presenceFor(
          '123'
        )
      )._unsafeUnwrapErr()
    ).toEqual(error);
    repo.withSnapshot = (fn) => fn(repo);
    repo.territoriesByCoreId = async () => err(error);
    expect(
      (
        await makeInsContributor(repo, { territoryForCui: async () => ok(anchor()) }).presenceFor(
          '123'
        )
      )._unsafeUnwrapErr()
    ).toEqual(error);
  });
});
