/**
 * Vitest globalSetup for the Golden Master run.
 *
 * - `setup`: mints one run id (timestamp + random nonce) for the whole run,
 *   creates its report directory EXCLUSIVELY in cutover mode (a reused id is
 *   refused) and hands the id to the workers via `provide` (workers read it
 *   in setup.ts and export it as `TEST_GM_RUN_ID`).
 * - `teardown`: in cutover mode, assembles `summary.json` + `summary.md` from
 *   the per-case files, reconciles them against `planned.json`, computes the
 *   stale allowlist entries, and THROWS (failing the run) when the summary is
 *   not OK — a failed case, a planned/executed mismatch, or (strict) a stale
 *   allowlist entry.
 */

import { existsSync } from 'node:fs';

import {
  findStaleEntries,
  isStrictAllowlist,
  loadAllowlist,
  resolveAllowlistPath,
} from './allowlist.js';
import {
  createRunDir,
  newRunId,
  readCaseReports,
  resolveReportDir,
  writeSummary,
} from './report.js';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    gmRunId: string;
  }
}

let runId: string | null = null;

function isCutover(): boolean {
  return process.env['TEST_GM_BASELINE_URL'] !== undefined;
}

export function setup(project: TestProject): void {
  runId = process.env['TEST_GM_RUN_ID'] ?? newRunId();
  if (isCutover()) {
    const dir = createRunDir(resolveReportDir(), runId);
    console.log(`\n[Golden Master cutover] run ${runId} → ${dir}`);
  }
  project.provide('gmRunId', runId);
}

export function teardown(): void {
  if (runId === null) return;
  if (!isCutover()) return;

  const reportDir = resolveReportDir();
  const reports = readCaseReports(reportDir, runId);
  const allowlist = existsSync(resolveAllowlistPath()) ? loadAllowlist() : { entries: [] };
  const used = new Set(reports.flatMap((report) => report.allowedEntryIds));
  const stale = findStaleEntries(allowlist, used);
  const strictAllowlist = isStrictAllowlist();

  const written = writeSummary({
    reportDir,
    runId,
    allowlist: allowlist.entries,
    staleAllowlistEntries: stale,
    strictAllowlist,
  });
  if (written === null) {
    console.log(`\n[Golden Master cutover] no case reports were written for run ${runId}\n`);
    return;
  }

  const { totals, reconciliation, ok } = written.summary;
  console.log(
    `\n[Golden Master cutover] run ${runId}: ${String(totals.cases)} case(s), ` +
      `${String(totals.pass)} pass, ${String(totals.passWithWarnings)} pass-with-warnings, ` +
      `${String(totals.fail)} fail — contract-break ${String(totals.differences['contract-break'])}, ` +
      `data-parity ${String(totals.differences['data-parity'])}, rounding ${String(totals.differences.rounding)}, ` +
      `leaves compared ${String(totals.leavesCompared)}`
  );
  if (reconciliation.planned !== null && !reconciliation.ok) {
    console.log(
      `[Golden Master cutover] RECONCILIATION MISMATCH: planned ${String(reconciliation.planned)}, executed ${String(reconciliation.executed)}; missing [${reconciliation.missing.join(', ')}]; unplanned [${reconciliation.unplanned.join(', ')}]`
    );
  }
  if (stale.length > 0) {
    console.log(
      `[Golden Master cutover] ${strictAllowlist ? 'FAIL' : 'WARNING'}: ${String(stale.length)} allowlist entr${stale.length === 1 ? 'y' : 'ies'} matched no difference in this run (stale)`
    );
  }
  console.log(`[Golden Master cutover] summary: ${written.markdownPath}\n`);

  if (!ok) {
    // Vitest 4 logs a teardown error as "error during close" but still exits
    // 0 when every test passed (verified: a `-t` filtered run reported the
    // reconciliation mismatch and exited 0). The exit code is set explicitly
    // so a summary that is NOT OK fails the process, not only the log.
    process.exitCode = 1;
    throw new Error(
      `[Golden Master cutover] run ${runId} is NOT OK (fail ${String(totals.fail)}, reconciliation ${reconciliation.ok ? 'ok' : 'mismatch'}, stale allowlist entries ${String(stale.length)}${strictAllowlist ? ' [strict]' : ''}) — see ${written.markdownPath}`
    );
  }
}
