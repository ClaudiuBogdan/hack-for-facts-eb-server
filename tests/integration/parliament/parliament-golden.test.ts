/**
 * Parliament golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to the verified 2026-06-17 parliament serving anchors:
 *   - Legea nr. 423/2023 => legal act_id 145905, bill_key 12760,
 *     final adoption vote cdep:29892.
 *   - Gabriel Andronache 2020 Chamber mandate => 2:2020:12, person_id 2264.
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
const PERSON = '2264';

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
    expect(counts.get('groups')).toBe(73);
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
    expect(bill.statusText).toBe('Lege 423/2023 29.12.2023');
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
          ballots(first:200) { edges { node { rowIndex choice mandateKey constituencyName } } }
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
    // ballots connection is capped at 200 per page, so the first page surfaces a
    // substantial (~186) constituency-bearing slice — the județ column is populated.
    const resolvedWithConstituency = vote.ballots.edges.filter(
      (edge) => edge.node.mandateKey !== null && edge.node.constituencyName !== null
    );
    expect(resolvedWithConstituency.length).toBeGreaterThanOrEqual(150);
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
    expect(member.person?.personId).toBe(PERSON);
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
      { personId: PERSON }
    );
    const personData = expectGqlData(personRes);
    const person = requireValue(personData.parliamentPerson, 'parliamentPerson');
    expect(person.personId).toBe(PERSON);
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
    expect(personResolve.parliamentResolveFilter.some((hit) => hit.value === PERSON)).toBe(true);

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
    const roster = async (groupId: string): Promise<readonly { readonly mandateKey: string; readonly chamber: string | null }[]> => {
      const data = expectGqlData(
        await gql<{
          parliamentGroupMembers: readonly { readonly mandateKey: string; readonly chamber: string | null }[];
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
      await gql<{ parliamentGroups: readonly { readonly groupId: string; readonly chamber: string }[] }>(
        `{ parliamentGroups(legislature:"2024") { groupId chamber } }`
      )
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

  it('bill billType + status filters return the live prod classification counts', async () => {
    const billsTotal = async (filter: string): Promise<number> => {
      const data = expectGqlData(
        await gql<{ parliamentBills: { readonly total: number; readonly totalEstimated: boolean } }>(
          `{ parliamentBills(filter:${filter}, page:1, pageSize:1) { total totalEstimated } }`
        )
      );
      // All buckets are < the 10k list cap, so total is EXACT (never estimated).
      expect(data.parliamentBills.totalEstimated).toBe(false);
      return data.parliamentBills.total;
    };

    // billType (initiative-kind badge), prefix on procedure.tip_initiativa. The
    // kernel renders enum filter fields as GraphQL String (literal-union validated
    // server-side), so values are passed as quoted strings.
    expect(await billsTotal('{billType:{eq:"government"}}')).toBe(5271);
    expect(await billsTotal('{billType:{eq:"parliamentary"}}')).toBe(3005);
    // in:[both] is the OR — the union (bills carrying a procedure block).
    expect(await billsTotal('{billType:{in:["government","parliamentary"]}}')).toBe(8276);

    // status buckets on status_text — a clean partition of all 9,958 bills.
    const promulgated = await billsTotal('{status:{eq:"promulgated"}}');
    const rejected = await billsTotal('{status:{eq:"rejected"}}');
    const inProgress = await billsTotal('{status:{eq:"in_progress"}}');
    expect(promulgated).toBe(3606);
    expect(rejected).toBe(1939);
    expect(inProgress).toBe(4413);
    expect(promulgated + rejected + inProgress).toBe(9958); // partition is exhaustive

    // Combined filters AND together (government bills that became law).
    expect(await billsTotal('{billType:{eq:"government"}, status:{eq:"promulgated"}}')).toBe(3270);

    // An unknown enum value is a clean InvalidInput (repo enumSelection guard) —
    // NOT a silent empty result. (The kernel renders these virtual enums as String
    // and skips virtual fields, so the repo owns the domain check.)
    const bad = await gql<{ parliamentBills: unknown }>(
      `{ parliamentBills(filter:{status:{eq:"enacted"}}, page:1, pageSize:1) { total } }`
    );
    expect(bad.errors).toBeDefined();
    expect(bad.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
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
});
