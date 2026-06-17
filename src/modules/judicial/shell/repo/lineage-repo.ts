/**
 * Judicial module — case lineage-candidate repo (plan 08 §4, JD-4). CANDIDATE-ONLY
 * (never rendered as fact), empty until gate #10. No PII: the served projection
 * carries the edge metadata only; the `evidence` jsonb is NOT declared on the
 * table row type and is never projected (leak audit #6).
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import type { JudicialLineageRepo } from '../../core/ports.js';
import type { JudicialLineageEdge } from '../../core/types.js';

type Db = Kysely<ProdDatabase>;
const ID_RE = /^\d+$/u;

export const makeJudicialLineageRepo = (db: Db): JudicialLineageRepo => ({
  async lineageForCase(caseId: string): Promise<Result<readonly JudicialLineageEdge[], ApiError>> {
    if (!ID_RE.test(caseId)) return ok([]);
    try {
      // Edges where the case is either endpoint. evidence jsonb never selected.
      const r = await sql<{
        lineage_candidate_id: string;
        from_case_id: string;
        to_case_id: string;
        lineage_type: string;
        method: string | null;
        confidence_score: string | null;
        validation_status: string;
      }>`
        select lc.lineage_candidate_id::text as lineage_candidate_id,
               lc.from_case_id::text as from_case_id, lc.to_case_id::text as to_case_id,
               lc.lineage_type, lc.method, lc.confidence_score::text as confidence_score,
               lc.validation_status
        from justice.case_lineage_candidates lc
        where lc.from_case_id = ${caseId}::bigint or lc.to_case_id = ${caseId}::bigint
        order by lc.lineage_candidate_id asc
      `.execute(db);
      return ok(
        r.rows.map((row) => ({
          lineageCandidateId: row.lineage_candidate_id,
          fromCaseId: row.from_case_id,
          toCaseId: row.to_case_id,
          lineageType: row.lineage_type,
          method: row.method,
          confidenceScore: row.confidence_score,
          validationStatus: row.validation_status,
        }))
      );
    } catch (error) {
      return err(databaseError('lineage.lineageForCase failed', error));
    }
  },
});
