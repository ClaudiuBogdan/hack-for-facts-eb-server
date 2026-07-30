/**
 * Parliament golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to the verified parliament serving anchors:
 *   - Legea nr. 423/2023 => legal act_id 145905, bill_key 12760,
 *     final adoption vote cdep:29892.
 *   - Gabriel Andronache 2020 Chamber mandate => 2:2020:12. (person_id is a LIVE
 *     serving surrogate — PARLIAMENT_CONTRACT §2 — NOT pinned; it is resolved
 *     dynamically from the member and reassigned by identity rebuilds.)
 *
 * Skips cleanly when PROD_DATABASE_URL is absent (CI without the prod tunnel).
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

import type { FastifyInstance } from 'fastify';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const PARL = '145905';
const BILL = '12760';
const VOTE = 'cdep:29892';
const MEMBER = '2:2020:12';
// NOTE: person_id is a serving surrogate only (PARLIAMENT_CONTRACT §2), NOT a stable
// cross-rebuild identity — it is resolved dynamically from the member, never pinned.
const ABRUDEAN = '1:2024:1'; // Mircea Abrudean — senate current, 2 committee seats (B2)

const d = HAS_DB ? describe : describe.skip;

let app: FastifyInstance;
let close: () => Promise<void>;
let pool: Pool;

/** Swallow ONLY the benign stateless-MCP transport teardown error (kernel race). */
const onUncaught = (err: unknown): void => {
  if (err instanceof Error && err.message.includes('destroySoon')) return;
  throw err;
};

interface GqlError {
  readonly message: string;
  readonly extensions?: {
    readonly code?: string;
    readonly type?: string;
  };
}

interface GqlResponse<TData> {
  readonly data?: TData;
  readonly errors?: readonly GqlError[];
}

interface JsonRpcToolResult {
  readonly structuredContent?: unknown;
  readonly content?: readonly { readonly text?: string }[];
}

interface JsonRpcResponse {
  readonly result?: JsonRpcToolResult;
}

interface ParliamentTally {
  readonly pentru: number | null;
  readonly impotriva: number | null;
  readonly abtinere: number | null;
  readonly nuAVotat: number | null;
  readonly present: number | null;
}

interface ParliamentLineageVote {
  readonly voteKey: string;
  readonly billKey: string | null;
  readonly chamber: string;
  readonly voteDate: string | null;
  readonly role: string;
  readonly outcome: string | null;
  readonly tally: ParliamentTally;
  readonly ballotsTotal: number | null;
  readonly ballotsResolved: number | null;
}

interface ParliamentActLineage {
  readonly actId: string;
  readonly bills: readonly { readonly billKey: string }[];
  readonly votes: readonly ParliamentLineageVote[];
  readonly caveats: readonly string[];
}

interface ParliamentResolveHit {
  readonly value: string;
  readonly label: string;
  readonly kind: string;
}

interface ParliamentGroupCohesion {
  readonly groupName: string;
  readonly cohesionIndex: number;
  readonly voteCount: number;
}

const gql = async <TData>(
  query: string,
  variables?: Record<string, unknown>
): Promise<GqlResponse<TData>> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  const body: GqlResponse<TData> = res.json();
  return body;
};

const mcpCall = async <TOutput>(name: string, args: Record<string, unknown>): Promise<TOutput> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body: JsonRpcResponse = res.json();
  if (body.result?.structuredContent !== undefined) return body.result.structuredContent as TOutput;
  const text = body.result?.content?.[0]?.text;
  // eslint-disable-next-line no-restricted-syntax -- test parses the trusted MCP tool-output text payload
  return (text !== undefined ? JSON.parse(text) : undefined) as TOutput;
};

const expectGqlData = <TData>(res: GqlResponse<TData>): TData => {
  expect(res.errors).toBeUndefined();
  expect(res.data).toBeDefined();
  return res.data as TData;
};

const requireValue = <T>(value: T | null | undefined, label: string): T => {
  expect(value).not.toBeNull();
  expect(value).toBeDefined();
  if (value === null || value === undefined) throw new Error(`expected ${label}`);
  return value;
};

d('Parliament golden (live prod)', () => {
  beforeAll(async () => {
    const built = await buildRedesignApp({
      kernelConfig: loadRedesignConfig(process.env).kernel,
      logLevel: 'silent',
      modules: ['legal', 'parliament'],
    });
    app = built.app;
    close = built.app.close.bind(built.app);
    await app.ready();
    // The prod URL carries sslmode=require; pg's default verifies the cert (the
    // tunnel presents a self-signed one). Encrypt without verifying, like the
    // kernel pool does.
    const connectionString = (process.env['PROD_DATABASE_URL'] ?? '').replace(
      /[?&]sslmode=[a-z-]+/iu,
      ''
    );
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
    // Kept in sync with the legal golden harness: swallow only the exact benign
    // post-response teardown race if it appears under MCP injection.
    process.on('uncaughtException', onUncaught);
  }, 60_000);

  afterAll(async () => {
    await close?.();
    await pool?.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('parliament table counts meet the live prod golden floor', async () => {
    const sqlRes = await pool.query<{ table_name: string; cnt: string }>(
      `select 'members' as table_name, count(*)::text as cnt from parliament.members
       union all select 'votes', count(*)::text from parliament.votes
       union all select 'vote_records', count(*)::text from parliament.vote_records
       union all select 'bills', count(*)::text from parliament.bills
       union all select 'persons', count(*)::text from parliament.persons
       union all select 'groups', count(*)::text from parliament.parliamentary_groups
       union all select 'control_items', count(*)::text from parliament.control_items`
    );
    const counts = new Map(sqlRes.rows.map((r) => [r.table_name, Number(r.cnt)]));
    expect(counts.get('members')).toBeGreaterThanOrEqual(5289);
    expect(counts.get('votes')).toBeGreaterThanOrEqual(20672);
    expect(counts.get('vote_records')).toBeGreaterThanOrEqual(4_156_243);
    expect(counts.get('bills')).toBeGreaterThanOrEqual(9935);
    expect(counts.get('persons')).toBeGreaterThanOrEqual(2988);
    // The group registry count follows live data (identity-v2 / finish-wave rebuilds
    // merge or retire historical groups) — assert a floor, not an exact pin.
    expect(counts.get('groups')).toBeGreaterThanOrEqual(72);
    expect(counts.get('control_items')).toBeGreaterThanOrEqual(81513);
  }, 30_000);

  it('Act lineage golden (GraphQL): Legea 423/2023 resolves to bill 12760 and final vote cdep:29892', async () => {
    const res = await gql<{ parliamentActLineage: ParliamentActLineage | null }>(
      `query($actId: ID!) {
        parliamentActLineage(actId:$actId, includeBallots:true) {
          actId
          bills { billKey }
          votes {
            voteKey
            billKey
            chamber
            voteDate
            role
            outcome
            tally { pentru impotriva abtinere nuAVotat present }
            ballotsTotal
            ballotsResolved
          }
          caveats
        }
      }`,
      { actId: PARL }
    );
    const data = expectGqlData(res);
    const lineage = requireValue(data.parliamentActLineage, 'parliamentActLineage');
    expect(lineage.actId).toBe(PARL);
    expect(lineage.bills.map((bill) => bill.billKey)).toContain(BILL);

    const finalVote = requireValue(
      lineage.votes.find((vote) => vote.voteKey === VOTE),
      'final adoption lineage vote'
    );
    expect(finalVote.role).toBe('final_adoption');
    expect(finalVote.chamber).toBe('camera_deputatilor');
    expect(finalVote.voteDate).toBe('2022-05-04');
    expect(finalVote.outcome).toBe('adoptat');
    expect(finalVote.tally.pentru).toBe(275);
    expect(finalVote.tally.abtinere).toBe(1);
    expect(finalVote.tally.nuAVotat).toBe(1);
    expect(finalVote.tally.present).toBe(277);
    expect(finalVote.ballotsTotal).toBe(277);
    expect(finalVote.ballotsResolved).toBe(277);
  });

  it('Bill dossier golden (GraphQL): bill 12760 links to legal act 145905 and final adoption vote', async () => {
    const res = await gql<{
      parliamentBill: {
        readonly billKey: string;
        readonly plxNumber: string | null;
        readonly plxYear: number | null;
        readonly title: string | null;
        readonly finalLawNumber: string | null;
        readonly finalLawYear: number | null;
        readonly statusText: string | null;
        readonly billType: string | null;
        readonly actLinks: readonly {
          readonly relationshipKind: string;
          readonly targetActId: string | null;
          readonly resolutionStatus: string;
          readonly confidenceLabel: string;
          readonly legalAct: {
            readonly actId: string;
            readonly title: string | null;
            readonly actType: string | null;
          } | null;
        }[];
        readonly voteLinks: readonly {
          readonly voteKey: string;
          readonly role: string;
          readonly resolutionStatus: string;
        }[];
        readonly relatedVotes: readonly { readonly voteKey: string }[];
        readonly events: readonly {
          readonly position: number;
          readonly description: string | null;
        }[];
      } | null;
    }>(
      `query($billKey: ID!) {
        parliamentBill(billKey:$billKey) {
          billKey
          plxNumber
          plxYear
          title
          finalLawNumber
          finalLawYear
          statusText
          billType
          actLinks {
            relationshipKind
            targetActId
            resolutionStatus
            confidenceLabel
            legalAct { actId title actType }
          }
          voteLinks { voteKey role resolutionStatus }
          relatedVotes { voteKey }
          events { position description }
        }
      }`,
      { billKey: BILL }
    );
    const data = expectGqlData(res);
    const bill = requireValue(data.parliamentBill, 'parliamentBill');
    expect(bill.billKey).toBe(BILL);
    expect(bill.title?.startsWith('Proiect de Lege pentru aprobarea Ordonan')).toBe(true);
    expect(bill.plxNumber).toBe('237');
    expect(bill.plxYear).toBe(2012);
    expect(bill.finalLawNumber).toBe('423');
    expect(bill.finalLawYear).toBe(2023);
    // Gap 2: source-stored classification, surfaced flat (was attrs-only / unreachable).
    // statusText is the RAW source status string; the finish-wave rebuild dropped the
    // trailing publication date (live is now 'Lege 423/2023'). Assert the stable law-id
    // prefix rather than the volatile full string.
    expect(bill.statusText?.startsWith('Lege 423/2023')).toBe(true);
    expect(bill.billType).toBe('Proiect de Lege pentru aprobarea O.U.G. nr. 21/2012');

    const firstActLink = requireValue(bill.actLinks[0], 'first act link');
    expect(firstActLink.relationshipKind).toBe('becomes_law');
    expect(firstActLink.resolutionStatus).toBe('linked');
    expect(firstActLink.targetActId).toBe(PARL);
    expect(firstActLink.legalAct).not.toBeNull();
    expect(firstActLink.legalAct?.actId).toBe(PARL);
    expect(firstActLink.legalAct?.title).toContain('423/2023');

    const finalVoteLink = requireValue(
      bill.voteLinks.find((link) => link.role === 'final_adoption'),
      'final adoption vote link'
    );
    expect(finalVoteLink.voteKey).toBe(VOTE);
    expect(finalVoteLink.resolutionStatus).toBe('linked');
    expect(bill.relatedVotes.map((vote) => vote.voteKey)).toContain(VOTE);
    expect(bill.events.length).toBeGreaterThan(0);
  });

  it('Vote golden (GraphQL): cdep:29892 exposes tally, group breakdown, and bounded ballots', async () => {
    const res = await gql<{
      parliamentVote: {
        readonly voteKey: string;
        readonly chamber: string;
        readonly voteDate: string | null;
        readonly outcome: string | null;
        readonly tally: ParliamentTally;
        readonly groupBreakdown: readonly {
          readonly groupName: string | null;
          readonly pentru: number;
        }[];
        readonly ballots: {
          readonly edges: readonly {
            readonly node: {
              readonly rowIndex: number;
              readonly choice: string | null;
              readonly mandateKey: string | null;
              readonly constituencyName: string | null;
            };
          }[];
        };
      } | null;
    }>(
      `query($voteKey: ID!) {
        parliamentVote(voteKey:$voteKey) {
          voteKey
          chamber
          voteDate
          outcome
          tally { pentru impotriva abtinere nuAVotat present }
          groupBreakdown { groupName pentru }
          ballots(first:500) { edges { node { rowIndex choice mandateKey constituencyName } } }
        }
      }`,
      { voteKey: VOTE }
    );
    const data = expectGqlData(res);
    const vote = requireValue(data.parliamentVote, 'parliamentVote');
    expect(vote.voteKey).toBe(VOTE);
    expect(vote.chamber).toBe('camera_deputatilor');
    expect(vote.voteDate).toBe('2022-05-04');
    expect(vote.outcome).toBe('adoptat');
    expect(vote.tally.pentru).toBe(275);
    expect(vote.tally.abtinere).toBe(1);
    expect(vote.tally.nuAVotat).toBe(1);
    expect(vote.tally.present).toBe(277);
    expect(vote.groupBreakdown.length).toBeGreaterThan(0);
    expect(vote.ballots.edges.length).toBeGreaterThan(0);
    expect(vote.ballots.edges.some((edge) => edge.node.mandateKey !== null)).toBe(true);

    // Gap 1: the resolved ballot carries the member's constituency (JOINed), so the
    // client's vote-detail "județ" column is populated in live mode. Andronache
    // (mandate 2:2020:12, row 0) voted in BRAȘOV.
    const andronache = requireValue(
      vote.ballots.edges.find((edge) => edge.node.mandateKey === MEMBER)?.node,
      'Andronache ballot'
    );
    expect(andronache.constituencyName).toBe('BRAŞOV');
    // Across the vote, 261/277 ballots resolve to a member with a constituency; the
    // measured 500-row page covers this full vote in one response.
    const resolvedWithConstituency = vote.ballots.edges.filter(
      (edge) => edge.node.mandateKey !== null && edge.node.constituencyName !== null
    );
    expect(resolvedWithConstituency).toHaveLength(261);
  });

  it('Member and person golden (GraphQL): Gabriel Andronache links mandate 2:2020:12 to person 2264', async () => {
    const memberRes = await gql<{
      parliamentMember: {
        readonly mandateKey: string;
        readonly chamber: string | null;
        readonly legislature: string | null;
        readonly fullName: string | null;
        readonly groupName: string | null;
        readonly birthDate: string | null;
        readonly constituencyName: string | null;
        readonly profileUrl: string | null;
        readonly person: {
          readonly personId: string;
          readonly canonicalName: string;
          readonly confidence: string;
          readonly careerTotals: {
            readonly mandates: number;
            readonly votes: number;
            readonly initiatives: number;
            readonly speeches: number;
          };
        } | null;
        readonly activityCounts: {
          readonly votes: number;
          readonly controlItems: number;
          readonly speeches: number;
          readonly initiatives: number;
          readonly declarations: number;
        };
        readonly votes: {
          readonly total: number;
          readonly edges: readonly {
            readonly node: {
              readonly voteKey: string;
              readonly choice: string | null;
              readonly voteDate: string | null;
            };
          }[];
        };
      } | null;
    }>(
      `query($mandateKey: ID!) {
        parliamentMember(mandateKey:$mandateKey) {
          mandateKey
          chamber
          legislature
          fullName
          groupName
          birthDate
          constituencyName
          profileUrl
          person {
            personId
            canonicalName
            confidence
            careerTotals { mandates votes initiatives speeches }
          }
          activityCounts { votes controlItems speeches initiatives declarations }
          votes(first:3) { total edges { node { voteKey choice voteDate } } }
        }
      }`,
      { mandateKey: MEMBER }
    );
    const memberData = expectGqlData(memberRes);
    const member = requireValue(memberData.parliamentMember, 'parliamentMember');
    expect(member.mandateKey).toBe(MEMBER);
    expect(member.fullName).toContain('Andronache');
    expect(member.legislature).toBe('2020');
    expect(member.chamber).toBe('camera_deputatilor');
    expect(member.constituencyName).toBe('BRAŞOV');
    // Gap 4: the public CDEP profile URL is surfaced flat (was attrs-only / unreachable).
    expect(member.profileUrl).toBe(
      'https://www.cdep.ro/ords/pls/parlam/structura2015.mp?idm=12&cam=2&leg=2020'
    );
    // PARLIAMENT_CONTRACT §2: person_id is a serving surrogate ONLY, not cross-rebuild
    // identity — the identity-v2 rebuild reassigned Andronache from 2264 (now gone) to
    // a new surrogate. Assert the STABLE facts (person present, canonical name) and
    // carry the LIVE surrogate forward for the round-trip query below; never pin it.
    const livePerson = requireValue(member.person, 'member.person');
    expect(livePerson.canonicalName).toContain('Andronache');
    const livePersonId = livePerson.personId;
    expect(member.votes.total).toBeGreaterThanOrEqual(6000);
    expect(member.votes.edges.length).toBeGreaterThan(0);
    expect(member.activityCounts.votes).toBeGreaterThanOrEqual(6000);

    const personRes = await gql<{
      parliamentPerson: {
        readonly personId: string;
        readonly canonicalName: string;
        readonly confidence: string;
        readonly careerTotals: {
          readonly mandates: number;
          readonly votes: number;
          readonly initiatives: number;
          readonly speeches: number;
        };
      } | null;
    }>(
      `query($personId: ID!) {
        parliamentPerson(personId:$personId) {
          personId
          canonicalName
          confidence
          careerTotals { mandates votes initiatives speeches }
        }
      }`,
      { personId: livePersonId }
    );
    const personData = expectGqlData(personRes);
    const person = requireValue(personData.parliamentPerson, 'parliamentPerson');
    // Round-trips the LIVE surrogate (not a pinned id — contract §2); the stable
    // identity assertion is the canonical name.
    expect(person.personId).toBe(livePersonId);
    expect(person.canonicalName).toContain('Andronache');
    expect(person.careerTotals.mandates).toBeGreaterThanOrEqual(1);
  });

  it('List and resolver surfaces return the expected live parliament slices', async () => {
    const members = expectGqlData(
      await gql<{
        parliamentMembers: {
          readonly members: readonly {
            readonly mandateKey: string;
            readonly fullName: string | null;
          }[];
          readonly total: number;
        };
      }>(
        `{
          parliamentMembers(filter:{legislature:{eq:"2024"}}, page:1, pageSize:5) {
            total
            members { mandateKey fullName }
          }
        }`
      )
    );
    expect(members.parliamentMembers.total).toBeGreaterThan(0);
    expect(members.parliamentMembers.members.length).toBeGreaterThan(0);

    const groups = expectGqlData(
      await gql<{
        parliamentGroups: readonly { readonly name: string; readonly memberCount: number | null }[];
      }>(
        `{
          parliamentGroups(legislature:"2024") { name memberCount }
        }`
      )
    );
    const psd = requireValue(
      groups.parliamentGroups.find(
        (group) => group.name === 'PSD' && (group.memberCount ?? 0) >= 100
      ),
      '2024 PSD group'
    );
    expect(psd.memberCount).toBeGreaterThanOrEqual(100);
    expect(groups.parliamentGroups.some((group) => group.name === 'AUR')).toBe(true);

    const bills = expectGqlData(
      await gql<{
        parliamentBills: {
          readonly bills: readonly { readonly billKey: string; readonly plxYear: number | null }[];
          readonly total: number;
        };
      }>(
        `{
          parliamentBills(filter:{year:{eq:2012}}, page:1, pageSize:3) {
            total
            bills { billKey plxYear }
          }
        }`
      )
    );
    expect(bills.parliamentBills.total).toBeGreaterThanOrEqual(1);
    expect(bills.parliamentBills.bills.length).toBeGreaterThan(0);

    const votes = expectGqlData(
      await gql<{
        parliamentVotes: {
          readonly edges: readonly { readonly node: { readonly voteKey: string } }[];
        };
      }>(
        `query($billKey: String!) {
          parliamentVotes(filter:{billKey:{eq:$billKey}}, first:10) {
            edges { node { voteKey } }
          }
        }`,
        { billKey: BILL }
      )
    );
    expect(votes.parliamentVotes.edges.map((edge) => edge.node.voteKey)).toContain(VOTE);

    const controls = expectGqlData(
      await gql<{
        parliamentControlItems: {
          readonly edges: readonly { readonly node: { readonly itemKey: string } }[];
        };
      }>(
        `{
          parliamentControlItems(filter:{itemDate:{between:{from:"2024-01-01", to:"2024-12-31"}}}, first:3) {
            edges { node { itemKey } }
          }
        }`
      )
    );
    expect(controls.parliamentControlItems.edges.length).toBeGreaterThan(0);

    const chamberResolve = expectGqlData(
      await gql<{ parliamentResolveFilter: readonly ParliamentResolveHit[] }>(
        `{
          parliamentResolveFilter(dim:chamber, q:"sen") { value label kind }
        }`
      )
    );
    expect(chamberResolve.parliamentResolveFilter.map((hit) => hit.value)).toContain('senat');

    const personResolve = expectGqlData(
      await gql<{ parliamentResolveFilter: readonly ParliamentResolveHit[] }>(
        `{
          parliamentResolveFilter(dim:person, q:"Andronache") { value label kind }
        }`
      )
    );
    expect(personResolve.parliamentResolveFilter.length).toBeGreaterThanOrEqual(1);
    // Match on the STABLE label (canonical name), not the volatile person_id surrogate
    // (contract §2 — reassigned by the identity-v2 rebuild).
    expect(
      personResolve.parliamentResolveFilter.some(
        (hit) => hit.kind === 'person' && hit.label.includes('Andronache')
      )
    ).toBe(true);

    const cohesion = expectGqlData(
      await gql<{ parliamentVoteCohesion: readonly ParliamentGroupCohesion[] }>(
        `query($billKey: ID!) {
          parliamentVoteCohesion(billKey:$billKey) { groupName cohesionIndex voteCount }
        }`,
        { billKey: BILL }
      )
    );
    expect(cohesion.parliamentVoteCohesion.length).toBeGreaterThan(0);
  }, 30_000);

  it('group roster resolves a PARTY-LEVEL groupId to its full cross-chamber set, and a per-chamber slug exactly', async () => {
    const roster = async (
      groupId: string
    ): Promise<readonly { readonly mandateKey: string; readonly chamber: string | null }[]> => {
      const data = expectGqlData(
        await gql<{
          parliamentGroupMembers: readonly {
            readonly mandateKey: string;
            readonly chamber: string | null;
          }[];
        }>(
          `query($groupId: ID!, $legislature: String) {
            parliamentGroupMembers(groupId:$groupId, legislature:$legislature) { mandateKey chamber }
          }`,
          { groupId, legislature: '2024' }
        )
      );
      return data.parliamentGroupMembers;
    };

    // The whole-parliament groups list hands the client a party-level id (= group_name).
    // It MUST resolve to the full cross-chamber roster (the defect: it returned 0).
    const aur = await roster('AUR');
    expect(aur.length).toBe(91);
    expect(aur.filter((m) => m.chamber === 'camera_deputatilor').length).toBe(63);
    expect(aur.filter((m) => m.chamber === 'senat').length).toBe(28);

    // Regression: a per-chamber group_id slug still resolves EXACTLY (one chamber).
    const aurSenat = await roster('aur-senat');
    expect(aurSenat.length).toBe(28);
    expect(aurSenat.every((m) => m.chamber === 'senat')).toBe(true);

    // The party-level rosters partition the legislature: every 2024 member belongs to
    // exactly one party, so the per-party roster sizes sum to the chamber totals.
    const groups = expectGqlData(
      await gql<{
        parliamentGroups: readonly { readonly groupId: string; readonly chamber: string }[];
      }>(`{ parliamentGroups(legislature:"2024") { groupId chamber } }`)
    );
    // Whole-parliament list → party-level rows (chamber === "").
    const partyIds = groups.parliamentGroups.filter((g) => g.chamber === '').map((g) => g.groupId);
    expect(partyIds.length).toBeGreaterThan(0);
    const rosters = await Promise.all(partyIds.map((id) => roster(id)));
    const all = rosters.flat();
    expect(all.length).toBe(472);
    expect(all.filter((m) => m.chamber === 'camera_deputatilor').length).toBe(335);
    expect(all.filter((m) => m.chamber === 'senat').length).toBe(137);
    // No member is double-counted (mandate_key is unique across the party rosters).
    expect(new Set(all.map((m) => m.mandateKey)).size).toBe(472);
  }, 30_000);

  it('SC-1 is_current scopes composition/rosters but NEVER vote attribution', async () => {
    const SUPERSEDED = '2:2024:146'; // Ibram Iusein — deces 2025-01-27, keeps 12 ballots

    // (a) parliamentMembers current filter → per-chamber CURRENT seat counts (330/134/464).
    const memberTotal = async (filter: string): Promise<number> => {
      const data = expectGqlData(
        await gql<{ parliamentMembers: { readonly total: number } }>(
          `{ parliamentMembers(filter:${filter}, page:1, pageSize:1) { total } }`
        )
      );
      return data.parliamentMembers.total;
    };
    expect(
      await memberTotal(
        '{legislature:{eq:"2024"}, chamber:{eq:"camera_deputatilor"}, current:{eq:true}}'
      )
    ).toBe(330);
    expect(
      await memberTotal('{legislature:{eq:"2024"}, chamber:{eq:"senat"}, current:{eq:true}}')
    ).toBe(134);
    expect(await memberTotal('{legislature:{eq:"2024"}, current:{eq:true}}')).toBe(464);
    // all-mandate counts UNCHANGED when current is omitted.
    expect(await memberTotal('{legislature:{eq:"2024"}}')).toBe(472);

    // (b) current-only group roster: AUR current 90 (62 camera + 28 senat) vs all 91.
    const roster = async (
      current: boolean
    ): Promise<readonly { readonly chamber: string | null; readonly isCurrent: boolean }[]> => {
      const data = expectGqlData(
        await gql<{
          parliamentGroupMembers: readonly {
            readonly chamber: string | null;
            readonly isCurrent: boolean;
          }[];
        }>(
          `query($c: Boolean) {
            parliamentGroupMembers(groupId:"AUR", legislature:"2024", current:$c) { chamber isCurrent }
          }`,
          { c: current }
        )
      );
      return data.parliamentGroupMembers;
    };
    const aurCurrent = await roster(true);
    expect(aurCurrent.length).toBe(90);
    expect(aurCurrent.filter((m) => m.chamber === 'camera_deputatilor').length).toBe(62);
    expect(aurCurrent.filter((m) => m.chamber === 'senat').length).toBe(28);
    expect(aurCurrent.every((m) => m.isCurrent)).toBe(true);
    expect((await roster(false)).length).toBe(91); // all-mandate roster UNCHANGED

    // (c) composition counts: parliamentGroups current:true → AUR current 90; default 91.
    const aurCount = async (current: boolean): Promise<number> => {
      const data = expectGqlData(
        await gql<{
          parliamentGroups: readonly {
            readonly name: string;
            readonly memberCount: number | null;
          }[];
        }>(
          `query($c: Boolean) { parliamentGroups(legislature:"2024", current:$c) { name memberCount } }`,
          { c: current }
        )
      );
      return data.parliamentGroups.find((g) => g.name === 'AUR')?.memberCount ?? -1;
    };
    expect(await aurCount(true)).toBe(90);
    expect(await aurCount(false)).toBe(91);

    // (d) CRITICAL INVARIANT: a superseded member is isCurrent=false on the member,
    // but attribution (member detail + voting history) is UNAFFECTED — Ibram keeps
    // his 12 ballots. is_current must NEVER reach the vote_records path.
    const member = expectGqlData(
      await gql<{
        parliamentMember: {
          readonly mandateKey: string;
          readonly isCurrent: boolean;
          readonly mandateEndDate: string | null;
          readonly mandateEndReason: string | null;
          readonly activityCounts: { readonly votes: number };
          readonly votes: { readonly total: number };
        } | null;
      }>(
        `query($mk: ID!) {
          parliamentMember(mandateKey:$mk) {
            mandateKey isCurrent mandateEndDate mandateEndReason
            activityCounts { votes }
            votes(first:1) { total }
          }
        }`,
        { mk: SUPERSEDED }
      )
    );
    const m = requireValue(member.parliamentMember, 'superseded member');
    expect(m.isCurrent).toBe(false);
    expect(m.mandateEndDate).toBe('2025-01-27');
    expect(m.mandateEndReason).toBe('deces');
    // Attribution intact: both the activity count and the member-votes connection
    // total still report all 12 ballots — is_current did NOT filter them out.
    expect(m.activityCounts.votes).toBe(12);
    expect(m.votes.total).toBe(12);

    // (e) the superseded member is EXCLUDED from the current roster but PRESENT in
    // the all-mandate roster (same group, Minoritati) — composition vs attribution.
    const minoritatiAll = expectGqlData(
      await gql<{ parliamentGroupMembers: readonly { readonly mandateKey: string }[] }>(
        `{ parliamentGroupMembers(groupId:"Minoritati", legislature:"2024") { mandateKey } }`
      )
    );
    const minoritatiCurrent = expectGqlData(
      await gql<{ parliamentGroupMembers: readonly { readonly mandateKey: string }[] }>(
        `{ parliamentGroupMembers(groupId:"Minoritati", legislature:"2024", current:true) { mandateKey } }`
      )
    );
    expect(minoritatiAll.parliamentGroupMembers.some((x) => x.mandateKey === SUPERSEDED)).toBe(
      true
    );
    expect(minoritatiCurrent.parliamentGroupMembers.some((x) => x.mandateKey === SUPERSEDED)).toBe(
      false
    );

    // (f) Codex BLOCKER guard: bill initiators are typed ParliamentMember (isCurrent
    // is Boolean!), so the lean initiator projection MUST carry isCurrent or the
    // non-null field null-propagates. Bill 14873 has 224 initiators, all from the
    // 2012 legislature (isCurrent=false). They are ALL returned (attribution is
    // NEVER filtered by is_current) and isCurrent resolves cleanly to false.
    const dossier = expectGqlData(
      await gql<{
        parliamentBill: {
          readonly initiators: readonly {
            readonly mandateKey: string;
            readonly isCurrent: boolean;
            readonly mandateEndReason: string | null;
          }[];
        } | null;
      }>(
        `{ parliamentBill(billKey:"14873") { initiators { mandateKey isCurrent mandateEndReason } } }`
      )
    );
    const initiators = requireValue(dossier.parliamentBill, 'bill 14873').initiators;
    expect(initiators.length).toBeGreaterThan(0);
    expect(initiators.every((i) => !i.isCurrent)).toBe(true); // 2012 cohort, all superseded
  }, 30_000);

  it('bill billType + status filters return the live prod classification slices', async () => {
    // The default bill list is CANONICAL-only (contract §3), ~22.9k rows live — still
    // past the 10k list cap, so per-bucket totals are CAPPED + estimated. Assert the
    // filter LOGIC — floors, structural relations, and the stable edge cases — not the
    // volatile exact counts that drift with every daily load. (billType buckets are
    // unchanged by canonicalization; status buckets ~halved — the navetă twins were
    // promulgated/rejected duplicates — so the floors below stay conservative.)
    const bills = async (filter: string): Promise<number> => {
      const data = expectGqlData(
        await gql<{ parliamentBills: { readonly total: number } }>(
          `{ parliamentBills(filter:${filter}, page:1, pageSize:1) { total } }`
        )
      );
      return data.parliamentBills.total;
    };
    const billsMeta = async (filter: string): Promise<{ total: number; estimated: boolean }> => {
      const data = expectGqlData(
        await gql<{
          parliamentBills: { readonly total: number; readonly totalEstimated: boolean };
        }>(`{ parliamentBills(filter:${filter}, page:1, pageSize:1) { total totalEstimated } }`)
      );
      return { total: data.parliamentBills.total, estimated: data.parliamentBills.totalEstimated };
    };

    // billType (initiative-kind badge), prefix on procedure.tip_initiativa. The kernel
    // renders enum filter fields as GraphQL String (literal-union validated server-side).
    const government = await bills('{billType:{eq:"government"}}');
    const parliamentary = await bills('{billType:{eq:"parliamentary"}}');
    const union = await bills('{billType:{in:["government","parliamentary"]}}');
    expect(government).toBeGreaterThanOrEqual(5000);
    expect(parliamentary).toBeGreaterThanOrEqual(3000);
    // in:[both] is the OR union → at least as large as either part.
    expect(union).toBeGreaterThanOrEqual(government);
    expect(union).toBeGreaterThanOrEqual(parliamentary);

    // status buckets on status_text (promulgated unions both became-law phrasings).
    const promulgated = await bills('{status:{eq:"promulgated"}}');
    const rejected = await bills('{status:{eq:"rejected"}}');
    const inProgress = await bills('{status:{eq:"in_progress"}}');
    expect(promulgated).toBeGreaterThanOrEqual(4000);
    expect(rejected).toBeGreaterThanOrEqual(1900);
    expect(inProgress).toBeGreaterThanOrEqual(3000);

    // Combined filters AND together (government bills that became law) → a subset of each.
    const govPromulgated = await bills('{billType:{eq:"government"}, status:{eq:"promulgated"}}');
    expect(govPromulgated).toBeGreaterThanOrEqual(3000);
    expect(govPromulgated).toBeLessThanOrEqual(government);
    expect(govPromulgated).toBeLessThanOrEqual(promulgated);

    // An unknown enum value is a clean InvalidInput (repo enumSelection guard) —
    // NOT a silent empty result. (The kernel renders these virtual enums as String
    // and skips virtual fields, so the repo owns the domain check.)
    const bad = await gql<{ parliamentBills: unknown }>(
      `{ parliamentBills(filter:{status:{eq:"enacted"}}, page:1, pageSize:1) { total } }`
    );
    expect(bad.errors).toBeDefined();
    expect(bad.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');

    // Edge cases (stable regardless of corpus size):
    // (a) explicit empty in:[] is "match nothing" (#60h), NOT "match all".
    const base = await bills('{}');
    expect(base).toBeGreaterThan(0);
    expect(await bills('{billType:{in:[]}}')).toBe(0);
    expect(await bills('{status:{in:[]}}')).toBe(0);
    expect(await bills('{billType:{eq:"government",in:[]}}')).toBe(0);
    expect(await bills('{billType:{eq:"government",in:["parliamentary"]}}')).toBe(0);
    expect(await bills('{status:{eq:"promulgated",in:["rejected"]}}')).toBe(0);
    // (b) explicit null on a virtual field is treated as ABSENT (same result as base).
    expect(await bills('{status:null}')).toBe(base);
    expect(await bills('{billType:null, status:null}')).toBe(base);

    // DISCRIMINATING (a filter-IGNORING regression must FAIL): the unfiltered base is
    // capped + estimated (~22.9k > 10k), but each of these buckets is UNDER the cap, so
    // a real filter returns an EXACT (non-estimated) count strictly smaller than the base.
    // If billType/status were ignored, every bucket would collapse to the capped base —
    // estimated=true and total===base — and every assertion below would fail.
    const baseMeta = await billsMeta('{}');
    expect(baseMeta.estimated).toBe(true);
    for (const filter of [
      '{status:{eq:"rejected"}}',
      '{status:{eq:"in_progress"}}',
      '{billType:{eq:"parliamentary"}}',
    ]) {
      const bucket = await billsMeta(filter);
      expect(bucket.estimated).toBe(false); // an EXACT count → a genuine filtered subset
      expect(bucket.total).toBeLessThan(baseMeta.total); // strictly smaller than the capped base
    }
    // Strict cross-bucket ordering: rejected (exact ~6.4k) < promulgated (larger became-law
    // bucket). A status-ignoring repo returns base for both → equal → this fails.
    expect(await bills('{status:{eq:"rejected"}}')).toBeLessThan(
      await bills('{status:{eq:"promulgated"}}')
    );
  }, 30_000);

  it('§3 canonicality: the default list is canonical-only; a non-canonical deep link still resolves with a redirect key', async () => {
    // A suppressed Senate navetă twin (source-owned key, stable) resolves via
    // parliamentBill (deep link — findBill is unfiltered) but is EXCLUDED from the
    // default parliamentBills list. It carries the canonical CDep key to redirect to.
    const twin = expectGqlData(
      await gql<{
        parliamentBill: {
          readonly billKey: string;
          readonly isCanonical: boolean;
          readonly canonicalBillKey: string | null;
        } | null;
      }>(`{ parliamentBill(billKey:"senat:1-1998") { billKey isCanonical canonicalBillKey } }`)
    );
    const t = requireValue(twin.parliamentBill, 'non-canonical twin senat:1-1998');
    expect(t.isCanonical).toBe(false);
    const canonicalKey = requireValue(t.canonicalBillKey, 'twin canonicalBillKey');

    // The canonical target resolves and IS canonical.
    const canon = expectGqlData(
      await gql<{ parliamentBill: { readonly isCanonical: boolean } | null }>(
        `query($k: ID!){ parliamentBill(billKey:$k){ isCanonical } }`,
        { k: canonicalKey }
      )
    );
    expect(requireValue(canon.parliamentBill, 'canonical target').isCanonical).toBe(true);

    // The default list NEVER surfaces a non-canonical row (contract §3): every row on a
    // page is canonical, and a canonical anchor (12760) is listable.
    const page = expectGqlData(
      await gql<{
        parliamentBills: {
          readonly bills: readonly { readonly billKey: string; readonly isCanonical: boolean }[];
          readonly total: number;
        };
      }>(`{ parliamentBills(page:1, pageSize:50) { total bills { billKey isCanonical } } }`)
    );
    expect(page.parliamentBills.bills.length).toBeGreaterThan(0);
    expect(page.parliamentBills.bills.every((b) => b.isCanonical)).toBe(true);
  }, 30_000);

  it('member initiatives are ordered newest-registration-first (sort bug fix)', async () => {
    // Bug: ORDER BY initiative_key ASC surfaced NULL-date legacy items (initiative:100…)
    // on page 1 and buried a member's recent initiatives. Fixed to registration date
    // DESC NULLS LAST. Member 2:2024:235 has all-2026 initiatives.
    const data = expectGqlData(
      await gql<{
        parliamentMember: {
          readonly initiatives: {
            readonly total: number;
            readonly initiatives: readonly {
              readonly initiativeKey: string;
              readonly registrationDate: string | null;
            }[];
          };
        } | null;
      }>(
        `{
          parliamentMember(mandateKey:"2:2024:235") {
            initiatives(page:1, pageSize:10) {
              total
              initiatives { initiativeKey registrationDate }
            }
          }
        }`
      )
    );
    const page = requireValue(data.parliamentMember, '2:2024:235').initiatives;
    expect(page.total).toBeGreaterThan(50);
    const items = page.initiatives;
    expect(items.length).toBe(10);
    // Page 1 is NOT the legacy initiative:100–109 block (the bug); it is recent items.
    expect(items.every((i) => !/:initiative:10[0-9]$/u.test(i.initiativeKey))).toBe(true);
    // Page 1 carries a registration date and is monotonically DESC (newest first).
    expect(items.every((i) => i.registrationDate !== null)).toBe(true);
    const dates = items.map((i) => i.registrationDate ?? '');
    expect([...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))).toEqual(dates);
    // The newest item is a 2026 registration (this member's real recent work).
    expect(items[0]?.registrationDate?.startsWith('2026-')).toBe(true);
  }, 30_000);

  it('bills default sort exposes lastEventDate, descending (display fix)', async () => {
    const data = expectGqlData(
      await gql<{
        parliamentBills: {
          readonly bills: readonly {
            readonly billKey: string;
            readonly lastEventDate: string | null;
          }[];
        };
      }>(`{ parliamentBills(page:1, pageSize:10) { bills { billKey lastEventDate } } }`)
    );
    const bills = data.parliamentBills.bills;
    expect(bills.length).toBe(10);
    // Default sort is updated_desc (last_event_date DESC NULLS LAST): the top page is
    // fully populated and monotonically descending, and the newest is recent (2026).
    expect(bills.every((b) => b.lastEventDate !== null)).toBe(true);
    const dates = bills.map((b) => b.lastEventDate ?? '');
    expect([...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))).toEqual(dates);
    expect(bills[0]?.lastEventDate?.startsWith('2026-')).toBe(true);
  }, 30_000);

  it('person-candidates data-quality surface is API-key gated by default', async () => {
    const res = await gql<{ parliamentPersonCandidates: unknown }>(
      `{
        parliamentPersonCandidates(status:"pending", page:1, pageSize:1) {
          total
          candidates { mandateKey personId status }
        }
      }`
    );
    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toContain('data-quality requires an API key');
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('GraphQL and MCP agree on lineage, filter resolution, member activity, and vote cohesion', async () => {
    const graphLineage = expectGqlData(
      await gql<{ parliamentActLineage: ParliamentActLineage | null }>(
        `query($actId: ID!) {
          parliamentActLineage(actId:$actId, includeBallots:true) {
            actId
            bills { billKey }
            votes {
              voteKey
              billKey
              chamber
              voteDate
              role
              outcome
              tally { pentru impotriva abtinere nuAVotat present }
              ballotsTotal
              ballotsResolved
            }
            caveats
          }
        }`,
        { actId: PARL }
      )
    );
    const graphLineageItem = requireValue(graphLineage.parliamentActLineage, 'GraphQL lineage');
    const graphVote = requireValue(
      graphLineageItem.votes.find((vote) => vote.voteKey === VOTE),
      'GraphQL lineage vote'
    );

    const mcpLineage = await mcpCall<{ ok: boolean; item: ParliamentActLineage }>(
      'get_parliament_law_lineage',
      {
        actId: PARL,
        includeBallots: true,
      }
    );
    const mcpVote = requireValue(
      mcpLineage.item.votes.find((vote) => vote.voteKey === VOTE),
      'MCP lineage vote'
    );
    expect(mcpLineage.ok).toBe(true);
    expect(mcpLineage.item.actId).toBe(graphLineageItem.actId);
    expect(mcpLineage.item.bills.map((bill) => bill.billKey)).toContain(BILL);
    expect(mcpVote.ballotsResolved).toBe(277);
    expect(mcpVote.ballotsResolved).toBe(graphVote.ballotsResolved);
    expect(mcpVote.ballotsTotal).toBe(graphVote.ballotsTotal);
    expect(mcpVote.tally.pentru).toBe(graphVote.tally.pentru);

    const graphResolve = expectGqlData(
      await gql<{ parliamentResolveFilter: readonly ParliamentResolveHit[] }>(
        `{
          parliamentResolveFilter(dim:chamber, q:"sen") { value label kind }
        }`
      )
    );
    const mcpResolve = await mcpCall<{ ok: boolean; items: readonly ParliamentResolveHit[] }>(
      'resolve_parliament_filters',
      { dim: 'chamber', q: 'sen' }
    );
    expect(mcpResolve.ok).toBe(true);
    expect(graphResolve.parliamentResolveFilter.map((hit) => hit.value)).toContain('senat');
    expect(mcpResolve.items.map((hit) => hit.value)).toContain('senat');

    const mcpActivity = await mcpCall<{
      ok: boolean;
      item: {
        readonly member: { readonly fullName: string | null; readonly mandateKey: string } | null;
      };
    }>('get_parliament_member_activity', { mandateKey: MEMBER });
    expect(mcpActivity.ok).toBe(true);
    expect(mcpActivity.item.member?.mandateKey).toBe(MEMBER);
    expect(mcpActivity.item.member?.fullName).toContain('Andronache');

    const graphCohesion = expectGqlData(
      await gql<{ parliamentVoteCohesion: readonly ParliamentGroupCohesion[] }>(
        `query($billKey: ID!) {
          parliamentVoteCohesion(billKey:$billKey) { groupName cohesionIndex voteCount }
        }`,
        { billKey: BILL }
      )
    );
    const mcpCohesion = await mcpCall<{ ok: boolean; items: readonly ParliamentGroupCohesion[] }>(
      'rank_parliament_vote_cohesion',
      { billKey: BILL }
    );
    expect(mcpCohesion.ok).toBe(true);
    expect(mcpCohesion.items.length).toBeGreaterThan(0);
    expect(graphCohesion.parliamentVoteCohesion.length).toBeGreaterThan(0);
    expect(mcpCohesion.items.map((item) => item.groupName)).toEqual(
      expect.arrayContaining(graphCohesion.parliamentVoteCohesion.map((item) => item.groupName))
    );
  }, 30_000);

  it('vote_records are exposed only through parented ballot reads', async () => {
    const bounded = expectGqlData(
      await gql<{
        parliamentVote: {
          readonly ballots: {
            readonly edges: readonly { readonly node: { readonly rowIndex: number } }[];
          };
        } | null;
      }>(
        `query($voteKey: ID!) {
          parliamentVote(voteKey:$voteKey) {
            ballots(first:3) { edges { node { rowIndex } } }
          }
        }`,
        { voteKey: VOTE }
      )
    );
    const vote = requireValue(bounded.parliamentVote, 'parliamentVote');
    expect(vote.ballots.edges.length).toBeLessThanOrEqual(3);
    expect(vote.ballots.edges.length).toBeGreaterThan(0);

    const introspection = expectGqlData(
      await gql<{
        schema: {
          readonly queryType: { readonly fields: readonly { readonly name: string }[] } | null;
        };
      }>(
        `{
          schema: __schema { queryType { fields { name } } }
        }`
      )
    );
    const rootFields = introspection.schema.queryType?.fields.map((field) => field.name) ?? [];
    expect(rootFields).not.toContain('parliamentBallots');
    expect(rootFields).not.toContain('parliamentVoteRecords');
    expect(rootFields.filter((field) => field.toLowerCase().includes('ballot'))).toEqual([]);
  });

  // ── QA-audit regression (2026-06-20): group-namespace + lineage fixes ──────────
  // The audit found these resolvers had ZERO coverage; the nullable SDL let H1 ship
  // silently. These lock the party-NAME ↔ chamber-SLUG reconciliation + the H13 fix.

  it('H1a/H1b: member.group and groupIntervals[].group resolve (party-NAME vs chamber-SLUG reconciled)', async () => {
    const data = expectGqlData(
      await gql<{
        parliamentMember: {
          readonly group: {
            readonly groupId: string;
            readonly name: string;
            readonly chamber: string;
          } | null;
          readonly groupIntervals: readonly {
            readonly groupId: string;
            readonly group: { readonly groupId: string; readonly name: string } | null;
          }[];
        } | null;
      }>(
        `query($k: ID!) {
          parliamentMember(mandateKey:$k) {
            group { groupId name chamber }
            groupIntervals { groupId group { groupId name } }
          }
        }`,
        { k: MEMBER }
      )
    );
    const member = requireValue(data.parliamentMember, 'parliamentMember');
    // H1a: the member's own group resolves (was null for 100% of members).
    const group = requireValue(member.group, 'member.group');
    expect(group.name.length).toBeGreaterThan(0);
    expect(group.chamber.length).toBeGreaterThan(0);
    // The resolved groupId is a chamber SLUG, and it is one of the member's interval slugs.
    expect(member.groupIntervals.map((i) => i.groupId)).toContain(group.groupId);
    // H1b: every interval's group resolves via the parliamentary_groups registry.
    expect(member.groupIntervals.length).toBeGreaterThan(0);
    expect(member.groupIntervals.every((i) => i.group !== null)).toBe(true);
  });

  it('H6/H7: the group filter round-trips a chamber slug; an explicit empty in:[] matches nothing', async () => {
    const member = expectGqlData(
      await gql<{
        parliamentMember: {
          readonly groupIntervals: readonly { readonly groupId: string }[];
        } | null;
      }>(`query($k: ID!){ parliamentMember(mandateKey:$k){ groupIntervals { groupId } } }`, {
        k: MEMBER,
      })
    );
    const slug = requireValue(
      member.parliamentMember?.groupIntervals[0]?.groupId,
      'an interval groupId'
    );
    const data = expectGqlData(
      await gql<{
        bySlug: { readonly total: number };
        emptyGroup: { readonly total: number };
        emptyJudet: { readonly total: number };
        base: { readonly total: number };
      }>(
        `query($slug: String!) {
          bySlug: parliamentMembers(pageSize:1, filter:{ group:{ eq:$slug } }) { total }
          emptyGroup: parliamentMembers(pageSize:1, filter:{ group:{ in:[] } }) { total }
          emptyJudet: parliamentMembers(pageSize:1, filter:{ judet:{ in:[] } }) { total }
          base: parliamentMembers(pageSize:1) { total }
        }`,
        { slug }
      )
    );
    expect(data.bySlug.total).toBeGreaterThan(0); // H6: the slug form now matches
    expect(data.emptyGroup.total).toBe(0); // H7: empty in:[] is match-nothing, not match-all
    expect(data.emptyJudet.total).toBe(0);
    expect(data.base.total).toBeGreaterThan(0);
  });

  it('H9: parliamentGroupMembers returns the full cross-chamber roster (no 1000-row cap)', async () => {
    const data = expectGqlData(
      await gql<{ parliamentGroupMembers: readonly { readonly mandateKey: string }[] }>(
        `{ parliamentGroupMembers(groupId:"PSD") { mandateKey } }`
      )
    );
    // PSD spans both chambers across all legislatures (≈1,336) — the old cap silently cut it to 1000.
    expect(data.parliamentGroupMembers.length).toBeGreaterThan(1000);
  });

  it('H10: bill initiators expose the FULL member shape (legislature/normalizedName were null)', async () => {
    const list = expectGqlData(
      await gql<{ parliamentBills: { readonly bills: readonly { readonly billKey: string }[] } }>(
        `{ parliamentBills(filter:{ billType:{ eq:"parliamentary" } }, pageSize:25) { bills { billKey } } }`
      )
    );
    let initiators:
      | readonly { readonly legislature: string | null; readonly normalizedName: string | null }[]
      | null = null;
    for (const bill of list.parliamentBills.bills) {
      const dossier = expectGqlData(
        await gql<{
          parliamentBill: {
            readonly initiators: readonly {
              readonly legislature: string | null;
              readonly normalizedName: string | null;
            }[];
          } | null;
        }>(
          `query($k: ID!){ parliamentBill(billKey:$k){ initiators { mandateKey legislature normalizedName constituencyName birthDate } } }`,
          { k: bill.billKey }
        )
      );
      const found = dossier.parliamentBill?.initiators ?? [];
      if (found.length > 0) {
        initiators = found;
        break;
      }
    }
    const resolved = requireValue(initiators, 'a bill with at least one initiator');
    // The bug: these were null for 49/49 initiators (reduced projection). Now populated.
    expect(resolved.some((i) => i.legislature !== null)).toBe(true);
    expect(resolved.some((i) => i.normalizedName !== null)).toBe(true);
  });

  it('H13: lineage reports each senat vote with its OWN billKey, not the CDEP twin', async () => {
    const data = expectGqlData(
      await gql<{
        parliamentActLineage: { readonly votes: readonly ParliamentLineageVote[] } | null;
      }>(`{ parliamentActLineage(actId:"101942") { votes { voteKey billKey chamber } } }`)
    );
    const senatVotes = (data.parliamentActLineage?.votes ?? []).filter(
      (v) => v.chamber === 'senat'
    );
    expect(senatVotes.length).toBeGreaterThan(0);
    // Before the fix these returned the CDEP bvl bill key (e.g. "17335"); now each is the
    // vote's own bill key (or null), never a foreign cdep key.
    expect(senatVotes.every((v) => v.billKey === null || v.billKey.startsWith('senat:'))).toBe(
      true
    );
  });

  it('H2: a guard error on a nullable root field isolates (the sibling query survives)', async () => {
    // A malformed cursor makes parliamentVotes throw; because the field is now nullable
    // the error stays on that field instead of nullifying the whole Query.
    const res = await gql<{ bad: unknown; ok: { readonly total: number } | null }>(
      `{ bad: parliamentVotes(after:"NOT_A_CURSOR") { edges { cursor } } ok: parliamentBills(pageSize:1) { total } }`
    );
    expect(res.errors?.length).toBeGreaterThan(0); // the error is still reported…
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
    expect(res.data?.bad).toBeNull(); // …isolated to the offending field…
    expect(res.data?.ok?.total).toBeGreaterThan(0); // …and the sibling survives.
  });

  it('M16: ballots connection exposes the EXACT total count', async () => {
    const data = expectGqlData(
      await gql<{
        parliamentVote: {
          readonly ballots: { readonly total: number; readonly edges: readonly unknown[] };
        } | null;
      }>(
        `query($k: ID!){ parliamentVote(voteKey:$k){ ballots(first:2){ total edges { node { rowIndex } } } } }`,
        { k: VOTE }
      )
    );
    const ballots = requireValue(data.parliamentVote?.ballots, 'ballots');
    expect(ballots.total).toBeGreaterThan(ballots.edges.length); // total is the full set, not the page
  });

  it('M12/M13: cohesion percentages sum to 100.00 and cohesionIndex is null for no-decided-vote groups', async () => {
    const data = expectGqlData(
      await gql<{
        parliamentVoteCohesion:
          | readonly {
              readonly forPct: number;
              readonly againstPct: number;
              readonly abstainPct: number;
              readonly absentPct: number;
              readonly cohesionIndex: number | null;
            }[]
          | null;
      }>(
        // bill 22086: AUR cast a single all-abstain vote → undefined Rice (null, not 0).
        `{ parliamentVoteCohesion(billKey:"22086"){ forPct againstPct abstainPct absentPct cohesionIndex } }`
      )
    );
    const rows = requireValue(data.parliamentVoteCohesion, 'cohesion rows');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // M12: largest-remainder keeps the sum at exactly 100.00 (no 99.99/100.01 drift).
      expect(Math.round((r.forPct + r.againstPct + r.abstainPct + r.absentPct) * 100) / 100).toBe(
        100
      );
    }
    // M13: at least one group has no decided votes here → null cohesionIndex (never a 0).
    expect(rows.some((r) => r.cohesionIndex === null)).toBe(true);
  });

  it('M14: ParliamentBill.relatedVotes is deprecated (use voteLinks)', async () => {
    const data = expectGqlData(
      await gql<{
        // eslint-disable-next-line @typescript-eslint/naming-convention -- `__type` is the GraphQL introspection root field.
        __type: {
          readonly fields: readonly { readonly name: string; readonly isDeprecated: boolean }[];
        } | null;
      }>(`{ __type(name:"ParliamentBill"){ fields(includeDeprecated:true){ name isDeprecated } } }`)
    );
    const field = data.__type?.fields.find((f) => f.name === 'relatedVotes');
    expect(field?.isDeprecated).toBe(true);
  });

  it('H14/M15: lineage defaults to final votes, caveats report omitted non-default votes, roles:["all"] widens', async () => {
    // act 133626 (← bill 20229) has 2 final_adoption + 38 amendment + 3 procedural linked votes.
    const def = expectGqlData(
      await gql<{
        parliamentActLineage: {
          readonly votes: readonly ParliamentLineageVote[];
          readonly caveats: readonly string[];
        } | null;
      }>(`{ parliamentActLineage(actId:"133626"){ votes { role } caveats } }`)
    );
    const all = expectGqlData(
      await gql<{
        parliamentActLineage: { readonly votes: readonly ParliamentLineageVote[] } | null;
      }>(`{ parliamentActLineage(actId:"133626", roles:["all"]){ votes { role } } }`)
    );
    const defaultVotes = def.parliamentActLineage?.votes ?? [];
    const allVotes = all.parliamentActLineage?.votes ?? [];
    expect(allVotes.length).toBeGreaterThan(defaultVotes.length); // roles:["all"] widens
    expect(
      defaultVotes.every((v) => v.role === 'final_adoption' || v.role === 'final_rejection')
    ).toBe(true);
    // M15: the caveat is no longer empty for an act WITH a lineage — it reports the omission.
    expect((def.parliamentActLineage?.caveats ?? []).some((c) => c.includes('omitted'))).toBe(true);
  });

  // ── Workstream B serving additions (2026-07-06): cvPdfUrl, freshness, AI, committees ──

  it('B3/B2: member 2:2020:12 exposes cvPdfUrl and 4 committee seats (cdep, mandate-linked)', async () => {
    const data = expectGqlData(
      await gql<{
        parliamentMember: {
          readonly cvPdfUrl: string | null;
          readonly committeeMemberships: readonly {
            readonly membershipKey: string;
            readonly role: string | null;
            readonly committee: {
              readonly committeeKey: string;
              readonly name: string;
              readonly chamber: string;
            } | null;
            readonly member: { readonly mandateKey: string } | null;
          }[];
        } | null;
      }>(
        `query($k: ID!) {
          parliamentMember(mandateKey:$k) {
            cvPdfUrl
            committeeMemberships {
              membershipKey role
              committee { committeeKey name chamber }
              member { mandateKey }
            }
          }
        }`,
        { k: MEMBER }
      )
    );
    const member = requireValue(data.parliamentMember, 'parliamentMember 2:2020:12');
    // B3: the official CV PDF is surfaced flat (present for this member).
    expect(member.cvPdfUrl).not.toBeNull();
    // B2: 4 committee seats, each with a resolved committee soft-link; member is null
    // in the member→memberships direction (the client already knows the member).
    expect(member.committeeMemberships).toHaveLength(4);
    expect(member.committeeMemberships.every((m) => m.committee !== null)).toBe(true);
    expect(member.committeeMemberships.every((m) => m.member === null)).toBe(true);
  });

  it('B2: senator 1:2024:1 (Abrudean) has 2 committee seats via the current-roster attr join', async () => {
    const data = expectGqlData(
      await gql<{
        parliamentMember: {
          readonly committeeMemberships: readonly {
            readonly role: string | null;
            readonly isBureau: boolean | null;
            readonly committee: { readonly name: string; readonly chamber: string } | null;
          }[];
        } | null;
      }>(
        `query($k: ID!) {
          parliamentMember(mandateKey:$k) {
            committeeMemberships { role isBureau committee { name chamber } }
          }
        }`,
        { k: ABRUDEAN }
      )
    );
    const member = requireValue(data.parliamentMember, 'parliamentMember 1:2024:1');
    expect(member.committeeMemberships).toHaveLength(2);
    // Every senate seat resolves to a senat committee (the attr join, 376/376 live).
    expect(member.committeeMemberships.every((m) => m.committee?.chamber === 'senat')).toBe(true);
    // At least one bureau seat (vicepreședinte on the OCDE special committee).
    expect(member.committeeMemberships.some((m) => m.isBureau === true)).toBe(true);
  });

  it('B2: parliamentCommittees lists committees and parliamentCommittee returns roster + linked bills + meetings', async () => {
    const list = expectGqlData(
      await gql<{
        parliamentCommittees: {
          readonly edges: readonly {
            readonly node: {
              readonly committeeKey: string;
              readonly chamber: string;
              readonly sourceUrl: string;
            };
          }[];
        } | null;
      }>(
        `{ parliamentCommittees(chamber:"camera_deputatilor", first:5) { edges { node { committeeKey chamber sourceUrl } } } }`
      )
    );
    const edges = requireValue(list.parliamentCommittees, 'parliamentCommittees').edges;
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.node.chamber === 'camera_deputatilor')).toBe(true);
    // source_url is NOT NULL — the traceability terminator.
    expect(edges.every((e) => e.node.sourceUrl.length > 0)).toBe(true);

    const key = requireValue(edges[0]?.node.committeeKey, 'a committee key');
    const detail = expectGqlData(
      await gql<{
        parliamentCommittee: {
          readonly committeeKey: string;
          readonly name: string;
          readonly members: readonly { readonly membershipKey: string }[];
          readonly linkedBills: readonly { readonly billKey: string }[];
          readonly linkedBillsTotal: number;
          readonly meetingsCount: number;
        } | null;
      }>(
        `query($k: ID!) {
          parliamentCommittee(committeeKey:$k) {
            committeeKey name
            members { membershipKey }
            linkedBills { billKey }
            linkedBillsTotal
            meetingsCount
          }
        }`,
        { k: key }
      )
    );
    const committee = requireValue(detail.parliamentCommittee, 'parliamentCommittee detail');
    expect(committee.committeeKey).toBe(key);
    expect(committee.name.length).toBeGreaterThan(0);
    expect(committee.linkedBills.length).toBeLessThanOrEqual(committee.linkedBillsTotal);
  }, 30_000);

  it('B1: bill 12760 aiMetadata is non-null, NON-AUTHORITATIVE (trust class + disclaimer + valueClass)', async () => {
    const data = expectGqlData(
      await gql<{
        parliamentBill: {
          readonly aiMetadata: {
            readonly summary: string | null;
            readonly valueClass: string;
            readonly trustClass: string;
            readonly disclaimer: string;
            readonly privacyClass: string;
          } | null;
        } | null;
      }>(
        `query($k: ID!) {
          parliamentBill(billKey:$k) {
            aiMetadata { summary valueClass trustClass disclaimer privacyClass }
          }
        }`,
        { k: BILL }
      )
    );
    const bill = requireValue(data.parliamentBill, 'parliamentBill 12760');
    const ai = requireValue(bill.aiMetadata, 'bill aiMetadata');
    expect(ai.trustClass).toBe('inference_only_label');
    expect(ai.disclaimer.length).toBeGreaterThan(0);
    expect(['standard', 'low_value']).toContain(ai.valueClass);
    expect(ai.privacyClass).toBe('public');
  });

  it('B4: parliamentDataFreshness reports both freshness signals', async () => {
    const data = expectGqlData(
      await gql<{
        parliamentDataFreshness: {
          readonly latestVoteDate: string | null;
          readonly lastLoadedAt: string | null;
        } | null;
      }>(`{ parliamentDataFreshness { latestVoteDate lastLoadedAt } }`)
    );
    const fresh = requireValue(data.parliamentDataFreshness, 'parliamentDataFreshness');
    expect(fresh.latestVoteDate).not.toBeNull();
    expect(fresh.lastLoadedAt).not.toBeNull();
  });

  it('M10: declaration metadata recovers a year + synthesized label from the file_url', async () => {
    const data = expectGqlData(
      await gql<{
        parliamentMember: {
          readonly declarations: readonly {
            readonly declarationType: string;
            readonly declarationYear: number | null;
            readonly label: string | null;
          }[];
        } | null;
      }>(
        `query($k: ID!){ parliamentMember(mandateKey:$k){ declarations { declarationType declarationYear label } } }`,
        { k: MEMBER }
      )
    );
    const decls = data.parliamentMember?.declarations ?? [];
    expect(decls.length).toBeGreaterThan(0);
    // were 100% null before; now the year is parsed from the path and the label synthesized.
    expect(decls.every((d) => d.declarationYear !== null && d.label !== null)).toBe(true);
  });

  // Codex code-review follow-ups: kernel-contract op semantics + null-input safety.
  it('group filter ANDs eq+in and treats an explicit empty in:[] as match-nothing even with eq', async () => {
    const data = expectGqlData(
      await gql<{
        eqIn: { readonly total: number };
        eqEmpty: { readonly total: number };
        eqOnly: { readonly total: number };
      }>(
        `{
          eqIn: parliamentMembers(pageSize:1, filter:{ group:{ eq:"PSD", in:["PNL"] } }) { total }
          eqEmpty: parliamentMembers(pageSize:1, filter:{ group:{ eq:"PSD", in:[] } }) { total }
          eqOnly: parliamentMembers(pageSize:1, filter:{ group:{ eq:"PSD" } }) { total }
        }`
      )
    );
    expect(data.eqIn.total).toBe(0); // eq=PSD AND in=[PNL] is impossible
    expect(data.eqEmpty.total).toBe(0); // explicit empty in:[] → nothing, even with eq
    expect(data.eqOnly.total).toBeGreaterThan(0); // eq alone still matches
  });

  it('null filter fields are treated as absent (no 500): legislature:null applies the default; q:null is fine', async () => {
    const members = await gql<{
      withNull: { readonly total: number } | null;
      base: { readonly total: number } | null;
    }>(
      `{ withNull: parliamentMembers(pageSize:1, filter:{ legislature:null }) { total } base: parliamentMembers(pageSize:1) { total } }`
    );
    expect(members.errors).toBeUndefined();
    expect(members.data?.withNull?.total).toBe(members.data?.base?.total); // null == omitted (default-latest)

    const votes = await gql<{ parliamentVotes: unknown }>(
      `{ parliamentVotes(filter:{ q:null }, first:1) { edges { cursor } } }`
    );
    expect(votes.errors).toBeUndefined(); // q:null no longer throws a raw TypeError
  });

  // ── filterable member votes + per-day activity (2026-07-06) ──────────────────
  // Anchored on Mircea Abrudean (senat, mandate 1:2024:1). Live golden numbers pinned
  // against transparenta_prod: 1110 ballots (648 comun + 462 senat), 846 pentru.

  interface MemberVotesConn {
    readonly total: number;
    readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
    readonly edges: readonly {
      readonly cursor: string;
      readonly node: { readonly voteKey: string; readonly choice: string | null };
    }[];
  }

  const memberVotes = async (
    filter: string,
    first = 1,
    after?: string
  ): Promise<GqlResponse<{ parliamentMember: { readonly votes: MemberVotesConn } | null }>> => {
    const afterArg = after !== undefined ? `, after:${JSON.stringify(after)}` : '';
    return gql<{ parliamentMember: { readonly votes: MemberVotesConn } | null }>(
      `{
        parliamentMember(mandateKey:"${ABRUDEAN}") {
          votes(first:${String(first)}, filter:${filter}${afterArg}) {
            total
            pageInfo { hasNextPage endCursor }
            edges { cursor node { voteKey choice } }
          }
        }
      }`
    );
  };
  const memberVotesTotal = async (filter: string): Promise<number> =>
    requireValue(expectGqlData(await memberVotes(filter)).parliamentMember, 'Abrudean').votes.total;

  it('member votes total is the EXACT filtered count (choice/outcome/chamber slices)', async () => {
    expect(await memberVotesTotal('{}')).toBe(1110);
    // choice buckets partition the full set (846 + 240 + 19 + 5 = 1110).
    expect(await memberVotesTotal('{choice:{eq:"pentru"}}')).toBe(846);
    expect(await memberVotesTotal('{choice:{eq:"impotriva"}}')).toBe(240);
    expect(await memberVotesTotal('{choice:{eq:"abtinere"}}')).toBe(19);
    expect(await memberVotesTotal('{choice:{eq:"nu_a_votat"}}')).toBe(5);
    // outcome (vote-level result) buckets.
    expect(await memberVotesTotal('{outcome:{eq:"adoptat"}}')).toBe(886);
    expect(await memberVotesTotal('{outcome:{eq:"respins"}}')).toBe(224);
    // chamber: a senator ballots only in senat or the joint comun sitting.
    expect(await memberVotesTotal('{chamber:{eq:"comun"}}')).toBe(648);
    expect(await memberVotesTotal('{chamber:{eq:"senat"}}')).toBe(462);
  }, 30_000);

  it('filtered member-votes pagination is stable and the cursor is bound to the filter', async () => {
    const page1 = expectGqlData(await memberVotes('{choice:{eq:"pentru"}}', 5)).parliamentMember;
    const conn1 = requireValue(page1, 'Abrudean').votes;
    expect(conn1.edges).toHaveLength(5);
    // every edge on a choice=pentru page is a pentru ballot (the filter is applied).
    expect(conn1.edges.every((e) => e.node.choice === 'pentru')).toBe(true);
    const endCursor = requireValue(conn1.pageInfo.endCursor, 'page-1 endCursor');
    expect(conn1.pageInfo.hasNextPage).toBe(true);

    // page 2 under the SAME filter continues cleanly, no voteKey overlap with page 1.
    const page2 = expectGqlData(
      await memberVotes('{choice:{eq:"pentru"}}', 5, endCursor)
    ).parliamentMember;
    const conn2 = requireValue(page2, 'Abrudean page 2').votes;
    expect(conn2.edges.every((e) => e.node.choice === 'pentru')).toBe(true);
    const keys1 = new Set(conn1.edges.map((e) => e.node.voteKey));
    expect(conn2.edges.some((e) => keys1.has(e.node.voteKey))).toBe(false);

    // replaying the page-1 cursor under a DIFFERENT filter → INVALID_INPUT (fhash bound).
    const crossed = await memberVotes('{choice:{eq:"impotriva"}}', 5, endCursor);
    expect(crossed.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  }, 30_000);

  interface ActivityDay {
    readonly date: string;
    readonly total: number;
    readonly pentru: number;
    readonly impotriva: number;
    readonly abtinere: number;
    readonly nuAVotat: number;
  }
  interface Activity {
    readonly year: number;
    readonly days: readonly ActivityDay[];
    readonly availableYears: readonly number[];
  }
  const voteActivity = async (
    filter: string
  ): Promise<GqlResponse<{ parliamentMember: { readonly voteActivity: Activity } | null }>> =>
    gql<{ parliamentMember: { readonly voteActivity: Activity } | null }>(
      `{
        parliamentMember(mandateKey:"${ABRUDEAN}") {
          voteActivity(year:2026, filter:${filter}) {
            year
            days { date total pentru impotriva abtinere nuAVotat }
            availableYears
          }
        }
      }`
    );

  it('voteActivity(2026) returns per-day counts that sum + partition, and a sorted availableYears', async () => {
    const act = requireValue(
      expectGqlData(await voteActivity('{}')).parliamentMember,
      'Abrudean'
    ).voteActivity;
    expect(act.year).toBe(2026);
    expect(act.days).toHaveLength(25);
    expect(act.days.reduce((s, d) => s + d.total, 0)).toBe(485);
    const mar20 = requireValue(
      act.days.find((d) => d.date === '2026-03-20'),
      '2026-03-20 activity day'
    );
    expect(mar20.total).toBe(280);
    // each day's four choice counts partition its total.
    expect(
      act.days.every((d) => d.pentru + d.impotriva + d.abtinere + d.nuAVotat === d.total)
    ).toBe(true);
    // availableYears is DISTINCT + ascending and includes the requested year.
    expect(act.availableYears).toContain(2026);
    expect([...act.availableYears].sort((a, b) => a - b)).toEqual([...act.availableYears]);
  }, 30_000);

  it('voteActivity reflects the filter: a choice=pentru day total equals the unfiltered same-day pentru', async () => {
    const base = requireValue(
      expectGqlData(await voteActivity('{}')).parliamentMember,
      'Abrudean base'
    ).voteActivity;
    const filtered = requireValue(
      expectGqlData(await voteActivity('{choice:{eq:"pentru"}}')).parliamentMember,
      'Abrudean pentru'
    ).voteActivity;
    const basePentruByDate = new Map(base.days.map((d) => [d.date, d.pentru]));
    // under choice=pentru, each day's total is exactly the unfiltered pentru count.
    expect(filtered.days.every((d) => d.total === (basePentruByDate.get(d.date) ?? -1))).toBe(true);
    expect(filtered.days.every((d) => d.total === d.pentru)).toBe(true);
  }, 30_000);

  it('voteActivity rejects a voteDate inside the filter (year is the range bound)', async () => {
    const res = await gql<{ parliamentMember: unknown }>(
      `{ parliamentMember(mandateKey:"${ABRUDEAN}") {
          voteActivity(year:2026, filter:{ voteDate:{ gte:"2026-01-01" } }) { year }
        } }`
    );
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });

  // ── filterable + searchable member speeches + per-day activity (2026-07-06) ───
  // Anchored on Luminiţa Păucean-Fernandes (senat, mandate 1:2024:79). Live golden
  // numbers pinned vs transparenta_prod: 83 non-quarantined turns (81 senat + 2 comun),
  // 61 in 2025, 7 matching 'întrebare'. Totals that a backfill can grow use >=.
  const PAUCEAN = '1:2024:79';
  const WORST_SPEECH = '2:2000:92'; // ~35k turns — the keyset-latency floor case.

  interface SpeechNode {
    readonly speechKey: string;
    readonly spokenAt: string | null;
    readonly chamber: string | null;
    readonly sourceUrl: string | null;
    readonly sourceUrlKind: string | null;
  }
  interface SpeechConn {
    readonly total: number;
    readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
    readonly edges: readonly { readonly cursor: string; readonly node: SpeechNode }[];
  }
  const memberSpeeches = async (
    args: string,
    first = 5,
    after?: string
  ): Promise<
    GqlResponse<{ parliamentMember: { readonly speechesConnection: SpeechConn } | null }>
  > => {
    const afterArg = after !== undefined ? `, after:${JSON.stringify(after)}` : '';
    return gql<{ parliamentMember: { readonly speechesConnection: SpeechConn } | null }>(
      `{
        parliamentMember(mandateKey:"${PAUCEAN}") {
          speechesConnection(first:${String(first)}${args}${afterArg}) {
            total
            pageInfo { hasNextPage endCursor }
            edges { cursor node { speechKey spokenAt chamber sourceUrl sourceUrlKind } }
          }
        }
      }`
    );
  };
  const speechesConn = async (args: string, first = 5, after?: string): Promise<SpeechConn> =>
    requireValue(
      expectGqlData(await memberSpeeches(args, first, after)).parliamentMember,
      'Păucean speeches'
    ).speechesConnection;

  it('member speeches total is the EXACT filtered count (chamber + date + q slices)', async () => {
    // unfiltered floor (extraction backfill can only add turns).
    expect((await speechesConn('')).total).toBeGreaterThanOrEqual(83);
    // chamber partitions the set: a senator speaks only in senat or the joint comun sitting.
    const senat = (await speechesConn(', filter:{chamber:{eq:"senat"}}')).total;
    const comun = (await speechesConn(', filter:{chamber:{eq:"comun"}}')).total;
    const all = (await speechesConn('')).total;
    expect(senat + comun).toBe(all);
    expect(senat).toBeGreaterThanOrEqual(81);
    expect(comun).toBeGreaterThanOrEqual(2);
    // 2025 is frozen → exact.
    expect(
      (await speechesConn(', filter:{spokenAt:{between:{from:"2025-01-01",to:"2025-12-31"}}}'))
        .total
    ).toBe(61);
    // q is a strict subset of the full set and non-empty.
    const q = (await speechesConn(', q:"întrebare"')).total;
    expect(q).toBeGreaterThan(0);
    expect(q).toBeLessThan(all);
  }, 30_000);

  it('filtered speech pagination is keyset-stable and the cursor is bound to filter + q', async () => {
    const page1 = await speechesConn(', filter:{chamber:{eq:"senat"}}', 5);
    expect(page1.edges).toHaveLength(5);
    expect(page1.edges.every((e) => e.node.chamber === 'senat')).toBe(true);
    // spokenAt desc, speechKey desc → the page is non-increasing on (spokenAt, speechKey).
    for (let i = 1; i < page1.edges.length; i++) {
      const prev = page1.edges[i - 1]?.node;
      const cur = page1.edges[i]?.node;
      if (prev != null && cur != null)
        expect((prev.spokenAt ?? '') >= (cur.spokenAt ?? '')).toBe(true);
    }
    const endCursor = requireValue(page1.pageInfo.endCursor, 'page-1 endCursor');
    expect(page1.pageInfo.hasNextPage).toBe(true);

    // page 2 under the SAME filter: no speechKey overlap with page 1.
    const page2 = await speechesConn(', filter:{chamber:{eq:"senat"}}', 5, endCursor);
    const keys1 = new Set(page1.edges.map((e) => e.node.speechKey));
    expect(page2.edges.some((e) => keys1.has(e.node.speechKey))).toBe(false);

    // replaying the page-1 cursor under a DIFFERENT q → INVALID_INPUT (fhash bound).
    const crossed = await memberSpeeches(', filter:{chamber:{eq:"senat"}}, q:"lege"', 5, endCursor);
    expect(crossed.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  }, 30_000);

  it('senate speeches carry a lossy_root source link (do-not-deep-link semantics)', async () => {
    const page = await speechesConn(', filter:{chamber:{eq:"senat"}}', 3);
    expect(page.edges.length).toBeGreaterThan(0);
    // every senate turn resolves to a URL, flagged lossy_root (no per-turn anchor).
    for (const e of page.edges) {
      expect(e.node.sourceUrl).not.toBeNull();
      expect(e.node.sourceUrlKind).toBe('lossy_root');
    }
  }, 30_000);

  interface ActivityDay {
    readonly date: string;
    readonly total: number;
    readonly proprie: number;
    readonly comun: number;
  }
  interface SpeechActivity {
    readonly year: number;
    readonly days: readonly ActivityDay[];
    readonly availableYears: readonly number[];
  }
  const speechActivity = async (year: number, args = ''): Promise<SpeechActivity> =>
    requireValue(
      expectGqlData(
        await gql<{ parliamentMember: { readonly speechActivity: SpeechActivity } | null }>(
          `{
            parliamentMember(mandateKey:"${PAUCEAN}") {
              speechActivity(year:${String(year)}${args}) {
                year days { date total proprie comun } availableYears
              }
            }
          }`
        )
      ).parliamentMember,
      'Păucean speechActivity'
    ).speechActivity;

  it('speechActivity(2025) sums to the frozen 2025 total, partitions per day, sorted availableYears', async () => {
    const act = await speechActivity(2025);
    expect(act.year).toBe(2025);
    expect(act.days.reduce((s, day) => s + day.total, 0)).toBe(61);
    // proprie + comun == total on every day.
    expect(act.days.every((day) => day.proprie + day.comun === day.total)).toBe(true);
    // availableYears is DISTINCT + ascending and contains the years with turns.
    expect([...act.availableYears].sort((a, b) => a - b)).toEqual([...act.availableYears]);
    expect(act.availableYears).toContain(2025);
    expect(act.availableYears).toContain(2026);
  }, 30_000);

  it('speechActivity reflects a chamber filter: a comun day total equals the unfiltered same-day comun', async () => {
    const base = await speechActivity(2025);
    const filtered = await speechActivity(2025, ', filter:{chamber:{eq:"comun"}}');
    const baseComunByDate = new Map(base.days.map((day) => [day.date, day.comun]));
    // under chamber=comun, each day's total is exactly the unfiltered comun count, and
    // proprie is 0 (no own-chamber turns survive the filter).
    expect(filtered.days.every((day) => day.total === (baseComunByDate.get(day.date) ?? -1))).toBe(
      true
    );
    expect(filtered.days.every((day) => day.proprie === 0)).toBe(true);
  }, 30_000);

  it('speechActivity reflects the q token: its 2025 day-sum equals the connection total under the SAME q', async () => {
    // The activity heatmap and the connection MUST agree under the same free-text q.
    const act = await speechActivity(2025, ', q:"întrebare"');
    const daySum = act.days.reduce((s, day) => s + day.total, 0);
    const connTotal = (
      await speechesConn(
        ', q:"întrebare", filter:{spokenAt:{between:{from:"2025-01-01",to:"2025-12-31"}}}'
      )
    ).total;
    expect(daySum).toBe(connTotal);
    // q narrows: non-empty but strictly less than the unfiltered 2025 total (61).
    expect(daySum).toBeGreaterThan(0);
    expect(daySum).toBeLessThan(61);
    // per-day partition still holds under q.
    expect(act.days.every((day) => day.proprie + day.comun === day.total)).toBe(true);
  }, 30_000);

  it('speechActivity rejects a spokenAt inside the filter (year is the range bound)', async () => {
    const res = await gql<{ parliamentMember: unknown }>(
      `{ parliamentMember(mandateKey:"${PAUCEAN}") {
          speechActivity(year:2025, filter:{ spokenAt:{ gte:"2025-01-01" } }) { year }
        } }`
    );
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });

  it('the worst-case mandate (~35k turns) returns a fast first keyset page', async () => {
    const started = Date.now();
    const res = await gql<{
      parliamentMember: { readonly speechesConnection: SpeechConn } | null;
    }>(
      `{ parliamentMember(mandateKey:"${WORST_SPEECH}") {
          speechesConnection(first:50) { total edges { node { speechKey } } pageInfo { hasNextPage } }
        } }`
    );
    const conn = requireValue(
      expectGqlData(res).parliamentMember,
      'worst mandate'
    ).speechesConnection;
    expect(conn.edges).toHaveLength(50);
    expect(conn.total).toBeGreaterThanOrEqual(35_000);
    expect(conn.pageInfo.hasNextPage).toBe(true);
    // Generous ceiling (SQL page measured ~38ms; this bounds the whole GraphQL round-trip).
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it('keyset breaks same-date ties by speechKey DESC (worst mandate has many same-day rows)', async () => {
    const res = await gql<{
      parliamentMember: {
        readonly speechesConnection: {
          edges: { node: { speechKey: string; spokenAt: string | null } }[];
        };
      } | null;
    }>(
      `{ parliamentMember(mandateKey:"${WORST_SPEECH}") {
          speechesConnection(first:100) { edges { node { speechKey spokenAt } } }
        } }`
    );
    const nodes = requireValue(
      expectGqlData(res).parliamentMember,
      'worst mandate ties'
    ).speechesConnection.edges.map((e) => e.node);
    expect(nodes.length).toBe(100);
    let sameDatePairs = 0;
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const cur = nodes[i];
      if (prev === undefined || cur === undefined) continue;
      // global order: (spokenAt, speechKey) is strictly non-increasing.
      const prevDate = prev.spokenAt ?? '';
      const curDate = cur.spokenAt ?? '';
      expect(prevDate >= curDate).toBe(true);
      if (prevDate === curDate) {
        sameDatePairs++;
        // the tiebreaker: within a same-date run, speechKey strictly descends (PK unique).
        expect(prev.speechKey > cur.speechKey).toBe(true);
      }
    }
    // the mandate genuinely has same-day runs, so the tiebreaker is actually exercised.
    expect(sameDatePairs).toBeGreaterThan(0);
  }, 30_000);

  it('fullText resolves from speech_texts when present, else degrades to null (table-gated)', async () => {
    const reg = await pool.query<{ reg: string | null }>(
      `select to_regclass('parliament.speech_texts')::text as reg`
    );
    const hasTexts = reg.rows[0]?.reg != null;
    const res = await gql<{
      parliamentMember: {
        readonly speechesConnection: { edges: { node: { fullText: string | null } }[] };
      } | null;
    }>(
      `{ parliamentMember(mandateKey:"${PAUCEAN}") {
          speechesConnection(first:3) { edges { node { fullText } } }
        } }`
    );
    // The query must NEVER error, whether or not speech_texts exists.
    const conn = requireValue(
      expectGqlData(res).parliamentMember,
      'Păucean fullText'
    ).speechesConnection;
    if (!hasTexts) {
      // Table absent (parallel slice not landed): every fullText degrades to null.
      expect(conn.edges.every((e) => e.node.fullText === null)).toBe(true);
    } else {
      // Table present: fullText is a string-or-null per row (loaded coverage may be partial).
      expect(
        conn.edges.every((e) => e.node.fullText === null || typeof e.node.fullText === 'string')
      ).toBe(true);
    }
  }, 30_000);

  // ── GLOBAL speeches (stenograme) roots: parliamentSpeeches / activity / speech ──

  interface GlobalSpeechNode {
    readonly speechKey: string;
    readonly spokenAt: string | null;
    readonly chamber: string | null;
    readonly speakerName: string | null;
    readonly mandateKey: string | null;
  }
  interface GlobalSpeechConn {
    readonly total: number;
    readonly totalEstimated: boolean;
    readonly searchDepth: string | null;
    readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
    readonly edges: readonly { readonly cursor: string; readonly node: GlobalSpeechNode }[];
  }
  const globalSpeechesRes = async (
    args: string,
    first = 5,
    after?: string
  ): Promise<GqlResponse<{ parliamentSpeeches: GlobalSpeechConn | null }>> => {
    const afterArg = after !== undefined ? `, after:${JSON.stringify(after)}` : '';
    return gql<{ parliamentSpeeches: GlobalSpeechConn | null }>(
      `{
        parliamentSpeeches(first:${String(first)}${args}${afterArg}) {
          total totalEstimated searchDepth
          pageInfo { hasNextPage endCursor }
          edges { cursor node { speechKey spokenAt chamber speakerName mandateKey } }
        }
      }`
    );
  };
  const globalSpeeches = async (
    args: string,
    first = 5,
    after?: string
  ): Promise<GlobalSpeechConn> =>
    requireValue(
      expectGqlData(await globalSpeechesRes(args, first, after)).parliamentSpeeches,
      'parliamentSpeeches'
    );

  it('global stenograme: an UNBOUNDED list resolves null + INVALID_INPUT in errors[] (H2 nullable root)', async () => {
    for (const args of [
      '', // no bound at all
      ', filter:{chamber:{eq:"senat"}}', // chamber bounds nothing
      ', filter:{spokenAt:{gte:"2025-01-01"}}', // half-open window
      ', filter:{spokenAt:{between:{from:"2023-01-01",to:"2024-01-02"}}}', // 367 days
      ', filter:{mandateKey:{in:[]}}', // empty in:[] is not a bound
      ', q:"lege"', // q bounds nothing
    ]) {
      const res = await globalSpeechesRes(args);
      expect(res.data?.parliamentSpeeches, args).toBeNull();
      expect(res.errors?.[0]?.extensions?.code, args).toBe('INVALID_INPUT');
    }
  }, 30_000);

  it('global stenograme: year-window keyset page1→page2 with no overlap, ordered (spokenAt, speechKey) desc', async () => {
    const WINDOW = ', filter:{spokenAt:{between:{from:"2025-01-01",to:"2025-12-31"}}}';
    const page1 = await globalSpeeches(WINDOW, 25);
    expect(page1.edges).toHaveLength(25);
    expect(page1.total).toBeGreaterThan(25);
    expect(page1.searchDepth).toBeNull(); // no q → no depth
    expect(page1.pageInfo.hasNextPage).toBe(true);
    for (let i = 1; i < page1.edges.length; i++) {
      const prev = page1.edges[i - 1]?.node;
      const cur = page1.edges[i]?.node;
      if (prev == null || cur == null) continue;
      const prevDate = prev.spokenAt ?? '';
      const curDate = cur.spokenAt ?? '';
      expect(prevDate >= curDate).toBe(true);
      if (prevDate === curDate) expect(prev.speechKey > cur.speechKey).toBe(true);
    }
    const endCursor = requireValue(page1.pageInfo.endCursor, 'global page-1 endCursor');
    const page2 = await globalSpeeches(WINDOW, 25, endCursor);
    const keys1 = new Set(page1.edges.map((e) => e.node.speechKey));
    expect(page2.edges.some((e) => keys1.has(e.node.speechKey))).toBe(false);

    // the cursor is bound to the filter: replaying it under a different window fails.
    const crossed = await globalSpeechesRes(
      ', filter:{spokenAt:{between:{from:"2024-01-01",to:"2024-12-31"}}}',
      25,
      endCursor
    );
    expect(crossed.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  }, 30_000);

  it('global stenograme: mandate-bounded total matches parliamentMember.speechesConnection.total exactly', async () => {
    const viaGlobal = await globalSpeeches(`, filter:{mandateKey:{eq:"${PAUCEAN}"}}`);
    const viaMember = await speechesConn('');
    expect(viaGlobal.total).toBe(viaMember.total);
    expect(viaGlobal.totalEstimated).toBe(false);
    expect(viaGlobal.edges.every((e) => e.node.mandateKey === PAUCEAN)).toBe(true);
  }, 30_000);

  it('global stenograme: parliamentSpeech resolves a dynamic key with speakerName/member + lazy fullText; unknown → null', async () => {
    const first = requireValue(
      (await globalSpeeches(`, filter:{mandateKey:{eq:"${PAUCEAN}"}}`, 1)).edges[0],
      'a Păucean speech'
    ).node;
    const res = await gql<{
      parliamentSpeech: {
        readonly speechKey: string;
        readonly speakerName: string | null;
        readonly mandateKey: string | null;
        readonly fullText: string | null;
        readonly member: { readonly mandateKey: string; readonly fullName: string | null } | null;
      } | null;
    }>(
      `{ parliamentSpeech(speechKey:${JSON.stringify(first.speechKey)}) {
          speechKey speakerName mandateKey fullText member { mandateKey fullName }
        } }`
    );
    const speech = requireValue(expectGqlData(res).parliamentSpeech, 'parliamentSpeech');
    expect(speech.speechKey).toBe(first.speechKey);
    expect(speech.mandateKey).toBe(PAUCEAN);
    expect(speech.member?.mandateKey).toBe(PAUCEAN);
    expect(speech.member?.fullName).not.toBeNull();
    // fullText never errors: string when the transcript is loaded, else null.
    expect(speech.fullText === null || typeof speech.fullText === 'string').toBe(true);

    const missing = await gql<{ parliamentSpeech: unknown }>(
      `{ parliamentSpeech(speechKey:"no-such-speech") { speechKey } }`
    );
    expect(expectGqlData(missing).parliamentSpeech).toBeNull();
  }, 30_000);

  interface GlobalActivity {
    readonly year: number;
    readonly days: readonly ActivityDay[];
    readonly availableYears: readonly number[];
    readonly searchDepth: string | null;
  }
  const globalActivity = async (year: number, args = ''): Promise<GlobalActivity> =>
    requireValue(
      expectGqlData(
        await gql<{ parliamentSpeechActivity: GlobalActivity | null }>(
          `{ parliamentSpeechActivity(year:${String(year)}${args}) {
              year days { date total proprie comun } availableYears searchDepth
            } }`
        )
      ).parliamentSpeechActivity,
      'parliamentSpeechActivity'
    );

  it('global stenograme activity: proprie + comun partition every day; mandate-scoped matches the member view', async () => {
    const act = await globalActivity(2025, `, filter:{mandateKey:{eq:"${PAUCEAN}"}}`);
    expect(act.year).toBe(2025);
    expect(act.days.every((day) => day.proprie + day.comun === day.total)).toBe(true);
    expect(act.searchDepth).toBeNull();
    // parity with the member speechActivity surface (same filter semantics).
    const member = await speechActivity(2025);
    expect(act.days.reduce((s, day) => s + day.total, 0)).toBe(
      member.days.reduce((s, day) => s + day.total, 0)
    );
    expect(act.availableYears).toEqual(member.availableYears);
    // spokenAt inside the filter is rejected (the year bounds the range).
    const rejected = await gql<{ parliamentSpeechActivity: unknown }>(
      `{ parliamentSpeechActivity(year:2025, filter:{spokenAt:{gte:"2025-01-01"}}) { year } }`
    );
    expect(rejected.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  }, 30_000);

  it('global stenograme: searchDepth reports FULL_TEXT under a mandate bound vs TITLE_SUMMARY under a year window', async () => {
    const reg = await pool.query<{ reg: string | null }>(
      `select to_regclass('parliament.speech_texts')::text as reg`
    );
    const hasTexts = reg.rows[0]?.reg != null;
    const mandateQ = await globalSpeeches(`, filter:{mandateKey:{eq:"${PAUCEAN}"}}, q:"întrebare"`);
    // Mandate-bound q is full-text ELIGIBLE; the applied depth still degrades to
    // TITLE_SUMMARY when the transcript table has not landed (probe-false).
    expect(mandateQ.searchDepth).toBe(hasTexts ? 'FULL_TEXT' : 'TITLE_SUMMARY');
    // A 365-day window exceeds the 92-day full-text cap → TITLE_SUMMARY regardless.
    const yearQ = await globalSpeeches(
      ', filter:{spokenAt:{between:{from:"2025-01-01",to:"2025-12-31"}}}, q:"întrebare"'
    );
    expect(yearQ.searchDepth).toBe('TITLE_SUMMARY');
    expect(yearQ.total).toBeGreaterThan(0);
    // The activity surface reports the depth the same way (mandate-bound only).
    const actDepth = (
      await globalActivity(2025, `, filter:{mandateKey:{eq:"${PAUCEAN}"}}, q:"întrebare"`)
    ).searchDepth;
    expect(actDepth).toBe(hasTexts ? 'FULL_TEXT' : 'TITLE_SUMMARY');
  }, 30_000);

  it('MCP search_parliament_speeches: bounded call ok:true with meta; unbounded call in-band ok:false', async () => {
    interface SpeechesToolOut {
      readonly ok: boolean;
      readonly kind: string;
      readonly items?: readonly { readonly speechKey: string }[];
      readonly meta?: {
        readonly total?: number;
        readonly totalEstimated?: boolean;
        readonly searchDepth?: string | null;
      };
      readonly summary?: string;
      readonly error?: string;
    }
    const bounded = await mcpCall<SpeechesToolOut>('search_parliament_speeches', {
      mandateKey: PAUCEAN,
      q: 'întrebare',
      limit: 5,
    });
    expect(bounded.ok).toBe(true);
    expect(bounded.kind).toBe('speeches');
    expect(bounded.items?.length).toBeGreaterThan(0);
    expect(bounded.meta?.total).toBeGreaterThan(0);
    expect(bounded.meta?.totalEstimated).toBe(false);
    expect(bounded.summary).toContain('speech');

    const unbounded = await mcpCall<SpeechesToolOut>('search_parliament_speeches', { q: 'lege' });
    expect(unbounded.ok).toBe(false);
    expect(unbounded.error).toContain('mandateKey');
  }, 30_000);

  /**
   * `filter.groupVote` — the derived group-PLURALITY stance, checked against the
   * ballots themselves. The expectations are COMPUTED from vote_records inside the
   * test (an independent per-vote argmax, not the repo's EXISTS), so the suite
   * proves the two agree instead of pinning constants that drift as data loads.
   */
  describe('groupVote — plurality drill-down (live ballots)', () => {
    const CHAMBER = 'camera_deputatilor';
    const FROM = '2026-01-28';
    const TO = '2026-07-28';
    const GROUP = 'PSD';

    /** Per-choice vote counts where GROUP's plurality was that choice; ties excluded. */
    const sqlPlurality = async (): Promise<{ byChoice: Map<string, number>; ties: number }> => {
      const res = await pool.query<{ plurality: string; cnt: string }>(
        `with w as (
           select v.vote_key from parliament.votes v
           where v.chamber = $1 and v.vote_date between $2::date and $3::date
         ), c as (
           select vr.vote_key,
             count(*) filter (where vr.choice='pentru')     as p,
             count(*) filter (where vr.choice='impotriva')  as i,
             count(*) filter (where vr.choice='abtinere')   as a,
             count(*) filter (where vr.choice='nu_a_votat') as n
           from parliament.vote_records vr join w on w.vote_key = vr.vote_key
           where vr.group_name = $4
           group by 1
         )
         select case
                  when p>i and p>a and p>n then 'pentru'
                  when i>p and i>a and i>n then 'impotriva'
                  when a>p and a>i and a>n then 'abtinere'
                  when n>p and n>i and n>a then 'nu_a_votat'
                  else 'TIE' end as plurality,
                count(*)::text as cnt
         from c group by 1`,
        [CHAMBER, FROM, TO, GROUP]
      );
      const byChoice = new Map(
        res.rows.filter((r) => r.plurality !== 'TIE').map((r) => [r.plurality, Number(r.cnt)])
      );
      const ties = Number(res.rows.find((r) => r.plurality === 'TIE')?.cnt ?? 0);
      return { byChoice, ties };
    };

    /** Page the connection to exhaustion and return the matched vote keys. */
    const gqlVoteKeys = async (choice: string): Promise<readonly string[]> => {
      const keys: string[] = [];
      let after: string | null = null;
      for (let page = 0; page < 20; page++) {
        const data: {
          parliamentVotes: {
            edges: readonly { node: { voteKey: string } }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          } | null;
        } = expectGqlData(
          await gql(
            `query($chamber:String!, $from:Date!, $to:Date!, $group:String!, $choice:ParliamentVoteChoice!, $after:String) {
               parliamentVotes(
                 filter:{
                   chamber:{eq:$chamber}
                   voteDate:{between:{from:$from, to:$to}}
                   groupVote:{group:$group, choice:$choice}
                 }
                 first:100
                 after:$after
               ) {
                 edges { node { voteKey } }
                 pageInfo { hasNextPage endCursor }
               }
             }`,
            { chamber: CHAMBER, from: FROM, to: TO, group: GROUP, choice, after }
          )
        );
        const conn = requireValue(data.parliamentVotes, 'parliamentVotes');
        keys.push(...conn.edges.map((e) => e.node.voteKey));
        if (!conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      return keys;
    };

    it('the four plurality buckets partition the window, ties excluded from BOTH sides', async () => {
      const { byChoice, ties } = await sqlPlurality();
      const windowVotes = await pool.query<{ cnt: string }>(
        `select count(*)::text as cnt from parliament.votes
         where chamber = $1 and vote_date between $2::date and $3::date`,
        [CHAMBER, FROM, TO]
      );
      const total = Number(windowVotes.rows[0]?.cnt ?? 0);
      expect(total).toBeGreaterThan(0);

      const perChoice = new Map<string, readonly string[]>();
      for (const choice of ['pentru', 'impotriva', 'abtinere', 'nu_a_votat']) {
        const keys = await gqlVoteKeys(choice);
        // The API agrees with an independent per-vote argmax over the same ballots.
        expect(keys.length).toBe(byChoice.get(choice) ?? 0);
        perChoice.set(choice, keys);
      }

      // A vote is attributed to AT MOST ONE stance (no double-counting), and the
      // shortfall against the window is exactly the tied votes — the tie rule means
      // a tied vote appears under NEITHER tied choice.
      const all = [...perChoice.values()].flat();
      expect(new Set(all).size).toBe(all.length);
      expect(all.length).toBe(total - ties);
      // The window must actually EXERCISE the tie rule, else this proves nothing.
      expect(ties).toBeGreaterThan(0);

      // nu_a_votat is a stance, not a hole: "the group mostly did not show up" is
      // expressible and DOES attribute votes.
      expect((perChoice.get('nu_a_votat') ?? []).length).toBeGreaterThan(0);
    }, 60_000);

    it('a tied vote is served under NEITHER tied choice', async () => {
      // Find a live vote where GROUP's top two choices tie.
      const tie = await pool.query<{ vote_key: string; top: string; other: string }>(
        `with w as (
           select v.vote_key from parliament.votes v
           where v.chamber = $1 and v.vote_date between $2::date and $3::date
         ), c as (
           select vr.vote_key, vr.choice, count(*) as n
           from parliament.vote_records vr join w on w.vote_key = vr.vote_key
           where vr.group_name = $4
           group by 1, 2
         ), ranked as (
           select vote_key, choice, n, rank() over (partition by vote_key order by n desc) as rnk
           from c
         )
         select vote_key,
                min(choice) filter (where rnk = 1) as top,
                max(choice) filter (where rnk = 1) as other
         from ranked group by vote_key
         having count(*) filter (where rnk = 1) > 1
         limit 1`,
        [CHAMBER, FROM, TO, GROUP]
      );
      const row = tie.rows[0];
      // A window with no tie cannot exercise the rule — fail loudly rather than pass vacuously.
      expect(row).toBeDefined();
      if (row === undefined) return;
      expect(row.top).not.toBe(row.other);
      for (const choice of [row.top, row.other]) {
        expect(await gqlVoteKeys(choice)).not.toContain(row.vote_key);
      }
    }, 60_000);

    it('matches the stored group_name EXACTLY (no fuzzy bridging of the vocabulary gap)', async () => {
      // The directory spelling of an unaffiliated bloc is NOT the ballot spelling.
      expect(await gqlVoteKeys('pentru')).not.toHaveLength(0);
      const misspelled: { parliamentVotes: { edges: readonly unknown[] } | null } = expectGqlData(
        await gql(
          `query($chamber:String!, $from:Date!, $to:Date!) {
             parliamentVotes(
               filter:{
                 chamber:{eq:$chamber}
                 voteDate:{between:{from:$from, to:$to}}
                 groupVote:{group:"psd", choice:pentru}
               }
               first:5
             ) { edges { node { voteKey } } }
           }`,
          { chamber: CHAMBER, from: FROM, to: TO }
        )
      );
      // Lower-cased spelling is a DIFFERENT name: zero rows, never a fuzzy hit.
      expect(requireValue(misspelled.parliamentVotes, 'parliamentVotes').edges).toHaveLength(0);
    }, 60_000);

    it('an UNBOUNDED groupVote list resolves null + INVALID_INPUT (no 4.1M-ballot scan)', async () => {
      const res = await gql<{ parliamentVotes: null }>(
        `{
           parliamentVotes(filter:{groupVote:{group:"PSD", choice:pentru}}, first:5) {
             edges { node { voteKey } }
           }
         }`
      );
      expect(res.data?.parliamentVotes ?? null).toBeNull();
      expect(res.errors?.[0]?.message).toContain('groupVote');
      expect(res.errors?.[0]?.extensions?.code ?? res.errors?.[0]?.extensions?.type).toContain(
        'INVALID'
      );
    }, 30_000);

    it('the filtered vote count is NOT the cohesion bar percentage (different denominators)', async () => {
      const cohesion = expectGqlData(
        await gql<{ parliamentVoteCohesion: readonly { groupName: string; voteCount: number }[] }>(
          `query($chamber:ParliamentChamber!, $from:Date!, $to:Date!, $group:String!) {
             parliamentVoteCohesion(chamber:$chamber, from:$from, to:$to, group:$group) {
               groupName voteCount
             }
           }`,
          { chamber: CHAMBER, from: FROM, to: TO, group: GROUP }
        )
      );
      const bar = cohesion.parliamentVoteCohesion.find((g) => g.groupName === GROUP);
      const forVotes = (await gqlVoteKeys('pentru')).length;
      expect(bar).toBeDefined();
      // Cohesion counts every vote the group balloted in; the filter counts the votes
      // whose PLURALITY was pentru — a strict subset, so a client must never present
      // the filtered count as the bar's percentage of the same window.
      expect(forVotes).toBeLessThan(bar?.voteCount ?? 0);
    }, 60_000);

    /**
     * PARTICIPATION (`groupVote` with NO `choice`) — "every vote this group took
     * part in". The client's filter panel lets a reader pick a party without picking
     * a stance, and that must be the WIDER set, not a fifth stance and not an error.
     */
    describe('participation — a group with no choice', () => {
      /** connection.total for a groupVote filter over the standard window. */
      const totalFor = async (groupVoteSdl: string): Promise<number> => {
        const data = expectGqlData(
          await gql<{ parliamentVotes: { total: number } | null }>(
            `query($chamber:String!, $from:Date!, $to:Date!) {
               parliamentVotes(
                 filter:{
                   chamber:{eq:$chamber}
                   voteDate:{between:{from:$from, to:$to}}
                   groupVote:${groupVoteSdl}
                 }
                 first:1
               ) { total totalEstimated }
             }`,
            { chamber: CHAMBER, from: FROM, to: TO }
          )
        );
        return requireValue(data.parliamentVotes, 'parliamentVotes').total;
      };

      it('matches an independent SQL semi-join over the same ballots', async () => {
        const res = await pool.query<{ cnt: string }>(
          `select count(*)::text as cnt from parliament.votes v
           where v.chamber = $1 and v.vote_date between $2::date and $3::date
             and exists (select 1 from parliament.vote_records vr
                         where vr.vote_key = v.vote_key and vr.group_name = $4)`,
          [CHAMBER, FROM, TO, GROUP]
        );
        const expected = Number(res.rows[0]?.cnt ?? 0);
        expect(expected).toBeGreaterThan(0);
        expect(await totalFor(`{group:"${GROUP}"}`)).toBe(expected);
      }, 60_000);

      it('is WIDER than any single stance, and is exactly the four stances PLUS the ties', async () => {
        const { byChoice, ties } = await sqlPlurality();
        const participation = await totalFor(`{group:"${GROUP}"}`);
        const stances = [...byChoice.values()].reduce((a, b) => a + b, 0);

        // The whole point of the reading: a TIED vote has no plurality, so it falls
        // out of all four stance filters — yet the group unmistakably took part.
        expect(ties).toBeGreaterThan(0);
        expect(participation).toBe(stances + ties);
        expect(participation).toBeGreaterThan(byChoice.get('pentru') ?? 0);
      }, 60_000);

      it('never exceeds the window itself (it is a filter, not a cross join)', async () => {
        const windowVotes = await pool.query<{ cnt: string }>(
          `select count(*)::text as cnt from parliament.votes
           where chamber = $1 and vote_date between $2::date and $3::date`,
          [CHAMBER, FROM, TO]
        );
        const total = Number(windowVotes.rows[0]?.cnt ?? 0);
        expect(await totalFor(`{group:"${GROUP}"}`)).toBeLessThanOrEqual(total);
      }, 60_000);

      it('still matches group_name EXACTLY — the lower-cased spelling is a different, empty question', async () => {
        expect(await totalFor(`{group:"psd"}`)).toBe(0);
      }, 60_000);

      it('still REQUIRES a bound (the missing index does not care which reading runs)', async () => {
        const res = await gql<{ parliamentVotes: null }>(
          `{ parliamentVotes(filter:{groupVote:{group:"PSD"}}, first:5) { total } }`
        );
        expect(res.data?.parliamentVotes ?? null).toBeNull();
        expect(res.errors?.[0]?.message).toContain('groupVote');
      }, 30_000);

      it('a `choice` with NO `group` is still an error — it does not describe a subset', async () => {
        const res = await gql<{ parliamentVotes: null }>(
          `query($chamber:String!, $from:Date!, $to:Date!) {
             parliamentVotes(
               filter:{
                 chamber:{eq:$chamber}
                 voteDate:{between:{from:$from, to:$to}}
                 groupVote:{choice:pentru}
               }
               first:5
             ) { total }
           }`,
          { chamber: CHAMBER, from: FROM, to: TO }
        );
        expect(res.data?.parliamentVotes ?? null).toBeNull();
        expect(res.errors?.[0]?.message).toContain('group');
      }, 30_000);

      it('pages under its own cursor, and refuses a cursor minted under a stance', async () => {
        const page = async (
          groupVoteSdl: string,
          after: string | null
        ): Promise<{
          keys: readonly string[];
          endCursor: string | null;
          hasNextPage: boolean;
        }> => {
          const data = expectGqlData(
            await gql<{
              parliamentVotes: {
                edges: readonly { node: { voteKey: string } }[];
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              } | null;
            }>(
              `query($chamber:String!, $from:Date!, $to:Date!, $after:String) {
                 parliamentVotes(
                   filter:{
                     chamber:{eq:$chamber}
                     voteDate:{between:{from:$from, to:$to}}
                     groupVote:${groupVoteSdl}
                   }
                   first:2
                   after:$after
                 ) {
                   edges { node { voteKey } }
                   pageInfo { hasNextPage endCursor }
                 }
               }`,
              { chamber: CHAMBER, from: FROM, to: TO, after }
            )
          );
          const conn = requireValue(data.parliamentVotes, 'parliamentVotes');
          return {
            keys: conn.edges.map((e) => e.node.voteKey),
            endCursor: conn.pageInfo.endCursor,
            hasNextPage: conn.pageInfo.hasNextPage,
          };
        };

        const first = await page(`{group:"${GROUP}"}`, null);
        expect(first.hasNextPage).toBe(true);
        const cursor = requireValue(first.endCursor, 'endCursor');
        const second = await page(`{group:"${GROUP}"}`, cursor);
        expect(second.keys.some((k) => first.keys.includes(k))).toBe(false);

        // Participation and a stance are DIFFERENT result sets, so they must not share
        // a cursor: replaying one under the other is a refusal, not a shifted page.
        const crossed = await gql<{ parliamentVotes: null }>(
          `query($chamber:String!, $from:Date!, $to:Date!, $after:String) {
             parliamentVotes(
               filter:{
                 chamber:{eq:$chamber}
                 voteDate:{between:{from:$from, to:$to}}
                 groupVote:{group:"${GROUP}", choice:pentru}
               }
               first:2
               after:$after
             ) { edges { node { voteKey } } }
           }`,
          { chamber: CHAMBER, from: FROM, to: TO, after: cursor }
        );
        expect(crossed.data?.parliamentVotes ?? null).toBeNull();
        expect(crossed.errors?.[0]?.message).toContain('cursor');
      }, 60_000);
    });
  });
  /**
   * `total` / `totalEstimated` on ParliamentVoteConnection, and the `kind`
   * partition it is used to size. Every expectation is CHECKED AGAINST AN
   * INDEPENDENT SQL COUNT over the same slice — the point of the field is that a
   * client can trust the number without paging the list, so a drifting count is
   * worse than no count.
   */
  describe('votes total + kind partition (live prod)', () => {
    const CHAMBER = 'senat'; // every bucket in this chamber is under the 10k cap
    const KINDS = [
      'legislative',
      'amendment',
      'procedural',
      'chamber_decision',
      'attendance',
      'unclassified',
    ] as const;

    interface VotePage {
      readonly total: number;
      readonly totalEstimated: boolean;
      readonly edges: readonly { readonly node: { readonly voteKey: string } }[];
      readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
    }

    const votes = async (
      filterSdl: string,
      first = 3,
      after: string | null = null
    ): Promise<VotePage> => {
      const data = expectGqlData(
        await gql<{ parliamentVotes: VotePage | null }>(
          `query($after:String) {
             parliamentVotes(filter:${filterSdl}, first:${String(first)}, after:$after) {
               total totalEstimated
               edges { node { voteKey } }
               pageInfo { hasNextPage endCursor }
             }
           }`,
          { after }
        )
      );
      return requireValue(data.parliamentVotes, 'parliamentVotes');
    };

    const sqlCount = async (where: string, params: readonly unknown[] = []): Promise<number> => {
      const res = await pool.query<{ cnt: string }>(
        `select count(*)::text as cnt from parliament.votes v where ${where}`,
        [...params]
      );
      return Number(res.rows[0]?.cnt ?? 0);
    };

    it('matches an independent SQL count(*) over the SAME filter', async () => {
      const page = await votes(
        `{chamber:{eq:"${CHAMBER}"}, voteDate:{between:{from:"2024-01-01", to:"2026-07-28"}}}`
      );
      const expected = await sqlCount(
        `v.chamber = $1 and v.vote_date between $2::date and $3::date`,
        [CHAMBER, '2024-01-01', '2026-07-28']
      );
      expect(expected).toBeGreaterThan(0);
      expect(page.total).toBe(expected);
      expect(page.totalEstimated).toBe(false);
      // The page is a page; the total is the whole filtered slice.
      expect(page.edges.length).toBeLessThanOrEqual(3);
    }, 60_000);

    it('caps at 10,000 and SAYS SO (the listSpeeches contract), rather than reporting a partial count', async () => {
      const page = await votes('{}');
      const corpus = await sqlCount('true');
      expect(corpus).toBeGreaterThan(10_000);
      expect(page.total).toBe(10_000);
      expect(page.totalEstimated).toBe(true);
    }, 60_000);

    it('does not shrink as the client pages (the keyset predicate is excluded from the count)', async () => {
      const filter = `{chamber:{eq:"${CHAMBER}"}, kind:{eq:"procedural"}}`;
      const first = await votes(filter, 2);
      expect(first.pageInfo.hasNextPage).toBe(true);
      const second = await votes(filter, 2, first.pageInfo.endCursor);
      expect(second.total).toBe(first.total);
      expect(second.edges[0]?.node.voteKey).not.toBe(first.edges[0]?.node.voteKey);
    }, 60_000);

    it('the six kinds PARTITION the chamber: the bucket totals sum to the unfiltered total', async () => {
      const all = await votes(`{chamber:{eq:"${CHAMBER}"}}`);
      const expected = await sqlCount('v.chamber = $1', [CHAMBER]);
      expect(all.total).toBe(expected);
      expect(all.totalEstimated).toBe(false);

      const totals = new Map<string, number>();
      for (const kind of KINDS) {
        const page = await votes(`{chamber:{eq:"${CHAMBER}"}, kind:{eq:"${kind}"}}`);
        expect(page.totalEstimated).toBe(false);
        totals.set(kind, page.total);
      }
      const sum = [...totals.values()].reduce((a, b) => a + b, 0);
      // Disjoint AND exhaustive: nothing double-counted, nothing silently dropped.
      expect(sum).toBe(all.total);
      // `unclassified` is a SERVED bucket, not an empty formality.
      expect(totals.get('unclassified') ?? 0).toBeGreaterThan(0);
      // The one bucket that is a column, checked against the column itself.
      expect(totals.get('legislative')).toBe(
        await sqlCount('v.chamber = $1 and v.bill_key is not null', [CHAMBER])
      );
    }, 120_000);

    it('an `in` of two buckets equals the sum of the two (the buckets do not overlap)', async () => {
      const both = await votes(
        `{chamber:{eq:"${CHAMBER}"}, kind:{in:["attendance","procedural"]}}`
      );
      const attendance = await votes(`{chamber:{eq:"${CHAMBER}"}, kind:{eq:"attendance"}}`);
      const procedural = await votes(`{chamber:{eq:"${CHAMBER}"}, kind:{eq:"procedural"}}`);
      expect(both.total).toBe(attendance.total + procedural.total);
    }, 60_000);

    it('an unknown bucket is INVALID_INPUT, never a silently unfiltered list', async () => {
      const res = await gql<{ parliamentVotes: null }>(
        `{ parliamentVotes(filter:{kind:{eq:"budget"}}, first:1) { total edges { node { voteKey } } } }`
      );
      expect(res.data?.parliamentVotes ?? null).toBeNull();
      expect(res.errors?.[0]?.message).toContain('kind');
    }, 30_000);

    it('counts a groupVote slice exactly — the count runs the same correlated aggregate', async () => {
      const filter =
        '{chamber:{eq:"camera_deputatilor"}, voteDate:{between:{from:"2026-01-28", to:"2026-07-28"}}, groupVote:{group:"PSD", choice:pentru}}';
      const page = await votes(filter, 100);
      const keys: string[] = page.edges.map((e) => e.node.voteKey);
      let after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      for (let i = 0; i < 10 && after !== null; i++) {
        const next = await votes(filter, 100, after);
        keys.push(...next.edges.map((e) => e.node.voteKey));
        expect(next.total).toBe(page.total);
        after = next.pageInfo.hasNextPage ? next.pageInfo.endCursor : null;
      }
      // The eager count equals what exhaustive paging actually yields.
      expect(page.total).toBe(keys.length);
      expect(page.totalEstimated).toBe(false);
      expect(page.total).toBeGreaterThan(0);
    }, 120_000);

    /**
     * REGRESSION (kernel fhash): the cursor `fhash` used to lower-case string
     * values, so a cursor minted under `group:"PSD"` decoded cleanly under
     * `group:"psd"` — a filter that matches NOTHING, because vote_records.group_name
     * is case-sensitive — and the client saw an empty page instead of an error.
     */
    it('a cursor minted under group "PSD" is REFUSED under "psd", not silently paged empty', async () => {
      const window =
        'chamber:{eq:"camera_deputatilor"}, voteDate:{between:{from:"2026-01-28", to:"2026-07-28"}}';
      const first = await votes(`{${window}, groupVote:{group:"PSD", choice:pentru}}`, 2);
      expect(first.pageInfo.hasNextPage).toBe(true);
      const cursor = requireValue(first.pageInfo.endCursor, 'endCursor');

      const replayed = await gql<{ parliamentVotes: null }>(
        `query($after:String) {
           parliamentVotes(
             filter:{${window}, groupVote:{group:"psd", choice:pentru}}
             first:2
             after:$after
           ) { total edges { node { voteKey } } }
         }`,
        { after: cursor }
      );
      expect(replayed.data?.parliamentVotes ?? null).toBeNull();
      expect(replayed.errors?.[0]?.message).toContain('cursor');

      // And the lower-cased spelling itself is a different, EMPTY question — the
      // error above is the cursor guard, not a coincidence of the empty result.
      const lower = await votes(`{${window}, groupVote:{group:"psd", choice:pentru}}`, 2);
      expect(lower.total).toBe(0);
      expect(lower.edges).toHaveLength(0);
    }, 60_000);
  });

  /**
   * `parliamentVotes(dir:)` — the sort DIRECTION, against live rows.
   *
   * The resolver hardcoded `desc`, so "oldest first" was unreachable even though the
   * usecase and the repo already took a direction. Two things need proving on real
   * data rather than compiled SQL: an ASC page really walks the corpus forward
   * without repeating or skipping (for BOTH sorts, not just the date one), and a
   * cursor does not survive a flip of the direction it was minted under — the same
   * refusal the `group:"PSD"`-vs-`"psd"` case mismatch above produces.
   */
  describe('votes sort direction (live prod)', () => {
    const CHAMBER = 'senat';
    const FROM = '2026-01-28';
    const TO = '2026-07-28';
    const FILTER_SDL = `{chamber:{eq:"${CHAMBER}"}, voteDate:{between:{from:"${FROM}", to:"${TO}"}}}`;

    interface DirPage {
      readonly edges: readonly {
        readonly node: { readonly voteKey: string; readonly voteDate: string | null };
      }[];
      readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
    }

    const page = async (
      sort: string,
      dir: string,
      first = 5,
      after: string | null = null
    ): Promise<DirPage> => {
      const data = expectGqlData(
        await gql<{ parliamentVotes: DirPage | null }>(
          `query($after:String) {
             parliamentVotes(filter:${FILTER_SDL}, sort:${sort}, dir:${dir}, first:${String(first)}, after:$after) {
               edges { node { voteKey voteDate } }
               pageInfo { hasNextPage endCursor }
             }
           }`,
          { after }
        )
      );
      return requireValue(data.parliamentVotes, 'parliamentVotes');
    };

    /** Walk `pages` pages of `first` and return the concatenated keys. */
    const walk = async (
      sort: string,
      dir: string,
      first: number,
      pages: number
    ): Promise<string[]> => {
      const keys: string[] = [];
      let after: string | null = null;
      for (let i = 0; i < pages; i++) {
        const p: DirPage = await page(sort, dir, first, after);
        keys.push(...p.edges.map((e) => e.node.voteKey));
        if (!p.pageInfo.hasNextPage) break;
        after = p.pageInfo.endCursor;
      }
      return keys;
    };

    /** The SAME order the repo compiles: coalesce(date,'') then vote_key. */
    const sqlKeys = async (orderBy: string, limit: number): Promise<string[]> => {
      const res = await pool.query<{ vote_key: string }>(
        `select v.vote_key from parliament.votes v
         where v.chamber = $1 and v.vote_date between $2::date and $3::date
         order by ${orderBy} limit ${String(limit)}`,
        [CHAMBER, FROM, TO]
      );
      return res.rows.map((r) => r.vote_key);
    };

    it('ASC really reverses the list — the first row is the window OLDEST, not the newest', async () => {
      const asc = await page('voteDate', 'ASC', 1);
      const desc = await page('voteDate', 'DESC', 1);
      const oldest = asc.edges[0]?.node.voteDate;
      const newest = desc.edges[0]?.node.voteDate;
      expect(oldest).toBeDefined();
      expect(newest).toBeDefined();
      expect(String(oldest) < String(newest)).toBe(true);
      // Against the window itself, so this is not just "the two ends differ".
      const bounds = await pool.query<{ lo: string; hi: string }>(
        `select min(vote_date)::text as lo, max(vote_date)::text as hi from parliament.votes
         where chamber = $1 and vote_date between $2::date and $3::date`,
        [CHAMBER, FROM, TO]
      );
      expect(oldest).toBe(bounds.rows[0]?.lo);
      expect(newest).toBe(bounds.rows[0]?.hi);
    }, 60_000);

    it('OMITTING dir is still DESC — existing callers do not move', async () => {
      const data = expectGqlData(
        await gql<{ parliamentVotes: DirPage | null }>(
          `{ parliamentVotes(filter:${FILTER_SDL}, first:5) {
               edges { node { voteKey } } pageInfo { hasNextPage endCursor } } }`
        )
      );
      const implicit = requireValue(data.parliamentVotes, 'parliamentVotes');
      const explicit = await page('voteDate', 'DESC', 5);
      expect(implicit.edges.map((e) => e.node.voteKey)).toEqual(
        explicit.edges.map((e) => e.node.voteKey)
      );
    }, 60_000);

    it('voteDate/ASC pages forward with no repeats and no gaps', async () => {
      const keys = await walk('voteDate', 'ASC', 5, 4);
      expect(keys.length).toBeGreaterThan(5);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual(
        await sqlKeys(`coalesce(v.vote_date::text,'') asc, v.vote_key asc`, keys.length)
      );
    }, 60_000);

    it('voteKey/ASC pages correctly too — not only the date sort', async () => {
      const keys = await walk('voteKey', 'ASC', 5, 4);
      expect(keys.length).toBeGreaterThan(5);
      expect(new Set(keys).size).toBe(keys.length);
      // Strictly increasing: a keyset that did not flip with the ORDER BY would
      // re-serve page 1 or jump past rows here.
      expect([...keys].sort()).toEqual(keys);
      expect(keys).toEqual(await sqlKeys('v.vote_key asc', keys.length));
    }, 60_000);

    it('voteKey/DESC still pages the other way', async () => {
      const keys = await walk('voteKey', 'DESC', 5, 3);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual(await sqlKeys('v.vote_key desc', keys.length));
    }, 60_000);

    /**
     * REGRESSION GUARD for the new argument: `dir` is CURSOR IDENTITY, exactly like
     * `sort` and the filter hash. A DESC cursor accepted by an ASC page would seek
     * the reversed keyset from the wrong end of the list — wrong rows, no error.
     */
    it('a cursor minted under DESC is REFUSED under ASC (the same clean INVALID_INPUT as the case mismatch)', async () => {
      const first = await page('voteDate', 'DESC', 2);
      expect(first.pageInfo.hasNextPage).toBe(true);
      const cursor = requireValue(first.pageInfo.endCursor, 'endCursor');

      const flipped = await gql<{ parliamentVotes: null }>(
        `query($after:String) {
           parliamentVotes(filter:${FILTER_SDL}, sort:voteDate, dir:ASC, first:2, after:$after) {
             edges { node { voteKey } }
           }
         }`,
        { after: cursor }
      );
      expect(flipped.data?.parliamentVotes ?? null).toBeNull();
      expect(flipped.errors?.[0]?.message).toContain('cursor');
      expect(flipped.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');

      // And the ASC page is a real, working page on its own — the error above is the
      // cursor guard, not ASC being broken.
      const ascPage = await page('voteDate', 'ASC', 2);
      expect(ascPage.edges).toHaveLength(2);
    }, 60_000);

    it('an ASC cursor is refused under DESC, on the voteKey sort as well', async () => {
      for (const [minted, replayed] of [
        ['ASC', 'DESC'],
        ['DESC', 'ASC'],
      ] as const) {
        for (const sort of ['voteDate', 'voteKey']) {
          const first = await page(sort, minted, 2);
          const cursor = requireValue(first.pageInfo.endCursor, 'endCursor');
          const res = await gql<{ parliamentVotes: null }>(
            `query($after:String) {
               parliamentVotes(filter:${FILTER_SDL}, sort:${sort}, dir:${replayed}, first:2, after:$after) {
                 edges { node { voteKey } }
               }
             }`,
            { after: cursor }
          );
          expect(res.data?.parliamentVotes ?? null, `${sort} ${minted}→${replayed}`).toBeNull();
          expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
        }
      }
    }, 120_000);
  });
  describe('plenary agenda (ordinea de zi) — live prod', () => {
    it('the sitting spine is fully dated, and the dates come from the transcript', async () => {
      // The whole serving surface rests on this: before 2026-07-28 the agenda
      // lane left 1,990 of 2,102 sittings undated because it read a weekly
      // column the source populates almost nowhere.
      const res = await pool.query<{ total: string; dated: string; from_steno: string }>(
        `select count(*)::text as total,
                count(*) filter (where sitting_date is not null)::text as dated,
                count(*) filter (where sitting_date_source = 'stenogram_session')::text as from_steno
           from parliament.sittings`
      );
      const row = res.rows[0];
      expect(Number(row?.dated)).toBe(Number(row?.total));
      expect(Number(row?.from_steno)).toBeGreaterThanOrEqual(1990);
    }, 30_000);

    it('no scheduling edge claims debate or a vote', async () => {
      // debated_in_session / voted_in_session require a transcript or division
      // anchor that nothing produces yet. A populated row means somebody
      // promoted a plan to proof.
      const res = await pool.query<{ cnt: string }>(
        `select count(*)::text as cnt from parliament.bill_sitting_links
          where relationship_kind <> 'scheduled_on_agenda'`
      );
      expect(Number(res.rows[0]?.cnt)).toBe(0);
    }, 30_000);

    it('the weekly parser no longer emits the nested wrapper row', async () => {
      // One phantom block existed on all 940 captured weeks; 72 of them paired
      // an agenda with a sitting the source never linked.
      const res = await pool.query<{ cnt: string }>(
        `select count(*)::text as cnt from parliament.sitting_schedule_blocks
          where is_current and block_text like '%text-decoration:underline%'`
      );
      expect(Number(res.rows[0]?.cnt)).toBe(0);
    }, 30_000);

    it('lists orders of business newest-first and reaches a human-openable source', async () => {
      const res = await gql<{
        parliamentAgendas: {
          total: number;
          nodes: {
            agendaKey: string;
            approvedDate: string | null;
            sourceUrl: string;
            itemCount: number;
            billCount: number;
            sittings: { sittingKey: string; date: string | null; dateSource: string }[];
          }[];
        } | null;
      }>(
        `query {
          parliamentAgendas(limit: 5) {
            total
            nodes {
              agendaKey approvedDate sourceUrl itemCount billCount
              sittings { sittingKey date dateSource }
            }
          }
        }`
      );
      expect(res.errors).toBeUndefined();
      const page = res.data?.parliamentAgendas;
      expect(page?.total).toBeGreaterThanOrEqual(1296);
      expect(page?.nodes.length).toBe(5);
      const dates = (page?.nodes ?? [])
        .map((n) => n.approvedDate)
        .filter((d): d is string => d !== null);
      expect([...dates].sort().reverse()).toEqual(dates);
      for (const node of page?.nodes ?? []) {
        expect(node.sourceUrl).toMatch(/^https:\/\/www\.cdep\.ro\/.*oid=\d+$/u);
        expect(node.itemCount).toBeGreaterThanOrEqual(0);
      }
    }, 60_000);

    it('serves the ordered CURRENT points of one agenda, with their documents', async () => {
      const pick = await pool.query<{ agenda_key: string }>(
        `select a.agenda_key from parliament.sitting_agendas a
          join parliament.sitting_agenda_items i
            on i.agenda_key = a.agenda_key and i.is_current
          where a.approved_date is not null
          group by a.agenda_key
          having count(*) filter (where i.bill_key is not null) > 3
          order by a.approved_date desc
          limit 1`
      );
      const agendaKey = pick.rows[0]?.agenda_key;
      expect(agendaKey).toBeDefined();

      const res = await gql<{
        parliamentAgenda: {
          agenda: { agendaKey: string; itemCount: number };
          items: {
            rowIndex: number;
            itemKind: string;
            billKey: string | null;
            resolutionStatus: string;
            committeeRapporteurs: string[];
            documents: { url: string }[];
          }[];
        } | null;
      }>(
        `query($k: ID!) {
          parliamentAgenda(agendaKey: $k) {
            agenda { agendaKey itemCount }
            items {
              rowIndex itemKind billKey resolutionStatus committeeRapporteurs
              documents { url }
            }
          }
        }`,
        { k: agendaKey }
      );
      expect(res.errors).toBeUndefined();
      const detail = res.data?.parliamentAgenda;
      expect(detail?.agenda.agendaKey).toBe(agendaKey);
      // The header count and the served points are the same population.
      expect(detail?.items.length).toBe(detail?.agenda.itemCount);
      const rowIndexes = (detail?.items ?? []).map((i) => i.rowIndex);
      expect([...rowIndexes].sort((a, b) => a - b)).toEqual(rowIndexes);
      // A resolved point names a bill; an unresolved one must not pretend to.
      for (const item of detail?.items ?? []) {
        if (item.resolutionStatus === 'linked') expect(item.billKey).not.toBeNull();
      }
    }, 60_000);

    it('an unknown agenda key is null, not an error', async () => {
      const res = await gql<{ parliamentAgenda: unknown }>(
        `query { parliamentAgenda(agendaKey: "cdep_agenda_ordinezi:oid:0") { agenda { agendaKey } } }`
      );
      expect(res.errors).toBeUndefined();
      expect(res.data?.parliamentAgenda).toBeNull();
    }, 30_000);

    it("a bill's scheduling history is dated, ordered, and claims only scheduling", async () => {
      const pick = await pool.query<{ bill_key: string }>(
        `select bill_key from parliament.bill_sitting_links
          group by bill_key having count(*) between 3 and 12 limit 1`
      );
      const billKey = pick.rows[0]?.bill_key;
      expect(billKey).toBeDefined();

      const res = await gql<{
        parliamentBillScheduling: {
          sittingDate: string | null;
          sittingDateSource: string;
          relationshipKind: string;
          resolutionStatus: string;
          agendaKey: string;
        }[];
      }>(
        `query($k: ID!) {
          parliamentBillScheduling(billKey: $k) {
            sittingDate sittingDateSource relationshipKind resolutionStatus agendaKey
          }
        }`,
        { k: billKey }
      );
      expect(res.errors).toBeUndefined();
      const rows = res.data?.parliamentBillScheduling ?? [];
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const row of rows) {
        expect(row.relationshipKind).toBe('scheduled_on_agenda');
        expect(['exact', 'candidate']).toContain(row.resolutionStatus);
      }
      const dates = rows.map((r) => r.sittingDate).filter((d): d is string => d !== null);
      expect([...dates].sort()).toEqual(dates);
    }, 60_000);
  });
});
