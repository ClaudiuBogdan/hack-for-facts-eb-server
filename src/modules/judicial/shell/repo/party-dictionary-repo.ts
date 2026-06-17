/**
 * Judicial module — the GATED party-name dictionary repo (plan 08 §3.1). THE
 * CENTERPIECE of the privacy mechanism.
 *
 * This is the **ONLY** file in the entire module that names
 * `justice.party_name_keys.display_name`, and it does so inside parameterized SQL
 * that re-asserts the publishable predicate:
 *   1. `party_kind IN ('company','public_entity')` (defence-in-depth vs DB CHECK),
 *   2. the name-key traces to ≥1 case_party row whose `classifier_rule ∈
 *      PUBLISHABLE_RULES` AND whose `classifier_version` the server recognizes.
 * `display_name` never escapes except wrapped as a `PublishableName` value object.
 *
 * The static leak-audit test (§12 test 1) greps the module source and asserts
 * `display_name` appears ONLY in this file. The runtime SQL-log audit (test 2)
 * asserts it is SELECTed only by these queries.
 *
 * GATE SELF-DISABLE (§3.1 req 1): the predicate filters on the recognized
 * `CLASSIFIER_VERSION`. If the loader writes a version the server does not pin,
 * those rows do not satisfy the EXISTS, so the name is simply withheld (no leak),
 * which is the safe failure mode.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { CLASSIFIER_VERSION, PUBLISHABLE_PARTY_KINDS, PUBLISHABLE_RULES } from './constants.js';

import type { PartyDictionaryRepo } from '../../core/ports.js';
import type { PublishableName } from '../../core/types.js';

type Db = Kysely<ProdDatabase>;
const ID_RE = /^\d+$/u;

interface DictRow {
  name_key_id: string;
  display_name: string;
  party_kind: string;
  legal_form: string | null;
}

const mapName = (r: DictRow): PublishableName => ({
  nameKeyId: r.name_key_id,
  displayName: r.display_name,
  partyKind: r.party_kind as 'company' | 'public_entity',
  legalForm: r.legal_form,
});

/** Parameterized arrays of the publishable rule + kind + version sets. */
const rulesArr = sql`array[${sql.join(
  PUBLISHABLE_RULES.map((r) => sql`${r}`),
  sql`, `
)}]`;
const kindsArr = sql`array[${sql.join(
  PUBLISHABLE_PARTY_KINDS.map((k) => sql`${k}`),
  sql`, `
)}]`;

export const makeJudicialPartyDictionaryRepo = (db: Db): PartyDictionaryRepo => {
  const getPublishableNames = async (
    nameKeyIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, PublishableName>, ApiError>> => {
    const ids = [...new Set(nameKeyIds.filter((id) => ID_RE.test(id)))];
    if (ids.length === 0) return ok(new Map());
    const idArr = sql`array[${sql.join(
      ids.map((id) => sql`${id}::bigint`),
      sql`, `
    )}]`;
    try {
      // display_name is read HERE ONLY. The EXISTS re-asserts the publishable rule
      // + the recognized classifier_version so an unrecognized loader version
      // self-disables the gate (the name is withheld, not leaked).
      const r = await sql<DictRow>`
        select k.name_key_id::text as name_key_id, k.display_name, k.party_kind, k.legal_form
        from justice.party_name_keys k
        where k.name_key_id = any(${idArr})
          and k.party_kind = any(${kindsArr})
          and exists (
            select 1 from justice.case_parties p
            where p.name_key_id = k.name_key_id
              and p.party_kind = any(${kindsArr})
              and p.classifier_rule = any(${rulesArr})
              and p.classifier_version = ${CLASSIFIER_VERSION}
          )
      `.execute(db);
      const out = new Map<string, PublishableName>();
      for (const row of r.rows) out.set(row.name_key_id, mapName(row));
      return ok(out);
    } catch (error) {
      return err(databaseError('partyDictionary.getPublishableNames failed', error));
    }
  };

  const getPublishableName = async (
    nameKeyId: string
  ): Promise<Result<PublishableName | null, ApiError>> => {
    const res = await getPublishableNames([nameKeyId]);
    if (res.isErr()) return err(res.error);
    return ok(res.value.get(nameKeyId) ?? null);
  };

  const resolveCompanyName = async (
    q: string,
    limit: number
  ): Promise<Result<readonly PublishableName[], ApiError>> => {
    const needle = q.trim();
    if (needle === '') return ok([]);
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    const pattern = '%' + needle.replace(/[\\%_]/gu, (m) => `\\${m}`) + '%';
    try {
      // Resolve names from the dictionary (company/public ONLY by CHECK + the
      // EXISTS gate). A person-name query returns ZERO rows — the system cannot
      // resolve a person. The result carries only matched dictionary display_names,
      // NEVER the user's query string echoed back (S1).
      const r = await sql<DictRow>`
        select k.name_key_id::text as name_key_id, k.display_name, k.party_kind, k.legal_form
        from justice.party_name_keys k
        where k.party_kind = any(${kindsArr})
          and k.display_name ilike ${pattern} escape '\\'
          and exists (
            select 1 from justice.case_parties p
            where p.name_key_id = k.name_key_id
              and p.party_kind = any(${kindsArr})
              and p.classifier_rule = any(${rulesArr})
              and p.classifier_version = ${CLASSIFIER_VERSION}
          )
        order by k.mention_count desc nulls last
        limit ${capped}
      `.execute(db);
      return ok(r.rows.map(mapName));
    } catch (error) {
      return err(databaseError('partyDictionary.resolveCompanyName failed', error));
    }
  };

  return { getPublishableName, getPublishableNames, resolveCompanyName };
};
