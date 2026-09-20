import { buildSchema, graphql } from 'graphql';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { getNgoProfileOverview } from '@/modules/ngos/core/usecases.js';
import {
  makeNgoProfileResolvers,
  ngoProfileTypeDefs,
} from '@/modules/ngos/shell/graphql/profile-schema.js';
import { ngoRegistryTypeDefs } from '@/modules/ngos/shell/graphql/schema.js';
import { makeNgoProfileMcpTools } from '@/modules/ngos/shell/mcp/profile-tools.js';

import type { NgoProfileRepository } from '@/modules/ngos/core/ports.js';
import type { NgoProfileOverview, NgoRegistryRecord } from '@/modules/ngos/core/types.js';

const record: NgoRegistryRecord = {
  id: 'row:1',
  sourceRowNumber: 1,
  registryNumber: '1/A/2001',
  specialRegistryNumber: null,
  sourceRegistrationDate: null,
  category: 'association',
  legalForm: 'Asociație',
  name: 'Name pending verification',
  nameWithheld: true,
  court: 'Court',
  sourceRegistryStatus: 'Source status',
  county: null,
  locality: null,
  sourceCui: '4305857',
  linkedOrganizationCui: '4305857',
  isBranch: false,
  sourceReportsPublicUtility: null,
  snapshot: {
    id: 'snapshot',
    sourceDeclaredDate: null,
    importedAt: '2026-09-20T00:00:00Z',
    capturedAt: '2026-09-20T00:00:00Z',
    refreshOverdue: false,
    acceptedAt: '2026-09-20T00:00:00Z',
    recordCount: 2,
    isCurrent: true,
    sourceUrl: 'https://rnong.just.ro/registru-ong',
    coverageBasis: 'provided_artifact',
    nationalCompleteness: 'unverified',
  },
};
const profile: NgoProfileOverview = {
  cui: '4305857',
  identityBasis: 'accepted_rnong_cui',
  registryRecords: [record, { ...record, id: 'row:2', sourceRowNumber: 2 }],
  fiscal: {
    availability: 'available',
    data: {
      vatPayer: false,
      declaredFiscallyInactive: null,
      splitVat: null,
      mainCaenCode: '9499',
      mainCaenRev: null,
      queryDate: '2026-09-20',
      capturedAt: null,
      sourceUrl: 'https://www.anaf.ro/RegistruTVA/',
      sourceSnapshotId: 'anaf:tva:2026-09-20:4305857',
    },
  },
  sections: [{ key: 'financials', availability: 'not_released' }],
};
const repository = (value: NgoProfileOverview | null = profile): NgoProfileRepository => ({
  overview: () => Promise.resolve(ok(value)),
});

describe('live NGO profile contract', () => {
  it('preserves multiple registry observations, false/null and provenance identically through GraphQL/MCP', async () => {
    const repo = repository();
    const gql = await makeNgoProfileResolvers(repo).Query.ngoProfileOverview(null, {
      cui: profile.cui,
    });
    const mcp = await makeNgoProfileMcpTools(repo, 'https://transparenta.eu')[0]?.handler({
      cui: profile.cui,
    });
    expect(gql).toEqual(profile);
    expect(mcp?.item).toEqual(gql);
    expect(mcp?.link).toBe('https://transparenta.eu/ong-uri/4305857');
  });
  it('rejects malformed and personal-length identifiers before repository access', async () => {
    let calls = 0;
    const repo: NgoProfileRepository = {
      overview: () => {
        calls += 1;
        return Promise.resolve(ok(null));
      },
    };
    for (const cui of ['', 'RO4305857', '04305857', '12345678901', 'abc4305857'])
      expect((await getNgoProfileOverview(repo, cui)).isErr()).toBe(true);
    expect(calls).toBe(0);
  });
  it('distinguishes unavailable fiscal data from absence of an admitted profile', async () => {
    const unavailable = {
      ...profile,
      fiscal: { availability: 'unavailable' as const, data: null },
    };
    expect(
      await makeNgoProfileResolvers(repository(unavailable)).Query.ngoProfileOverview(null, {
        cui: profile.cui,
      })
    ).toEqual(unavailable);
    expect(
      await makeNgoProfileResolvers(repository(null)).Query.ngoProfileOverview(null, {
        cui: profile.cui,
      })
    ).toBeNull();
  });
  it('propagates read failures instead of inventing an unavailable section', async () => {
    const repo: NgoProfileRepository = {
      overview: () => Promise.resolve(err({ type: 'Database', message: 'failed' })),
    };
    await expect(
      makeNgoProfileResolvers(repo).Query.ngoProfileOverview(null, { cui: profile.cui })
    ).rejects.toMatchObject({ extensions: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(
      await makeNgoProfileMcpTools(repo, 'https://transparenta.eu')[0]?.handler({
        cui: profile.cui,
      })
    ).toMatchObject({ ok: false, errorType: 'Database' });
  });
  it('has no private fiscal fields in the public GraphQL schema', async () => {
    const schema = buildSchema(
      'scalar Date\nscalar DateTime\nscalar CUI\ntype PageInfo {hasNextPage:Boolean! endCursor:String}\ntype Query {ping:String}\n' +
        ngoRegistryTypeDefs +
        ngoProfileTypeDefs
    );
    const result = await graphql({
      schema,
      source:
        '{ngoProfileOverview(cui:"4305857"){fiscal{data{registeredName address responseHash raw}}}}',
    });
    expect(result.errors).toHaveLength(4);
  });
});
