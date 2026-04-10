import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeAdvancedMapDatasetRoutes,
  type AccessibleAdvancedMapDatasetLookupInput,
  type AdvancedMapDatasetRepository,
  type CreateAdvancedMapDatasetParams,
  type ReplaceAdvancedMapDatasetRowsParams,
  type UpdateAdvancedMapDatasetMetadataParams,
} from '@/modules/advanced-map-datasets/index.js';
import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';

import type { BudgetDbClient } from '@/infra/database/client.js';
import type {
  AdvancedMapDatasetDetail,
  AdvancedMapDatasetRow,
  AdvancedMapDatasetSummary,
} from '@/modules/advanced-map-datasets/core/types.js';

interface SeedDataset {
  id: string;
  publicId: string;
  userId: string;
  title: string;
  description: string | null;
  markdown: string | null;
  unit: string | null;
  visibility: 'private' | 'unlisted' | 'public';
  rows: AdvancedMapDatasetRow[];
}

class InMemoryAdvancedMapDatasetRepo implements AdvancedMapDatasetRepository {
  private readonly datasets = new Map<string, AdvancedMapDatasetDetail>();

  constructor(initialDatasets: SeedDataset[] = []) {
    initialDatasets.forEach((dataset) => {
      this.datasets.set(dataset.id, this.toDetail(dataset));
    });
  }

  async createDataset(input: CreateAdvancedMapDatasetParams) {
    const now = new Date('2026-04-10T10:00:00.000Z');
    const dataset: AdvancedMapDatasetDetail = {
      id: input.id,
      publicId: input.publicId,
      userId: input.userId,
      title: input.title,
      description: input.description,
      markdown: input.markdown,
      unit: input.unit,
      visibility: input.visibility,
      rowCount: input.rows.length,
      replacedAt: null,
      createdAt: now,
      updatedAt: now,
      rows: input.rows.map(cloneRow),
    };

    this.datasets.set(dataset.id, dataset);
    return ok(this.cloneDetail(dataset));
  }

  async getDatasetForUser(datasetId: string, userId: string) {
    const dataset = this.datasets.get(datasetId);
    if (dataset?.userId !== userId) {
      return ok(null);
    }

    return ok(this.cloneDetail(dataset));
  }

  async listDatasetsForUser(userId: string, limit: number, offset: number) {
    const nodes = [...this.datasets.values()].filter((dataset) => dataset.userId === userId);

    return ok({
      nodes: nodes.slice(offset, offset + limit).map((dataset) => this.toSummary(dataset)),
      pageInfo: {
        totalCount: nodes.length,
        hasNextPage: offset + limit < nodes.length,
        hasPreviousPage: offset > 0,
      },
    });
  }

  async updateDatasetMetadata(input: UpdateAdvancedMapDatasetMetadataParams) {
    const dataset = this.datasets.get(input.datasetId);
    if (dataset?.userId !== input.userId) {
      return ok(null);
    }

    const updated: AdvancedMapDatasetDetail = {
      ...dataset,
      title: input.title,
      description: input.description,
      markdown: input.markdown,
      unit: input.unit,
      visibility: input.visibility,
      updatedAt: new Date('2026-04-10T11:00:00.000Z'),
    };

    this.datasets.set(updated.id, updated);
    return ok(this.cloneDetail(updated));
  }

  async replaceDatasetRows(input: ReplaceAdvancedMapDatasetRowsParams) {
    const dataset = this.datasets.get(input.datasetId);
    if (dataset?.userId !== input.userId) {
      return ok(null);
    }

    const updated: AdvancedMapDatasetDetail = {
      ...dataset,
      rowCount: input.rows.length,
      replacedAt: new Date('2026-04-10T12:00:00.000Z'),
      updatedAt: new Date('2026-04-10T12:00:00.000Z'),
      rows: input.rows.map(cloneRow),
    };

    this.datasets.set(updated.id, updated);
    return ok(this.cloneDetail(updated));
  }

  async softDeleteDataset(datasetId: string, userId: string) {
    const dataset = this.datasets.get(datasetId);
    if (dataset?.userId !== userId) {
      return ok(false);
    }

    this.datasets.delete(datasetId);
    return ok(true);
  }

  async listPublicDatasets(limit: number, offset: number) {
    const nodes = [...this.datasets.values()].filter((dataset) => dataset.visibility === 'public');

    return ok({
      nodes: nodes.slice(offset, offset + limit).map((dataset) => this.toSummary(dataset)),
      pageInfo: {
        totalCount: nodes.length,
        hasNextPage: offset + limit < nodes.length,
        hasPreviousPage: offset > 0,
      },
    });
  }

  async getPublicDatasetByPublicId(publicId: string) {
    const dataset = [...this.datasets.values()].find(
      (candidate) =>
        candidate.publicId === publicId &&
        (candidate.visibility === 'public' || candidate.visibility === 'unlisted')
    );

    return ok(dataset === undefined ? null : this.cloneDetail(dataset));
  }

  async getShareableDatasetHeadById(datasetId: string) {
    const dataset = this.datasets.get(datasetId);
    if (dataset === undefined || dataset.visibility === 'private') {
      return ok(null);
    }

    return ok(this.toSummary(dataset));
  }

  async getAccessibleDatasetHead(input: AccessibleAdvancedMapDatasetLookupInput) {
    const dataset = this.findAccessibleDataset(input);
    return ok(dataset === undefined ? null : this.toSummary(dataset));
  }

  async getAccessibleDataset(input: AccessibleAdvancedMapDatasetLookupInput) {
    const dataset = this.findAccessibleDataset(input);
    return ok(dataset === undefined ? null : this.cloneDetail(dataset));
  }

  async listDatasetRows(datasetId: string) {
    const dataset = this.datasets.get(datasetId);
    return ok(dataset === undefined ? [] : dataset.rows.map(cloneRow));
  }

  async listReferencingMaps() {
    return ok([]);
  }

  async listPublicReferencingMaps() {
    return ok([]);
  }

  private toDetail(dataset: SeedDataset): AdvancedMapDatasetDetail {
    const createdAt = new Date('2026-04-09T09:00:00.000Z');

    return {
      id: dataset.id,
      publicId: dataset.publicId,
      userId: dataset.userId,
      title: dataset.title,
      description: dataset.description,
      markdown: dataset.markdown,
      unit: dataset.unit,
      visibility: dataset.visibility,
      rowCount: dataset.rows.length,
      replacedAt: null,
      createdAt,
      updatedAt: createdAt,
      rows: dataset.rows.map(cloneRow),
    };
  }

  private toSummary(dataset: AdvancedMapDatasetDetail): AdvancedMapDatasetSummary {
    return {
      id: dataset.id,
      publicId: dataset.publicId,
      userId: dataset.userId,
      title: dataset.title,
      description: dataset.description,
      markdown: dataset.markdown,
      unit: dataset.unit,
      visibility: dataset.visibility,
      rowCount: dataset.rowCount,
      replacedAt: dataset.replacedAt,
      createdAt: dataset.createdAt,
      updatedAt: dataset.updatedAt,
    };
  }

  private cloneDetail(dataset: AdvancedMapDatasetDetail): AdvancedMapDatasetDetail {
    return {
      ...dataset,
      createdAt: new Date(dataset.createdAt),
      updatedAt: new Date(dataset.updatedAt),
      replacedAt: dataset.replacedAt === null ? null : new Date(dataset.replacedAt),
      rows: dataset.rows.map(cloneRow),
    };
  }

  private findAccessibleDataset(input: AccessibleAdvancedMapDatasetLookupInput) {
    if (input.requestUserId !== undefined && input.datasetId !== undefined) {
      const dataset = this.datasets.get(input.datasetId);
      if (dataset?.userId === input.requestUserId) {
        return dataset;
      }
    }

    if (input.datasetPublicId === undefined) {
      return undefined;
    }

    const dataset = [...this.datasets.values()].find(
      (candidate) => candidate.publicId === input.datasetPublicId
    );

    if (dataset === undefined || dataset.visibility === 'private') {
      return undefined;
    }

    return dataset;
  }
}

function cloneRow(row: AdvancedMapDatasetRow): AdvancedMapDatasetRow {
  return {
    sirutaCode: row.sirutaCode,
    valueNumber: row.valueNumber,
    valueJson:
      row.valueJson === null
        ? null
        : row.valueJson.type === 'text'
          ? {
              type: 'text',
              value: {
                text: row.valueJson.value.text,
              },
            }
          : row.valueJson.type === 'link'
            ? {
                type: 'link',
                value: {
                  url: row.valueJson.value.url,
                  label: row.valueJson.value.label,
                },
              }
            : {
                type: 'markdown',
                value: {
                  markdown: row.valueJson.value.markdown,
                },
              },
  };
}

function makeBudgetDb(): BudgetDbClient {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          orderBy: () => ({
            execute: async () => [{ siruta_code: '1001' }],
          }),
        }),
      }),
    }),
  } as unknown as BudgetDbClient;
}

function makeMultipartRequest(parts: { name: string; value?: string; filename?: string }[]) {
  const boundary = '----codex-test-boundary';
  const body = parts
    .map((part) => {
      if (part.filename !== undefined) {
        return [
          `--${boundary}`,
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`,
          'Content-Type: text/csv',
          '',
          part.value ?? '',
        ].join('\r\n');
      }

      return [
        `--${boundary}`,
        `Content-Disposition: form-data; name="${part.name}"`,
        '',
        part.value ?? '',
      ].join('\r\n');
    })
    .concat(`--${boundary}--`)
    .join('\r\n');

  return {
    payload: body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function createTestApp(options?: { canWrite?: boolean; initialDatasets?: SeedDataset[] }) {
  const app = fastifyLib({ logger: false });
  const testAuth = createTestAuthProvider();
  const permissionChecker = {
    canWrite: vi.fn(async () => options?.canWrite ?? true),
  };

  app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));

  await app.register(
    makeAdvancedMapDatasetRoutes({
      repo: new InMemoryAdvancedMapDatasetRepo(options?.initialDatasets),
      budgetDb: makeBudgetDb(),
      idGenerator: {
        generateId: () => '11111111-1111-4111-8111-111111111111',
        generatePublicId: () => '22222222-2222-4222-8222-222222222222',
      },
      writePermissionChecker: permissionChecker,
    })
  );

  await app.ready();
  return { app, testAuth, permissionChecker };
}

function buildCreateMultipart(visibility?: 'private' | 'unlisted' | 'public' | 'publicish') {
  return makeMultipartRequest([
    { name: 'title', value: 'Dataset' },
    { name: 'unit', value: 'RON' },
    ...(visibility !== undefined ? [{ name: 'visibility', value: visibility }] : []),
    {
      name: 'file',
      filename: 'data.csv',
      value: 'siruta_code,value\n1001,1',
    },
  ]);
}

function buildReplaceMultipart(csvText = 'siruta_code,value\n1001,2') {
  return makeMultipartRequest([{ name: 'file', filename: 'data.csv', value: csvText }]);
}

function makeSeedDataset(
  visibility: 'private' | 'unlisted' | 'public',
  rows: AdvancedMapDatasetRow[] = [{ sirutaCode: '1001', valueNumber: '1.5', valueJson: null }]
): SeedDataset {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    publicId: '11111111-1111-4111-8111-111111111111',
    userId: 'user_test_1',
    title: 'Shared dataset',
    description: 'Description',
    markdown: null,
    unit: 'RON',
    visibility,
    rows,
  };
}

describe('advanced map datasets rest', () => {
  let app: FastifyInstance;
  let testAuth: ReturnType<typeof createTestAuthProvider>;

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  beforeEach(async () => {
    if (app !== undefined) {
      await app.close();
    }

    const setup = await createTestApp({
      initialDatasets: [makeSeedDataset('public')],
    });
    app = setup.app;
    testAuth = setup.testAuth;
  });

  it('does not expose internal id or owner userId on public dataset APIs', async () => {
    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/advanced-map-datasets/public',
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().data.nodes[0]).not.toHaveProperty('id');
    expect(listResponse.json().data.nodes[0]).not.toHaveProperty('userId');

    const detailResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/advanced-map-datasets/public/11111111-1111-4111-8111-111111111111',
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().data).not.toHaveProperty('id');
    expect(detailResponse.json().data).not.toHaveProperty('userId');
  });

  it('rejects legacy multipart valueType fields', async () => {
    const multipart = makeMultipartRequest([
      { name: 'title', value: 'Dataset' },
      { name: 'valueType', value: 'string' },
      { name: 'file', filename: 'data.csv', value: 'siruta_code,value\n1001,1' },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-datasets',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': multipart.contentType,
      },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('valueType is no longer supported');
  });

  it('creates numeric datasets from CSV with valueNumber rows', async () => {
    const multipart = buildCreateMultipart();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-datasets',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': multipart.contentType,
      },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        unit: 'RON',
        rows: [{ sirutaCode: '1001', valueNumber: '1', valueJson: null }],
      },
    });
  });

  it('creates mixed number/json datasets through the JSON endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-datasets/json',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
      payload: {
        title: 'Mixed dataset',
        unit: 'RON',
        rows: [
          {
            sirutaCode: '1001',
            valueNumber: '42',
            valueJson: {
              type: 'text',
              value: {
                text: 'hello',
              },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        rows: [
          {
            sirutaCode: '1001',
            valueNumber: '42',
            valueJson: {
              type: 'text',
              value: {
                text: 'hello',
              },
            },
          },
        ],
      },
    });
  });

  it('rejects JSON dataset create rows with unsupported siruta codes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-datasets/json',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
      payload: {
        title: 'Invalid siruta dataset',
        rows: [
          {
            sirutaCode: '9999',
            valueNumber: '42',
            valueJson: null,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'InvalidInputError',
      message: 'Dataset row validation failed',
      details: {
        rows: [
          {
            rowNumber: 1,
            message: 'Unknown or unsupported UAT siruta_code: 9999',
          },
        ],
      },
    });
  });

  it('preserves existing valueJson payloads when replacing numeric values from CSV', async () => {
    await app.close();
    const setup = await createTestApp({
      initialDatasets: [
        makeSeedDataset('private', [
          {
            sirutaCode: '1001',
            valueNumber: '1',
            valueJson: {
              type: 'text',
              value: {
                text: 'existing note',
              },
            },
          },
        ]),
      ],
    });
    app = setup.app;
    testAuth = setup.testAuth;

    const multipart = buildReplaceMultipart('siruta_code,value\n1001,2');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/file',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': multipart.contentType,
      },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        rows: [
          {
            sirutaCode: '1001',
            valueNumber: '2',
            valueJson: {
              type: 'text',
              value: {
                text: 'existing note',
              },
            },
          },
        ],
      },
    });
  });

  it('replaces rows through the JSON row endpoint', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/advanced-map-datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/rows',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
      payload: {
        rows: [
          {
            sirutaCode: '1001',
            valueNumber: null,
            valueJson: {
              type: 'markdown',
              value: {
                markdown: '# title',
              },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        rows: [
          {
            sirutaCode: '1001',
            valueNumber: null,
            valueJson: {
              type: 'markdown',
              value: {
                markdown: '# title',
              },
            },
          },
        ],
      },
    });
  });

  it('rejects invalid json row payloads', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/advanced-map-datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/rows',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
      payload: {
        rows: [
          {
            sirutaCode: '1001',
            valueNumber: null,
            valueJson: {
              type: 'link',
              value: {
                url: 'javascript:bad',
                label: null,
              },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('http/https');
  });

  it('rejects JSON row replacement with unsupported siruta codes', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/advanced-map-datasets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/rows',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
      payload: {
        rows: [
          {
            sirutaCode: '9999',
            valueNumber: null,
            valueJson: {
              type: 'text',
              value: {
                text: 'invalid row',
              },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'InvalidInputError',
      message: 'Dataset row validation failed',
      details: {
        rows: [
          {
            rowNumber: 1,
            message: 'Unknown or unsupported UAT siruta_code: 9999',
          },
        ],
      },
    });
  });

  it('allows private and unlisted creates without public-write permission', async () => {
    await app.close();
    const setup = await createTestApp({ canWrite: false });
    app = setup.app;
    testAuth = setup.testAuth;

    const privateResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-datasets',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': buildCreateMultipart('private').contentType,
      },
      payload: buildCreateMultipart('private').payload,
    });

    const unlistedResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-datasets',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': buildCreateMultipart('unlisted').contentType,
      },
      payload: buildCreateMultipart('unlisted').payload,
    });

    expect(privateResponse.statusCode).toBe(201);
    expect(unlistedResponse.statusCode).toBe(201);
    expect(setup.permissionChecker.canWrite).not.toHaveBeenCalled();
  });

  it('requires public-write permission for public dataset create', async () => {
    await app.close();
    const setup = await createTestApp({ canWrite: false });
    app = setup.app;
    testAuth = setup.testAuth;

    const multipart = buildCreateMultipart('public');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-datasets',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': multipart.contentType,
      },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(403);
    expect(setup.permissionChecker.canWrite).toHaveBeenCalledOnce();
  });
});
