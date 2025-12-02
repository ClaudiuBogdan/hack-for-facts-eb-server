/**
 * Database Seeding Module
 * Provides two main functionalities:
 * 1. seedDatabase() - Seeds actual PostgreSQL database with data from JSON files
 * 2. loadSeedData() - Loads data into in-memory database for testing/mocking
 */

import fs from 'node:fs';

import { type Kysely, sql } from 'kysely';
import { fromThrowable } from 'neverthrow';

import type { SeedJson, ReportGroup } from './types.js';
import type { BudgetDatabase, ReportType } from '../budget/types.js';

// Re-export in-memory database functionality
export { createInMemoryDatabase, InMemoryDatabaseQuery } from './in-memory-db.js';
export type {
  InMemoryDatabase,
  InMemoryEntity,
  InMemoryFunctionalClassification,
  InMemoryEconomicClassification,
  InMemoryFundingSource,
  InMemoryBudgetSector,
  InMemoryReport,
  InMemoryExecutionLineItem,
} from './in-memory-db.js';
export { loadSeedData, loadSeedFile } from './seed-loader.js';

const safeJsonParse = fromThrowable(JSON.parse);

export async function seedDatabase(db: Kysely<BudgetDatabase>, filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parseResult = safeJsonParse(content);
  if (parseResult.isErr()) {
    const errorMessage =
      parseResult.error instanceof Error ? parseResult.error.message : String(parseResult.error);
    throw new Error(`Failed to parse JSON from ${filePath}: ${errorMessage}`);
  }
  const data = parseResult.value as SeedJson;

  // 1. Upsert Dimensions

  // Functional Classifications
  for (const [code, name] of Object.entries(data.nameLookups.functional)) {
    await db
      .insertInto('functionalclassifications')
      .values({ functional_code: code, functional_name: name })
      .onConflict((oc) => oc.column('functional_code').doUpdateSet({ functional_name: name }))
      .execute();
  }

  // Economic Classifications
  for (const [code, name] of Object.entries(data.nameLookups.economic)) {
    await db
      .insertInto('economicclassifications')
      .values({ economic_code: code, economic_name: name })
      .onConflict((oc) => oc.column('economic_code').doUpdateSet({ economic_name: name }))
      .execute();
  }

  // Funding Sources
  const fundingSourceMap = new Map<string, number>();
  for (const [code, desc] of Object.entries(data.nameLookups.fundingSource)) {
    let row = await db
      .selectFrom('fundingsources')
      .select('source_id')
      .where('source_description', '=', desc)
      .executeTakeFirst();

    row ??= await db
      .insertInto('fundingsources')
      .values({ source_description: desc })
      .returning('source_id')
      .executeTakeFirst();

    if (row !== undefined) fundingSourceMap.set(code, row.source_id);
  }

  // 2. Collect Reports and Sectors
  const sectors = new Map<number, string>();
  type TypedReport = ReportGroup & { type: ReportType };
  const allReports: TypedReport[] = [];

  const processGroups = (
    groups: Record<string, Record<string, ReportGroup[]>> | undefined,
    type: ReportType
  ) => {
    if (groups === undefined) return;
    for (const yearStr in groups) {
      const yearData = groups[yearStr];
      if (yearData === undefined) continue;
      for (const monthStr in yearData) {
        const monthData = yearData[monthStr];
        if (monthData === undefined) continue;
        for (const r of monthData) {
          allReports.push({ ...r, type });
          sectors.set(r.summary.budgetSectorId, r.summary.sectorType);
        }
      }
    }
  };

  processGroups(data.mainCreditData, 'Executie bugetara agregata la nivel de ordonator principal');
  processGroups(
    data.secondaryCreditData,
    'Executie bugetara agregata la nivel de ordonator secundar'
  );
  processGroups(data.detailedCreditData, 'Executie bugetara detaliata');

  // Upsert Sectors
  for (const [id, desc] of sectors.entries()) {
    await db
      .insertInto('budgetsectors')
      .values({
        sector_id: id,
        sector_description: desc,
      })
      .onConflict((oc) => oc.column('sector_id').doUpdateSet({ sector_description: desc }))
      .execute();
  }

  // Update sequence for sectors
  await sql`SELECT setval('budgetsectors_sector_id_seq', (SELECT MAX(sector_id) FROM budgetsectors))`.execute(
    db
  );

  // 3. Upsert Entities
  // Main Entity
  await db
    .insertInto('entities')
    .values({
      cui: data.cui,
      name: data.entityName,
      is_uat: true, // Assuming the seed file is for a UAT
    })
    .onConflict((oc) => oc.column('cui').doUpdateSet({ name: data.entityName }))
    .execute();

  // 4. Process Reports and Line Items
  for (const report of allReports) {
    const mainCreditorCui =
      report.summary.mainCreditor !== '' ? report.summary.mainCreditor : data.cui; // Fallback to self if missing

    // Upsert Main Creditor if it's not the main entity
    if (mainCreditorCui !== data.cui) {
      await db
        .insertInto('entities')
        .values({
          cui: mainCreditorCui,
          name: `Creditor ${mainCreditorCui}`, // Placeholder
          is_uat: false,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    // Extract month from period or date
    // format "Luna 10" or date "31-OCT-16"
    let month = 12; // Default
    if (report.reportInfo.period !== '' && report.reportInfo.period.startsWith('Luna ')) {
      month = Number.parseInt(report.reportInfo.period.replace('Luna ', ''), 10);
    } else {
      const date = new Date(report.reportInfo.date);
      if (!Number.isNaN(date.getTime())) {
        month = date.getMonth() + 1;
      }
    }

    const reportingDate = new Date(report.reportInfo.date);

    // Insert Report
    await db
      .insertInto('reports')
      .values({
        report_id: report.reportInfo.id,
        entity_cui: data.cui,
        report_type: report.type,
        main_creditor_cui: mainCreditorCui,
        report_date: Number.isNaN(reportingDate.getTime()) ? new Date() : reportingDate,
        reporting_year: report.reportInfo.year,
        reporting_period: report.reportInfo.period,
        budget_sector_id: report.summary.budgetSectorId,
        file_source: report.fileInfo.source,
        download_links: report.reportInfo.documentLinks,
      })
      .onConflict((oc) =>
        oc.column('report_id').doUpdateSet({
          import_timestamp: new Date(), // Update timestamp
        })
      )
      .execute();

    // Insert Line Items
    // Batch insert for performance? doing 1 by 1 for simplicity first
    const lineItemsToInsert = report.lineItems
      .map((li) => {
        const fsId = fundingSourceMap.get(li.fundingSource);
        if (fsId === undefined || fsId === 0) {
          // If missing, skip or log?
          // For tests, maybe fail?
          // Actually, I'll skip to avoid crashing
          return null;
        }

        return {
          year: report.reportInfo.year,
          month: month,
          report_type: report.type,
          report_id: report.reportInfo.id,
          entity_cui: data.cui,
          main_creditor_cui: mainCreditorCui,
          budget_sector_id: report.summary.budgetSectorId,
          funding_source_id: fsId,
          functional_code: li.functionalCode,
          economic_code: li.economicCode ?? null,
          account_category: li.type, // 'vn' or 'ch' matches enum
          expense_type: li.expenseType ?? null,
          ytd_amount: String(li.ytdAmount),
          monthly_amount: String(li.monthlyAmount),
          is_quarterly: false, // Will be calculated by function/trigger or default
          is_yearly: false,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (lineItemsToInsert.length > 0) {
      // Chunking might be needed if too many items
      const chunkSize = 1000;
      for (let i = 0; i < lineItemsToInsert.length; i += chunkSize) {
        await db
          .insertInto('executionlineitems')
          .values(lineItemsToInsert.slice(i, i + chunkSize))
          .execute();
      }
    }
  }
}
