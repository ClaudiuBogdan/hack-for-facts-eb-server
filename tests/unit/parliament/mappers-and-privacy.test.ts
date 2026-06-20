/**
 * Parliament unit tests — mappers + the PRIVACY invariant (§2.6). Asserts that the
 * `attrs` whitelist drops unknown/PII keys, declaration metadata never carries
 * file_hash, the tally shape is correct, bigint/date stay strings, and the
 * dangling legal-act loader tolerates a missing id (returns null, never throws).
 */

import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeLegalActLoader, type LegalActsRepo } from '@/modules/legal/index.js';
import { BILL_ATTR_KEYS, MEMBER_ATTR_KEYS, VOTE_ATTR_KEYS } from '@/modules/parliament/core/types.js';
import {
  mapBill,
  mapDeclaration,
  mapMember,
  mapVote,
  safeAttrs,
  type BillRow,
  type DeclarationRow,
  type MemberRow,
  type VoteRow,
} from '@/modules/parliament/shell/repo/mappers.js';

describe('safeAttrs — privacy whitelist (Codex BLOCKER #4)', () => {
  it('keeps only whitelisted keys and drops everything else', () => {
    const raw = {
      status_text: 'adoptat',
      // PII / provenance that must NEVER leak even if it lands in attrs:
      birth_date_text: '12 mai 1970',
      birth_date_parse_method: 'regex',
      cluster_key: 'secret-anchor',
      file_hash: 'deadbeef',
      evidence: { matcher: 'x' },
      unknown_future_key: 'leak?',
    };
    const out = safeAttrs(raw, BILL_ATTR_KEYS);
    expect(out['status_text']).toBe('adoptat');
    expect(out['birth_date_text']).toBeUndefined();
    expect(out['cluster_key']).toBeUndefined();
    expect(out['file_hash']).toBeUndefined();
    expect(out['evidence']).toBeUndefined();
    expect(out['unknown_future_key']).toBeUndefined();
  });

  it('drops non-primitive values (objects/arrays) even for whitelisted keys', () => {
    const out = safeAttrs({ status_text: { nested: 'object' }, source_title: ['a'] }, BILL_ATTR_KEYS);
    expect(out['status_text']).toBeUndefined();
    expect(out['source_title']).toBeUndefined();
  });

  it('returns an empty object for null / array / non-object input', () => {
    expect(safeAttrs(null, MEMBER_ATTR_KEYS)).toEqual({});
    expect(safeAttrs([1, 2], MEMBER_ATTR_KEYS)).toEqual({});
    expect(safeAttrs('string', MEMBER_ATTR_KEYS)).toEqual({});
  });
});

describe('mapMember — bigint/date as strings, attrs whitelisted, no PII', () => {
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
    attrs: { source_title: 'X', profile_url: 'http://x', birth_date_text: 'LEAK' },
  };

  it('emits string scalars and a whitelisted attrs object', () => {
    const m = mapMember(row);
    expect(m.personId).toBe('2264');
    expect(typeof m.personId).toBe('string');
    expect(m.birthDate).toBe('1970-05-12');
    expect(m.attrs['source_title']).toBe('X');
    expect(m.attrs['profile_url']).toBe('http://x');
    // The PII key that leaked into attrs is stripped.
    expect((m.attrs as Record<string, unknown>)['birth_date_text']).toBeUndefined();
  });

  it('surfaces profileUrl flat from the whitelisted attrs (Gap 4)', () => {
    expect(mapMember(row).profileUrl).toBe('http://x');
  });

  it('leaves profileUrl null when attrs carries no profile_url', () => {
    const noProfile: MemberRow = { ...row, attrs: { source_title: 'X' } };
    expect(mapMember(noProfile).profileUrl).toBeNull();
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

describe('mapVote — tally shape + tallyMismatch from attrs', () => {
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
    attrs: { tally_mismatch: true, source_title: 'ST', secret: 'x' },
  };

  it('maps the tally with camelCase nuAVotat and surfaces tallyMismatch', () => {
    const v = mapVote(row);
    expect(v.tally).toEqual({ pentru: 275, impotriva: 0, abtinere: 1, nuAVotat: 1, present: 277 });
    expect(v.tallyMismatch).toBe(true);
    expect(v.attrs['source_title']).toBe('ST');
    expect((v.attrs as Record<string, unknown>)['secret']).toBeUndefined();
    expect(VOTE_ATTR_KEYS).toContain('tally_mismatch');
  });

  // M1 regression: the loader writes tally_mismatch as a JSON OBJECT, not a boolean.
  // safeAttrs drops the object (non-primitive), so the old `attrs['tally_mismatch']
  // === true` was false for 0/4855 votes. The flag is now read from RAW attrs (presence),
  // and the object itself is never exposed (§2.6 — only a boolean is surfaced).
  it('surfaces tallyMismatch=true when tally_mismatch is an OBJECT (the real loader shape)', () => {
    const v = mapVote({ ...row, attrs: { tally_mismatch: { pentru: { official: 168, recorded: 84 } }, source_title: 'ST' } });
    expect(v.tallyMismatch).toBe(true);
    // the object internals must NOT leak into the whitelisted attrs view
    expect((v.attrs as Record<string, unknown>)['tally_mismatch']).toBeUndefined();
  });

  it('leaves tallyMismatch=false when attrs carries no tally_mismatch key', () => {
    expect(mapVote({ ...row, attrs: { source_title: 'ST' } }).tallyMismatch).toBe(false);
    expect(mapVote({ ...row, attrs: null }).tallyMismatch).toBe(false);
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

describe('mapBill — dates/timestamps as strings, attrs whitelisted, flat classification', () => {
  it('keeps known bill attrs and drops the rest', () => {
    const row: BillRow = {
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
      attrs: { status_text: 'adoptat', last_event_date: '2023-12-01', internal_secret: 'x' },
      source_updated_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    };
    const b = mapBill(row);
    expect(b.finalLawNumber).toBe('423');
    expect(b.attrs['status_text']).toBe('adoptat');
    expect(b.attrs['last_event_date']).toBe('2023-12-01');
    expect((b.attrs as Record<string, unknown>)['internal_secret']).toBeUndefined();
    expect(BILL_ATTR_KEYS).toContain('status_text');
    expect(b.lastEventDate).toBe('2023-12-01'); // surfaced flat from the extracted column
  });

  it('surfaces statusText + billType flat from the extracted columns (Gap 2)', () => {
    const row: BillRow = {
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
      last_event_date: '2023-12-29',
      attrs: {},
      source_updated_at: null,
      updated_at: null,
    };
    const b = mapBill(row);
    expect(b.statusText).toBe('Lege 423/2023 29.12.2023');
    expect(b.billType).toBe('Proiect de Lege pentru aprobarea O.U.G. nr. 21/2012');
    expect(b.lastEventDate).toBe('2023-12-29');
  });

  it('leaves statusText / billType null when the source carries neither', () => {
    const row: BillRow = {
      bill_key: 'x',
      plx_number: null,
      plx_year: null,
      senate_number: null,
      senate_year: null,
      title: null,
      final_law_number: null,
      final_law_year: null,
      status_text: null,
      bill_type: null,
      last_event_date: null,
      attrs: {},
      source_updated_at: null,
      updated_at: null,
    };
    const b = mapBill(row);
    expect(b.statusText).toBeNull();
    expect(b.billType).toBeNull();
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
