export interface SeedJson {
  version: number;
  cui: string;
  entityName: string;
  mainCreditData?: Record<string, Record<string, ReportGroup[]>>;
  secondaryCreditData?: Record<string, Record<string, ReportGroup[]>>;
  detailedCreditData?: Record<string, Record<string, ReportGroup[]>>;
  nameLookups: {
    functional: Record<string, string>;
    economic: Record<string, string>;
    fundingSource: Record<string, string>;
  };
}

export interface ReportGroup {
  reportInfo: {
    id: string;
    date: string;
    year: number;
    period: string;
    documentLinks: string[];
  };
  fileInfo: {
    source: string;
    xmlHash: string;
    parsedAt: string;
    formatId: string;
  };
  summary: {
    budgetSectorId: number;
    sectorType: string;
    mainCreditor: string;
  };
  lineItems: LineItem[];
}

export interface LineItem {
  type: 'vn' | 'ch';
  functionalCode: string;
  economicCode?: string;
  fundingSource: string;
  ytdAmount: number;
  monthlyAmount: number;
  expenseType?: 'dezvoltare' | 'functionare';
}
