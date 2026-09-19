import { buildSchema, graphql } from 'graphql';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { getNgoRegistryRecord, listNgoRegistry } from '@/modules/ngos/core/usecases.js';
import {
  makeNgoRegistryResolvers,
  ngoRegistryTypeDefs,
} from '@/modules/ngos/shell/graphql/schema.js';
import { makeNgoRegistryMcpTools } from '@/modules/ngos/shell/mcp/tools.js';
import { registryFilterHash } from '@/modules/ngos/shell/repo/registry-repo.js';
import { buildNextCursor, decodeCursor } from '@/modules/shared/index.js';

import type { NgoRegistryRepository } from '@/modules/ngos/core/ports.js';
import type { NgoRegistryRecord, NgoRegistryRequest } from '@/modules/ngos/core/types.js';

const record: NgoRegistryRecord = {
  id: 'mj_rnong:snapshot:row:1',
  sourceRowNumber: 1,
  registryNumber: '1/A/2001',
  specialRegistryNumber: null,
  sourceRegistrationDate: '2026-09-19',
  category: 'association',
  legalForm: 'Asociație',
  name: 'ASOCIAȚIA EXEMPLU',
  court: 'Judecatoria TEST',
  sourceRegistryStatus: 'Radiat',
  county: 'Cluj',
  locality: null,
  sourceCui: null,
  linkedOrganizationCui: null,
  isBranch: false,
  sourceReportsPublicUtility: false,
  snapshot: {
    id: 'snapshot',
    sourceDeclaredDate: null,
    importedAt: '2026-09-19T00:00:00Z',
    capturedAt: '2026-09-19T00:00:00Z',
    refreshOverdue: false,
    acceptedAt: '2026-09-19T01:00:00Z',
    recordCount: 1,
    isCurrent: true,
    sourceUrl: 'https://rnong.just.ro/registru-ong',
    coverageBasis: 'provided_artifact',
    nationalCompleteness: 'unverified',
  },
};
function fakeRepo() {
  const requests: NgoRegistryRequest[] = [];
  const repo: NgoRegistryRepository = {
    coverage: () => Promise.resolve(ok(record.snapshot)),
    detail: (id) => Promise.resolve(ok(id === record.id ? record : null)),
    list: (request) => {
      requests.push(request);
      return Promise.resolve(ok({ items: [record], next: null, snapshot: record.snapshot }));
    },
  };
  return { repo, requests };
}

describe('NGO public registry contract', () => {
  it('uses the same normalized filter and public record on GraphQL and MCP', async () => {
    const { repo, requests } = fakeRepo();
    const resolvers = makeNgoRegistryResolvers(repo);
    const gql = await resolvers.Query.ngoRegistryRecords(null, {
      filter: { name: { contains: 'Asociația Exemplu' } },
      first: 10,
    });
    const tool = makeNgoRegistryMcpTools(repo, 'https://transparenta.eu').find(
      (t) => t.name === 'list_ngo_registry_records'
    );
    const mcp = await tool?.handler({
      filter: { name: { contains: 'Asociația Exemplu' } },
      first: 10,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.filter['name']).toEqual({ contains: 'asociatia_exemplu' });
    expect(mcp?.items).toEqual(gql.edges.map((e) => e.node));
    expect(mcp?.meta?.['snapshot']).toEqual(record.snapshot);
  });
  it('rejects private GraphQL fields and publishes no private keys through MCP', async () => {
    const { repo } = fakeRepo();
    const schema = buildSchema(
      'scalar Date\nscalar DateTime\nscalar CUI\ntype PageInfo { hasNextPage: Boolean! endCursor: String }\ntype Query { ping: String }\n' +
        ngoRegistryTypeDefs
    );
    const result = await graphql({
      schema,
      source: '{ ngoRegistryRecord(id:"x") { purpose attrs address } }',
    });
    expect(result.errors).toHaveLength(3);
    const tool = makeNgoRegistryMcpTools(repo, 'https://transparenta.eu').find(
      (t) => t.name === 'get_ngo_registry_record'
    );
    const mcp = await tool?.handler({ id: record.id });
    expect(mcp?.item).toEqual(record);
    for (const field of ['purpose', 'attrs', 'address', 'source', 'objectKey', 'privacy_class'])
      expect(mcp?.item).not.toHaveProperty(field);
  });
  it('binds cursors to both filters and the current snapshot', () => {
    const fhash = registryFilterHash('snapshot-one', { county: { eq: 'Cluj' } });
    const cursor = buildNextCursor({ sort: 'sourceRowNumber', dir: 'asc', fhash, lastKeys: [100] });
    expect(decodeCursor(cursor, { sort: 'sourceRowNumber', dir: 'asc', fhash }).isOk()).toBe(true);
    for (const changed of [
      registryFilterHash('snapshot-two', { county: { eq: 'Cluj' } }),
      registryFilterHash('snapshot-one', { county: { eq: 'Alba' } }),
    ]) {
      expect(
        decodeCursor(cursor, { sort: 'sourceRowNumber', dir: 'asc', fhash: changed }).isErr()
      ).toBe(true);
    }
  });
  it('rejects unbounded requests and unsupported filters', async () => {
    const { repo, requests } = fakeRepo();
    expect((await listNgoRegistry(repo, { filter: {}, first: 101 })).isErr()).toBe(true);
    expect((await getNgoRegistryRecord(repo, '')).isErr()).toBe(true);
    const tool = makeNgoRegistryMcpTools(repo, 'https://transparenta.eu').find(
      (t) => t.name === 'list_ngo_registry_records'
    );
    expect((await tool?.handler({ filter: { purpose: { contains: 'private' } } }))?.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
  it('propagates unavailable data instead of returning an empty registry', async () => {
    const { repo } = fakeRepo();
    repo.coverage = () =>
      Promise.resolve(err({ type: 'InvalidInput', message: 'NGO registry is not published yet.' }));
    const resolver = makeNgoRegistryResolvers(repo);
    await expect(resolver.Query.ngoRegistryCoverage()).rejects.toMatchObject({
      extensions: { code: 'INVALID_INPUT' },
    });
    const tool = makeNgoRegistryMcpTools(repo, 'https://transparenta.eu').find(
      (t) => t.name === 'get_ngo_registry_coverage'
    );
    expect(await tool?.handler({})).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
  });
});
