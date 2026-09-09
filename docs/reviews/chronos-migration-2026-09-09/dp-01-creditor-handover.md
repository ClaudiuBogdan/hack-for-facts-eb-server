# DP-01 — annual and monthly budget summaries double count a mid-year creditor handover

Status: diagnosed 2026-09-09 (lead, live Chronos reads via db-read); fix location decided below.

## What is wrong

Budget execution reports are cumulative year-to-date (YTD). Chronos derives every period
flag (`is_yearly` / `is_latest_ytd`, `is_monthly`, `previous_available_month`,
`monthly_amount = ytd − previous ytd`) **per scope**, and the scope key includes
`main_creditor_cui` (scrapper `src/sources/anaf-extranet/recompute/execution-shadow-writer.ts`,
scope = entity × main creditor × sector; design
`prod-db/BUDGET_FACT_REBUILD_REQUIREMENTS_2026-09-02.md` §2.3(a)).

When an entity's reports move from one main creditor to another mid-year, the source keeps
reporting the entity's cumulative YTD under the new creditor. Two scopes now exist for one
entity-year:

- the old creditor's last row is that scope's max month → `is_yearly = true`;
- the new creditor's first row starts a fresh chain "from January" → its `monthly_amount`
  is the whole cumulative YTD, and its December row is also `is_yearly = true`.

`budget.mv_execution_summary_annual` (grouped by year, entity, creditor, report type) keeps
both yearly rows; the server collapses across creditors (`budget-repo.ts`, rankings,
timeseries, entity page), so the annual figure is inflated by the old creditor's last YTD.
The monthly MV carries the mirror image: a one-month spike equal to the accumulated YTD.

## Evidence (Chronos `transparenta_prod`, 2026-09-09)

Entity 26429279, 2024, `Executie bugetara detaliata`, expense:

| creditor | months | monthly rows (expense)                                                                  | Dec/last YTD     |
| -------- | ------ | --------------------------------------------------------------------------------------- | ---------------- |
| 4283422  | 1–6    | 125.2M, 123.3M, 213.6M, 168.1M, 223.6M, 15.4M                                           | 869,074,554.38   |
| 26429279 | 7–12   | 0.00 (July: 2 lines, YTD 0), **1,305,581,686.29** (Aug), 146.2M, 144.7M, 234.0M, 219.3M | 2,049,760,834.64 |

The August "monthly" value is the cumulative January–August YTD (it exceeds the old
creditor's whole first half). The annual MV sums 869,074,554.38 + 2,049,760,834.64; the true
annual is 2,049,760,834.64 (what Phoenix serves, whose flags are per entity:
scrapper `docs/BUSINESS_LOGIC.md` §8.2 `is_yearly = month = max(month) over (entity, year, report_type)`).

Population of the defect (monthly MV, execution, expense side, entity-years with exactly two
creditors and **disjoint** month ranges):

| year | handovers | chain continued (new first YTD ≥ 0.9 × old last YTD) | chain restarted | double-counted amount |
| ---- | --------- | ---------------------------------------------------- | --------------- | --------------------- |
| 2023 | 115       | 115                                                  | 0               | 804,851,998           |
| 2024 | 1         | 1                                                    | 0               | 869,074,554           |
| 2025 | 54        | 54                                                   | 0               | 150,725,385           |

No entity-year has more than two creditors. **Every handover continues the chain; none
restarts.** The 2023 figure equals the review's unexplained 804.9M Phoenix→Chronos MV delta
to the unit, so the residual is closed. Parallel reporting (two creditors reporting every
month, e.g. entity 10065309) is a different situation: two real streams, correctly summed.

`budget.mv_commitment_summary_annual` has the same grain (`group by … main_creditor_cui …`),
so the commitments tree is exposed to the same defect; not measured yet.

## Where the fix belongs

The flags are wrong at the source, and every server path reads them (the MVs, the fact-path
`is_yearly` / `is_monthly` predicates in `legacy-analytics-repo.ts` and the grouped repos, and
`asOf.latestCompleteYear`). A server-side "keep the later creditor" rule is not possible on the
annual MV (no month column) and would duplicate a chain rule the loader already owns. The
correct fix is in the scrapper's flag derivation, then an MV refresh:

1. **Chain linkage across a handover.** When a scope (entity, year, report type, sector) has a
   first report under creditor B and another creditor A has reports for the same entity-year
   with a strictly earlier max month, B's first row links to A's last row:
   `previous_available_month` = A's max month, `monthly_amount = ytd − A's last ytd`, and A's
   last row is **not** `is_latest_ytd` (the chain continued). Parallel creditors (overlapping
   months) keep separate chains exactly as today.
2. **Empty first report.** The July row under the new creditor has 2 lines and YTD 0 (a
   header-only report). Under the rule above it would produce a −869M July delta and a +1.3B
   August delta. The loader's admission already has `financially_admitted` / `report_status`
   on `scope_periods` (unpopulated on Chronos today); a zero-line report must not become a
   chain member, so the August row links to June instead.
3. **Refresh** `mv_execution_summary_{annual,monthly,quarterly}` and the commitment
   counterparts; re-run the parity replay (`pnpm test:gm:cutover`) — the 2023–2025 deltas in
   the table above must vanish.

Server side (this repo), independent of the scrapper timing:

- A golden assertion pins 26429279/2024 detailed expense at 2,049,760,834.64 on the annual
  path and rejects the 1.3B August monthly spike, so the defect is visible until fixed and
  cannot come back.
- Until the scrapper lands, the annual/monthly roots keep serving the wrong number; the caveat
  path was rejected by the owner as a stopgap, so nothing is masked.

Owner decision 2026-09-09: implement in the scrapper repository. The requirement spec
(`prod-db/DP01_CHAIN_LINEAGE_REQUIREMENTS_2026-09-09.md`, scrapper repo) went through seven
Codex review rounds and is approved at revision 7; the panel evidence (four memos, tie-breaker,
synthesis and the seven reviews) sits in
`prod-db/evidence/dp-01-creditor-handover-2026-09-09/`. Headline rules: financial YTD chain per
(entity, year, report type, family, sector) across creditors; source presence stays per creditor;
persisted predecessor report ids; annual MVs keep `main_creditor_cui`; the July 2024
declared-zero report stays pending, so the 26429279/2024 chain is REFUSED (not rewritten) until
its admission is decided — the served total stays 2,918,835,389.02 until then and
2,049,760,834.64 is the post-admission target.
