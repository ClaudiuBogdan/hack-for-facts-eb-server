/**
 * `makeCompanyResolve` + `toCompanyResolveResult` (no I/O): NAME/REGNUM answer
 * under ONE pinned registry scope, rechecked, and report it, also for zero
 * hits and `limit <= 0`; an expected scope (`expectedScopeKey`) is validated
 * inside the pin before the resolve read and refused when malformed or not
 * the pinned one, never re-pinned; CAEN/COUNTY are catalog reads with no
 * scope; degraded is not a successful zero; the legacy hit array is the
 * result's hits.
 */

import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  REGISTRY_MOVED_MESSAGE,
  registryScopeKey,
  type CompanyRegistryEnvelope,
} from '@/modules/companies/core/registry.js';
import {
  RESOLVE_SCOPE_CHANGED_MESSAGE,
  RESOLVE_SCOPE_MALFORMED_MESSAGE,
  RESOLVE_SCOPE_NOT_APPLICABLE_MESSAGE,
  makeCompanyResolve,
  toCompanyResolveHits,
  toCompanyResolveResult,
  type CompanyResolveResponse,
} from '@/modules/companies/core/usecases.js';

import {
  MOVED_SCOPE,
  NEXT_EDITION_SCOPE,
  PUBLISHED_SCOPE,
  UNAVAILABLE_SCOPE,
  recheckOf,
} from './registry-fixtures.js';
import { stubFlows, stubRepo } from './repo-fixtures.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';
import type { CaenCodeHit, CompanyNameHit } from '@/modules/companies/core/types.js';

const PUBLISHED_KEY = 'onrc:published:7:3:11';
const NEXT_KEY = 'onrc:published:8:4:12';

const nameHit = (
  cui: string,
  label: string,
  labelSource: 'onrc_edition' | 'core_organization'
): CompanyNameHit => ({ dim: 'name', value: cui, label, cui, confidence: 0.75, labelSource });

const regnumHit = (cui: string, label: string): CompanyNameHit => ({
  dim: 'regnum',
  value: cui,
  label,
  cui,
  confidence: null,
  labelSource: 'onrc_edition',
});

const ACME = nameHit('2816464', 'ACME ONRC QUALIFIED SRL', 'onrc_edition');
const DIRECTORY = nameHit('14918042', 'DIRECTORY NAME SA', 'core_organization');

const setUp = (over: Partial<CompaniesRepository> = {}, scope = PUBLISHED_SCOPE) => {
  const repo = stubRepo(over, scope);
  return { repo, deps: { repo, flowsRepo: stubFlows(), meili: null } };
};

const resultOf = async (
  ...args: Parameters<typeof makeCompanyResolve>
): Promise<ReturnType<typeof toCompanyResolveResult>> =>
  toCompanyResolveResult((await makeCompanyResolve(...args))._unsafeUnwrap());

describe('NAME/REGNUM: one pinned scope, reported with the answer', () => {
  it('a stable NAME answer carries its pinned scope; each hit keeps its own name attribution', async () => {
    const { repo, deps } = setUp({
      resolveByName: vi.fn(async () => ok({ hits: [ACME, DIRECTORY], degraded: false })),
    });
    const expected = {
      hits: [
        {
          dim: 'NAME',
          value: '2816464',
          label: 'ACME ONRC QUALIFIED SRL',
          cui: '2816464',
          confidence: 0.75,
          revision: null,
          key: null,
          labelSource: 'onrc_edition',
        },
        {
          dim: 'NAME',
          value: '14918042',
          label: 'DIRECTORY NAME SA',
          cui: '14918042',
          confidence: 0.75,
          revision: null,
          key: null,
          labelSource: 'core_organization',
        },
      ],
      degraded: false,
      ambiguous: true,
      registry: PUBLISHED_SCOPE,
      scopeKey: PUBLISHED_KEY,
    };
    expect(await resultOf(deps, 'name', 'acme', 10)).toEqual(expected);
    expect(repo.confirmRegistryScope).toHaveBeenCalledWith(PUBLISHED_SCOPE, [
      '2816464',
      '14918042',
    ]);
    // The same answer bound to the scope the caller holds.
    expect(await resultOf(deps, 'name', 'acme', 10, { expectedScopeKey: PUBLISHED_KEY })).toEqual(
      expected
    );
  });

  it('zero hits are scoped and rechecked too (NAME and REGNUM)', async () => {
    const { repo, deps } = setUp();
    for (const dim of ['name', 'regnum'] as const) {
      expect(await resultOf(deps, dim, 'nothing', 10)).toEqual({
        hits: [],
        degraded: false,
        ambiguous: false,
        registry: PUBLISHED_SCOPE,
        scopeKey: PUBLISHED_KEY,
      });
    }
    expect(repo.resolveByName).toHaveBeenCalledTimes(1);
    expect(repo.findByRegistrationNumber).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.confirmRegistryScope).mock.calls).toEqual([
      [PUBLISHED_SCOPE, []],
      [PUBLISHED_SCOPE, []],
    ]);
  });

  it.each([
    ['name', 0],
    ['name', -3],
    ['regnum', 0],
    ['regnum', -1],
  ] as const)(
    '%s with limit %d: no resolve read, yet pinned, rechecked and scoped (no unscoped shortcut)',
    async (dim, limit) => {
      const { repo, deps } = setUp({
        resolveByName: vi.fn(async () => ok({ hits: [ACME], degraded: false })),
        findByRegistrationNumber: vi.fn(async () => ok([regnumHit('2816464', 'ACME')])),
      });
      expect(await resultOf(deps, dim, 'acme', limit)).toEqual({
        hits: [],
        degraded: false,
        ambiguous: false,
        registry: PUBLISHED_SCOPE,
        scopeKey: PUBLISHED_KEY,
      });
      expect(repo.captureRegistryScope).toHaveBeenCalledTimes(1);
      expect(repo.confirmRegistryScope).toHaveBeenCalledWith(PUBLISHED_SCOPE, []);
      expect(repo.resolveByName).not.toHaveBeenCalled();
      expect(repo.findByRegistrationNumber).not.toHaveBeenCalled();

      // The expected scope is still checked under the pin for no hits.
      const refused = await makeCompanyResolve(deps, dim, 'acme', limit, {
        expectedScopeKey: NEXT_KEY,
      });
      expect(refused._unsafeUnwrapErr()).toEqual({
        type: 'InvalidInput',
        message: RESOLVE_SCOPE_CHANGED_MESSAGE,
        field: 'registryScope',
      });
      expect(repo.confirmRegistryScope).toHaveBeenCalledTimes(1);
    }
  );

  it('limit 0 under an UNAVAILABLE registry reports that state (scoped, never an empty edition)', async () => {
    const { deps } = setUp({}, UNAVAILABLE_SCOPE);
    expect(await resultOf(deps, 'name', 'acme', 0)).toMatchObject({
      hits: [],
      registry: { state: 'unavailable', editionId: null },
      scopeKey: 'onrc:unavailable:-:-:-',
    });
  });
});

describe('an expected scope is validated inside the pin, before the resolve read', () => {
  it.each([
    '',
    'garbage',
    'onrc:published:7:3',
    'onrc:published:7:3:11:',
    'onrc:unavailable:7:3:11',
    'onrc:published:07:3:11',
    ' onrc:published:7:3:11',
  ])('malformed %j: refused before ANY repository call (NAME and REGNUM)', async (key) => {
    for (const dim of ['name', 'regnum'] as const) {
      const { repo, deps } = setUp();
      const res = await makeCompanyResolve(deps, dim, 'acme', 10, { expectedScopeKey: key });
      expect(res._unsafeUnwrapErr()).toEqual({
        type: 'InvalidInput',
        message: RESOLVE_SCOPE_MALFORMED_MESSAGE,
        field: 'registryScope',
      });
      expect(repo.captureRegistryScope).not.toHaveBeenCalled();
      expect(repo.resolveByName).not.toHaveBeenCalled();
      expect(repo.findByRegistrationNumber).not.toHaveBeenCalled();
      expect(repo.confirmRegistryScope).not.toHaveBeenCalled();
    }
  });

  it.each([
    [PUBLISHED_SCOPE, NEXT_KEY],
    [PUBLISHED_SCOPE, 'onrc:unavailable:-:-:-'],
    [PUBLISHED_SCOPE, registryScopeKey(MOVED_SCOPE)],
    [UNAVAILABLE_SCOPE, PUBLISHED_KEY],
  ] as const)(
    'well-formed but not the pinned scope (%#): refused after the capture, before the resolve read',
    async (current, key) => {
      for (const dim of ['name', 'regnum'] as const) {
        const { repo, deps } = setUp({}, current);
        const res = await makeCompanyResolve(deps, dim, 'acme', 10, { expectedScopeKey: key });
        expect(res._unsafeUnwrapErr()).toEqual({
          type: 'InvalidInput',
          message: RESOLVE_SCOPE_CHANGED_MESSAGE,
          field: 'registryScope',
        });
        expect(repo.captureRegistryScope).toHaveBeenCalledTimes(1);
        expect(repo.resolveByName).not.toHaveBeenCalled();
        expect(repo.findByRegistrationNumber).not.toHaveBeenCalled();
        expect(repo.confirmRegistryScope).not.toHaveBeenCalled();
      }
    }
  );
});

describe('a publication between the read and the recheck', () => {
  /** Captures `current`; the first recheck publishes edition 8, later ones hold. */
  const publishingDuringFirstRead = () => {
    let current: CompanyRegistryEnvelope = PUBLISHED_SCOPE;
    const resolveByName = vi.fn(
      async (_q: string, _l: number, _m: unknown, s: CompanyRegistryEnvelope) =>
        ok({
          hits: [nameHit('2816464', `NAME UNDER ${s.editionId ?? '-'}`, 'onrc_edition')],
          degraded: false,
        })
    );
    return setUp({
      captureRegistryScope: vi.fn(async () => ok(current)),
      confirmRegistryScope: vi.fn(async () => {
        current = NEXT_EDITION_SCOPE;
        return ok(recheckOf(current));
      }),
      resolveByName,
    });
  };

  it('without an expected scope: re-pinned once and answered under the new scope', async () => {
    const { repo, deps } = publishingDuringFirstRead();
    const result = await resultOf(deps, 'name', 'acme', 10);
    expect(result.registry).toEqual(NEXT_EDITION_SCOPE);
    expect(result.scopeKey).toBe(NEXT_KEY);
    expect(result.hits.map((h) => h.label)).toEqual(['NAME UNDER 8']);
    expect(vi.mocked(repo.resolveByName).mock.calls.map((c) => c[3].editionId)).toEqual(['7', '8']);
  });

  it('with the expected scope: refused, never switched to the new scope (one read only)', async () => {
    const { repo, deps } = publishingDuringFirstRead();
    const res = await makeCompanyResolve(deps, 'name', 'acme', 10, {
      expectedScopeKey: PUBLISHED_KEY,
    });
    expect(res._unsafeUnwrapErr()).toEqual({
      type: 'InvalidInput',
      message: RESOLVE_SCOPE_CHANGED_MESSAGE,
      field: 'registryScope',
    });
    expect(repo.resolveByName).toHaveBeenCalledTimes(1);
    expect(repo.captureRegistryScope).toHaveBeenCalledTimes(2);
  });

  it('a returned parent turning private under the SAME scope is re-read under that scope, never another', async () => {
    let recheck = 0;
    const resolveByName = vi.fn(async () =>
      ok({ hits: recheck === 0 ? [ACME, DIRECTORY] : [ACME], degraded: false })
    );
    const { repo, deps } = setUp({
      resolveByName,
      confirmRegistryScope: vi.fn(async () => {
        recheck += 1;
        return ok(recheckOf(PUBLISHED_SCOPE, recheck === 1 ? ['14918042'] : []));
      }),
    });
    const result = await resultOf(deps, 'name', 'acme', 10, { expectedScopeKey: PUBLISHED_KEY });
    expect(result.hits.map((h) => h.cui)).toEqual(['2816464']);
    expect(result.scopeKey).toBe(PUBLISHED_KEY);
    expect(vi.mocked(repo.resolveByName).mock.calls.map((c) => c[3])).toEqual([
      PUBLISHED_SCOPE,
      PUBLISHED_SCOPE,
    ]);
  });

  it('a scope that keeps moving is refused (never served)', async () => {
    let epoch = 11;
    const { repo, deps } = setUp({
      confirmRegistryScope: vi.fn(async () => {
        epoch += 1;
        return ok(recheckOf({ ...PUBLISHED_SCOPE, accessEpoch: String(epoch) }));
      }),
    });
    const res = await makeCompanyResolve(deps, 'regnum', 'J40/1/2000', 10);
    expect(res._unsafeUnwrapErr()).toMatchObject({
      type: 'ServiceUnavailable',
      message: REGISTRY_MOVED_MESSAGE,
    });
    expect(repo.findByRegistrationNumber).toHaveBeenCalledTimes(2);
  });
});

describe('CAEN and COUNTY are catalog reads: no registry scope, no ONRC provenance', () => {
  const CAEN_ROWS: readonly CaenCodeHit[] = [
    { code: '1111', rev: 'rev0', key: 'rev0:1111', label: 'REV0 CATALOG LABEL' },
    { code: '1111', rev: 'rev2', key: 'rev2:1111', label: 'REV2 CATALOG LABEL' },
    // No catalog label: the row shows its own key, never another revision's label.
    { code: '1111', rev: 'rev3', key: 'rev3:1111', label: null },
  ];

  it('CAEN: each row keeps its own revision, key and label source; registry and scope key are null', async () => {
    const { repo, deps } = setUp({ resolveCaen: vi.fn(async () => ok(CAEN_ROWS)) });
    expect(await resultOf(deps, 'caen', '1111', 10)).toEqual({
      hits: [
        {
          dim: 'CAEN',
          value: '1111',
          label: 'REV0 CATALOG LABEL',
          cui: null,
          confidence: null,
          revision: 'rev0',
          key: 'rev0:1111',
          labelSource: 'current_db_catalog',
        },
        {
          dim: 'CAEN',
          value: '1111',
          label: 'REV2 CATALOG LABEL',
          cui: null,
          confidence: null,
          revision: 'rev2',
          key: 'rev2:1111',
          labelSource: 'current_db_catalog',
        },
        {
          dim: 'CAEN',
          value: '1111',
          label: 'rev3:1111',
          cui: null,
          confidence: null,
          revision: 'rev3',
          key: 'rev3:1111',
          labelSource: null,
        },
      ],
      degraded: false,
      ambiguous: true,
      registry: null,
      scopeKey: null,
    });
    expect(repo.captureRegistryScope).not.toHaveBeenCalled();
    expect(repo.confirmRegistryScope).not.toHaveBeenCalled();
  });

  it('COUNTY: canonical names from the territory hub; registry and scope key are null', async () => {
    const { repo, deps } = setUp({ resolveCounty: vi.fn(async () => ok(['Cluj'])) });
    expect(await resultOf(deps, 'county', 'cluj', 10)).toEqual({
      hits: [
        {
          dim: 'COUNTY',
          value: 'Cluj',
          label: 'Cluj',
          cui: null,
          confidence: null,
          revision: null,
          key: null,
          labelSource: 'territory_hub',
        },
      ],
      degraded: false,
      ambiguous: false,
      registry: null,
      scopeKey: null,
    });
    expect(repo.captureRegistryScope).not.toHaveBeenCalled();
  });

  it('limit <= 0 reads no catalog; an expected scope is refused for catalogs before any call', async () => {
    for (const dim of ['caen', 'county'] as const) {
      const { repo, deps } = setUp();
      expect(await resultOf(deps, dim, '62', 0)).toEqual({
        hits: [],
        degraded: false,
        ambiguous: false,
        registry: null,
        scopeKey: null,
      });
      const refused = await makeCompanyResolve(deps, dim, '62', 10, {
        expectedScopeKey: PUBLISHED_KEY,
      });
      expect(refused._unsafeUnwrapErr()).toEqual({
        type: 'InvalidInput',
        message: RESOLVE_SCOPE_NOT_APPLICABLE_MESSAGE,
        field: 'registryScope',
      });
      expect(repo.resolveCaen).not.toHaveBeenCalled();
      expect(repo.resolveCounty).not.toHaveBeenCalled();
      expect(repo.captureRegistryScope).not.toHaveBeenCalled();
    }
  });
});

describe('degraded is not a successful zero', () => {
  it('an engine outage and a healthy empty answer differ only in degraded; both are scoped', async () => {
    const outage = setUp({ resolveByName: vi.fn(async () => ok({ hits: [], degraded: true })) });
    const healthy = setUp({ resolveByName: vi.fn(async () => ok({ hits: [], degraded: false })) });
    const down = await resultOf(outage.deps, 'name', 'acme', 10);
    const empty = await resultOf(healthy.deps, 'name', 'acme', 10);
    expect(down).toEqual({ ...empty, degraded: true });
    expect(empty.degraded).toBe(false);
    expect(down.scopeKey).toBe(PUBLISHED_KEY);
  });
});

describe('the legacy hit array is the result hits', () => {
  const responses: readonly CompanyResolveResponse[] = [
    {
      dim: 'name',
      q: 'acme',
      matches: [ACME, DIRECTORY],
      caenMatches: [],
      countyMatches: [],
      ambiguous: true,
      degraded: false,
      registry: PUBLISHED_SCOPE,
    },
    {
      dim: 'regnum',
      q: 'J40/1/2000',
      matches: [regnumHit('2816464', 'ACME')],
      caenMatches: [],
      countyMatches: [],
      ambiguous: false,
      degraded: false,
      registry: PUBLISHED_SCOPE,
    },
    {
      dim: 'caen',
      q: '1111',
      matches: [],
      caenMatches: [{ code: '1111', rev: 'rev0', key: 'rev0:1111', label: null }],
      countyMatches: [],
      ambiguous: false,
      degraded: false,
      registry: null,
    },
    {
      dim: 'county',
      q: 'cluj',
      matches: [],
      caenMatches: [],
      countyMatches: ['Cluj'],
      ambiguous: false,
      degraded: false,
      registry: null,
    },
  ];

  it.each(responses.map((r) => [r.dim, r] as const))('%s', (_dim, response) => {
    expect(toCompanyResolveResult(response).hits).toEqual(toCompanyResolveHits(response));
  });
});
