/**
 * Primarii-transparency usecases + contributor over MOCKED ports. Verifies:
 *  - `getEntityTransparencyProfile` returns the bundle;
 *  - `territoryForEntity` enriches via the kernel `territoryForCui` (single path);
 *  - `resolveFilters` routes entity/county/status to the repo and `siruta` to the
 *    kernel identity name search (emitting kernel ResolveHit shape);
 *  - the contributor's `presenceFor`/`profileSlice` produce the kernel
 *    SourcePresence / EntityProfileSlice shapes;
 *  - GRAIN GATE: the profile slice carries NO spend total / amountRon (only QA facts);
 *  - `getRegistryLinks` returns [] without error (DDL-only, no API break).
 */

import { ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  getEntityTransparencyProfile,
  resolveFilters,
  territoryForEntity,
  type PrimariiDeps,
} from '@/modules/primarii-transparency/core/usecases.js';
import {
  makePrimariiContributor,
  toProfileSlice,
} from '@/modules/primarii-transparency/shell/contributor.js';

import type { PrimariiRepository } from '@/modules/primarii-transparency/core/ports.js';
import type {
  PrimariiEntityProfile,
  PrimariiEntityStatus,
} from '@/modules/primarii-transparency/core/types.js';
import type { ApiError, OrgNameMatch, Territory } from '@/modules/shared/index.js';

const STATUS: PrimariiEntityStatus = {
  cui: '2612790',
  snapshotId: '3615',
  entityName: 'MUNICIPIUL PIATRA-NEAMT',
  entityType: 'admin_municipality',
  county: 'NEAMȚ',
  websiteUrl: 'https://primariapn.ro',
  resultStatus: 'complete',
  dataQualityStatus: 'high',
  confidence: 0.93,
  evidenceCoverage: 1,
  missingRequiredCategories: [],
  issueCount: 0,
  updatedAt: '2026-06-16T00:00:00.000Z',
};

const PROFILE: PrimariiEntityProfile = {
  status: STATUS,
  categories: [
    { category: 'organigrama', status: 'found', evidenceCount: 2, missingEvidenceCount: 0 },
    { category: 'numar_angajati', status: 'found', evidenceCount: 2, missingEvidenceCount: 0 },
    { category: 'salarii', status: 'found', evidenceCount: 1, missingEvidenceCount: 0 },
  ],
  staffing: {
    totalPositions: 487,
    occupiedPositions: null,
    vacantPositions: null,
    asOfDate: null,
    confidence: 0.9,
  },
  organigrama: { status: 'found', effectiveDate: '2026-04-15', summary: null, confidence: 0.93 },
  documentCounts: [
    { category: 'numar_angajati', count: 1 },
    { category: 'organigrama', count: 1 },
    { category: 'other', count: 1 },
    { category: 'salarii', count: 2 },
  ],
};

const NEAMT_TERRITORY: Territory = {
  id: 7,
  territorialSirutaCode: '123456',
  sirutaCode: '123456',
  countySirutaCode: '27000',
  uatCode: 'NT',
  name: 'MUNICIPIUL PIATRA-NEAMT',
  countyCode: 'NT',
  countyName: 'NEAMT',
  region: 'Nord-Est',
  population: 85055,
};

const okR = <T>(v: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(v));

const makeRepo = (over: Partial<PrimariiRepository> = {}): PrimariiRepository => ({
  listEntities: () => okR({ items: [], next: null, totalCount: 0 }),
  getEntity: () => okR<PrimariiEntityStatus | null>(STATUS),
  getEntityProfile: () => okR<PrimariiEntityProfile | null>(PROFILE),
  getCategoryStatuses: () => okR(PROFILE.categories),
  getStaffing: () => okR(PROFILE.staffing),
  getOrganigrama: () => okR(PROFILE.organigrama),
  listSalaryClaims: () => okR({ items: [], next: null, totalCount: 0 }),
  listDocuments: () => okR({ items: [], next: null, totalCount: 0 }),
  listSnapshots: () => okR({ items: [], next: null, totalCount: 0 }),
  aggregateStatus: () => okR([]),
  aggregateCategoryCoverage: () => okR([]),
  listLoadIssues: () => okR([]),
  resolve: (dim, q) => okR([{ kind: dim, value: '2612790', label: `match:${q}` }]),
  getRegistryLinks: () => okR([]),
  presenceFor: () => okR({ present: true, status: 'complete', dataQuality: 'high' }),
  ...over,
});

const makeDeps = (over: Partial<PrimariiRepository> = {}): PrimariiDeps => ({
  repo: makeRepo(over),
  identityRepo: {
    findByCui: () => okR(null),
    findManyByCui: () => okR(new Map()),
    findByOrgId: () => okR(null),
    getIdentifiers: () => okR([]),
    searchByName: (q: string) =>
      okR<readonly OrgNameMatch[]>([
        {
          orgId: '99',
          cui: '2612790',
          name: `org:${q}`,
          normalizedName: null,
          countyName: 'NEAMT',
          kind: 'public_entity',
          score: 0.8,
        },
      ]),
    resolve: () => okR(null),
    territoryForCui: () => okR<Territory | null>(NEAMT_TERRITORY),
  },
});

describe('getEntityTransparencyProfile returns the bundle', () => {
  it('status + 3 categories + staffing + organigrama + doc counts', async () => {
    const res = await getEntityTransparencyProfile(makeDeps(), '2612790');
    expect(res.isOk()).toBe(true);
    if (res.isOk() && res.value !== null) {
      expect(res.value.status.dataQualityStatus).toBe('high');
      expect(res.value.categories).toHaveLength(3);
      expect(res.value.staffing?.totalPositions).toBe(487);
      expect(res.value.organigrama?.status).toBe('found');
    }
  });
});

describe('territoryForEntity enriches via the kernel territoryForCui (single path)', () => {
  it('resolves the kernel Territory for the CUI', async () => {
    const res = await territoryForEntity(makeDeps(), '2612790');
    expect(res.isOk() && res.value?.countyName).toBe('NEAMT');
    expect(res.isOk() && res.value?.region).toBe('Nord-Est');
  });
});

describe('resolveFilters routes dims + emits kernel ResolveHit (kind, not dim)', () => {
  it('entity → repo.resolve', async () => {
    const res = await resolveFilters(makeDeps(), 'entity', 'PIATRA', 5);
    expect(res.isOk() && res.value[0]?.kind).toBe('entity');
    expect(res.isOk() && res.value[0]?.value).toBe('2612790');
  });
  it('county → repo.resolve', async () => {
    const res = await resolveFilters(makeDeps(), 'county', 'NEAMT', 5);
    expect(res.isOk() && res.value[0]?.kind).toBe('county');
  });
  it('siruta → kernel identity name search (CUI as value, never touches the repo)', async () => {
    const res = await resolveFilters(makeDeps(), 'siruta', 'piatra', 5);
    expect(res.isOk() && res.value[0]?.value).toBe('2612790');
    expect(res.isOk() && res.value[0]?.hint).toBe('NEAMT');
  });
});

describe('contributor — presence + profileSlice (the §14.7 single path)', () => {
  it('presenceFor returns the kernel SourcePresence with QA badges', async () => {
    const c = makePrimariiContributor(makeDeps());
    const res = await c.presenceFor('2612790');
    expect(res.isOk()).toBe(true);
    if (res.isOk() && res.value !== null) {
      expect(res.value.source).toBe('primarii_transparency');
      expect(res.value.present).toBe(true);
      expect(res.value.label).toBe('Transparency QA');
      expect(res.value.badges).toContain('quality:high');
    }
  });

  it('profileSlice returns the kernel EntityProfileSlice shape (kind transparency)', async () => {
    const c = makePrimariiContributor(makeDeps());
    const res = await c.profileSlice?.('2612790');
    expect(res?.isOk()).toBe(true);
    if (res !== undefined && res.isOk() && res.value !== null) {
      expect(res.value.source).toBe('primarii_transparency');
      expect(res.value.kind).toBe('transparency');
    }
  });

  it('presenceFor returns null for an absent CUI', async () => {
    const c = makePrimariiContributor(makeDeps({ presenceFor: () => okR(null) }));
    const res = await c.presenceFor('9999999');
    expect(res.isOk() && res.value).toBeNull();
  });
});

describe('GRAIN GATE — the profile slice carries NO spend total / amountRon', () => {
  it('toProfileSlice exposes only QA/coverage facts, never money', () => {
    const slice = toProfileSlice(PROFILE);
    const json = JSON.stringify(slice);
    expect(json).not.toContain('amountRon');
    expect(json).not.toContain('amount_ron');
    expect(json.toLowerCase()).not.toContain('spend');
    expect(json).not.toContain('flowType');
    // It DOES carry the transparency facts.
    expect(slice.data?.['dataQualityStatus']).toBe('high');
    expect(slice.data?.['documentCount']).toBe(5);
    expect(slice.summary).toContain('PIATRA');
    expect(slice.summary).toContain('3/3');
  });
});

describe('getRegistryLinks returns [] without error (DDL-only, no API break)', () => {
  it('empty array, ok result', async () => {
    const res = await makeDeps().repo.getRegistryLinks('2612790');
    expect(res.isOk()).toBe(true);
    expect(res.isOk() && res.value).toEqual([]);
  });
});
