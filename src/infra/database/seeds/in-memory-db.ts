/**
 * In-Memory Database Mock
 * Provides an in-memory representation of the budget database
 * populated from seed files for testing and development
 */

import type { ReportType } from '../budget/types.js';

// ========= In-Memory Data Structures =========

export interface InMemoryEntity {
  cui: string;
  name: string;
  is_uat: boolean;
}

export interface InMemoryFunctionalClassification {
  functional_code: string;
  functional_name: string;
}

export interface InMemoryEconomicClassification {
  economic_code: string;
  economic_name: string;
}

export interface InMemoryFundingSource {
  source_id: number;
  source_description: string;
}

export interface InMemoryBudgetSector {
  sector_id: number;
  sector_description: string;
}

export interface InMemoryReport {
  report_id: string;
  entity_cui: string;
  report_type: ReportType;
  main_creditor_cui: string;
  report_date: Date;
  reporting_year: number;
  reporting_period: string;
  budget_sector_id: number;
  file_source: string;
  download_links: string[];
  import_timestamp: Date;
}

export interface InMemoryExecutionLineItem {
  line_item_id: number;
  year: number;
  month: number;
  report_type: ReportType;
  report_id: string;
  entity_cui: string;
  main_creditor_cui: string;
  budget_sector_id: number;
  funding_source_id: number;
  functional_code: string;
  economic_code: string | null;
  account_category: 'vn' | 'ch';
  expense_type: 'dezvoltare' | 'functionare' | null;
  ytd_amount: string;
  monthly_amount: string;
  is_quarterly: boolean;
  is_yearly: boolean;
}

/**
 * In-memory database store
 */
export interface InMemoryDatabase {
  entities: Map<string, InMemoryEntity>;
  functionalClassifications: Map<string, InMemoryFunctionalClassification>;
  economicClassifications: Map<string, InMemoryEconomicClassification>;
  fundingSources: Map<number, InMemoryFundingSource>;
  budgetSectors: Map<number, InMemoryBudgetSector>;
  reports: Map<string, InMemoryReport>;
  executionLineItems: InMemoryExecutionLineItem[];

  // Auto-increment counters
  nextFundingSourceId: number;
  nextBudgetSectorId: number;
  nextLineItemId: number;
}

/**
 * Create an empty in-memory database
 */
export function createInMemoryDatabase(): InMemoryDatabase {
  return {
    entities: new Map(),
    functionalClassifications: new Map(),
    economicClassifications: new Map(),
    fundingSources: new Map(),
    budgetSectors: new Map(),
    reports: new Map(),
    executionLineItems: [],
    nextFundingSourceId: 1,
    nextBudgetSectorId: 1,
    nextLineItemId: 1,
  };
}

/**
 * Query helpers for in-memory database
 */
export class InMemoryDatabaseQuery {
  constructor(private readonly db: InMemoryDatabase) {}

  // ========= Entity Queries =========

  getEntityByCui(cui: string): InMemoryEntity | undefined {
    return this.db.entities.get(cui);
  }

  getAllEntities(): InMemoryEntity[] {
    return Array.from(this.db.entities.values());
  }

  // ========= Classification Queries =========

  getFunctionalClassification(code: string): InMemoryFunctionalClassification | undefined {
    return this.db.functionalClassifications.get(code);
  }

  getEconomicClassification(code: string): InMemoryEconomicClassification | undefined {
    return this.db.economicClassifications.get(code);
  }

  getFundingSource(id: number): InMemoryFundingSource | undefined {
    return this.db.fundingSources.get(id);
  }

  getFundingSourceByDescription(description: string): InMemoryFundingSource | undefined {
    for (const source of this.db.fundingSources.values()) {
      if (source.source_description === description) {
        return source;
      }
    }
    return undefined;
  }

  getBudgetSector(id: number): InMemoryBudgetSector | undefined {
    return this.db.budgetSectors.get(id);
  }

  // ========= Report Queries =========

  getReport(reportId: string): InMemoryReport | undefined {
    return this.db.reports.get(reportId);
  }

  getReportsByEntity(entityCui: string): InMemoryReport[] {
    return Array.from(this.db.reports.values()).filter((r) => r.entity_cui === entityCui);
  }

  getReportsByYear(year: number): InMemoryReport[] {
    return Array.from(this.db.reports.values()).filter((r) => r.reporting_year === year);
  }

  getReportsByEntityAndYear(entityCui: string, year: number): InMemoryReport[] {
    return Array.from(this.db.reports.values()).filter(
      (r) => r.entity_cui === entityCui && r.reporting_year === year
    );
  }

  // ========= Line Item Queries =========

  getLineItemsByReport(reportId: string): InMemoryExecutionLineItem[] {
    return this.db.executionLineItems.filter((item) => item.report_id === reportId);
  }

  getLineItemsByEntity(entityCui: string): InMemoryExecutionLineItem[] {
    return this.db.executionLineItems.filter((item) => item.entity_cui === entityCui);
  }

  getLineItemsByEntityAndYear(entityCui: string, year: number): InMemoryExecutionLineItem[] {
    return this.db.executionLineItems.filter(
      (item) => item.entity_cui === entityCui && item.year === year
    );
  }

  getLineItemsByYearAndMonth(year: number, month: number): InMemoryExecutionLineItem[] {
    return this.db.executionLineItems.filter((item) => item.year === year && item.month === month);
  }

  getLineItemsByFunctionalCode(functionalCode: string): InMemoryExecutionLineItem[] {
    return this.db.executionLineItems.filter((item) => item.functional_code === functionalCode);
  }

  getLineItemsByEconomicCode(economicCode: string): InMemoryExecutionLineItem[] {
    return this.db.executionLineItems.filter((item) => item.economic_code === economicCode);
  }

  // ========= Aggregate Queries =========

  getTotalsByEntityAndYear(
    entityCui: string,
    year: number,
    reportType: ReportType
  ): { totalIncome: number; totalExpense: number; balance: number } {
    const items = this.db.executionLineItems.filter(
      (item) =>
        item.entity_cui === entityCui &&
        item.year === year &&
        item.report_type === reportType &&
        item.is_yearly
    );

    let totalIncome = 0;
    let totalExpense = 0;

    for (const item of items) {
      const amount = Number.parseFloat(item.ytd_amount);
      if (item.account_category === 'vn') {
        totalIncome += amount;
      } else {
        totalExpense += amount;
      }
    }

    return {
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
    };
  }

  getMonthlyTotalsByEntity(
    entityCui: string,
    year: number,
    month: number,
    reportType: ReportType
  ): { totalIncome: number; totalExpense: number; balance: number } {
    const items = this.db.executionLineItems.filter(
      (item) =>
        item.entity_cui === entityCui &&
        item.year === year &&
        item.month === month &&
        item.report_type === reportType
    );

    let totalIncome = 0;
    let totalExpense = 0;

    for (const item of items) {
      const amount = Number.parseFloat(item.monthly_amount);
      if (item.account_category === 'vn') {
        totalIncome += amount;
      } else {
        totalExpense += amount;
      }
    }

    return {
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
    };
  }
}
