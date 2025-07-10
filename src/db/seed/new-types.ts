
export type ExtractedData = {
    [cui: string]: NormalizedData[];
};

export interface NormalizedData {
    cui?: string;
    entityName?: string;
    sectorType?: string;
    address?: string;
    parent1?: string;
    parent2?: string;
    reportingDate: string;
    formatId: string;
    lineItems: LineItem[];
    totalIncome: number;
    totalExpenses: number;
    filePath: string;
    year: string;
    month: string;
    budgetSector?: number;
    budgetProgramCode?: string;
    report: Report;
    metadata: ReportMetadata;
}

export interface LineItem {
    date: string;
    type: "Income" | "Expense";
    functionalCode?: string;
    functionalName?: string;
    economicCode?: string;
    economicName?: string;
    fundingSource?: string;
    fundingSourceDescription?: string;
    foundingEntity?: string;
    amount: number;
    budgetProgramCode?: string;
}

export interface Report {
    report_id: number;
    entity_cui: string;
    report_date: string;
    reporting_year: number;
    reporting_period: string;
    file_source: string;
    file_urls: string[];
    import_timestamp: string;
}

export interface ReportMetadata {
    id: string;
    reportType: string; // e.g., "Executie bugetara detaliata"
    county: string;
    reportingPeriod: string;
    publicEntity: string;
    budgetSector: string;
    mainCreditor: string;
    documentLinks: string[];
    downloadPath: string;
}

export interface SeedData {
    budgetSectors: Map<number, string>;
    functionalClassifications: Map<string, string>;
    economicClassifications: Map<string, string>;
    fundingSources: Map<string, string>;
}
