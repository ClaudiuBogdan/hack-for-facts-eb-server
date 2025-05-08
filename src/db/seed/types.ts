export type EconomicClassificationFile = {
  items: {
    [key: string]: {
      code: number;
      name: string;
      occurrences: number;
      entities: number[];
    };
  };
};

export type EntityFile = {
  entities: {
    [key: string]: {
      cui: number;
      entityName: string;
      sectorType: string;
      years: {
        [key: string]: string[];
      };
      latestFilePath: string;
    };
  };
};

export type FunctionalClassificationFile = {
  items: {
    [key: string]: {
      code: number;
      name: string;
      occurrences: number;
      entities: number[];
    };
  };
};

export type FundingSourceFile = {
  items: {
    [key: string]: {
      code: string;
      name: string;
      occurrences: number;
      entities: number[];
    };
  };
};

export type UATFile = {
  uats: {
    id: number;
    uat_key: string;
    uat_code: string;
    name: string;
    county_code: string;
    county_name: string;
    population: number;
    siruta_code: string;
  }[];
  cifToUatMap: {
    [key: string]: string;
  };
  uatToCifMap: {
    [key: string]: string;
  };
  uatKeyToIdMap: {
    [key: string]: number;
  };
};

export type ExecutionLineItemsFile = {
  lineItems: {
    line_item_id: number;
    report_id: number;
    funding_source_id: number;
    functional_code?: number;
    economic_code?: number;
    account_category: string;
    amount: string;
    program_code: string;
    year: number;
  }[];
};

export type ReportsFile = {
  reports: {
    report_id: number;
    entity_cui: number;
    report_date: string;
    reporting_year: number;
    reporting_period: string;
    file_source: string;
    import_timestamp: string;
  }[];
};
