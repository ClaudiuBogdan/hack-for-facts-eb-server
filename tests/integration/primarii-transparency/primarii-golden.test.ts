/**
 * Primarii-transparency golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to the verified 2026-06-16 primarii_transparency snapshot:
 *   - current_entity_status 3,187
 *   - data_quality_status: medium 2,559; high 265; review_needed 169; low 116; missing 78
 *   - result_status: partial 2,723; complete 265; blocked 113; missing_result 78; not_found 5; error 3
 *   - entity_type: admin_commune_hall 2,861; admin_town_hall 216; admin_municipality 103; admin_sector_hall 6; primarie 1
 *   - documents 7,233; salarii 4,062; organigrama 1,842; numar_angajati 805; other 524
 *   - entity_category_statuses 9,327; load issues: warning/evidence_missing 1,859; error/evidence_empty 18; error/evidence_hash_mismatch 3
 *   - CUI 2612790 = MUNICIPIUL PIATRA-NEAMT, high quality, complete result, snapshot 3,615
 *
 * Tri-surface: the GraphQL `primariiEntity` profile == the MCP
 * `get_primarii_entity_transparency` item == `Entity.primariiTransparency`.
 * Raw evidence/excerpt/private-path fields are never exposed. Skips cleanly when
 * PROD_DATABASE_URL is absent (CI without tunnel).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

import type { FastifyInstance } from 'fastify';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const PIATRA_CUI = '2612790';
const RAW_DENYLIST = ['source_excerpt', 'local_path', 'raw_document', 'raw_evidence', 'raw_claim', 'raw_quality', 'raw_'];

const d = HAS_DB ? describe : describe.skip;

let app: FastifyInstance;
let close: () => Promise<void>;

/** Swallow ONLY the benign stateless-MCP transport teardown error (kernel race). */
const onUncaught = (err: unknown): void => {
  if (err instanceof Error && err.message.includes('destroySoon')) return;
  throw err;
};

const gql = async (
  query: string,
  variables?: Record<string, unknown>
): Promise<{ data?: unknown; errors?: unknown }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return res.json();
};

const mcpCall = async (name: string, args: Record<string, unknown>): Promise<{ raw: string; out: Record<string, unknown> }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  // eslint-disable-next-line no-restricted-syntax -- test parses a trusted MCP JSON-RPC response body
  const body = JSON.parse(res.body) as { result?: { structuredContent?: unknown; content?: { text?: string }[] } };
  const structured = body.result?.structuredContent;
  if (structured !== undefined) return { raw: JSON.stringify(structured), out: structured as Record<string, unknown> };
  const text = body.result?.content?.[0]?.text ?? '{}';
  // eslint-disable-next-line no-restricted-syntax -- test parses the trusted MCP tool-output text payload
  return { raw: text, out: JSON.parse(text) as Record<string, unknown> };
};

const expectNoRawEvidence = (raw: string): void => {
  for (const field of RAW_DENYLIST) expect(raw).not.toContain(field);
};

interface PrimariiProfile {
  status: {
    cui: string;
    entityName: string;
    entityType: string | null;
    county: string | null;
    websiteUrl: string | null;
    resultStatus: string;
    dataQualityStatus: string;
    confidence: number | null;
    evidenceCoverage: number | null;
    missingRequiredCategories: string[];
    issueCount: number;
    updatedAt: string;
    snapshotId?: string | null;
  };
  categories: { category: string; status: string; evidenceCount: number; missingEvidenceCount: number }[];
  staffing: {
    totalPositions: number | null;
    occupiedPositions: number | null;
    vacantPositions: number | null;
    asOfDate: string | null;
    confidence: number | null;
  } | null;
  organigrama: { status: string; effectiveDate: string | null; summary: string | null; confidence: number | null } | null;
  documentCounts: { category: string; count: number }[];
}

/** Drop `snapshotId` (present on MCP item, absent on the GraphQL projection) so the two compare equal. */
const graphqlComparableProfile = (profile: PrimariiProfile): PrimariiProfile => {
  const status = { ...profile.status };
  delete status.snapshotId;
  return { ...profile, status };
};

const profileQuery = /* GraphQL */ `
  query($cui: CUI!) {
    primariiEntity(cui: $cui) {
      status {
        cui
        entityName
        entityType
        county
        websiteUrl
        resultStatus
        dataQualityStatus
        confidence
        evidenceCoverage
        missingRequiredCategories
        issueCount
        updatedAt
      }
      categories {
        category
        status
        evidenceCount
        missingEvidenceCount
      }
      staffing {
        totalPositions
        occupiedPositions
        vacantPositions
        asOfDate
        confidence
      }
      organigrama {
        status
        effectiveDate
        summary
        confidence
      }
      documentCounts {
        category
        count
      }
    }
  }
`;

d('Primarii-transparency golden (live prod)', () => {
  beforeAll(async () => {
    const config = loadRedesignConfig(process.env);
    const built = await buildRedesignApp({ kernelConfig: config.kernel, logLevel: 'silent', modules: ['primarii-transparency'] });
    app = built.app;
    close = built.app.close.bind(built.app);
    await app.ready();
    // The stateless-MCP transport (SDK hono server) schedules a delayed forceClose
    // after each request; once the socket is gone it throws `destroySoon is not a
    // function` — a KERNEL transport teardown race, not a module defect. Swallow
    // only that exact benign post-response error so the file reports clean.
    process.on('uncaughtException', onUncaught);
  }, 60_000);

  afterAll(async () => {
    await close?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('entity list filters and live status distributions match the pinned registry', async () => {
    const all = await gql(`query { primariiEntities(first: 5) { totalCount edges { node { cui } cursor } pageInfo { hasNextPage endCursor } } }`);
    const allConn = (all.data as { primariiEntities: { totalCount: number; edges: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } })
      .primariiEntities;
    expect(all.errors).toBeUndefined();
    expect(allConn.totalCount).toBe(3187);
    expect(allConn.edges.length).toBe(5);
    expect(allConn.pageInfo.hasNextPage).toBe(true);
    expect(allConn.pageInfo.endCursor).not.toBeNull();

    const qualityExpected: Record<string, number> = { medium: 2559, high: 265, review_needed: 169, low: 116, missing: 78 };
    for (const [status, total] of Object.entries(qualityExpected)) {
      const res = await gql(`query($filter: PrimariiEntityFilter!) { primariiEntities(first: 1, filter: $filter) { totalCount } }`, {
        filter: { dataQualityStatus: { in: [status] } },
      });
      expect(res.errors).toBeUndefined();
      expect((res.data as { primariiEntities: { totalCount: number } }).primariiEntities.totalCount).toBe(total);
    }

    const resultExpected: Record<string, number> = {
      partial: 2723,
      complete: 265,
      blocked: 113,
      missing_result: 78,
      not_found: 5,
      error: 3,
    };
    for (const [status, total] of Object.entries(resultExpected)) {
      const res = await gql(`query($filter: PrimariiEntityFilter!) { primariiEntities(first: 1, filter: $filter) { totalCount } }`, {
        filter: { resultStatus: { in: [status] } },
      });
      expect(res.errors).toBeUndefined();
      expect((res.data as { primariiEntities: { totalCount: number } }).primariiEntities.totalCount).toBe(total);
    }

    const typeExpected: Record<string, number> = {
      admin_commune_hall: 2861,
      admin_town_hall: 216,
      admin_municipality: 103,
      admin_sector_hall: 6,
      primarie: 1,
    };
    for (const [entityType, total] of Object.entries(typeExpected)) {
      const res = await gql(`query($filter: PrimariiEntityFilter!) { primariiEntities(first: 1, filter: $filter) { totalCount } }`, {
        filter: { entityType: { in: [entityType] } },
      });
      expect(res.errors).toBeUndefined();
      expect((res.data as { primariiEntities: { totalCount: number } }).primariiEntities.totalCount).toBe(total);
    }

    // publishesCategory semijoin: UATs whose CURRENT snapshot has salarii=found is a
    // positive subset (< 3187 and > 0). entity_category_statuses salarii/found = 1851.
    const publishes = await gql(
      `query($filter: PrimariiEntityFilter!) { primariiEntities(first: 1, filter: $filter) { totalCount } }`,
      { filter: { publishesCategory: { in: ['salarii'] }, categoryState: { eq: 'found' } } }
    );
    expect(publishes.errors).toBeUndefined();
    const publishesTotal = (publishes.data as { primariiEntities: { totalCount: number } }).primariiEntities.totalCount;
    expect(publishesTotal).toBe(1851);

    // An EXPLICIT empty publishesCategory in:[] must match NOTHING (not all 3187) — review P1.
    const emptyPublishes = await gql(
      `query($filter: PrimariiEntityFilter!) { primariiEntities(first: 1, filter: $filter) { totalCount } }`,
      { filter: { publishesCategory: { in: [] } } }
    );
    expect(emptyPublishes.errors).toBeUndefined();
    expect((emptyPublishes.data as { primariiEntities: { totalCount: number } }).primariiEntities.totalCount).toBe(0);

    // missingCategory text[] overlap (&&): UATs whose current view requires-but-lacks salarii.
    const missing = await gql(
      `query($filter: PrimariiEntityFilter!) { primariiEntities(first: 1, filter: $filter) { totalCount } }`,
      { filter: { missingCategory: { in: ['salarii'] } } }
    );
    expect(missing.errors).toBeUndefined();
    expect((missing.data as { primariiEntities: { totalCount: number } }).primariiEntities.totalCount).toBeGreaterThan(0);
  }, 60_000);

  it('Piatra-Neamt entity profile is the pinned golden UAT', async () => {
    const res = await gql(profileQuery, { cui: PIATRA_CUI });
    expect(res.errors).toBeUndefined();
    const profile = (res.data as { primariiEntity: PrimariiProfile }).primariiEntity;
    expect(profile.status).toMatchObject({
      cui: PIATRA_CUI,
      entityName: 'MUNICIPIUL PIATRA-NEAMT',
      entityType: 'admin_municipality',
      county: 'NEAMȚ',
      resultStatus: 'complete',
      dataQualityStatus: 'high',
    });
    expect(profile.categories).toHaveLength(3);
    expect(profile.categories.every((c) => c.status === 'found')).toBe(true);
    expect(profile.staffing).toMatchObject({ totalPositions: 487, occupiedPositions: null, vacantPositions: null });
    expect(profile.organigrama).toMatchObject({ status: 'found', effectiveDate: '2026-04-15', confidence: 0.93 });
    expect(Object.fromEntries(profile.documentCounts.map((c) => [c.category, c.count]))).toMatchObject({
      numar_angajati: 1,
      organigrama: 1,
      other: 1,
      salarii: 2,
    });

    const snapshots = await gql(
      `query($cui: CUI!) { primariiEntitySnapshots(cui: $cui, first: 1) { totalCount edges { node { snapshotId cui resultStatus } } } }`,
      { cui: PIATRA_CUI }
    );
    expect(snapshots.errors).toBeUndefined();
    const snapshot = (snapshots.data as { primariiEntitySnapshots: { edges: { node: { snapshotId: string; cui: string; resultStatus: string } }[] } })
      .primariiEntitySnapshots.edges[0]?.node;
    expect(snapshot).toEqual({ snapshotId: '3615', cui: PIATRA_CUI, resultStatus: 'complete' });
  });

  it('Piatra-Neamt territory resolves through the kernel CUI territory path', async () => {
    const res = await gql(
      `query($cui: CUI!) { primariiEntity(cui: $cui) { status { territory { countyName region } } } }`,
      { cui: PIATRA_CUI }
    );
    expect(res.errors).toBeUndefined();
    const territory = (res.data as { primariiEntity: { status: { territory: { countyName: string | null; region: string | null } | null } } })
      .primariiEntity.status.territory;
    expect(territory).not.toBeNull();
    expect(territory?.countyName).toBeTruthy();
    expect(territory?.region).toBeTruthy();
  });

  it('status aggregates and category coverage match the live pinned totals', async () => {
    const quality = await gql(`query { primariiStats(groupBy: data_quality_status) { key total withEvidence } }`);
    expect(quality.errors).toBeUndefined();
    const qualityBuckets = (quality.data as { primariiStats: { key: string; total: number }[] }).primariiStats;
    expect(qualityBuckets.reduce((sum, b) => sum + b.total, 0)).toBe(3187);
    expect(qualityBuckets.find((b) => b.key === 'high')?.total).toBe(265);

    const types = await gql(`query { primariiStats(groupBy: entity_type) { key total withEvidence } }`);
    expect(types.errors).toBeUndefined();
    const typeBuckets = (types.data as { primariiStats: { key: string; total: number }[] }).primariiStats;
    expect(typeBuckets.find((b) => b.key === 'admin_commune_hall')?.total).toBe(2861);

    const coverage = await gql(`query { primariiCategoryCoverage { category found notFound unknown blocked coverage } }`);
    expect(coverage.errors).toBeUndefined();
    const rows = (coverage.data as {
      primariiCategoryCoverage: { category: string; found: number; notFound: number; unknown: number; blocked: number; coverage: number }[];
    }).primariiCategoryCoverage;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.category).sort()).toEqual(['numar_angajati', 'organigrama', 'salarii']);
    for (const row of rows) {
      expect(row.found + row.notFound + row.unknown + row.blocked).toBe(3109);
      expect(row.coverage).toBeGreaterThanOrEqual(0);
      expect(row.coverage).toBeLessThanOrEqual(1);
    }
    expect(rows.reduce((sum, row) => sum + row.found + row.notFound + row.unknown + row.blocked, 0)).toBe(9327);
  });

  it('documents connection works for bounded filters and rejects unbounded list requests', async () => {
    const byCui = await gql(
      `query($filter: PrimariiDocumentFilter!) { primariiDocuments(filter: $filter, first: 10) { totalCount edges { node { cui category documentPk } } } }`,
      { filter: { cui: { eq: PIATRA_CUI } } }
    );
    expect(byCui.errors).toBeUndefined();
    const cuiDocs = (byCui.data as { primariiDocuments: { totalCount: number; edges: { node: { cui: string; category: string | null } }[] } })
      .primariiDocuments;
    expect(cuiDocs.totalCount).toBe(5);
    expect(cuiDocs.edges.every((e) => e.node.cui === PIATRA_CUI)).toBe(true);

    const categoryExpected: Record<string, number> = { salarii: 4062, organigrama: 1842, numar_angajati: 805, other: 524 };
    let documentTotal = 0;
    for (const [category, total] of Object.entries(categoryExpected)) {
      const res = await gql(`query($filter: PrimariiDocumentFilter!) { primariiDocuments(filter: $filter, first: 1) { totalCount } }`, {
        filter: { category: { eq: category } },
      });
      expect(res.errors).toBeUndefined();
      const count = (res.data as { primariiDocuments: { totalCount: number } }).primariiDocuments.totalCount;
      expect(count).toBe(total);
      documentTotal += count;
    }
    expect(documentTotal).toBe(7233);

    const unbounded = await gql(`query { primariiDocuments(filter: {}) { totalCount } }`);
    expect(unbounded.data).toBeNull();
    expect(JSON.stringify(unbounded.errors)).toContain('InvalidInput');
    expect(JSON.stringify(unbounded.errors)).toContain('requires a cui or category');

    // A field present but with NO meaningful op ({ cui: {} }) must NOT bypass the
    // guard into an unbounded scan (review P1).
    const emptyOp = await gql(
      `query($filter: PrimariiDocumentFilter!) { primariiDocuments(filter: $filter) { totalCount } }`,
      { filter: { cui: {} } }
    );
    expect(emptyOp.data).toBeNull();
    expect(JSON.stringify(emptyOp.errors)).toContain('InvalidInput');
  }, 60_000);

  it('salary claims are numeric-string disclosure facts and PII/raw evidence is gated off', async () => {
    const res = await gql(
      `query($cui: CUI!) {
        primariiEntitySalaryClaims(cui: $cui, first: 5) {
          totalCount
          edges {
            node {
              salaryAmountClaimId
              amountRon
              roleTitle
              confidence
            }
          }
        }
      }`,
      { cui: PIATRA_CUI }
    );
    expect(res.errors).toBeUndefined();
    expectNoRawEvidence(JSON.stringify(res));
    const claims = (res.data as {
      primariiEntitySalaryClaims: { totalCount: number; edges: { node: { amountRon: string; roleTitle: string | null } }[] };
    }).primariiEntitySalaryClaims;
    expect(claims.totalCount).toBe(240);
    expect(claims.edges.length).toBe(5);
    for (const edge of claims.edges) {
      expect(edge.node.amountRon).toMatch(/^\d+(?:\.\d+)?$/u);
      expect(edge.node.roleTitle).toBeNull();
    }
  });

  it('load issues expose the pinned error codes and warning evidence_missing count', async () => {
    const errors = await gql(`query { primariiLoadIssues(severity: "error", limit: 50) { severity issueCode cui message } }`);
    expect(errors.errors).toBeUndefined();
    const errorRows = (errors.data as { primariiLoadIssues: { severity: string; issueCode: string }[] }).primariiLoadIssues;
    expect(errorRows).toHaveLength(21);
    expect(errorRows.every((r) => r.severity === 'error')).toBe(true);
    expect(errorRows.filter((r) => r.issueCode === 'evidence_empty')).toHaveLength(18);
    expect(errorRows.filter((r) => r.issueCode === 'evidence_hash_mismatch')).toHaveLength(3);

    const warnings = await gql(
      `query { primariiLoadIssues(severity: "warning", issueCode: "evidence_missing", limit: 200) { severity issueCode } }`
    );
    expect(warnings.errors).toBeUndefined();
    expect((warnings.data as { primariiLoadIssues: unknown[] }).primariiLoadIssues).toHaveLength(200);
  });

  it('territory filters compile through the kernel cui→territory builder (live counts)', async () => {
    // The app wires territoryFilterAvailable=true, so geo FILTERS now return real
    // filtered results. Counts pinned against raw SQL over the cui→territory semijoin
    // (verified 2026-06-17): region=Nord-Vest 446; isUat=false 15; population
    // 10000..50000 174; region=Nord-Vest ∧ dataQuality=high 42; exclude region
    // Bucuresti-Ilfov → 3140 (3187 − 47).
    const total = async (filter: Record<string, unknown>): Promise<number> => {
      const res = await gql(
        `query($filter: PrimariiEntityFilter!) { primariiEntities(filter: $filter, first: 1) { totalCount } }`,
        { filter }
      );
      expect(res.errors).toBeUndefined();
      return (res.data as { primariiEntities: { totalCount: number } }).primariiEntities.totalCount;
    };

    expect(await total({ region: { in: ['Nord-Vest'] } })).toBe(446);
    expect(await total({ siruta: { eq: '120726' } })).toBe(1); // Piatra-Neamt's territory
    expect(await total({ isUat: { eq: false } })).toBe(15);
    expect(await total({ population: { between: { from: 10000, to: 50000 } } })).toBe(174);
    // territory predicate ANDs with a physical filter (region ∧ dataQuality=high).
    expect(await total({ region: { in: ['Nord-Vest'] }, dataQualityStatus: { in: ['high'] } })).toBe(42);
    // exclusion negates the membership: everything outside Bucuresti-Ilfov.
    expect(await total({ exclude: { region: { in: ['Bucuresti-Ilfov'] } } })).toBe(3140);

    // region GROUPING (a group-by, not a predicate) stays gated — out of scope here.
    const aggregate = await gql(`query { primariiStats(groupBy: region) { key total } }`);
    expect(aggregate.data).toBeNull();
    const aggregateErrors = JSON.stringify(aggregate.errors);
    expect(aggregateErrors).toContain('InvalidInput');
    expect(aggregateErrors).toContain('requires the kernel cui');
  });

  it('entity resolver maps PIATRA to the golden CUI', async () => {
    const res = await gql(`query { primariiResolve(dim: entity, q: "PIATRA", limit: 10) { kind value label hint } }`);
    expect(res.errors).toBeUndefined();
    const hits = (res.data as { primariiResolve: { value: string; label: string }[] }).primariiResolve;
    expect(hits.some((h) => h.value === PIATRA_CUI)).toBe(true);
  });

  it('Entity.primariiTransparency has contributor parity with primariiEntity', async () => {
    const direct = await gql(profileQuery, { cui: PIATRA_CUI });
    const viaEntity = await gql(
      `query($cui: CUI!) {
        entity(cui: $cui) {
          primariiTransparency {
            status {
              cui
              entityName
              entityType
              county
              websiteUrl
              resultStatus
              dataQualityStatus
              confidence
              evidenceCoverage
              missingRequiredCategories
              issueCount
              updatedAt
            }
            categories {
              category
              status
              evidenceCount
              missingEvidenceCount
            }
            staffing {
              totalPositions
              occupiedPositions
              vacantPositions
              asOfDate
              confidence
            }
            organigrama {
              status
              effectiveDate
              summary
              confidence
            }
            documentCounts {
              category
              count
            }
          }
        }
      }`,
      { cui: PIATRA_CUI }
    );
    expect(direct.errors).toBeUndefined();
    expect(viaEntity.errors).toBeUndefined();
    const directProfile = (direct.data as { primariiEntity: PrimariiProfile }).primariiEntity;
    const entityProfile = (viaEntity.data as { entity: { primariiTransparency: PrimariiProfile | null } }).entity.primariiTransparency;
    expect(entityProfile).toEqual(directProfile);
    expect(entityProfile?.status.dataQualityStatus).toBe('high');
    expect(entityProfile?.categories.map((c) => ({ category: c.category, status: c.status }))).toEqual(
      directProfile.categories.map((c) => ({ category: c.category, status: c.status }))
    );
  });

  it('GraphQL profile equals MCP get_primarii_entity_transparency and MCP omits raw evidence', async () => {
    const g = await gql(profileQuery, { cui: PIATRA_CUI });
    expect(g.errors).toBeUndefined();
    const graphProfile = (g.data as { primariiEntity: PrimariiProfile }).primariiEntity;

    const m = await mcpCall('get_primarii_entity_transparency', { cui: PIATRA_CUI });
    expectNoRawEvidence(m.raw);
    expect(m.out['ok']).toBe(true);
    expect(m.out['kind']).toBe('entity_transparency');
    expect(String(m.out['summary'])).toContain('PIATRA');
    expect(String(m.out['summary'])).toContain('3/3');
    const item = m.out['item'] as PrimariiProfile | undefined;
    expect(item?.status.snapshotId).toBe('3615');
    expect(item === undefined ? undefined : graphqlComparableProfile(item)).toEqual(graphProfile);
    expect(item?.status.dataQualityStatus).toBe('high');
  });

  it('MCP list, aggregate, capability gate, and resolve surfaces match GraphQL facts', async () => {
    const list = await mcpCall('list_primarii_entities', { filter: { dataQualityStatus: { in: ['high'] } }, limit: 5 });
    expectNoRawEvidence(list.raw);
    expect(list.out['ok']).toBe(true);
    expect(list.out['kind']).toBe('entity_list');
    expect(String(list.out['summary'])).toContain('265');
    expect(((list.out['items'] as unknown[]) ?? []).length).toBeLessThanOrEqual(5);

    const quality = await mcpCall('aggregate_primarii_transparency', { groupBy: 'data_quality_status' });
    expectNoRawEvidence(quality.raw);
    expect(quality.out['ok']).toBe(true);
    expect(quality.out['kind']).toBe('aggregate');
    expect((quality.out['items'] as { key: string; total: number }[]).find((b) => b.key === 'high')?.total).toBe(265);

    const coverage = await mcpCall('aggregate_primarii_transparency', { groupBy: 'category_coverage' });
    expectNoRawEvidence(coverage.raw);
    expect(coverage.out['ok']).toBe(true);
    expect(coverage.out['kind']).toBe('aggregate');
    expect((coverage.out['items'] as unknown[]).length).toBe(3);

    const region = await mcpCall('aggregate_primarii_transparency', { groupBy: 'region' });
    expectNoRawEvidence(region.raw);
    expect(region.out['ok']).toBe(false);
    expect(String(region.out['error'])).toContain('territory');

    const resolve = await mcpCall('resolve_primarii_filters', { dim: 'entity', q: 'PIATRA', limit: 10 });
    expectNoRawEvidence(resolve.raw);
    expect(resolve.out['ok']).toBe(true);
    expect(resolve.out['kind']).toBe('filter_values');
    expect((resolve.out['items'] as { value: string }[]).some((i) => i.value === PIATRA_CUI)).toBe(true);
  });
});
