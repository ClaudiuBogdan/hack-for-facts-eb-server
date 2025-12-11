import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDatasetRepo } from '@/modules/datasets/shell/repo/fs-repo.js';

const makeTempDir = async (): Promise<string> => {
  return mkdtemp(path.join(tmpdir(), 'datasets-'));
};

const writeDatasetFile = async (dir: string, name: string, contents: string): Promise<void> => {
  await writeFile(path.join(dir, `${name}.yaml`), contents, 'utf8');
};

const validYaml = `metadata:
  id: "ro.test.metric.yearly"
  source: "Test"
  sourceUrl: "https://example.com"
  lastUpdated: "2024-12-31"
  units: "million_eur"
  frequency: "yearly"
i18n:
  ro:
    title: "Titlu"
    description: "Desc"
    xAxisLabel: "An"
    yAxisLabel: "Milioane"
axes:
  x:
    label: "An"
    type: "date"
    frequency: "yearly"
    format: "YYYY"
  y:
    label: "Milioane"
    type: "number"
    unit: "million_eur"
data:
  - { x: "2020", y: "10" }
`;

describe('fs dataset repo', () => {
  it('loads a dataset from disk', async () => {
    const dir = await makeTempDir();
    await writeDatasetFile(dir, 'ro.test.metric.yearly', validYaml);

    const repo = createDatasetRepo({ rootDir: dir });
    const result = await repo.getById('ro.test.metric.yearly');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().points).toHaveLength(1);
  });

  it('fails when metadata.id does not match filename', async () => {
    const dir = await makeTempDir();
    await writeDatasetFile(
      dir,
      'ro.test.metric.yearly',
      validYaml.replace('ro.test.metric.yearly', 'ro.other.metric.yearly')
    );

    const repo = createDatasetRepo({ rootDir: dir });
    const result = await repo.getById('ro.test.metric.yearly');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('IdMismatch');
  });

  it('lists datasets recursively and loads nested files', async () => {
    const dir = await makeTempDir();
    const nestedDir = path.join(dir, 'economics');
    await mkdir(nestedDir);

    await writeDatasetFile(dir, 'ro.test.metric.yearly', validYaml);
    await writeDatasetFile(
      nestedDir,
      'ro.test.metric2.yearly',
      validYaml.replace(/ro\.test\.metric\.yearly/g, 'ro.test.metric2.yearly')
    );

    const repo = createDatasetRepo({ rootDir: dir });
    const listResult = await repo.listAvailable();

    expect(listResult.isOk()).toBe(true);
    const entries = listResult._unsafeUnwrap();
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      'economics/ro.test.metric2.yearly.yaml',
      'ro.test.metric.yearly.yaml',
    ]);

    const nestedResult = await repo.getById('ro.test.metric2.yearly');
    expect(nestedResult.isOk()).toBe(true);
  });

  it('fails when dataset ids are duplicated across files', async () => {
    const dir = await makeTempDir();
    const copyDir = path.join(dir, 'copy');
    await mkdir(copyDir);

    await writeDatasetFile(dir, 'ro.test.metric.yearly', validYaml);
    await writeDatasetFile(copyDir, 'ro.test.metric.yearly', validYaml);

    const repo = createDatasetRepo({ rootDir: dir });
    const listResult = await repo.listAvailable();

    expect(listResult.isErr()).toBe(true);
    expect(listResult._unsafeUnwrapErr().type).toBe('DuplicateId');
  });
});
