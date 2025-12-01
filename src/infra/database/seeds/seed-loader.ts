/**
 * Seed Data Loader
 * Loads seed JSON files and populates the in-memory database
 */

import fs from 'node:fs';
import path from 'node:path';

import { fromThrowable } from 'neverthrow';

import { createInMemoryDatabase, type InMemoryDatabase } from './in-memory-db.js';

import type { SeedJson, ReportGroup } from './types.js';
import type { ReportType } from '../budget/types.js';

const safeJsonParse = fromThrowable(JSON.parse);

/**
 * Load all seed files from a directory and populate in-memory database
 */
export function loadSeedData(seedDir: string): InMemoryDatabase {
  const db = createInMemoryDatabase();

  if (!fs.existsSync(seedDir)) {
    throw new Error(`Seed directory does not exist: ${seedDir}`);
  }

  const files = fs.readdirSync(seedDir).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(seedDir, file);
    loadSeedFile(db, filePath);
  }

  return db;
}

/**
 * Load a single seed file and populate in-memory database
 */
export function loadSeedFile(db: InMemoryDatabase, filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parseResult = safeJsonParse(content);

  if (parseResult.isErr()) {
    const errorMessage =
      parseResult.error instanceof Error ? parseResult.error.message : String(parseResult.error);
    throw new Error(`Failed to parse JSON from ${filePath}: ${errorMessage}`);
  }

  const data = parseResult.value as SeedJson;

  // 1. Load Dimensions
  loadFunctionalClassifications(db, data);
  loadEconomicClassifications(db, data);
  loadFundingSources(db, data);

  // 2. Create funding source map for lookups
  const fundingSourceMap = createFundingSourceMap(db, data);

  // 3. Load entity
  loadEntity(db, data);

  // 4. Process reports and line items
  processReports(
    db,
    data,
    fundingSourceMap,
    data.mainCreditData,
    'Executie bugetara agregata la nivel de ordonator principal'
  );
  processReports(
    db,
    data,
    fundingSourceMap,
    data.secondaryCreditData,
    'Executie bugetara agregata la nivel de ordonator secundar'
  );
  processReports(
    db,
    data,
    fundingSourceMap,
    data.detailedCreditData,
    'Executie bugetara detaliata'
  );
}

function loadFunctionalClassifications(db: InMemoryDatabase, data: SeedJson): void {
  for (const [code, name] of Object.entries(data.nameLookups.functional)) {
    db.functionalClassifications.set(code, {
      functional_code: code,
      functional_name: name,
    });
  }
}

function loadEconomicClassifications(db: InMemoryDatabase, data: SeedJson): void {
  for (const [code, name] of Object.entries(data.nameLookups.economic)) {
    db.economicClassifications.set(code, {
      economic_code: code,
      economic_name: name,
    });
  }
}

function loadFundingSources(db: InMemoryDatabase, data: SeedJson): void {
  for (const [, desc] of Object.entries(data.nameLookups.fundingSource)) {
    // Check if already exists
    const existing = Array.from(db.fundingSources.values()).find(
      (fs) => fs.source_description === desc
    );

    if (existing === undefined) {
      const id = db.nextFundingSourceId++;
      db.fundingSources.set(id, {
        source_id: id,
        source_description: desc,
      });
    }
  }
}

function createFundingSourceMap(db: InMemoryDatabase, data: SeedJson): Map<string, number> {
  const map = new Map<string, number>();

  for (const [code, desc] of Object.entries(data.nameLookups.fundingSource)) {
    const source = Array.from(db.fundingSources.values()).find(
      (fs) => fs.source_description === desc
    );
    if (source !== undefined) {
      map.set(code, source.source_id);
    }
  }

  return map;
}

function loadEntity(db: InMemoryDatabase, data: SeedJson): void {
  if (db.entities.has(data.cui)) {
    return; // Already exists
  }

  db.entities.set(data.cui, {
    cui: data.cui,
    name: data.entityName,
    is_uat: true,
  });
}

function processReports(
  db: InMemoryDatabase,
  data: SeedJson,
  fundingSourceMap: Map<string, number>,
  reportGroups: Record<string, Record<string, ReportGroup[]>> | undefined,
  reportType: ReportType
): void {
  if (reportGroups === undefined) return;

  for (const yearStr in reportGroups) {
    const yearData = reportGroups[yearStr];
    if (yearData === undefined) continue;

    for (const monthStr in yearData) {
      const monthData = yearData[monthStr];
      if (monthData === undefined) continue;

      for (const report of monthData) {
        processReport(db, data, fundingSourceMap, report, reportType);
      }
    }
  }
}

function processReport(
  db: InMemoryDatabase,
  data: SeedJson,
  fundingSourceMap: Map<string, number>,
  report: ReportGroup,
  reportType: ReportType
): void {
  // Load budget sector if not exists
  if (!db.budgetSectors.has(report.summary.budgetSectorId)) {
    db.budgetSectors.set(report.summary.budgetSectorId, {
      sector_id: report.summary.budgetSectorId,
      sector_description: report.summary.sectorType,
    });

    if (report.summary.budgetSectorId >= db.nextBudgetSectorId) {
      db.nextBudgetSectorId = report.summary.budgetSectorId + 1;
    }
  }

  // Load main creditor entity if different from main entity
  const mainCreditorCui =
    report.summary.mainCreditor !== '' ? report.summary.mainCreditor : data.cui;

  if (mainCreditorCui !== data.cui && !db.entities.has(mainCreditorCui)) {
    db.entities.set(mainCreditorCui, {
      cui: mainCreditorCui,
      name: `Creditor ${mainCreditorCui}`,
      is_uat: false,
    });
  }

  // Extract month from period or date
  let month = 12;
  if (report.reportInfo.period !== '' && report.reportInfo.period.startsWith('Luna ')) {
    month = Number.parseInt(report.reportInfo.period.replace('Luna ', ''), 10);
  } else {
    const date = new Date(report.reportInfo.date);
    if (!Number.isNaN(date.getTime())) {
      month = date.getMonth() + 1;
    }
  }

  const reportingDate = new Date(report.reportInfo.date);

  // Add report to in-memory database
  if (!db.reports.has(report.reportInfo.id)) {
    db.reports.set(report.reportInfo.id, {
      report_id: report.reportInfo.id,
      entity_cui: data.cui,
      report_type: reportType,
      main_creditor_cui: mainCreditorCui,
      report_date: Number.isNaN(reportingDate.getTime()) ? new Date() : reportingDate,
      reporting_year: report.reportInfo.year,
      reporting_period: report.reportInfo.period,
      budget_sector_id: report.summary.budgetSectorId,
      file_source: report.fileInfo.source,
      download_links: report.reportInfo.documentLinks,
      import_timestamp: new Date(),
    });
  }

  // Add line items
  for (const li of report.lineItems) {
    const fsId = fundingSourceMap.get(li.fundingSource);
    if (fsId === undefined || fsId === 0) {
      continue; // Skip if funding source not found
    }

    db.executionLineItems.push({
      line_item_id: db.nextLineItemId++,
      year: report.reportInfo.year,
      month: month,
      report_type: reportType,
      report_id: report.reportInfo.id,
      entity_cui: data.cui,
      main_creditor_cui: mainCreditorCui,
      budget_sector_id: report.summary.budgetSectorId,
      funding_source_id: fsId,
      functional_code: li.functionalCode,
      economic_code: li.economicCode ?? null,
      account_category: li.type,
      expense_type: li.expenseType ?? null,
      ytd_amount: String(li.ytdAmount),
      monthly_amount: String(li.monthlyAmount),
      is_quarterly: false,
      is_yearly: false,
    });
  }
}
