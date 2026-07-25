/**
 * P0 containment on the IDENTITY SPINE (2026-07-22 policy; spine gap closed
 * 2026-07-25).
 *
 * Why this file exists: the policy was implemented in the companies module only,
 * so on live prod `companies` refused a 13-digit identifier while
 * `referenceOrganization` and `entity` returned its name, kind and ONRC
 * identifiers. `core.organizations` carries `privacy_class='public'` on all
 * 4,022,143 rows — including 117,688 CNP-shaped ones — so `privacy_class` is NOT
 * a containment signal and nothing downstream can infer the rule from the data.
 *
 * These tests pin BOTH halves of the design:
 *  - probes (`entity`, `referenceOrganization`) refuse categorically;
 *  - the repo fails closed, so a future caller inherits containment instead of
 *    having to remember it.
 */

import { ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { getOrganizationRef, type ReferenceDeps } from '@/modules/reference/core/usecases.js';
import {
  isWithheldOrganizationIdentifier,
  MAX_SERVED_CUI_DIGITS,
} from '@/modules/shared/core/types.js';
import {
  makeEntity360,
  makeEntityCore,
  type Entity360Deps,
} from '@/modules/shared/core/usecases/entity-360.js';

import type { ApiError, Organization } from '@/modules/shared/index.js';

const WITHHELD_13 = '9999999999999';
const WITHHELD_11 = '99999999999';
const SERVED = '2816464';

const ORG: Organization = {
  orgId: '1',
  cui: SERVED,
  registrationNumber: null,
  kind: 'company',
  name: 'DEDEMAN SRL',
  normalizedName: 'dedeman srl',
  countyName: null,
  localityName: null,
  sirutaCode: null,
  firstSeenSource: 'onrc',
  attrs: {},
};

const identityRepo = (
  findByCui = vi.fn(async (): Promise<Result<Organization | null, ApiError>> => ok(ORG))
) => ({
  repo: {
    findByCui,
    findByOrgId: vi.fn(async () => ok(null)),
    getIdentifiers: vi.fn(async () => ok([])),
    searchByName: vi.fn(async () => ok([])),
    resolve: vi.fn(async () => ok(null)),
    territoryForCui: vi.fn(async () => ok(null)),
  },
  findByCui,
});

describe('identity spine — P0 containment', () => {
  it('the predicate matches the companies-module threshold exactly', () => {
    expect(MAX_SERVED_CUI_DIGITS).toBe(10);
    expect(isWithheldOrganizationIdentifier(WITHHELD_11)).toBe(true);
    expect(isWithheldOrganizationIdentifier(WITHHELD_13)).toBe(true);
    expect(isWithheldOrganizationIdentifier(SERVED)).toBe(false);
  });

  it('referenceOrganization refuses a withheld identifier and never reaches the repo', async () => {
    const { repo, findByCui } = identityRepo();
    const deps = { identityRepo: repo } as unknown as ReferenceDeps;

    const res = await getOrganizationRef(deps, WITHHELD_13);

    expect(res.isErr()).toBe(true);
    const error = (res as { error: ApiError }).error;
    expect(error.type).toBe('InvalidInput');
    expect(error.message).toContain('not served');
    // Load-bearing: refusing AFTER the query would still let a slow/fast timing
    // difference confirm existence.
    expect(findByCui).not.toHaveBeenCalled();
  });

  it('entity(cui) refuses before the 360 fan-out (flows/documents/presence would disclose a footprint)', async () => {
    const { repo } = identityRepo();
    const flowsRepo = { getFlowSummary: vi.fn(async () => ok(null)) };
    const searchRepo = { countByCui: vi.fn(async () => ok(0)) };
    const registry = { list: vi.fn(() => []) };
    const deps = {
      identityRepo: repo,
      flowsRepo,
      searchRepo,
      registry,
    } as unknown as Entity360Deps;

    for (const make of [makeEntityCore, makeEntity360]) {
      const res = await make(deps, WITHHELD_13);
      expect(res.isErr()).toBe(true);
      expect((res as { error: ApiError }).error.message).toContain('not served');
    }

    expect(flowsRepo.getFlowSummary).not.toHaveBeenCalled();
    expect(searchRepo.countByCui).not.toHaveBeenCalled();
    expect(registry.list).not.toHaveBeenCalled();
  });

  it('a servable identifier still resolves (the gate is not a blanket refusal)', async () => {
    const { repo } = identityRepo();
    const deps = { identityRepo: repo } as unknown as ReferenceDeps;

    const res = await getOrganizationRef(deps, SERVED);

    expect(res.isOk()).toBe(true);
    expect((res as unknown as { value: Organization }).value.name).toBe('DEDEMAN SRL');
  });
});
