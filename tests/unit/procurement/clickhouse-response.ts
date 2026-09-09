import type { ActiveGeneration } from '@/modules/procurement/core/ports.js';

export const compactResponse = (
  rows: readonly Record<string, unknown>[],
  emptyColumns: readonly string[] = []
): Response => {
  const names = rows[0] === undefined ? emptyColumns : Object.keys(rows[0]);
  return Response.json({
    meta: names.map((name) => ({ name, type: 'String' })),
    data: rows.map((row) => names.map((name) => row[name])),
  });
};

/** The active generation the ClickHouse tests read against (build 8: no `framework_role`). */
export const generationWithoutFrameworkRole: ActiveGeneration = {
  buildId: '1',
  publishedAt: '2026-07-12T00:00:00Z',
  quality: {},
  matrixHash: null,
  capabilities: { frameworkRole: false },
};
