import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface GraphQlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

interface InsDataset {
  code: string;
  has_uat_data: boolean;
  has_county_data: boolean;
  context_path: string | null;
}

interface InsContext {
  code: string;
  path: string;
}

interface InsLatestDatasetValue {
  dataset: { code: string };
  hasData: boolean;
  latestPeriod: string | null;
}

const GRAPHQL_URL = process.env['INS_AUDIT_GRAPHQL_URL'] ?? 'http://localhost:3001/graphql';
const OFFICIAL_CONTEXTS_URL =
  process.env['INS_AUDIT_CONTEXTS_URL'] ?? 'http://statistici.insse.ro:8077/tempo-ins/context/';
const OUTPUT_PATH = path.resolve(process.cwd(), 'scripts/output/ins-availability-report.json');

const UAT_SIRUTA = process.env['INS_AUDIT_UAT_SIRUTA'] ?? '143450';
const COUNTY_CODE = process.env['INS_AUDIT_COUNTY_CODE'] ?? 'SB';

const SHORTLIST_CODES = [
  'POP107D',
  'POP102D',
  'POP201D',
  'POP206D',
  'POP309E',
  'POP310E',
  'FOM104D',
  'SOM101E',
  'SOM101F',
  'LOC101B',
  'LOC103B',
  'GOS107A',
  'GOS110A',
  'GOS116A',
  'GOS118A',
  'GOS104A',
  'GOS105A',
  'SCL101C',
  'SCL103D',
  'SAN101B',
  'SAN104B',
  'TUR101C',
  'TUR104E',
  'POP2017A',
  'POP206C',
  'SOM103A',
  'SOM103B',
  'POP217A',
  'POP108D',
] as const;

const SUBSTITUTIONS: Record<string, string> = {
  POP102D: 'POP108D',
  POP2017A: 'POP217A',
};

const chunk = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
};

const postGraphQl = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed with status ${String(response.status)}`);
  }

  const payload = (await response.json()) as GraphQlResponse<T>;
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }
  if (payload.data === undefined) {
    throw new Error('GraphQL response had no data');
  }

  return payload.data;
};

const fetchAllDatasets = async (): Promise<InsDataset[]> => {
  const query = /* GraphQL */ `
    query AuditDatasets($limit: Int!, $offset: Int!) {
      insDatasets(limit: $limit, offset: $offset) {
        nodes {
          code
          has_uat_data
          has_county_data
          context_path
        }
        pageInfo {
          totalCount
          hasNextPage
        }
      }
    }
  `;

  const pageSize = 200;
  const datasets: InsDataset[] = [];
  let offset = 0;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await postGraphQl<{
      insDatasets: { nodes: InsDataset[]; pageInfo: { hasNextPage: boolean } };
    }>(query, { limit: pageSize, offset });

    datasets.push(...data.insDatasets.nodes);
    hasNextPage = data.insDatasets.pageInfo.hasNextPage;
    offset += pageSize;
  }

  return datasets;
};

const fetchAllContexts = async (): Promise<InsContext[]> => {
  const query = /* GraphQL */ `
    query AuditContexts($limit: Int!, $offset: Int!) {
      insContexts(limit: $limit, offset: $offset) {
        nodes {
          code
          path
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  const pageSize = 200;
  const contexts: InsContext[] = [];
  let offset = 0;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await postGraphQl<{
      insContexts: { nodes: InsContext[]; pageInfo: { hasNextPage: boolean } };
    }>(query, { limit: pageSize, offset });

    contexts.push(...data.insContexts.nodes);
    hasNextPage = data.insContexts.pageInfo.hasNextPage;
    offset += pageSize;
  }

  return contexts;
};

const fetchLatestCoverage = async (params: {
  selector: { sirutaCode?: string; territoryCode?: string; territoryLevel?: 'NUTS3' };
  datasetCodes: string[];
}): Promise<{ withData: number; total: number }> => {
  const query = /* GraphQL */ `
    query AuditLatest($entity: InsEntitySelectorInput!, $datasetCodes: [String!]!) {
      insLatestDatasetValues(entity: $entity, datasetCodes: $datasetCodes) {
        dataset {
          code
        }
        hasData
        latestPeriod
      }
    }
  `;

  let withData = 0;
  let total = 0;

  for (const part of chunk(params.datasetCodes, 100)) {
    const data = await postGraphQl<{ insLatestDatasetValues: InsLatestDatasetValue[] }>(query, {
      entity: params.selector,
      datasetCodes: part,
    });
    const rows = data.insLatestDatasetValues;
    total += rows.length;
    withData += rows.filter((row) => row.hasData).length;
  }

  return { withData, total };
};

const getRootCodeFromPath = (pathValue: string | null): string | null => {
  if (pathValue === null || pathValue === '') {
    return null;
  }
  const parts = pathValue.split('.');
  return parts[1] ?? null;
};

const main = async (): Promise<void> => {
  const [officialContextsResponse, datasets, localContexts] = await Promise.all([
    fetch(OFFICIAL_CONTEXTS_URL).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Official contexts request failed with status ${String(response.status)}`);
      }
      return response.json() as Promise<{ code: string; parentCode: string | null }[]>;
    }),
    fetchAllDatasets(),
    fetchAllContexts(),
  ]);

  const officialContextCodes = new Set(officialContextsResponse.map((context) => context.code));
  const localContextCodes = new Set(localContexts.map((context) => context.code));
  const officialRootCodes = new Set(
    officialContextsResponse
      .filter((context) => context.parentCode === null)
      .map((context) => context.code)
  );
  const localRootCodes = new Set(
    localContexts
      .map((context) => getRootCodeFromPath(context.path))
      .filter((code): code is string => code !== null)
  );

  const missingContextsInLocal = Array.from(officialContextCodes).filter(
    (code) => !localContextCodes.has(code)
  );
  const extraContextsInLocal = Array.from(localContextCodes).filter(
    (code) => !officialContextCodes.has(code)
  );

  const datasetCodeSet = new Set(datasets.map((dataset) => dataset.code));
  const shortlistMissing = SHORTLIST_CODES.filter((code) => !datasetCodeSet.has(code));

  const uatCodes = datasets
    .filter((dataset) => dataset.has_uat_data)
    .map((dataset) => dataset.code);
  const countyCodes = datasets
    .filter((dataset) => dataset.has_county_data)
    .map((dataset) => dataset.code);

  const [uatCoverage, countyCoverage] = await Promise.all([
    fetchLatestCoverage({
      selector: { sirutaCode: UAT_SIRUTA },
      datasetCodes: uatCodes,
    }),
    fetchLatestCoverage({
      selector: { territoryCode: COUNTY_CODE, territoryLevel: 'NUTS3' },
      datasetCodes: countyCodes,
    }),
  ]);

  const report = {
    generated_at: new Date().toISOString(),
    graphql_url: GRAPHQL_URL,
    official_contexts_url: OFFICIAL_CONTEXTS_URL,
    contexts: {
      official_total: officialContextCodes.size,
      local_total: localContextCodes.size,
      official_roots: Array.from(officialRootCodes).sort(),
      local_roots: Array.from(localRootCodes).sort(),
      missing_in_local: missingContextsInLocal.sort(),
      extra_in_local: extraContextsInLocal.sort(),
    },
    datasets: {
      total: datasets.length,
      uat_flagged_total: uatCodes.length,
      county_flagged_total: countyCodes.length,
      shortlist_missing: shortlistMissing,
      substitutions: SUBSTITUTIONS,
    },
    entity_coverage: {
      uat: {
        selector: { sirutaCode: UAT_SIRUTA },
        with_data: uatCoverage.withData,
        total: uatCoverage.total,
      },
      county: {
        selector: { territoryCode: COUNTY_CODE, territoryLevel: 'NUTS3' },
        with_data: countyCoverage.withData,
        total: countyCoverage.total,
      },
    },
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`INS availability report written to ${OUTPUT_PATH}`);
};

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
