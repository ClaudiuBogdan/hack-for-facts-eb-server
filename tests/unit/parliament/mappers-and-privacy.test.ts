/**
 * Parliament unit tests — mappers + the PRIVACY invariant (§2.6). Asserts that no
 * view model carries a passthrough `attrs` bag, declaration metadata never carries
 * file_hash, the tally shape is correct, bigint/date stay strings, and the
 * dangling legal-act loader tolerates a missing id (returns null, never throws).
 *
 * The gate that USED to live here — `safeAttrs` whitelisting the bag after it
 * arrived — is gone. Its replacement is structural and enforced one layer earlier,
 * in SQL: see `attrs-projection-gate.test.ts`, which compiles the repo's real
 * queries and fails if any of them selects a raw `attrs` column. The mapper-level
 * assertions kept here are the second half of that pair: a row type with no bag
 * cannot produce a view model with one.
 */

import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeLegalActLoader, type LegalActsRepo } from '@/modules/legal/index.js';
import { AI_DISCLAIMER, AI_TRUST_CLASS } from '@/modules/parliament/core/types.js';
import {
  mapAiBillMetadata,
  mapAiControlItemMetadata,
  mapBill,
  mapBillDocument,
  mapBillEvent,
  mapCommittee,
  mapCommitteeMembership,
  mapDeclaration,
  mapMember,
  mapVote,
  type AiBillMetadataRow,
  type AiControlItemMetadataRow,
  type BillRow,
  type CommitteeMembershipCoreRow,
  type CommitteeRow,
  type DeclarationRow,
  type MemberRow,
  type VoteRow,
} from '@/modules/parliament/shell/repo/mappers.js';

describe('merged dossier child source identity', () => {
  it('preserves the contributing bill key on events and documents', () => {
    expect(
      mapBillEvent({
        bill_key: 'senat:123-2012',
        position: 1,
        event_date: null,
        event_date_text: null,
        description: 'Înregistrare',
        chamber_code: 'senat',
        committee: null,
        vote_idv: null,
        docs: null,
      }).sourceBillKey
    ).toBe('senat:123-2012');
    expect(
      mapBillDocument({
        bill_key: '12760',
        url: 'https://www.cdep.ro/a.pdf',
        label: 'Document',
        kind: 'pdf',
        position: 1,
      }).sourceBillKey
    ).toBe('12760');
  });
});

describe('mapMember — bigint/date as strings, no attrs bag, no PII', () => {
  const row: MemberRow = {
    mandate_key: '2:2020:12',
    chamber: 'camera_deputatilor',
    legislature: '2020',
    full_name: 'Andronache Gabriel',
    normalized_name: 'andronache gabriel',
    group_name: 'PNL',
    group_id: 'pnl-camera_deputatilor',
    constituency_name: 'București',
    birth_date: '1970-05-12', // ::text — a STRING, not a Date
    person_id: '2264', // bigint → string
    is_current: true,
    mandate_end_date: null,
    mandate_end_reason: null,
    profile_url: 'http://x',
    cv_pdf_url: null,
  };

  it('emits string scalars', () => {
    const m = mapMember(row);
    expect(m.personId).toBe('2264');
    expect(typeof m.personId).toBe('string');
    expect(m.birthDate).toBe('1970-05-12');
  });

  /**
   * The member bag was the strongest argument for extracting keys in SQL rather
   * than filtering after arrival: live `members.attrs` carries
   * `senate_current_roster_alias_evidence` (an OBJECT of internal match evidence)
   * plus eight sibling `senate_current_roster_alias_*` provenance keys. Under the
   * old design all of it was fetched on every request — including on a vote page
   * fanning out up to 500 ballots — and was one unreviewed whitelist entry away
   * from a public surface. It is now unreachable: MemberRow has no bag to read.
   */
  it('has no attrs bag on the row type OR the view model — the bag is unreachable', () => {
    const m = mapMember(row);
    expect(Object.keys(m)).not.toContain('attrs');
    expect(Object.keys(row)).not.toContain('attrs');
    expect(Object.keys(m)).not.toContain('senate_current_roster_alias_evidence');
  });

  it('surfaces profileUrl flat from its own extracted column (Gap 4)', () => {
    expect(mapMember(row).profileUrl).toBe('http://x');
  });

  it('leaves profileUrl null when the source carries no profile_url', () => {
    const noProfile: MemberRow = { ...row, profile_url: null };
    expect(mapMember(noProfile).profileUrl).toBeNull();
  });

  it('surfaces cvPdfUrl flat from its own extracted column (B3), null when absent', () => {
    const withCv: MemberRow = { ...row, cv_pdf_url: 'https://cdep.ro/cv/12.pdf' };
    expect(mapMember(withCv).cvPdfUrl).toBe('https://cdep.ro/cv/12.pdf');
    expect(mapMember(row).cvPdfUrl).toBeNull(); // base row has no cv_pdf_url
  });

  it('the member view model has no birthDateText / clusterKey field at all', () => {
    const m = mapMember(row);
    expect(Object.keys(m)).not.toContain('birthDateText');
    expect(Object.keys(m)).not.toContain('clusterKey');
    expect(Object.keys(m)).not.toContain('birthDateParseMethod');
  });

  it('maps SC-1 seat lifecycle: a seated member is current with no end date/reason', () => {
    const m = mapMember(row);
    expect(m.isCurrent).toBe(true);
    expect(m.mandateEndDate).toBeNull();
    expect(m.mandateEndReason).toBeNull();
  });

  it('maps a superseded member: isCurrent false + end date/reason (attribution untouched here)', () => {
    const superseded: MemberRow = {
      ...row,
      mandate_key: '2:2024:146',
      is_current: false,
      mandate_end_date: '2025-01-27',
      mandate_end_reason: 'deces',
    };
    const m = mapMember(superseded);
    expect(m.isCurrent).toBe(false);
    expect(m.mandateEndDate).toBe('2025-01-27');
    expect(m.mandateEndReason).toBe('deces');
  });
});

describe('mapVote — tally shape, printed subject/time, no attrs bag', () => {
  const row: VoteRow = {
    vote_key: 'cdep:29892',
    chamber: 'camera_deputatilor',
    vote_date: '2022-05-04',
    title: 'X',
    pentru: 275,
    impotriva: 0,
    abtinere: 1,
    nu_a_votat: 1,
    present: 277,
    outcome: 'adoptat',
    division_number: null,
    bill_key: '12760',
    law_reference: null,
    source_url: 'https://www.cdep.ro/pls/steno/eVot.Nominal?idv=29892',
    tally_mismatch: true,
    vote_subject: 'raport de respingere (a legii)',
    vote_datetime_text: '04.05.2022 11:29',
    kind: 'legislative',
  };

  it('maps the tally with camelCase nuAVotat and passes tallyMismatch through', () => {
    const v = mapVote(row);
    expect(v.tally).toEqual({ pentru: 275, impotriva: 0, abtinere: 1, nuAVotat: 1, present: 277 });
    expect(v.tallyMismatch).toBe(true);
  });

  it('has no attrs bag on the row type OR the view model', () => {
    const v = mapVote(row);
    expect(Object.keys(v)).not.toContain('attrs');
    expect(Object.keys(row)).not.toContain('attrs');
  });

  /**
   * M1 regression, restated for the SQL projection. The loader writes
   * `tally_mismatch` as a JSON OBJECT ({pentru:{official,recorded},…}) on 925
   * votes, and only its PRESENCE is public — the per-choice split is not (§2.6).
   * The mapper now passes through a boolean the SELECT already reduced, so the
   * object cannot reach this layer at all. The reduction itself (including that a
   * JSON-null value reads false, matching the old `!= null`) is pinned in
   * `attrs-projection-gate.test.ts`, where the SQL is visible.
   */
  it('carries the mismatch flag as a boolean, never the object behind it', () => {
    expect(mapVote(row).tallyMismatch).toBe(true);
    expect(typeof mapVote(row).tallyMismatch).toBe('boolean');
    expect(mapVote({ ...row, tally_mismatch: false }).tallyMismatch).toBe(false);
  });

  it('surfaces the chamber-printed subject and the printed date+time', () => {
    const v = mapVote(row);
    expect(v.voteSubject).toBe('raport de respingere (a legii)');
    expect(v.voteDateTimeText).toBe('04.05.2022 11:29');
  });

  // 6,702 of 20,860 votes are Senate rows, whose feed publishes no time at all.
  it('leaves the printed time null for a Senate vote rather than inventing one', () => {
    const senate = mapVote({ ...row, vote_datetime_text: null, vote_subject: null });
    expect(senate.voteDateTimeText).toBeNull();
    expect(senate.voteSubject).toBeNull();
    expect(senate.voteDate).toBe('2022-05-04'); // the date still stands on its own
  });
});

describe('mapDeclaration — metadata only, NEVER file_hash or content', () => {
  it('projects {type,date,year,label,fileUrl} and keeps a source-provided label', () => {
    const row: DeclarationRow = {
      declaration_type: 'avere',
      declaration_date: '2024-03-01',
      label: 'Declarație de avere',
      file_url: 'https://example/decl.pdf', // no /YYYY/ path segment → year null
    };
    const d = mapDeclaration(row);
    expect(d).toEqual({
      declarationType: 'avere',
      declarationDate: '2024-03-01',
      declarationYear: null,
      label: 'Declarație de avere',
      fileUrl: 'https://example/decl.pdf',
    });
    expect(Object.keys(d)).not.toContain('fileHash');
    expect(Object.keys(d)).not.toContain('content');
  });

  // M10: declarationDate + label were 100% null in prod; recover the year from the CDEP
  // file_url path and synthesize a label so the fields are usable.
  it('recovers the year from the CDEP path and synthesizes a label when the source has none', () => {
    const d = mapDeclaration({
      declaration_type: 'avere',
      declaration_date: null,
      label: null,
      file_url: 'https://www.cdep.ro/declaratii/deputati/2012/avere/010f.pdf',
    });
    expect(d.declarationYear).toBe(2012);
    expect(d.label).toBe('avere 2012');
    expect(d.declarationDate).toBeNull(); // a full date is never fabricated from a year
  });
});

describe('mapBill — dates/timestamps as strings, no attrs bag, flat classification', () => {
  /** Every attrs-derived field absent — the shape of a bill with no procedure block. */
  const BARE: BillRow = {
    bill_key: '12760',
    plx_number: '237',
    plx_year: 2012,
    senate_number: null,
    senate_year: null,
    title: 'Proiect de Lege',
    final_law_number: '423',
    final_law_year: 2023,
    status_text: 'Lege 423/2023 29.12.2023',
    bill_type: 'Proiect de Lege pentru aprobarea O.U.G. nr. 21/2012',
    last_event_date: '2023-12-01',
    is_canonical: true,
    canonical_bill_key: null,
    decision_chamber: null,
    law_character: null,
    procedure_urgency: null,
    procedure_regime: null,
    object_of_regulation: null,
    last_event_description: null,
    first_event_date: null,
    last_event_source: null,
    cdep_project_url: null,
    senate_detail_url: null,
    senate_file_url: null,
    senate_opinions_url: null,
    senate_cod: null,
    government_e_number: null,
    government_e_year: null,
    initiator_type: null,
    initiator_type_confidence: null,
    initiator_type_method: null,
    source_updated_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
  };

  it('has no attrs bag on the row type OR the view model', () => {
    const b = mapBill(BARE);
    expect(Object.keys(b)).not.toContain('attrs');
    expect(Object.keys(BARE)).not.toContain('attrs');
  });

  it('surfaces statusText + billType flat from the extracted columns (Gap 2)', () => {
    const b = mapBill(BARE);
    expect(b.finalLawNumber).toBe('423');
    expect(b.statusText).toBe('Lege 423/2023 29.12.2023');
    expect(b.billType).toBe('Proiect de Lege pentru aprobarea O.U.G. nr. 21/2012');
    expect(b.lastEventDate).toBe('2023-12-01');
  });

  it('leaves statusText / billType null when the source carries neither', () => {
    const b = mapBill({
      ...BARE,
      bill_key: 'x',
      plx_number: null,
      plx_year: null,
      title: null,
      final_law_number: null,
      final_law_year: null,
      status_text: null,
      bill_type: null,
      last_event_date: null,
      // A suppressed bicameral (Senate navetá) twin: non-canonical, points at its CDep twin.
      is_canonical: false,
      canonical_bill_key: '12760',
    });
    expect(b.statusText).toBeNull();
    expect(b.billType).toBeNull();
    // B1 canonicality is surfaced flat for the client redirect (§3).
    expect(b.isCanonical).toBe(false);
    expect(b.canonicalBillKey).toBe('12760');
  });

  /**
   * The procedure facts (2026-08-05). These lived in `attrs.procedure`, a jsonb
   * OBJECT that the old primitives-only whitelist silently dropped — so they were
   * fetched on every request and published nowhere. Values are the live vocabulary.
   */
  it('surfaces the procedure facts the old whitelist dropped', () => {
    const b = mapBill({
      ...BARE,
      decision_chamber: 'Camera Deputaţilor',
      law_character: 'organic',
      procedure_urgency: true,
      procedure_regime: 'cf. Constitutiei revizuita în 2003',
    });
    expect(b.decisionChamber).toBe('Camera Deputaţilor');
    expect(b.lawCharacter).toBe('organic');
    expect(b.procedureUrgency).toBe(true);
    expect(b.procedureRegime).toBe('cf. Constitutiei revizuita în 2003');
  });

  /**
   * Tri-state, and the null is load-bearing: 21,242 of 41,990 bills carry no
   * procedure block at all. Collapsing that null to false would tell a reader the
   * chamber decided this bill was NOT urgent, which the source never said.
   */
  it('keeps procedureUrgency null — never false — when the source said nothing', () => {
    expect(mapBill(BARE).procedureUrgency).toBeNull();
    expect(mapBill({ ...BARE, procedure_urgency: false }).procedureUrgency).toBe(false);
  });

  it('surfaces the four source links, narrative, and cross-source identifiers', () => {
    const b = mapBill({
      ...BARE,
      cdep_project_url: 'https://www.cdep.ro/pls/proiecte/upl_pck.proiect?idp=1',
      senate_detail_url: 'https://www.senat.ro/legis/lista.aspx?cod=1',
      senate_file_url: 'https://www.senat.ro/fisa.aspx?cod=1',
      senate_opinions_url: 'https://www.senat.ro/avize.aspx?cod=1',
      object_of_regulation: 'Reglementarea regimului deșeurilor.',
      last_event_description: 'Vot final — adoptat',
      last_event_source: 'votes',
      senate_cod: 'b123',
      government_e_number: '412',
      government_e_year: '2012',
    });
    expect(b.cdepProjectUrl).toContain('cdep.ro');
    expect(b.senateDetailUrl).toContain('senat.ro');
    expect(b.senateFileUrl).toContain('fisa');
    expect(b.senateOpinionsUrl).toContain('avize');
    expect(b.objectOfRegulation).toBe('Reglementarea regimului deșeurilor.');
    expect(b.lastEventDescription).toBe('Vot final — adoptat');
    expect(b.lastEventSource).toBe('votes');
    expect(b.senateCod).toBe('b123');
    // Both stay STRINGS: the source stores the year as text, and a numeric cast
    // would silently null any non-numeric registration.
    expect(b.governmentENumber).toBe('412');
    expect(b.governmentEYear).toBe('2012');
    expect(typeof b.governmentEYear).toBe('string');
  });

  it('carries the initiator classification WITH the rule that produced it', () => {
    const b = mapBill({
      ...BARE,
      initiator_type: 'government',
      initiator_type_confidence: 'high',
      initiator_type_method: 'initiators:guvern',
    });
    expect(b.initiatorType).toBe('government');
    expect(b.initiatorTypeConfidence).toBe('high');
    // The honesty field: a derived value must arrive with its evidence, so a
    // reader can tell WHY we say it. Serving the value alone would present our
    // classification as if the chamber had printed it.
    expect(b.initiatorTypeMethod).toBe('initiators:guvern');
  });
});

describe('mapAiBillMetadata / mapAiControlItemMetadata — stamps trust class + disclaimer (B1)', () => {
  const billRow: AiBillMetadataRow = {
    summary: 'Rezumat pe scurt.',
    topic: 'fiscal',
    domains: ['fiscal', 'buget'],
    keywords: ['tva', 'accize'],
    value_class: 'standard',
    config_key: 'bill-v1',
    prompt_version: 'p3',
    schema_version: 2,
    model: 'glm-5.2',
    validation_status: 'valid',
    confidence: '0.870',
    source_updated_at: '2026-06-20T00:00:00Z',
    loaded_at: '2026-06-21T00:00:00Z',
    privacy_class: 'public',
  };

  it('stamps AI_TRUST_CLASS + AI_DISCLAIMER on every bill row and defends the arrays', () => {
    const m = mapAiBillMetadata(billRow);
    expect(m.trustClass).toBe(AI_TRUST_CLASS);
    expect(m.trustClass).toBe('inference_only_label');
    expect(m.disclaimer).toBe(AI_DISCLAIMER);
    expect(m.domains).toEqual(['fiscal', 'buget']);
    expect(m.keywords).toEqual(['tva', 'accize']);
    expect(m.valueClass).toBe('standard');
    expect(m.confidence).toBe('0.870'); // numeric → string (precision-safe)
  });

  it('serves low_value rows (client hides them) and tolerates null/absent arrays', () => {
    const m = mapAiBillMetadata({
      ...billRow,
      value_class: 'low_value',
      domains: null,
      keywords: undefined,
    });
    expect(m.valueClass).toBe('low_value');
    expect(m.domains).toEqual([]);
    expect(m.keywords).toEqual([]);
  });

  it('stamps the trust class + disclaimer on control rows too (no value_class field)', () => {
    const controlRow: AiControlItemMetadataRow = {
      summary: 'Întrebare către minister.',
      policy_domains: ['sanatate'],
      issue_types: ['intrebare'],
      urgency: 'normal',
      keywords: ['spital'],
      config_key: 'ctrl-v1',
      prompt_version: 'p2',
      schema_version: 1,
      model: 'glm-5.2',
      validation_status: 'valid',
      confidence: null,
      source_updated_at: null,
      loaded_at: '2026-06-21T00:00:00Z',
      privacy_class: 'public',
    };
    const m = mapAiControlItemMetadata(controlRow);
    expect(m.trustClass).toBe('inference_only_label');
    expect(m.disclaimer).toBe(AI_DISCLAIMER);
    expect(m.policyDomains).toEqual(['sanatate']);
    expect(m.issueTypes).toEqual(['intrebare']);
    expect(m.privacyClass).toBe('public');
    // control metadata has no value_class — the view model must not invent one.
    expect(Object.keys(m)).not.toContain('valueClass');
  });
});

describe('mapCommittee / mapCommitteeMembership — chamber translation + PDL-003 guard (B2)', () => {
  it('translates the raw chamber code to the module enum value', () => {
    const cdep: CommitteeRow = {
      committee_key: 'cdep:2:2024:1',
      chamber: 'cdep',
      name: 'Comisia pentru buget',
      legislature: '2024',
      committee_type: 'permanent',
      source_url: 'https://cdep.ro/comisii/buget',
    };
    expect(mapCommittee(cdep).chamber).toBe('camera_deputatilor');
    expect(mapCommittee({ ...cdep, chamber: 'senate' }).chamber).toBe('senat');
    expect(mapCommittee(cdep).sourceUrl).toBe('https://cdep.ro/comisii/buget');
  });

  it('PDL-003: the membership view model carries NO parliamentaryGroup / memberName / roleRaw keys', () => {
    const row: CommitteeMembershipCoreRow = {
      membership_key: 'senate:abc|def|membru|2024',
      membership_role: 'membru',
      joined_date: '2024-02-01',
      left_date: null,
      membership_is_bureau: false,
      membership_source_url: 'https://senat.ro/comisii/x',
    };
    const m = mapCommitteeMembership(row, null, null);
    expect(m.membershipKey).toBe('senate:abc|def|membru|2024'); // opaque, unparsed
    expect(m.role).toBe('membru');
    expect(m.isBureau).toBe(false);
    expect(m.committee).toBeNull();
    expect(m.member).toBeNull();
    // PDL-003 regression guard: raw group / name / role_raw are NEVER served.
    const keys = Object.keys(m);
    expect(keys).not.toContain('parliamentaryGroup');
    expect(keys).not.toContain('memberName');
    expect(keys).not.toContain('roleRaw');
    expect(keys).not.toContain('group');
  });
});

describe('legal act loader — dangling tolerance (Codex risk #3)', () => {
  it('returns null for a missing act_id and NEVER throws', async () => {
    const acts = {
      findActById: () => Promise.resolve(ok(null)),
      findActsByIds: () => Promise.resolve(ok([])),
    } as unknown as LegalActsRepo;
    const loader = makeLegalActLoader({ acts });
    await expect(loader.load('999999999')).resolves.toBeNull();
    await expect(loader.loadMany(['999999999', '1'])).resolves.toEqual([null, null]);
  });
});
