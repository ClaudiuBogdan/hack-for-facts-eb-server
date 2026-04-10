import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  ADVANCED_MAP_DATASET_MAX_ROW_COUNT,
  createAdvancedMapDataset,
  replaceAdvancedMapDatasetRows,
  updateAdvancedMapDatasetMetadata,
  type AdvancedMapDatasetRepository,
} from '@/modules/advanced-map-datasets/index.js';

function makeDatasetRepo(
  overrides: Partial<AdvancedMapDatasetRepository> = {}
): AdvancedMapDatasetRepository {
  return {
    createDataset: async () => {
      throw new Error('Not implemented');
    },
    getDatasetForUser: async () =>
      ok({
        id: 'dataset-1',
        publicId: 'public-1',
        userId: 'user-1',
        title: 'Dataset',
        description: null,
        markdown: null,
        unit: 'RON',
        visibility: 'public',
        rowCount: 1,
        replacedAt: null,
        createdAt: new Date('2026-04-09T07:00:00.000Z'),
        updatedAt: new Date('2026-04-09T07:00:00.000Z'),
        rows: [{ sirutaCode: '1001', valueNumber: '1', valueJson: null }],
      }),
    listDatasetsForUser: async () => {
      throw new Error('Not implemented');
    },
    updateDatasetMetadata: async () => {
      throw new Error('Not implemented');
    },
    replaceDatasetRows: async () => {
      throw new Error('Not implemented');
    },
    softDeleteDataset: async () => {
      throw new Error('Not implemented');
    },
    listPublicDatasets: async () => {
      throw new Error('Not implemented');
    },
    getPublicDatasetByPublicId: async () => {
      throw new Error('Not implemented');
    },
    getShareableDatasetHeadById: async () => {
      throw new Error('Not implemented');
    },
    getAccessibleDatasetHead: async () => {
      throw new Error('Not implemented');
    },
    getAccessibleDataset: async () => {
      throw new Error('Not implemented');
    },
    listDatasetRows: async () => {
      throw new Error('Not implemented');
    },
    listReferencingMaps: async () => ok([]),
    listPublicReferencingMaps: async () => ok([]),
    ...overrides,
  };
}

describe('advanced map dataset usecases', () => {
  it('creates datasets with mixed numeric and typed json rows', async () => {
    const createDatasetSpy = vi.fn(async (input) =>
      ok({
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
        createdAt: new Date('2026-04-09T07:00:00.000Z'),
        updatedAt: new Date('2026-04-09T07:00:00.000Z'),
        rows: [...input.rows],
      })
    );
    const repo = makeDatasetRepo({
      createDataset: createDatasetSpy,
    });

    const result = await createAdvancedMapDataset(
      {
        repo,
        generateId: () => 'dataset-1',
        generatePublicId: () => 'public-1',
      },
      {
        request: {
          userId: 'user-1',
          title: ' Dataset ',
          unit: ' RON ',
          rows: [
            {
              sirutaCode: ' 1001 ',
              valueNumber: ' 42 ',
              valueJson: {
                type: 'text',
                value: {
                  text: ' hello ',
                },
              },
            },
          ],
        },
      }
    );

    expect(result.isOk()).toBe(true);
    expect(createDatasetSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Dataset',
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
      })
    );
  });

  it('blocks visibility downgrade to private when public maps reference the dataset', async () => {
    const updateDatasetMetadataSpy = vi.fn();
    const repo = makeDatasetRepo({
      listPublicReferencingMaps: async () =>
        ok([
          {
            mapId: 'map-1',
            title: 'Public map',
            snapshotId: 'snap-1',
          },
        ]),
      updateDatasetMetadata: updateDatasetMetadataSpy,
    });

    const result = await updateAdvancedMapDatasetMetadata(
      { repo },
      {
        request: {
          userId: 'user-1',
          datasetId: 'dataset-1',
          visibility: 'private',
        },
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error.type).toBe('DatasetInUseError');
    expect(updateDatasetMetadataSpy).not.toHaveBeenCalled();
  });

  it('rejects replacements above the dataset row cap', async () => {
    const replaceDatasetRowsSpy = vi.fn();
    const repo = makeDatasetRepo({
      replaceDatasetRows: replaceDatasetRowsSpy,
    });

    const rows = Array.from({ length: ADVANCED_MAP_DATASET_MAX_ROW_COUNT + 1 }, (_, index) => ({
      sirutaCode: String(index + 1),
      valueNumber: '1',
      valueJson: null,
    }));

    const result = await replaceAdvancedMapDatasetRows(
      { repo },
      {
        userId: 'user-1',
        datasetId: 'dataset-1',
        rows,
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error.type).toBe('InvalidInputError');
    expect(replaceDatasetRowsSpy).not.toHaveBeenCalled();
  });

  it('rejects rows that have neither valueNumber nor valueJson', async () => {
    const replaceDatasetRowsSpy = vi.fn();
    const repo = makeDatasetRepo({
      replaceDatasetRows: replaceDatasetRowsSpy,
    });

    const result = await replaceAdvancedMapDatasetRows(
      { repo },
      {
        userId: 'user-1',
        datasetId: 'dataset-1',
        rows: [{ sirutaCode: '1001', valueNumber: null, valueJson: null }],
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error.message).toContain('valueNumber or valueJson');
    expect(replaceDatasetRowsSpy).not.toHaveBeenCalled();
  });

  it('accepts json-only rows when replacing dataset content', async () => {
    const replaceDatasetRowsSpy = vi.fn(async (input) =>
      ok({
        id: 'dataset-1',
        publicId: 'public-1',
        userId: 'user-1',
        title: 'Dataset',
        description: null,
        markdown: null,
        unit: 'RON',
        visibility: 'public' as const,
        rowCount: input.rows.length,
        replacedAt: new Date('2026-04-09T07:00:00.000Z'),
        createdAt: new Date('2026-04-09T07:00:00.000Z'),
        updatedAt: new Date('2026-04-09T07:00:00.000Z'),
        rows: [...input.rows],
      })
    );
    const repo = makeDatasetRepo({
      replaceDatasetRows: replaceDatasetRowsSpy,
    });

    const result = await replaceAdvancedMapDatasetRows(
      { repo },
      {
        userId: 'user-1',
        datasetId: 'dataset-1',
        rows: [
          {
            sirutaCode: '1001',
            valueNumber: null,
            valueJson: {
              type: 'markdown',
              value: {
                markdown: '  # Title  ',
              },
            },
          },
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expect(replaceDatasetRowsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          {
            sirutaCode: '1001',
            valueNumber: null,
            valueJson: {
              type: 'markdown',
              value: {
                markdown: '# Title',
              },
            },
          },
        ],
      })
    );
  });

  it('sanitizes markdown metadata before updating the dataset', async () => {
    const updateDatasetMetadataSpy = vi.fn(async (input) =>
      ok({
        id: 'dataset-1',
        publicId: 'public-1',
        userId: 'user-1',
        title: input.title,
        description: input.description,
        markdown: input.markdown,
        unit: input.unit,
        visibility: input.visibility,
        rowCount: 1,
        replacedAt: null,
        createdAt: new Date('2026-04-09T07:00:00.000Z'),
        updatedAt: new Date('2026-04-09T07:00:00.000Z'),
        rows: [{ sirutaCode: '1001', valueNumber: '1', valueJson: null }],
      })
    );
    const repo = makeDatasetRepo({
      updateDatasetMetadata: updateDatasetMetadataSpy,
    });

    const result = await updateAdvancedMapDatasetMetadata(
      { repo },
      {
        request: {
          userId: 'user-1',
          datasetId: 'dataset-1',
          markdown:
            'Hello <script>alert(1)</script> [bad](javascript:alert(2)) <a href="javascript:bad">x</a> <a href="https://ok.test">ok</a>',
        },
      }
    );

    expect(result.isOk()).toBe(true);
    expect(updateDatasetMetadataSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: 'Hello alert(1) bad x [ok](https://ok.test)',
      })
    );
  });

  it('keeps encoded html escaped in sanitized markdown metadata', async () => {
    const updateDatasetMetadataSpy = vi.fn(async (input) =>
      ok({
        id: 'dataset-1',
        publicId: 'public-1',
        userId: 'user-1',
        title: input.title,
        description: input.description,
        markdown: input.markdown,
        unit: input.unit,
        visibility: input.visibility,
        rowCount: 1,
        replacedAt: null,
        createdAt: new Date('2026-04-09T07:00:00.000Z'),
        updatedAt: new Date('2026-04-09T07:00:00.000Z'),
        rows: [{ sirutaCode: '1001', valueNumber: '1', valueJson: null }],
      })
    );
    const repo = makeDatasetRepo({
      updateDatasetMetadata: updateDatasetMetadataSpy,
    });

    const result = await updateAdvancedMapDatasetMetadata(
      { repo },
      {
        request: {
          userId: 'user-1',
          datasetId: 'dataset-1',
          markdown: 'Hello &lt;img src=x onerror=alert(1)&gt; <a href="https://ok.test">ok</a>',
        },
      }
    );

    expect(result.isOk()).toBe(true);
    expect(updateDatasetMetadataSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: 'Hello &lt;img src=x onerror=alert(1)&gt; [ok](https://ok.test)',
      })
    );
  });
});
