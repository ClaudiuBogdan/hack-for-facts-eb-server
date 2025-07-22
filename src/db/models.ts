export interface UAT {
  id: number;
  uat_key: string;
  uat_code: string;
  name: string;
  county_code?: string;
  county_name?: string;
  region?: string;
  population?: number;
  last_updated?: Date;
}

export interface Entity {
  cui: string;
  name: string;
  entity_type: string | null;
  uat_id?: number;
  address?: string;
  last_updated?: Date;
}

export interface FunctionalClassification {
  functional_code: string;
  functional_name: string;
}

export interface EconomicClassification {
  economic_code: string;
  economic_name: string;
}

export interface FundingSource {
  source_id: number;
  source_description: string;
}

export interface Report {
  report_id: number;
  entity_cui: string;
  report_date: Date;
  reporting_year: number;
  reporting_period: string;
  import_timestamp: Date;
  download_links: string[];
  report_type: string;
  main_creditor_cui: string;
}

export interface ExecutionLineItem {
  line_item_id: number;
  report_id: number;
  entity_cui: string;
  funding_source_id: number;
  functional_code: string;
  economic_code?: string;
  account_category: "vn" | "ch";
  amount: number;
  program_code?: string;
  year: number;
}
