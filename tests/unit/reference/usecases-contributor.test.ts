/**
 * Reference usecases + contributor over MOCKED ports. Verifies:
 *  - `getPublicEntity` enriches the card with the kernel Territory (single path);
 *  - `resolveReference` routes each dim to the right repo + emits kernel ResolveHit
 *    shape (`kind`, not `dim`);
 *  - the contributor's `presenceFor`/`profileSlice` produce the card (no field_trace);
 *  - the four resolve dims are exactly the declared set.
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  REFERENCE_RESOLVE_DIMS,
  type ReferencePublicEntity,
  type ReferencePublicEntityCard,
} from '@/modules/reference/core/types.js';
import {
  getPublicEntity,
  resolveReference,
  type ReferenceDeps,
} from '@/modules/reference/core/usecases.js';
import { makeReferenceContributor, toProfileSlice } from '@/modules/reference/shell/contributor.js';
import { makeReferenceResolvers } from '@/modules/reference/shell/graphql/resolvers.js';
import {
  createContributorRegistry,
  databaseError,
  type ApiError,
  type OrgNameMatch,
  type Territory,
} from '@/modules/shared/index.js';

const CLUJ: ReferencePublicEntity = {
  cui: '4305857',
  name: 'MUNICIPIUL CLUJ-NAPOCA',
  address: null,
  entityType: 'uat',
  category: 'uat_municipality',
  tags: [],
  isUat: true,
  territorialSirutaCode: '54975',
  uatMapping: { method: 'direct_cif', confidence: 'exact', unresolvedReason: null },
  parents: { cui1: null, cui2: null },
  mainCreditors: [],
  defaultReportType: 'Executie bugetara agregata la nivel de ordonator principal',
  issues: [],
  fieldTrace: null,
  updatedAt: '2026-06-11T23:41:50.207Z',
  territory: null,
};

const CLUJ_TERRITORY: Territory = {
  id: 1,
  territorialSirutaCode: '54975',
  sirutaCode: '54975',
  countySirutaCode: '54600',
  uatCode: 'CJ',
  name: 'MUNICIPIUL CLUJ-NAPOCA',
  countyCode: 'CJ',
  countyName: 'CLUJ',
  region: 'Nord-Vest',
  population: 286598,
};

const okR = <T>(v: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(v));

/** A deps stub; tests override only what they exercise. */
const makeDeps = (over: Partial<ReferenceDeps> = {}): ReferenceDeps => ({
  publicEntities: {
    findByCui: () => okR<ReferencePublicEntity | null>(CLUJ),
    list: () => okR({ items: [], next: null, totalCount: 0 }),
    searchByName: () => okR<readonly ReferencePublicEntityCard[]>([]),
    findChildren: () => okR<readonly ReferencePublicEntityCard[]>([]),
    aggregate: () => okR([]),
    resolve: (q: string) =>
      okR([{ kind: 'public_entity', value: '4305857', label: `match:${q}`, score: 0.9 }]),
    cardsForCuis: () => okR(new Map()),
  },
  classification: {
    findOne: () => okR(null),
    list: () => okR({ items: [], next: null }),
    resolve: (_s, q) =>
      okR([{ kind: 'classification', value: '1071', label: `caen:${q}`, hint: 'caen_rev2' }]),
    listSystems: () => okR([]),
  },
  territories: {
    byId: () => okR<Territory | null>(null),
    list: () => okR({ items: [], next: null, totalCount: 0 }),
    listCountyRollups: () => okR([]),
    listRegionRollups: () => okR([]),
  },
  identityRepo: {
    findByCui: () => okR(null),
    findManyByCui: () => okR(new Map()),
    findByOrgId: () => okR(null),
    getIdentifiers: () => okR([]),
    searchByName: (q: string) =>
      okR<readonly OrgNameMatch[]>([
        {
          orgId: '99',
          cui: '16054368',
          name: `org:${q}`,
          normalizedName: null,
          countyName: 'CLUJ',
          kind: 'company',
          score: 0.7,
        },
      ]),
    resolve: () => okR(null),
    territoryForCui: () => okR<Territory | null>(CLUJ_TERRITORY),
  },
  territoryRepo: {
    byTerritorialSiruta: () => okR<Territory | null>(CLUJ_TERRITORY),
    byCounty: () => okR([]),
    searchUat: () => okR<readonly Territory[]>([CLUJ_TERRITORY]),
    listCounties: () => okR([]),
    listRegions: () => okR([]),
  },
  ...over,
});

describe('getPublicEntity enriches with the kernel Territory (single source of truth)', () => {
  it('attaches the kernel Territory resolved by CUI and canonical FK', async () => {
    const res = await getPublicEntity(makeDeps(), '4305857', false);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) {
      expect(res.value?.territory?.countyName).toBe('CLUJ');
      expect(res.value?.territory?.region).toBe('Nord-Vest');
    }
  });
});

describe('canonical entity territory resolution', () => {
  it('resolves a reference detail with no legacy SIRUTA through its CUI', async () => {
    const deps = makeDeps();
    const requested: string[] = [];
    const result = await getPublicEntity(
      {
        ...deps,
        publicEntities: {
          ...deps.publicEntities,
          findByCui: () => okR({ ...CLUJ, territorialSirutaCode: null }),
        },
        identityRepo: {
          ...deps.identityRepo,
          territoryForCui: (cui) => {
            requested.push(cui);
            return okR(CLUJ_TERRITORY);
          },
        },
        territoryRepo: {
          ...deps.territoryRepo,
          byTerritorialSiruta: () => {
            throw new Error('legacy lookup must not run');
          },
        },
      },
      CLUJ.cui,
      false
    );
    expect(requested).toEqual([CLUJ.cui]);
    expect(result.isOk() && result.value?.territory).toEqual(CLUJ_TERRITORY);
  });
});

describe('reference list territory resolver', () => {
  const resolver = (deps: ReferenceDeps) => {
    const result = makeReferenceResolvers({ ...deps, registry: createContributorRegistry() }) as {
      ReferencePublicEntity: {
        territory(parent: ReferencePublicEntityCard): Promise<Territory | null>;
      };
    };
    return result.ReferencePublicEntity.territory;
  };
  it('loads null-SIRUTA list cards by CUI and deduplicates same-tick requests', async () => {
    const deps = makeDeps();
    const calls: string[] = [];
    const load = resolver({
      ...deps,
      identityRepo: {
        ...deps.identityRepo,
        territoryForCui: (cui) => {
          calls.push(cui);
          return okR(CLUJ_TERRITORY);
        },
      },
    });
    const card = { ...CLUJ, territorialSirutaCode: null, territory: null };
    expect(await Promise.all([load(card), load(card)])).toEqual([CLUJ_TERRITORY, CLUJ_TERRITORY]);
    expect(calls).toEqual([CLUJ.cui]);
  });
  it('propagates unavailable lookup instead of presenting an absent territory', async () => {
    const deps = makeDeps();
    const load = resolver({
      ...deps,
      identityRepo: {
        ...deps.identityRepo,
        territoryForCui: () => Promise.resolve(err(databaseError('unavailable'))),
      },
    });
    await expect(load({ ...CLUJ, territory: null })).rejects.toThrow('unavailable');
  });
});

describe('resolveReference routes dims + emits kernel ResolveHit (kind, not dim)', () => {
  it('public_entity → PublicEntityRepo.resolve', async () => {
    const res = await resolveReference(makeDeps(), 'public_entity', 'Cluj', 5);
    expect(res.isOk() && res.value[0]?.kind).toBe('public_entity');
    expect(res.isOk() && res.value[0]?.value).toBe('4305857');
  });
  it('classification → ClassificationRepo.resolve', async () => {
    const res = await resolveReference(makeDeps(), 'classification', 'paine', 5);
    expect(res.isOk() && res.value[0]?.kind).toBe('classification');
  });
  it('territory → kernel TerritoryRepo.searchUat → siruta value', async () => {
    const res = await resolveReference(makeDeps(), 'territory', 'Cluj', 5);
    expect(res.isOk() && res.value[0]?.kind).toBe('territory');
    expect(res.isOk() && res.value[0]?.value).toBe('54975');
  });
  it('organization → kernel IdentityRepo (CUI as value)', async () => {
    const res = await resolveReference(makeDeps(), 'organization', 'someco', 5);
    expect(res.isOk() && res.value[0]?.kind).toBe('organization');
    expect(res.isOk() && res.value[0]?.value).toBe('16054368');
  });
  it('rejects an unknown dim', async () => {
    const res = await resolveReference(makeDeps(), 'nope' as never, 'x', 5);
    expect(res.isErr()).toBe(true);
  });
});

describe('REFERENCE_RESOLVE_DIMS is exactly the four declared dimensions', () => {
  it('matches', () => {
    expect([...REFERENCE_RESOLVE_DIMS]).toEqual([
      'public_entity',
      'territory',
      'classification',
      'organization',
    ]);
  });
});

describe('contributor — presence + profileSlice (the §14.7 single path, card only)', () => {
  it('presenceFor returns a registry presence with badges', async () => {
    const c = makeReferenceContributor(makeDeps().publicEntities);
    const res = await c.presenceFor('4305857');
    expect(res.isOk()).toBe(true);
    if (res.isOk() && res.value !== null) {
      expect(res.value.source).toBe('reference');
      expect(res.value.present).toBe(true);
      expect(res.value.badges).toContain('uat');
    }
  });

  it('profileSlice wraps the card (no field_trace key)', async () => {
    const c = makeReferenceContributor(makeDeps().publicEntities);
    const res = await c.profileSlice?.('4305857');
    expect(res?.isOk()).toBe(true);
    if (res !== undefined && res.isOk() && res.value !== null) {
      expect(res.value.source).toBe('reference');
      expect(res.value.kind).toBe('public_entity');
      expect(JSON.stringify(res.value.data)).not.toContain('field_trace');
    }
  });

  it('toProfileSlice summary mentions the entity + UAT', () => {
    const slice = toProfileSlice({ ...CLUJ, territory: CLUJ_TERRITORY });
    expect(slice.summary).toContain('CLUJ-NAPOCA');
    expect(slice.summary).toContain('(UAT)');
  });
});
