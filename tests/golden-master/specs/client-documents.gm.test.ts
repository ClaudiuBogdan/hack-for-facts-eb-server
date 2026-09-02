/**
 * Golden Master Tests: the real client documents.
 *
 * Replays every legacy GraphQL document the client sends over `/graphql`
 * (corpus/client-documents.json — exact document text and variables derived
 * from the client repo by scripts/gm/gen-client-corpus.mts) and:
 *
 * - SNAPSHOT mode (TEST_GM_API_URL only): records/compares the envelope
 *   `{ status, data, errors }` against `snapshots/client-documents/<id>.snap.json`.
 *   `live` cases must answer without errors; `invalid-today` cases must answer
 *   WITH errors (that error envelope is their expectation).
 * - CUTOVER mode (TEST_GM_BASELINE_URL + TEST_GM_API_URL): sends the same
 *   document+variables to both endpoints, compares the envelopes (compare.ts),
 *   classifies every difference, writes reports/<runId>/cases/<id>.json and
 *   fails on any case defect, any contract-break or any non-allowlisted
 *   data-parity difference (cutover.ts / report.ts). The cases this file will
 *   execute are registered in reports/<runId>/planned.json at collection time
 *   so the teardown summary can prove every planned case wrote a report — a
 *   `-t` filtered run therefore fails reconciliation by design.
 *
 * `dead` cases (fetchers with no consumer) stay in the corpus so their removal
 * is deliberate, but are skipped unless TEST_GM_INCLUDE_DEAD=true.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadAllowlist } from '../allowlist.js';
import {
  getBaselineClient,
  getClient,
  getComparisonMode,
  type GoldenMasterClient,
} from '../client.js';
import { loadCorpus, type CorpusCase } from '../corpus.js';
import { describeFailure, fetchTimeoutForCase, runCutoverCase } from '../cutover.js';
import { toPlain } from '../envelope.js';
import { resolveReportDir, resolveRunId, writePlanned } from '../report.js';

const corpus = loadCorpus();
const includeDead = process.env['TEST_GM_INCLUDE_DEAD'] === 'true';
const DEFAULT_CASE_TIMEOUT_MS = 30_000;
const SPEC_NAME = 'specs/client-documents.gm.test.ts';

const planned = corpus.filter((entry) => entry.status !== 'dead' || includeDead);

if (getComparisonMode() === 'cutover') {
  writePlanned(
    resolveReportDir(),
    resolveRunId(),
    SPEC_NAME,
    planned.map((entry) => entry.id)
  );
}

function caseTitle(entry: CorpusCase): string {
  return `[GM] ${entry.operationName ?? 'anonymous'} - ${entry.id} (${entry.status})`;
}

describe('[Golden Master] Client documents (legacy /graphql transport)', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  it('corpus covers the 51 legacy documents the client sends', () => {
    const distinctDocuments = new Set(corpus.map((entry) => entry.document));
    expect(distinctDocuments.size).toBe(51);
    expect(corpus.filter((entry) => entry.status === 'invalid-today')).toHaveLength(4);
    expect(corpus.filter((entry) => entry.status === 'dead')).toHaveLength(5);
  });

  for (const entry of corpus) {
    const timeout = entry.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;

    if (entry.status === 'dead' && !includeDead) {
      it.skip(`${caseTitle(entry)} — dead fetcher, excluded from the required set (TEST_GM_INCLUDE_DEAD=true to run)`, () => {
        // Deliberately kept in the corpus: see the inventory, §0 item 3.
      });
      continue;
    }

    it(
      caseTitle(entry),
      async () => {
        if (getComparisonMode() === 'cutover') {
          const baseline = getBaselineClient();
          if (baseline === null) {
            throw new Error('cutover mode without a baseline client');
          }

          const result = await runCutoverCase(
            {
              id: entry.id,
              key: entry.key,
              documentHash: entry.documentHash,
              variablesHash: entry.variablesHash,
              operationName: entry.operationName,
              status: entry.status,
              source: entry.source,
              document: entry.document,
              variables: entry.variables,
            },
            {
              baseline,
              target: client,
              allowlist: loadAllowlist(),
              runId: resolveRunId(),
              fetchTimeoutMs: fetchTimeoutForCase(timeout),
            }
          );

          if (result.report.verdict === 'fail') {
            throw new Error(describeFailure(result));
          }
          return;
        }

        // SNAPSHOT mode: record / compare the envelope of the target.
        const envelope = await client.queryEnvelope(entry.document, entry.variables, {
          timeoutMs: fetchTimeoutForCase(timeout),
        });
        const errorCount = envelope.errors?.length ?? 0;

        if (entry.status === 'invalid-today') {
          expect(
            errorCount,
            `${entry.id} is marked invalid-today but the endpoint accepted it — re-classify the corpus entry`
          ).toBeGreaterThan(0);
        } else {
          expect(
            errorCount,
            `${entry.id}: ${(envelope.errors ?? []).map((e) => e.message).join(' | ')}`
          ).toBe(0);
          expect(envelope.status).toBe(200);
        }

        const snapshotEnvelope = toPlain({
          status: envelope.status,
          ...(envelope.data !== undefined && { data: envelope.data }),
          ...(envelope.errors !== undefined && { errors: envelope.errors }),
        });
        await expect(snapshotEnvelope).toMatchNormalizedSnapshot(
          `../snapshots/client-documents/${entry.id}.snap.json`
        );
      },
      timeout
    );
  }
});
