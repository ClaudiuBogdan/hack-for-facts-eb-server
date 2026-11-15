/**
 * PNRR-V4Y1 scoped MIPE release binding (DDL 20261114T180000/180100).
 *
 * The pure binding rules, then the real repo over a scripted Kysely driver
 * (answers by statement, executes nothing; the ledger can flip mid-request)
 * and the real GraphQL, REST, MCP and contributor surfaces over that repo.
 * Every expected value is a literal. These prove routing, bound parameters,
 * withholding and release re-checks, not the view SQL against PostgreSQL.
 */

import createFastify, { type FastifyInstance } from 'fastify';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PNRR_DASHBOARD_OBSERVATION_FIELDS,
  type PnrrAnalysisScope,
  type PnrrDashboardObservationField,
  type PnrrOverview,
} from '@/modules/pnrr/core/types.js';
import { makePnrrContributor } from '@/modules/pnrr/shell/contributor.js';
import { makePnrrResolvers } from '@/modules/pnrr/shell/graphql/resolvers.js';
import { pnrrTypeDefs } from '@/modules/pnrr/shell/graphql/typedefs.js';
import { makePnrrMcpTools } from '@/modules/pnrr/shell/mcp/tools.js';
import {
  bindScopedMipeRelease,
  hasScopedLane,
  type ActiveReleaseRow,
  type LedgerLaneRow,
} from '@/modules/pnrr/shell/repo/mipe-release-binding.js';
import { makePnrrRepo } from '@/modules/pnrr/shell/repo/pnrr-repo.js';
import { makePnrrRestRoutes } from '@/modules/pnrr/shell/rest/routes.js';
import { createContributorRegistry } from '@/modules/shared/core/usecases/registry.js';

import type { PnrrRepository } from '@/modules/pnrr/core/ports.js';
import type { ApiError, ProdDatabase } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

// ── fixtures ──────────────────────────────────────────────────────────────────

const MIPE_RELEASE_ID = 'pnrr-release-v1:pnrr-v2-20261115T090000Z-0a1b2c3d4e5f';
const NEXT_RELEASE_ID = 'pnrr-release-v1:pnrr-v2-20261116T090000Z-1b2c3d4e5f6a';
const MIPE_SOURCE_AS_OF = '2026-10-15 00:00:00+00';
const ORDS_CAPTURE_AS_OF = '2026-11-02 07:41:12.5+00';
const OPAQUE_KEY = 'pnrr-project-v1:5b0f9c1e2d3a4b5c8d9e0f1a2b3c4d5e';
const PUBLIC_KEY = 'pnrr-project-v1:0123456789abcdef0123456789abcdef';
const CUI = '16054368';

const MIPE_ACTIVE: ActiveReleaseRow = {
  release_id: MIPE_RELEASE_ID,
  source_run_id: 'pnrr-v2-20261115T090000Z-0a1b2c3d4e5f',
  release_kind: 'operational_snapshot',
  source_snapshot_at: MIPE_SOURCE_AS_OF,
  activated_at: '2026-11-15 10:00:00+00',
  warnings: ['activation_requires_explicit_approval', 'ords_payment_amounts_withheld'],
};
const NEXT_ACTIVE: ActiveReleaseRow = {
  ...MIPE_ACTIVE,
  release_id: NEXT_RELEASE_ID,
  source_run_id: 'pnrr-v2-20261116T090000Z-1b2c3d4e5f6a',
};

const ORDS_LANE: LedgerLaneRow = {
  lane: 'ords_payments_capture',
  capability_state: 'abstained',
  as_of: ORDS_CAPTURE_AS_OF,
  suspended: false,
  warnings: null,
  lane_epoch: 'ords-payment-snapshot:42',
  row_count: '0',
};
const MIPE_LANES: readonly LedgerLaneRow[] = [
  {
    lane: 'mipe_indicators',
    capability_state: 'served',
    as_of: MIPE_SOURCE_AS_OF,
    suspended: false,
    warnings: [],
    lane_epoch: 'mipe-indicatori-total-2026-10-15',
    row_count: '1',
  },
  {
    lane: 'mipe_projects',
    capability_state: 'served',
    as_of: MIPE_SOURCE_AS_OF,
    suspended: false,
    warnings: [],
    lane_epoch: 'mipe-progres-tehnic-2026-10-15',
    row_count: '24891',
  },
  ORDS_LANE,
];
const withLane = (lane: string, over: Partial<LedgerLaneRow>): readonly LedgerLaneRow[] =>
  MIPE_LANES.map((row) => (row.lane === lane ? { ...row, ...over } : row));

const LEGACY_ACTIVE: ActiveReleaseRow = {
  release_id: 'pnrr-release-v1:pnrr-v2-20260726T000000Z-legacy1',
  source_run_id: 'pnrr-v2-20260726T000000Z-legacy1',
  release_kind: 'operational_snapshot',
  source_snapshot_at: '2026-07-26 00:00:00+00',
  activated_at: '2026-07-26 01:00:00+00',
  warnings: [],
};
const LEGACY_LANES: readonly LedgerLaneRow[] = [
  {
    lane: 'projection-v2',
    capability_state: 'served',
    as_of: '2026-07-26 00:00:00+00',
    suspended: false,
    warnings: [],
    lane_epoch: 'projection-v2:pnrr-v2-20260726T000000Z-legacy1',
    row_count: '100',
  },
];
const LEGACY_PROMOTED = {
  run_id: LEGACY_ACTIVE.source_run_id,
  source_snapshot_at: '2026-07-26 00:00:00+00',
  finished_at: '2026-07-26 00:30:00+00',
};

const projectRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  project_key_v1: OPAQUE_KEY,
  project_key_version: 'project_key_v1',
  observation_id: 'mipe-obs-2026-10-15-0001',
  snapshot_id: 'mipe-progres-tehnic-2026-10-15',
  snapshot_date: '2026-10-15',
  endpoint_name: 'progres_tehnic_proiecte',
  item_key: 'item-0001',
  commitment_business_id: null,
  contract_number: 'C-0001',
  contract_title: 'Reabilitare scoala',
  beneficiary_cui: null,
  beneficiary_name: 'Beneficiar retinut',
  beneficiary_type: null,
  component_code: 'C5',
  measure_raw: 'I1',
  submeasure_raw: null,
  responsible_institution_code: null,
  responsible_institution_name: null,
  financing_source: null,
  commitment_date: null,
  start_date: null,
  end_date: null,
  last_funding_date: null,
  total_value: '0.00',
  eu_value: null,
  national_public_value: null,
  vat_value: null,
  ineligible_value: null,
  received_amount_lei: null,
  allocated_eur: null,
  paid_eur: null,
  received_eur: null,
  prefinancing_eur: null,
  suspended_eur: null,
  revoked_eur: null,
  project_count: null,
  contract_beneficiary_count: null,
  payment_beneficiary_count: null,
  national_impact_project_count: null,
  payment_count: null,
  beneficiary_count: null,
  total_eur: null,
  total_ron: null,
  financial_progress: '0',
  physical_progress: '0.4',
  county_name: 'BUZAU',
  county_siruta: '10',
  locality_name: null,
  impact_raw: null,
  timeline_month: null,
  timeline_label: null,
  status_raw: 'in_implementare',
  source_system: 'mipe',
  source_url: 'https://mfe.gov.ro/pnrr/',
  retrieved_at: '2026-10-15 06:00:00+00',
  linked_commitment_key: null,
  commitment_aggregation_state: null,
  ...over,
});

/** The scoped overview row as the statement returns it: ORDS columns select null. */
const OVERVIEW_ROW = {
  indicator_row_count: '1',
  indicator_snapshot_date: '2026-10-15',
  indicator_project_count: 21710,
  allocation_eur: '21410000000.00',
  received_eur: '10500000000.00',
  paid_eur: '0.00',
  payment_count: null,
  payment_net_ron: null,
  payment_gross_ron: null,
  payment_reversal_ron: null,
  payment_first_date: null,
  payment_last_date: null,
  commitment_count: null,
  additive_commitment_count: null,
  unresolved_commitment_count: null,
  additive_commitment_ron: null,
  progress_total_count: '24891',
  progress_observed_count: '24000',
  progress_completed_count: '0',
  progress_over_hundred_count: '3',
  missing_financial_progress_count: '891',
  missing_physical_progress_count: '900',
};

const ENTITY_ROW = {
  cui: CUI,
  resolved_name: 'PRIMARIA EXEMPLU',
  name_source: 'anaf',
  caen_code: null,
  is_active: true,
  is_vat_payer: false,
  is_beneficiary: true,
  is_applicant: false,
  is_winner: false,
  is_subcontractor: false,
  first_seen_source: 'ords',
  hubs: [],
};

interface LedgerState {
  readonly active?: ActiveReleaseRow;
  readonly lanes?: readonly LedgerLaneRow[];
}

interface Script extends LedgerState {
  readonly ledger?: boolean;
  readonly servingViews?: boolean;
  readonly generation?: boolean;
  readonly promoted?: Record<string, unknown>;
  readonly projects?: readonly Record<string, unknown>[];
  readonly history?: readonly Record<string, unknown>[];
  /** The dashboard snapshot's aggregated cell arrays, as the driver parses the JSON value. */
  readonly snapshot?: readonly unknown[];
  readonly releaseProgress?: readonly Record<string, unknown>[];
  readonly entities?: readonly Record<string, unknown>[];
  readonly capabilities?: readonly Record<string, unknown>[];
  /** After the first fact statement mentioning `on`, the ledger becomes `to` (an activation). */
  readonly flip?: { readonly on: string; readonly to: LedgerState };
}

class ScriptedDriver extends DummyDriver {
  constructor(
    private readonly rowsFor: (sql: string, parameters: readonly unknown[]) => readonly unknown[]
  ) {
    super();
  }

  override acquireConnection(): Promise<DatabaseConnection> {
    const rowsFor = this.rowsFor;
    return Promise.resolve({
      executeQuery: (query) =>
        Promise.resolve({ rows: [...rowsFor(query.sql, query.parameters)] as never[] }),
      streamQuery: async function* () {
        // never streamed
      },
    });
  }
}

const normalize = (sql: string): string => sql.replace(/\s+/gu, ' ').trim();

const VERIFICATION_ROW = {
  unresolved_commitment_count: '0',
  duplicate_payment_group_count: '0',
  missing_commitment_source_url_count: '0',
  end_before_start_count: '0',
  over_hundred_progress_count: '0',
  missing_progress_link_count: '0',
};

const scriptedRepo = (script: Script) => {
  const statements: string[] = [];
  const parameters: (readonly unknown[])[] = [];
  let ledger: LedgerState = script;
  let flipped = false;
  const ledgerRows = (): readonly unknown[] => {
    if (ledger.active === undefined) return [];
    const base = { ...ledger.active, serving_views_present: script.servingViews ?? true };
    const lanes = ledger.lanes ?? [];
    if (lanes.length === 0) {
      return [
        {
          ...base,
          lane: null,
          capability_state: null,
          as_of: null,
          suspended: null,
          lane_warnings: null,
          lane_epoch: null,
          row_count: null,
        },
      ];
    }
    return lanes.map((lane) => ({ ...base, ...lane, lane_warnings: lane.warnings }));
  };
  const factRows = (s: string, params: readonly unknown[]): readonly unknown[] => {
    if (s.includes('missing_progress_link_count')) return [VERIFICATION_ROW];
    if (s.includes('is_current_observation')) return [{ observations: script.snapshot ?? [] }];
    if (s.includes('api_release_project_history_v1')) {
      return (script.history ?? []).filter((row) => params.includes(row['project_key_v1']));
    }
    if (s.includes('api_release_progress_v1')) return script.releaseProgress ?? [];
    if (s.includes('::text as count')) return [];
    if (s.includes('"pnrr"."api_projects_v1"') || s.includes('"pnrr"."api_progress_current"')) {
      return (script.projects ?? []).filter(
        (row) => !s.includes('p.project_key_v1 = $') || params.includes(row['project_key_v1'])
      );
    }
    if (s.includes('"pnrr"."entities"')) return script.entities ?? [];
    return [];
  };
  const rowsFor = (raw: string, params: readonly unknown[]): readonly unknown[] => {
    const s = normalize(raw);
    if (s.includes("to_regclass('etl.pnrr_releases')"))
      return [{ available: script.ledger ?? true }];
    if (s.includes('serving_views_present')) return ledgerRows();
    if (s.startsWith('select release_id from etl.pnrr_releases where')) {
      return ledger.active === undefined ? [] : [{ release_id: ledger.active.release_id }];
    }
    if (s.includes('project_membership_generations_v1')) {
      return [{ present: script.generation ?? true }];
    }
    if (s.includes("to_regclass('pnrr.api_projects_v1')")) return [{ available: true }];
    if (s.includes('etl.pnrr_projection_v2_runs')) {
      return script.promoted === undefined ? [] : [script.promoted];
    }
    if (s.includes('etl.pnrr_release_capabilities')) return script.capabilities ?? [];
    if (s.includes('etl.sync_policy')) return [];
    const rows = factRows(s, params);
    if (script.flip !== undefined && !flipped && s.includes(script.flip.on)) {
      flipped = true;
      ledger = script.flip.to;
    }
    return rows;
  };
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(rowsFor),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') {
        statements.push(normalize(event.query.sql));
        parameters.push(event.query.parameters);
      }
    },
  });
  return { repo: makePnrrRepo(db), statements, parameters };
};

const READY_MIPE: Script = { active: MIPE_ACTIVE, lanes: MIPE_LANES };
const LEGACY_SCRIPT: Script = {
  active: LEGACY_ACTIVE,
  lanes: LEGACY_LANES,
  promoted: LEGACY_PROMOTED,
};
const MIPE_LEDGER: LedgerState = { active: MIPE_ACTIVE, lanes: MIPE_LANES };

const SCOPE: PnrrAnalysisScope = {
  grain: 'program',
  measure: 'amount',
  componentCode: null,
  beneficiaryCui: null,
  countySiruta: null,
  from: null,
  to: null,
  timeRole: 'snapshot_date',
  geographyRole: 'implementation_county',
  currency: null,
  resolutionPolicyVersion: 'pnrr-resolution-v1',
};

/** The binding's own statements name the views (to_regclass) or the ledger but read no facts. */
const isLedgerStatement = (statement: string): boolean =>
  statement.includes('serving_views_present') ||
  statement.includes('to_regclass(') ||
  statement.startsWith('select release_id from etl.pnrr_releases where');

/** Relations a scoped release never reads: legacy facts and private spine data. */
const LEGACY_OR_PRIVATE = [
  'api_payments',
  'api_progress_current',
  'pnrr.progress_observations',
  '"pnrr"."progress_observations"',
  'pnrr.projects_v1',
  '"pnrr"."projects_v1"',
  'pnrr.entities',
  '"pnrr"."entities"',
  'identity_basis',
  'subject_unique_identifier',
  'tax_identification_number',
  'public_key_uuid',
];

/** Fact statements that touch legacy or private data, including a live commitment link. */
const legacyOrPrivateReads = (statements: readonly string[]): string[] =>
  statements.filter(
    (statement) =>
      !isLedgerStatement(statement) &&
      (LEGACY_OR_PRIVATE.some((needle) => statement.includes(needle)) ||
        (statement.includes('api_commitments') && !statement.includes('as "c" on false')))
  );

const factReads = (statements: readonly string[], needle: string): string[] =>
  statements.filter((statement) => !isLedgerStatement(statement) && statement.includes(needle));

type Read = (repo: PnrrRepository) => Promise<Result<unknown, ApiError>>;

const WITHHELD_READS: readonly (readonly [string, Read])[] = [
  ['payments list', (r) => r.listPayments({}, { first: 5 })],
  ['payment aggregate', (r) => r.aggregatePayments({}, 'component')],
  ['entity profile', (r) => r.getEntityProfile(CUI)],
  ['commitments', (r) => r.listCommitments({}, { first: 5 })],
  ['verification', (r) => r.getVerification({ ...SCOPE, grain: 'verification' })],
  ['funding calls', (r) => r.listFundingCalls({ first: 5 })],
  ['contractor ranking', (r) => r.rankContractors({}, 'relationships', 5)],
  ['entity resolution', (r) => r.resolveDimension('entity', 'primaria', 5)],
];

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// ── pure binding ────────────────────────────────────────────────────────────

describe('bindScopedMipeRelease', () => {
  const facts = { servingViewsPresent: true, projectGenerationPresent: true };

  it('recognizes a release only by its scoped ledger lanes', () => {
    expect(hasScopedLane(MIPE_LANES)).toBe(true);
    expect(hasScopedLane([ORDS_LANE])).toBe(true);
    expect(hasScopedLane(LEGACY_LANES)).toBe(false);
    expect(hasScopedLane([])).toBe(false);
  });

  it('binds a complete MIPE release with independent MIPE and ORDS dates', () => {
    const binding = bindScopedMipeRelease(MIPE_ACTIVE, MIPE_LANES, facts);
    expect(binding.kind).toBe('mipe');
    expect(binding.release.state).toBe('degraded');
    const byLane = new Map(binding.release.lanes.map((lane) => [lane.lane, lane]));
    expect(byLane.get('mipe_projects')).toEqual({
      lane: 'mipe_projects',
      state: 'served',
      asOf: MIPE_SOURCE_AS_OF,
      suspended: false,
      reasonCodes: [],
    });
    expect(byLane.get('ords_payments_capture')).toEqual({
      lane: 'ords_payments_capture',
      state: 'abstained',
      asOf: ORDS_CAPTURE_AS_OF,
      suspended: false,
      reasonCodes: ['ords_payment_amounts_withheld'],
    });
  });

  it.each([
    [
      'a missing ORDS lane',
      MIPE_LANES.filter((lane) => lane.lane !== 'ords_payments_capture'),
      facts,
      ['scoped_release_manifest_incomplete', 'scoped_ords_receipt_invalid'],
    ],
    [
      'a mixed legacy lane',
      [...MIPE_LANES, ...LEGACY_LANES],
      facts,
      ['scoped_release_manifest_incomplete'],
    ],
    [
      'a suspended projects lane',
      withLane('mipe_projects', { suspended: true }),
      facts,
      ['scoped_mipe_lane_not_servable'],
    ],
    [
      'an abstained indicators lane',
      withLane('mipe_indicators', { capability_state: 'abstained' }),
      facts,
      ['scoped_mipe_lane_not_servable'],
    ],
    [
      'differing MIPE source dates',
      withLane('mipe_indicators', { as_of: '2026-09-15 00:00:00+00' }),
      facts,
      ['scoped_mipe_source_dates_differ'],
    ],
    [
      'an ORDS lane that claims served amounts',
      withLane('ords_payments_capture', { capability_state: 'served' }),
      facts,
      ['scoped_ords_receipt_invalid'],
    ],
    [
      'an ORDS lane that carries rows',
      withLane('ords_payments_capture', { row_count: '120000' }),
      facts,
      ['scoped_ords_receipt_invalid'],
    ],
    [
      'an ORDS lane without an accepted capture epoch',
      withLane('ords_payments_capture', { lane_epoch: 'ords-payment-snapshot:draft' }),
      facts,
      ['scoped_ords_receipt_invalid'],
    ],
    [
      'an ORDS lane without a capture time',
      withLane('ords_payments_capture', { as_of: null }),
      facts,
      ['scoped_ords_receipt_invalid'],
    ],
    [
      'unapplied serving views',
      MIPE_LANES,
      { servingViewsPresent: false, projectGenerationPresent: false },
      ['scoped_release_views_missing', 'scoped_project_generation_missing'],
    ],
    [
      'a missing project generation',
      MIPE_LANES,
      { servingViewsPresent: true, projectGenerationPresent: false },
      ['scoped_project_generation_missing'],
    ],
  ])('withholds the release on %s', (_name, lanes, laneFacts, reasons) => {
    const binding = bindScopedMipeRelease(MIPE_ACTIVE, lanes, laneFacts);
    expect(binding.kind).toBe('withheld');
    expect(binding.release.state).toBe('abstained');
    expect(binding.release.lanes[0]).toEqual({
      lane: 'release-manifest',
      state: 'abstained',
      asOf: MIPE_SOURCE_AS_OF,
      suspended: true,
      reasonCodes: reasons,
    });
  });

  it('accepts an ORDS capture time independent of the MIPE source date', () => {
    const lanes = withLane('ords_payments_capture', { as_of: '2025-01-01 00:00:00+00' });
    expect(bindScopedMipeRelease(MIPE_ACTIVE, lanes, facts).kind).toBe('mipe');
  });
});

// ── legacy, no ledger and no active release ──────────────────────────────────

describe('PNRR repo without a scoped active release', () => {
  it('keeps the legacy reader when the release ledger is absent', async () => {
    const { repo, statements } = scriptedRepo({ ledger: false });
    expect((await repo.listProjects({}, { first: 5 })).isOk()).toBe(true);
    const reads = factReads(statements, '"pnrr"."api_projects_v1"');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain(
      'on "c"."envelope_candidate_key_v1" = "p"."commitment_envelope_key_v1"'
    );
    expect(factReads(statements, 'api_release_')).toEqual([]);
  });

  it('keeps the legacy no-active-release state and readers', async () => {
    const { repo, statements } = scriptedRepo({});
    expect((await repo.getCurrentRelease())._unsafeUnwrap()).toMatchObject({
      releaseId: 'pnrr-no-active-release',
      state: 'abstained',
    });
    expect((await repo.listProjects({}, { first: 5 })).isOk()).toBe(true);
    expect(factReads(statements, '"pnrr"."api_projects_v1"')).toHaveLength(1);
    expect(factReads(statements, 'p.release_id')).toEqual([]);
  });

  it('keeps an old legacy active release on the promoted-projection path', async () => {
    const { repo, statements } = scriptedRepo(LEGACY_SCRIPT);
    expect((await repo.getCurrentRelease())._unsafeUnwrap()).toMatchObject({
      releaseId: LEGACY_ACTIVE.release_id,
      state: 'served',
      lanes: [expect.objectContaining({ lane: 'projection-v2', state: 'served' })],
    });
    expect(factReads(statements, 'etl.pnrr_projection_v2_runs')).toHaveLength(1);
    expect((await repo.listProjects({}, { first: 5 })).isOk()).toBe(true);
    expect(factReads(statements, 'p.release_id')).toEqual([]);
  });

  it('keeps staged release-scoped rows out of legacy direct readers (draft isolation)', async () => {
    const { repo, statements } = scriptedRepo({
      ...LEGACY_SCRIPT,
      projects: [projectRow({ project_key_v1: PUBLIC_KEY, observation_id: 'legacy-obs-1' })],
    });
    expect((await repo.getProjectHistory(PUBLIC_KEY)).isOk()).toBe(true);
    const direct = factReads(statements, 'from "pnrr"."progress_observations"');
    expect(direct).toHaveLength(1);
    expect(direct[0]).toContain(`(to_jsonb(p) ->> 'release_scope') is null`);

    expect((await repo.getVerification({ ...SCOPE, grain: 'verification' })).isOk()).toBe(true);
    const verification = factReads(statements, 'missing_progress_link_count');
    expect(verification).toHaveLength(1);
    expect(verification[0]).toContain(`(to_jsonb(po) ->> 'release_scope') is null`);
    expect(factReads(statements, 'api_release_')).toEqual([]);
  });
});

// ── ready MIPE release ───────────────────────────────────────────────────────

describe('PNRR repo bound to a ready scoped MIPE release', () => {
  it('reports the scoped release with no legacy projection at all', async () => {
    const { repo, statements } = scriptedRepo(READY_MIPE);
    const release = (await repo.getCurrentRelease())._unsafeUnwrap();
    expect(release).toMatchObject({
      releaseId: MIPE_RELEASE_ID,
      state: 'degraded',
      sourceSnapshotAt: MIPE_SOURCE_AS_OF,
    });
    expect(factReads(statements, 'etl.pnrr_projection_v2_runs')).toEqual([]);
  });

  it('derives the dashboard capabilities from the declared indicator and project lanes', async () => {
    const declared = (capability: string, state: string, reasons: string[]) => ({
      capability,
      capability_state: state,
      reason_codes: reasons,
      limitation: null,
    });
    const { repo } = scriptedRepo({
      ...READY_MIPE,
      capabilities: [
        declared('indicators', 'served', []),
        declared('projects', 'degraded', ['project_membership_v1']),
        declared('history', 'degraded', ['history_starts_at_first_scoped_release']),
        declared('payments', 'abstained', ['ords_payment_policy_unresolved']),
        declared('commitment_links', 'abstained', ['ords_commitments_not_loaded']),
      ],
    });
    const byId = new Map(
      (await repo.getCapabilities())
        ._unsafeUnwrap()
        .map((capability) => [capability.id, capability])
    );
    expect(byId.get('overview')).toMatchObject({
      releaseId: MIPE_RELEASE_ID,
      state: 'degraded',
      reasonCodes: ['derived_from_indicators', 'ords_payment_amounts_withheld'],
    });
    expect(byId.get('places')).toMatchObject({
      state: 'degraded',
      reasonCodes: ['derived_from_projects', 'ords_payment_amounts_withheld'],
    });
    expect(byId.get('payments')?.state).toBe('abstained');
    expect(byId.get('organizations')?.reasonCodes).toEqual(['capability_not_declared_for_release']);
  });

  it('derives nothing for a legacy release that does not declare a capability', async () => {
    const { repo } = scriptedRepo({
      ...LEGACY_SCRIPT,
      capabilities: [
        {
          capability: 'indicators',
          capability_state: 'served',
          reason_codes: [],
          limitation: null,
        },
      ],
    });
    const byId = new Map(
      (await repo.getCapabilities())
        ._unsafeUnwrap()
        .map((capability) => [capability.id, capability])
    );
    expect(byId.get('overview')?.reasonCodes).toEqual(['capability_not_declared_for_release']);
  });

  it('pages projects through the shared select with a pinned release and no live link', async () => {
    const { repo, statements, parameters } = scriptedRepo({
      ...READY_MIPE,
      projects: [
        projectRow(),
        projectRow({ project_key_v1: PUBLIC_KEY, observation_id: 'mipe-obs-2026-10-15-0000' }),
      ],
    });
    const page = (
      await repo.listProjects({}, { first: 1, releaseId: MIPE_RELEASE_ID }, MIPE_RELEASE_ID)
    )._unsafeUnwrap();
    expect(page.items.map((item) => item.projectKey)).toEqual([OPAQUE_KEY]);
    expect(page.items[0]).toMatchObject({
      linkedCommitmentKey: null,
      totalValueRon: '0.00',
      financialProgressRatio: 0,
    });
    expect(page.next).not.toBeNull();

    const index = statements.findIndex(
      (s) => !isLedgerStatement(s) && s.includes('"pnrr"."api_projects_v1" as "p"')
    );
    expect(statements[index]).toContain('left join "pnrr"."api_commitments" as "c" on false');
    expect(statements[index]).toContain('p.release_id = $2');
    expect(parameters[index]?.[1]).toBe(MIPE_RELEASE_ID);
    expect(legacyOrPrivateReads(statements)).toEqual([]);

    const resumed = await repo.listProjects(
      {},
      { first: 1, after: page.next ?? '', releaseId: MIPE_RELEASE_ID },
      MIPE_RELEASE_ID
    );
    expect(resumed.isOk()).toBe(true);
  });

  it('binds facets and detail to the same release', async () => {
    const { repo, statements, parameters } = scriptedRepo({
      ...READY_MIPE,
      projects: [projectRow()],
    });
    expect((await repo.getProjectFacets({})).isOk()).toBe(true);
    expect((await repo.getProject(OPAQUE_KEY))._unsafeUnwrap()?.projectKey).toBe(OPAQUE_KEY);
    const scoped = statements
      .map((statement, i) => ({ statement, params: parameters[i] ?? [] }))
      .filter(
        ({ statement }) => !isLedgerStatement(statement) && statement.includes('api_projects_v1')
      );
    expect(scoped).toHaveLength(6);
    for (const { params } of scoped) expect(params).toContain(MIPE_RELEASE_ID);
    expect(legacyOrPrivateReads(statements)).toEqual([]);
  });

  it('serves publisher-reported indicators and withholds ORDS totals, nested ones included', async () => {
    const { repo, statements, parameters } = scriptedRepo({
      ...READY_MIPE,
      releaseProgress: [OVERVIEW_ROW],
    });
    const overview = (await repo.getOverview(SCOPE))._unsafeUnwrap();
    const reported = (factType: string, amount: string) => ({
      factType,
      amount,
      currency: 'EUR',
      aggregationState: 'additive',
      coveredCount: 1,
      totalCount: 1,
    });
    const withheld = (factType: string, currency: string) => ({
      factType,
      amount: null,
      currency,
      aggregationState: 'unavailable',
      coveredCount: 0,
      totalCount: 0,
    });
    expect(overview.program).toEqual({
      snapshotDate: '2026-10-15',
      projectCount: 21710,
      allocationEur: reported('plan_allocation', '21410000000.00'),
      receivedEur: reported('eu_receipt', '10500000000.00'),
      // A reported zero stays a reported zero.
      paidEur: reported('national_reported_payment', '0.00'),
    });
    expect(overview.beneficiaryPayments).toEqual({
      count: null,
      netRon: withheld('beneficiary_payment', 'RON'),
      grossRon: withheld('beneficiary_payment', 'RON'),
      reversalRon: withheld('beneficiary_payment', 'RON'),
      firstDate: null,
      lastDate: null,
    });
    expect(overview.commitments).toEqual({
      count: null,
      additiveCount: null,
      unresolvedCount: null,
      additiveRon: withheld('commitment', 'RON'),
    });
    expect(overview.delivery).toEqual({
      observedCount: 24000,
      completedCount: 0,
      overHundredCount: 3,
      missingFinancialProgressCount: 891,
      missingPhysicalProgressCount: 900,
    });
    expect(overview.meta.coverage.map((c) => c.field)).toEqual(['progress.physical']);
    expect(overview.meta.reasonCodes).toEqual([
      'ords_payment_amounts_withheld',
      'ords_commitments_not_loaded',
    ]);
    const lanes = new Map(overview.meta.release.lanes.map((lane) => [lane.lane, lane.asOf]));
    expect(lanes.get('mipe_projects')).toBe(MIPE_SOURCE_AS_OF);
    expect(lanes.get('ords_payments_capture')).toBe(ORDS_CAPTURE_AS_OF);

    const index = statements.findIndex((s) => s.includes('from pnrr.api_release_progress_v1 p'));
    expect(parameters[index]).toContain(MIPE_RELEASE_ID);
    expect(legacyOrPrivateReads(statements)).toEqual([]);
  });

  it('never picks or sums among ambiguous indicator rows', async () => {
    const { repo } = scriptedRepo({
      ...READY_MIPE,
      releaseProgress: [
        {
          ...OVERVIEW_ROW,
          indicator_row_count: '2',
          indicator_snapshot_date: null,
          indicator_project_count: null,
          allocation_eur: null,
          received_eur: null,
          paid_eur: null,
        },
      ],
    });
    const overview = (await repo.getOverview(SCOPE))._unsafeUnwrap();
    expect(overview.program.projectCount).toBeNull();
    expect(overview.program.allocationEur).toMatchObject({
      amount: null,
      aggregationState: 'unavailable',
    });
    expect(overview.meta.reasonCodes).toContain('mipe_indicator_rows_ambiguous');
  });

  it('serves map inputs as MIPE observation counts with ORDS facts null, never zero', async () => {
    const { repo, statements } = scriptedRepo({
      ...READY_MIPE,
      releaseProgress: [
        {
          county_siruta: '10',
          county_name: 'BUZAU',
          payment_count: null,
          payment_net_ron: null,
          commitment_count: null,
          additive_commitment_count: null,
          unresolved_commitment_count: null,
          additive_commitment_ron: null,
          project_observation_count: '0',
          source_locality_label_count: '0',
        },
      ],
    });
    expect((await repo.listPlaces({ ...SCOPE, grain: 'place' }))._unsafeUnwrap()).toEqual([
      {
        countySiruta: '10',
        countyName: 'BUZAU',
        paymentCount: null,
        paymentNetRon: null,
        commitmentCount: null,
        additiveCommitmentCount: null,
        unresolvedCommitmentCount: null,
        additiveCommitmentRon: null,
        projectObservationCount: 0,
        sourceLocalityLabelCount: 0,
        sourceLocalityLabelValue: null,
      },
    ]);
    const places = factReads(statements, 'core.territories');
    expect(places[0]).toContain('coalesce(ps.payment_count, null::bigint)');
    expect(legacyOrPrivateReads(statements)).toEqual([]);
  });

  it.each(WITHHELD_READS)('explicitly withholds the %s surface', async (_name, read) => {
    const { repo, statements } = scriptedRepo(READY_MIPE);
    const result = await read(repo);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
    expect(result._unsafeUnwrapErr().message).toContain(
      'withheld for the active MIPE-only release'
    );
    expect(legacyOrPrivateReads(statements)).toEqual([]);
  });

  it('spends one ledger statement before and one after each read, and none extra for status', async () => {
    const { repo, statements } = scriptedRepo({ ...READY_MIPE, projects: [projectRow()] });
    await repo.listProjects({}, { first: 5 });
    const warm = statements.length;
    await repo.listProjects({}, { first: 5 });
    expect(statements.slice(warm)).toEqual([
      expect.stringContaining('serving_views_present'),
      expect.stringContaining('"pnrr"."api_projects_v1" as "p"'),
      "select release_id from etl.pnrr_releases where release_state = 'active'",
    ]);
    const beforeStatus = statements.length;
    await repo.getCurrentRelease();
    expect(statements.length - beforeStatus).toBe(1);

    const legacy = scriptedRepo(LEGACY_SCRIPT);
    await legacy.repo.getCurrentRelease();
    const legacyWarm = legacy.statements.length;
    await legacy.repo.getCurrentRelease();
    // The ledger statement plus the legacy promoted-run check; no separate lane read.
    expect(legacy.statements.length - legacyWarm).toBe(2);
  });
});

// ── opaque-key-only history ─────────────────────────────────────────────────

describe('scoped project history', () => {
  const history = [
    projectRow({ snapshot_date: '2026-09-15', observation_id: 'mipe-obs-2026-09-15-0001' }),
    projectRow(),
  ];

  it('reads the release-pinned privacy view by the served opaque key only', async () => {
    const { repo, statements, parameters } = scriptedRepo({ ...READY_MIPE, history });
    const rows = (await repo.getProjectHistory(OPAQUE_KEY))._unsafeUnwrap();
    expect(rows.map((row) => [row.projectKey, row.snapshotDate])).toEqual([
      [OPAQUE_KEY, '2026-09-15'],
      [OPAQUE_KEY, '2026-10-15'],
    ]);
    const index = statements.findIndex((s) =>
      s.includes('"pnrr"."api_release_project_history_v1"')
    );
    expect(statements[index]).toContain('p.release_id = $2 and p.project_key_v1 = $3');
    expect(statements[index]).toContain('as "c" on false');
    expect(statements[index]).not.toContain('observation_id = $');
    expect(parameters[index]).toEqual(['project_progress', MIPE_RELEASE_ID, OPAQUE_KEY, 2000]);
    expect(legacyOrPrivateReads(statements)).toEqual([]);
  });

  it('finds nothing by an observation id or an internal private-derived key', async () => {
    const { repo, statements } = scriptedRepo({ ...READY_MIPE, history });
    expect((await repo.getProjectHistory('mipe-obs-2026-10-15-0001'))._unsafeUnwrap()).toEqual([]);
    expect(
      (
        await repo.getProjectHistory('pnrr-project-v1:ffffffffffffffffffffffffffffffff')
      )._unsafeUnwrap()
    ).toEqual([]);
    expect(legacyOrPrivateReads(statements)).toEqual([]);
  });
});

// ── fail closed: incomplete manifest and release flips ───────────────────────

describe('scoped release fail-closed paths', () => {
  it('withholds every fact for an incomplete scoped manifest without legacy fallback', async () => {
    const { repo, statements } = scriptedRepo({
      active: MIPE_ACTIVE,
      lanes: MIPE_LANES.filter((lane) => lane.lane === 'mipe_projects'),
      projects: [projectRow()],
    });
    const release = (await repo.getCurrentRelease())._unsafeUnwrap();
    expect(release).toMatchObject({ releaseId: MIPE_RELEASE_ID, state: 'abstained' });
    expect(release.lanes[0]?.reasonCodes).toContain('scoped_release_manifest_incomplete');
    const results: readonly Result<unknown, ApiError>[] = [
      await repo.listProjects({}, { first: 5 }),
      await repo.getOverview(SCOPE),
      await repo.getProjectHistory(OPAQUE_KEY),
      await repo.listPayments({}, { first: 5 }),
    ];
    for (const result of results) {
      expect(result._unsafeUnwrapErr()).toMatchObject({
        type: 'ServiceUnavailable',
        message: 'PNRR serving release is unavailable.',
      });
    }
    expect(factReads(statements, 'pnrr')).toEqual([
      expect.stringContaining('project_membership_generations_v1'),
    ]);
  });

  it('refuses a page observed under another release before reading it', async () => {
    const { repo, statements } = scriptedRepo({ ...READY_MIPE, projects: [projectRow()] });
    const result = await repo.listProjects(
      {},
      { first: 5, releaseId: 'pnrr-release-v1:pnrr-v2-previous' },
      'pnrr-release-v1:pnrr-v2-previous'
    );
    expect(result._unsafeUnwrapErr().message).toContain('changed during the read');
    expect(factReads(statements, 'api_projects_v1')).toEqual([]);
  });

  it.each([
    ['list', (r: PnrrRepository) => r.listProjects({}, { first: 5 })],
    ['facets', (r: PnrrRepository) => r.getProjectFacets({})],
    ['history', (r: PnrrRepository) => r.getProjectHistory(OPAQUE_KEY)],
    ['overview', (r: PnrrRepository) => r.getOverview(SCOPE)],
  ] as const)(
    'rejects an empty scoped %s returned while the next release activates',
    async (_name, read) => {
      const { repo } = scriptedRepo({
        ...READY_MIPE,
        releaseProgress: [OVERVIEW_ROW],
        flip: { on: 'pnrr', to: { active: NEXT_ACTIVE, lanes: MIPE_LANES } },
      });
      const result: Result<unknown, ApiError> = await read(repo);
      expect(result._unsafeUnwrapErr().message).toContain('changed during the read');
    }
  );
});

// ── legacy-to-MIPE activation in progress ─────────────────────────────────────

describe('activation of a scoped release during a legacy read', () => {
  const starts: readonly (readonly [string, Script])[] = [
    ['an active legacy release', LEGACY_SCRIPT],
    ['no active release', { promoted: LEGACY_PROMOTED }],
  ];

  it.each(starts)('never returns ORDS facts read under %s', async (_name, start) => {
    const transition = (): ReturnType<typeof scriptedRepo> =>
      scriptedRepo({
        ...start,
        entities: [ENTITY_ROW],
        flip: { on: 'api_payments', to: MIPE_LEDGER },
      });

    const direct = transition();
    const payments = await direct.repo.listPayments({ componentCode: { eq: 'C5' } }, { first: 5 });
    expect(payments._unsafeUnwrapErr().message).toContain('changed during the read');
    expect(factReads(direct.statements, 'api_payments')).toHaveLength(1);

    // GraphQL without assertReleaseId.
    const graphql = makePnrrResolvers({
      repo: transition().repo,
      registry: createContributorRegistry(),
    }) as { Query: { pnrrPayments: (r: unknown, a: object) => Promise<unknown> } };
    await expect(
      graphql.Query.pnrrPayments(null, { filter: { componentCode: { eq: 'C5' } }, first: 5 })
    ).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE' } });

    // MCP without assertReleaseId.
    const entityTool = makePnrrMcpTools({
      repo: transition().repo,
      clientBaseUrl: 'https://transparenta.eu',
    }).find((tool) => tool.name === 'get_pnrr_entity');
    const mcp = await entityTool!.handler({ cui: CUI });
    expect(mcp.ok).toBe(false);
    expect(mcp.item).toBeUndefined();

    // The entity-360 contributor path, which bypasses the resolvers.
    const presence = await makePnrrContributor(transition().repo).presenceFor(CUI);
    expect(presence.isErr()).toBe(true);
  });

  it('returns 503 over REST when the legacy release is replaced mid-request', async () => {
    const { repo } = scriptedRepo({
      ...LEGACY_SCRIPT,
      entities: [ENTITY_ROW],
      flip: { on: 'api_payments', to: MIPE_LEDGER },
    });
    const app = createFastify({ logger: false });
    apps.push(app);
    await app.register(makePnrrRestRoutes({ repo }), { prefix: '/api/v1/pnrr' });
    const response = await app.inject({ method: 'GET', url: `/api/v1/pnrr/organizations/${CUI}` });
    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).not.toContain('payments');
  });
});

// ── supported surfaces over the real repo ─────────────────────────────────────

describe('scoped MIPE release through GraphQL, REST and MCP', () => {
  it('serves the same overview with withheld nested ORDS totals on every surface', async () => {
    const { repo } = scriptedRepo({ ...READY_MIPE, releaseProgress: [OVERVIEW_ROW] });

    const resolvers = makePnrrResolvers({ repo, registry: createContributorRegistry() }) as {
      Query: {
        pnrrOverview: (r: unknown, a: { assertReleaseId?: string }) => Promise<PnrrOverview>;
        pnrrPayments: (r: unknown, a: { first?: number }) => Promise<unknown>;
      };
    };
    const graphql = await resolvers.Query.pnrrOverview(null, { assertReleaseId: MIPE_RELEASE_ID });
    expect(graphql.beneficiaryPayments.count).toBeNull();
    expect(graphql.beneficiaryPayments.netRon.aggregationState).toBe('unavailable');
    expect(graphql.commitments.additiveRon.amount).toBeNull();
    // No assertReleaseId: withheld at the repository boundary all the same.
    await expect(resolvers.Query.pnrrPayments(null, { first: 5 })).rejects.toMatchObject({
      extensions: { code: 'SERVICE_UNAVAILABLE' },
    });

    const app = createFastify({ logger: false });
    apps.push(app);
    await app.register(makePnrrRestRoutes({ repo }), { prefix: '/api/v1/pnrr' });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/pnrr/overview?assertReleaseId=${encodeURIComponent(MIPE_RELEASE_ID)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(graphql);

    const tools = makePnrrMcpTools({ repo, clientBaseUrl: 'https://transparenta.eu' });
    const overviewTool = tools.find((tool) => tool.name === 'get_pnrr_overview');
    const mcp = await overviewTool!.handler({ assertReleaseId: MIPE_RELEASE_ID });
    expect(mcp.ok).toBe(true);
    expect(mcp.item).toEqual(graphql);
    const aggregateTool = tools.find((tool) => tool.name === 'aggregate_pnrr_payments');
    expect((await aggregateTool!.handler({ groupBy: 'component' })).ok).toBe(false);
  });

  it('declares the withheld counts nullable in the GraphQL contract', () => {
    expect(pnrrTypeDefs).not.toContain('paymentCount: Int!');
    expect(pnrrTypeDefs).not.toContain('commitmentCount: Int!');
    expect(pnrrTypeDefs).toContain('unresolvedCount: Int\n');
  });
});

// ── dashboard snapshot (PNRR-RESTORE-API-02) ──────────────────────────────────

describe('dashboard snapshot of the active scoped MIPE release', () => {
  const SNAPSHOT_URL = '/api/v1/pnrr/dashboard-snapshot';
  /** The field list agreed with the client, in wire order. */
  const AGREED_FIELDS = [
    'projectKey',
    'sourceObservationId',
    'snapshotId',
    'snapshotDate',
    'commitmentBusinessId',
    'contractTitle',
    'beneficiaryName',
    'beneficiaryCui',
    'countyName',
    'localityName',
    'financingSource',
    'euContributionRon',
    'totalValueRon',
    'nationalPublicValueRon',
    'vatRon',
    'ineligibleValueRon',
    'contractNumber',
    'commitmentDate',
    'startDate',
    'endDate',
    'beneficiaryType',
    'impact',
    'responsibleInstitutionName',
    'physicalProgressRatio',
    'financialProgressRatio',
    'status',
    'componentCode',
    'measureCode',
    'responsibleInstitutionCode',
    'sourceUrl',
  ];
  /** The exact observation statement: fenced view, bound release, current rows at the lane date. */
  const observationStatement = (releaseParam: string, dateParam: string): string =>
    [
      'select coalesce( json_agg( json_build_array(',
      [
        'coalesce(p.project_key_v1, p.observation_id)',
        'p.observation_id::text',
        'p.snapshot_id::text',
        'p.snapshot_date::text',
        'p.commitment_business_id::text',
        'p.contract_title',
        'p.beneficiary_name::text',
        'case when p.beneficiary_cui collate "C" ~ \'^[0-9]{1,10}$\' then p.beneficiary_cui end',
        'p.county_name::text',
        'p.locality_name::text',
        'p.financing_source::text',
        'p.eu_value::text',
        'p.total_value::text',
        'p.national_public_value::text',
        'p.vat_value::text',
        'p.ineligible_value::text',
        'p.contract_number::text',
        'p.commitment_date',
        'p.start_date',
        'p.end_date',
        'p.beneficiary_type',
        'p.impact_raw',
        'p.responsible_institution_name::text',
        'p.physical_progress::text',
        'p.financial_progress::text',
        'p.status_raw::text',
        'p.component_code::text',
        'p.measure_raw::text',
        'p.responsible_institution_code::text',
        'p.source_url::text',
      ].join(', '),
      ") order by p.observation_id ), '[]'::json ) as observations",
      ' from pnrr.api_release_project_history_v1 p',
      ` where p.release_id = ${releaseParam}`,
      " and p.record_kind = 'project_progress'",
      ' and p.is_current_observation',
      ` and p.snapshot_date = (${dateParam}::timestamptz at time zone 'UTC')::date`,
    ].join('');

  type Cells = Partial<Record<PnrrDashboardObservationField, string | null>>;
  const BASE_CELLS: Cells = {
    projectKey: OPAQUE_KEY,
    sourceObservationId: 'mipe-obs-2026-10-15-0001',
    snapshotId: 'mipe-progres-tehnic-2026-10-15',
    snapshotDate: '2026-10-15',
    commitmentBusinessId: null,
    contractTitle: 'Reabilitare scoala',
    beneficiaryName: 'Beneficiar retinut',
    beneficiaryCui: null,
    countyName: 'BUZAU',
    localityName: 'Buzau',
    financingSource: 'PNRR',
    euContributionRon: '1250.50',
    totalValueRon: '0.00',
    nationalPublicValueRon: null,
    vatRon: null,
    ineligibleValueRon: null,
    contractNumber: 'C-0001',
    commitmentDate: '2024-03-01',
    startDate: '2024-03-15',
    endDate: '2026-06-30',
    beneficiaryType: 'UAT',
    impact: null,
    responsibleInstitutionName: 'MIPE',
    physicalProgressRatio: '0.4',
    financialProgressRatio: '0',
    status: 'in_implementare',
    componentCode: 'C5',
    measureCode: 'I1',
    responsibleInstitutionCode: null,
    sourceUrl: 'https://mfe.gov.ro/pnrr/',
  };
  /** One aggregated cell array, as `json_build_array` emits it in field order. */
  const cells = (over: Cells = {}): readonly (string | null)[] =>
    PNRR_DASHBOARD_OBSERVATION_FIELDS.map((field) => ({ ...BASE_CELLS, ...over })[field] ?? null);
  const PERSONAL_NUMBER = '1960101123456';
  /** What the fenced view aggregates for the current-observation predicate. */
  const current = [
    // Canonical observation of an opaque-key project; the view masked its CUI.
    cells(),
    // A noncanonical observation of the same project: same served key.
    cells({ sourceObservationId: 'mipe-obs-2026-10-15-0002', contractNumber: 'C-0001-bis' }),
    // A public-key project with a servable CUI and no reported physical progress.
    cells({
      projectKey: PUBLIC_KEY,
      sourceObservationId: 'mipe-obs-2026-10-15-0003',
      beneficiaryCui: CUI,
      beneficiaryName: 'PRIMARIA EXEMPLU',
      physicalProgressRatio: null,
    }),
    // A personal-number-shaped identifier is still withheld by the mapper's mask.
    cells({ sourceObservationId: 'mipe-obs-2026-10-15-0004', beneficiaryCui: PERSONAL_NUMBER }),
  ];
  const ready: Script = { ...READY_MIPE, releaseProgress: [OVERVIEW_ROW], snapshot: current };
  const snapshotReads = (statements: readonly string[]): string[] =>
    factReads(statements, 'api_release_project_history_v1');
  const bindings = (statements: readonly string[]): number =>
    statements.filter((s) => s.includes('serving_views_present')).length;
  const rechecks = (statements: readonly string[]): number =>
    statements.filter((s) => s.startsWith('select release_id from etl.pnrr_releases where')).length;
  const restApp = async (repo: PnrrRepository): Promise<FastifyInstance> => {
    const app = createFastify({ logger: false });
    apps.push(app);
    await app.register(makePnrrRestRoutes({ repo }), { prefix: '/api/v1/pnrr' });
    return app;
  };

  it('serves the bound release, national program and every current observation', async () => {
    const { repo, statements, parameters } = scriptedRepo(ready);
    const read = (await repo.getDashboardSnapshot(MIPE_RELEASE_ID))._unsafeUnwrap();
    if (read.kind !== 'snapshot') throw new Error(`expected a snapshot, got ${read.kind}`);
    const { release, program, observations } = read.snapshot;

    expect(release).toEqual((await repo.getCurrentRelease())._unsafeUnwrap());
    expect(release).toMatchObject({
      releaseId: MIPE_RELEASE_ID,
      state: 'degraded',
      sourceSnapshotAt: MIPE_SOURCE_AS_OF,
      completedAt: '2026-11-15 10:00:00+00',
    });
    // MIPE source date and ORDS capture time stay separate; ORDS stays withheld.
    expect(release.lanes.map((lane) => [lane.lane, lane.state, lane.asOf])).toEqual([
      ['mipe_indicators', 'served', MIPE_SOURCE_AS_OF],
      ['mipe_projects', 'served', MIPE_SOURCE_AS_OF],
      ['ords_payments_capture', 'abstained', ORDS_CAPTURE_AS_OF],
    ]);

    const reported = (factType: string, amount: string) => ({
      factType,
      amount,
      currency: 'EUR',
      aggregationState: 'additive',
      coveredCount: 1,
      totalCount: 1,
    });
    expect(program).toEqual({
      snapshotDate: '2026-10-15',
      projectCount: 21710,
      allocationEur: reported('plan_allocation', '21410000000.00'),
      receivedEur: reported('eu_receipt', '10500000000.00'),
      paidEur: reported('national_reported_payment', '0.00'),
    });

    // Every current observation, canonical or not, in the agreed fields only.
    expect(PNRR_DASHBOARD_OBSERVATION_FIELDS).toEqual(AGREED_FIELDS);
    for (const observation of observations) {
      expect(Object.keys(observation)).toEqual(AGREED_FIELDS);
    }
    expect(observations[0]).toEqual({
      projectKey: OPAQUE_KEY,
      sourceObservationId: 'mipe-obs-2026-10-15-0001',
      snapshotId: 'mipe-progres-tehnic-2026-10-15',
      snapshotDate: '2026-10-15',
      commitmentBusinessId: null,
      contractTitle: 'Reabilitare scoala',
      beneficiaryName: 'Beneficiar retinut',
      beneficiaryCui: null,
      countyName: 'BUZAU',
      localityName: 'Buzau',
      financingSource: 'PNRR',
      euContributionRon: '1250.50',
      totalValueRon: '0.00',
      nationalPublicValueRon: null,
      vatRon: null,
      ineligibleValueRon: null,
      contractNumber: 'C-0001',
      commitmentDate: '2024-03-01',
      startDate: '2024-03-15',
      endDate: '2026-06-30',
      beneficiaryType: 'UAT',
      impact: null,
      responsibleInstitutionName: 'MIPE',
      physicalProgressRatio: 0.4,
      financialProgressRatio: 0,
      status: 'in_implementare',
      componentCode: 'C5',
      measureCode: 'I1',
      responsibleInstitutionCode: null,
      sourceUrl: 'https://mfe.gov.ro/pnrr/',
    });
    expect(
      observations.map((o) => [
        o.sourceObservationId,
        o.projectKey,
        o.snapshotDate,
        o.beneficiaryCui,
        o.physicalProgressRatio,
      ])
    ).toEqual([
      ['mipe-obs-2026-10-15-0001', OPAQUE_KEY, '2026-10-15', null, 0.4],
      ['mipe-obs-2026-10-15-0002', OPAQUE_KEY, '2026-10-15', null, 0.4],
      ['mipe-obs-2026-10-15-0003', PUBLIC_KEY, '2026-10-15', CUI, null],
      ['mipe-obs-2026-10-15-0004', OPAQUE_KEY, '2026-10-15', null, 0.4],
    ]);

    // One aggregate statement over the fenced history view: the bound release,
    // current observations at the projects lane's source date (no prior
    // dates), canonical or not, unbounded, no whole-row JSON, the CUI mask.
    const reads = snapshotReads(statements);
    expect(reads).toEqual([observationStatement('$1', '$2')]);
    expect(parameters[statements.indexOf(reads[0] ?? '')]).toEqual([
      MIPE_RELEASE_ID,
      MIPE_SOURCE_AS_OF,
    ]);

    // Program: the release's own indicator row, never legacy facts.
    const indicatorReads = factReads(statements, 'api_release_progress_v1');
    expect(indicatorReads).toHaveLength(1);
    expect(parameters[statements.indexOf(indicatorReads[0] ?? '')]).toEqual([
      MIPE_RELEASE_ID,
      'mipe_indicators',
    ]);
    expect(legacyOrPrivateReads(statements)).toEqual([]);
  });

  it('answers over REST with one release check, no-store and the existing envelope', async () => {
    const { repo, statements } = scriptedRepo(ready);
    const direct = (await repo.getDashboardSnapshot())._unsafeUnwrap();
    if (direct.kind !== 'snapshot') throw new Error(`expected a snapshot, got ${direct.kind}`);
    const app = await restApp(repo);
    const before = statements.length;

    const response = await app.inject({
      method: 'GET',
      url: `${SNAPSHOT_URL}?assertReleaseId=${encodeURIComponent(MIPE_RELEASE_ID)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    // The snapshot holds only JSON values, so the decoded body equals it as is.
    expect(body).toEqual({ ok: true, data: direct.snapshot });
    expect(Object.keys(body.data)).toEqual(['release', 'program', 'observations']);
    // No ORDS payment or commitment section, nested or top level, and no
    // withheld identifier anywhere in the payload.
    expect(response.body).not.toMatch(/beneficiaryPayments|"commitments"|netRon/u);
    expect(response.body).not.toContain(PERSONAL_NUMBER);

    const during = statements.slice(before);
    expect(bindings(during)).toBe(1);
    expect(rechecks(during)).toBe(1);
  });

  it('excludes private identifiers and unprojected fields', async () => {
    const { repo, statements } = scriptedRepo(ready);
    const read = (await repo.getDashboardSnapshot())._unsafeUnwrap();
    if (read.kind !== 'snapshot') throw new Error(`expected a snapshot, got ${read.kind}`);
    expect(read.snapshot.observations.map((o) => o.beneficiaryCui)).toEqual([
      null,
      null,
      CUI,
      null,
    ]);
    const [statement = ''] = snapshotReads(statements);
    // No whole-row JSON, internal key, identity basis, subject or tax
    // identifier, uuid, endpoint or item key, and no legacy or private relation.
    for (const needle of [
      'to_jsonb',
      'project_key_version',
      'identity_basis',
      'subject_unique_identifier',
      'tax_identification_number',
      'public_key_uuid',
      'item_key',
      'endpoint_name',
      'retrieved_at',
    ]) {
      expect(statement).not.toContain(needle);
    }
    expect(legacyOrPrivateReads(statements)).toEqual([]);
  });

  it('pins observations to the bound projects lane date, not the release or a later date', async () => {
    const laneDate = '2026-11-15 00:00:00+00';
    const { repo, statements, parameters } = scriptedRepo({
      active: MIPE_ACTIVE,
      lanes: MIPE_LANES.map((lane) =>
        lane.lane === 'ords_payments_capture' ? lane : { ...lane, as_of: laneDate }
      ),
      releaseProgress: [OVERVIEW_ROW],
      snapshot: current,
    });
    expect((await repo.getDashboardSnapshot())._unsafeUnwrap().kind).toBe('snapshot');
    const [statement = ''] = snapshotReads(statements);
    expect(parameters[statements.indexOf(statement)]).toEqual([MIPE_RELEASE_ID, laneDate]);
  });

  it.each([
    ['a shifted cell array', [cells().slice(1)]],
    ['a non-text cell', [[...cells().slice(0, -1), 7]]],
    ['a missing project key', [cells({ projectKey: null })]],
    ['a non-array aggregate element', [{ projectKey: OPAQUE_KEY }]],
  ] as const)('fails closed on %s instead of serving it', async (_name, snapshot) => {
    const { repo } = scriptedRepo({ ...ready, snapshot });
    const result = await repo.getDashboardSnapshot();
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'Database',
      message: 'getDashboardSnapshot returned a malformed observation',
    });
    const app = await restApp(scriptedRepo({ ...ready, snapshot }).repo);
    const response = await app.inject({ method: 'GET', url: SNAPSHOT_URL });
    expect(response.statusCode).toBe(500);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports a different asserted release as a mismatch and reads no facts', async () => {
    const { repo, statements } = scriptedRepo(ready);
    const app = await restApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: `${SNAPSHOT_URL}?assertReleaseId=${encodeURIComponent(NEXT_RELEASE_ID)}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      ok: false,
      error: 'RELEASE_MISMATCH',
      message: 'PNRR release changed; restart the query.',
      expectedReleaseId: NEXT_RELEASE_ID,
      currentReleaseId: MIPE_RELEASE_ID,
    });
    expect(snapshotReads(statements)).toEqual([]);
    expect(factReads(statements, 'api_release_progress_v1')).toEqual([]);
  });

  const refusals: readonly (readonly [string, Script, string])[] = [
    [
      'an active legacy release',
      { ...LEGACY_SCRIPT, projects: [projectRow()], snapshot: current },
      'served only for an active scoped MIPE release',
    ],
    [
      'no active release',
      { promoted: LEGACY_PROMOTED, projects: [projectRow()], snapshot: current },
      'served only for an active scoped MIPE release',
    ],
    [
      'an incomplete scoped manifest',
      {
        active: MIPE_ACTIVE,
        lanes: MIPE_LANES.filter((lane) => lane.lane !== 'ords_payments_capture'),
        snapshot: current,
      },
      'PNRR serving release is unavailable.',
    ],
    [
      'an invalid ORDS receipt',
      {
        active: MIPE_ACTIVE,
        lanes: withLane('ords_payments_capture', { row_count: '12' }),
        snapshot: current,
      },
      'PNRR serving release is unavailable.',
    ],
  ];

  it.each(refusals)(
    'returns 503 with no legacy fallback under %s',
    async (_name, script, message) => {
      const { repo, statements } = scriptedRepo(script);
      const app = await restApp(repo);
      const response = await app.inject({ method: 'GET', url: SNAPSHOT_URL });
      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ ok: false, error: 'ServiceUnavailable' });
      expect(response.json().message).toContain(message);
      expect(snapshotReads(statements)).toEqual([]);
      expect(factReads(statements, 'api_release_progress_v1')).toEqual([]);
      expect(factReads(statements, 'api_projects_v1')).toEqual([]);
      expect(factReads(statements, 'api_progress_current')).toEqual([]);
    }
  );

  it('fails closed when the next release activates during the read', async () => {
    const { repo } = scriptedRepo({
      ...ready,
      flip: { on: 'is_current_observation', to: { active: NEXT_ACTIVE, lanes: MIPE_LANES } },
    });
    const app = await restApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: `${SNAPSHOT_URL}?assertReleaseId=${encodeURIComponent(MIPE_RELEASE_ID)}`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ServiceUnavailable',
      message: 'PNRR release changed during the read; restart the query.',
    });
  });
});
