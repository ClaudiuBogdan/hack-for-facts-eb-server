import * as fs from "fs-extra";
import * as path from "path";
import { xmlValidationConfig as config } from "../validationConfig";
import { findXmlFiles, getPathContext } from "../utils/fileFinder";
import { parseXml, extractData } from "./xmlProcessor";
import { NormalizedData, LineItem } from "../types";
import { EntityPubRecord } from "../scripts/generate-uat-json";
import { parse } from "csv-parse/sync";

interface EntityInfo {
  cui: string;
  entityName: string;
  sectorType?: string;
  address?: string;
  parent1?: string;
  parent2?: string;
  years: Record<string, string[]>; // years -> array of months
  latestFilePath?: string;
}

interface EntityMap {
  entities: Record<string, EntityInfo>;
  totalEntities: number;
  generatedAt: string;
}

interface ClassificationItem {
  code: string;
  name: string;
  occurrences: number;
  entities: Set<string>; // Set of CUIs using this classification
}

interface SerializableClassificationItem {
  code: string;
  name: string;
  occurrences: number;
  entities: string[]; // Array of CUIs for JSON serialization
}

interface ClassificationMap {
  items: Record<string, ClassificationItem>;
  totalItems: number;
  generatedAt: string;
}

interface SerializableClassificationMap {
  items: Record<string, SerializableClassificationItem>;
  totalItems: number;
  generatedAt: string;
}

interface Report {
  report_id: number;
  entity_cui: string;
  report_date: string;
  reporting_year: number;
  reporting_period: string;
  import_timestamp: string;
  download_links: string[];
  report_type: string;
  main_creditor_cui: string;
}

interface ExecutionLineItem {
  line_item_id: number;
  report_id: number;
  funding_source_id: number | null;
  functional_code: string;
  economic_code: string | null;
  account_category: string;
  amount: number;
  program_code: string | null;
  year: number;
}

interface ReportsData {
  reports: Report[];
  totalReports: number;
  generatedAt: string;
}

interface ExecutionLineItemsData {
  lineItems: ExecutionLineItem[];
  totalLineItems: number;
  generatedAt: string;
}

/**
 * Generate data export files for entities, classifications, reports, and execution line items
 */
export async function generateDataExport(): Promise<void> {
  console.log("Starting data export generation...");

  // Ensure data-map directory exists
  const dataMapDir = path.resolve(process.cwd(), "data-map", "data");
  await fs.ensureDir(dataMapDir);

  // Find all XML files
  const xmlFiles = await findXmlFiles(config.dataDir);
  console.log(`Found ${xmlFiles.length} XML files to process.`);

  // Initialize maps
  const entityMap: EntityMap = {
    entities: {},
    totalEntities: 0,
    generatedAt: new Date().toISOString(),
  };

  const functionalMap: ClassificationMap = {
    items: {},
    totalItems: 0,
    generatedAt: new Date().toISOString(),
  };

  const economicMap: ClassificationMap = {
    items: {},
    totalItems: 0,
    generatedAt: new Date().toISOString(),
  };

  const fundingSourceMap: ClassificationMap = {
    items: {},
    totalItems: 0,
    generatedAt: new Date().toISOString(),
  };

  // Initialize reports and execution line items data
  const reportsData: ReportsData = {
    reports: [],
    totalReports: 0,
    generatedAt: new Date().toISOString(),
  };

  const executionLineItemsData: ExecutionLineItemsData = {
    lineItems: [],
    totalLineItems: 0,
    generatedAt: new Date().toISOString(),
  };

  // Map funding source names to IDs
  const fundingSourceIds: Record<string, number> = {};

  // Process each file
  let reportIdCounter = 1;
  let lineItemIdCounter = 1;

  const cuiToEntityMap: Record<string, {address?: string, parent1?: string, parent2?: string}> = getCuiToEntityMap();

  for (const filePath of xmlFiles) {
    try {
      // Read and Parse XML
      const fileData = await fs.readFile(filePath, "utf8");
      const parsedXml = parseXml(fileData);

      // Extract Data
      const { year, month } = getPathContext(filePath, config.dataDir);
      const extractionResult = extractData(parsedXml, filePath, year, month);

      if (extractionResult.error || !extractionResult.data) {
        console.warn(
          `Error extracting data from ${filePath}: ${
            extractionResult.error || "Unknown error"
          }`
        );
        continue;
      }

      const data: NormalizedData = extractionResult.data;

      // Process entity map
      if (data.cui) {
        // Add or update entity in the map
        if (!entityMap.entities[data.cui]) {
          const extraData = cuiToEntityMap[data.cui];

          if (!extraData) {
            console.warn(`No entity data found for CUI ${data.cui}`);
          }

          entityMap.entities[data.cui] = {
            cui: data.cui,
            entityName: data.entityName || "Unknown",
            sectorType: data.sectorType,
            address: extraData?.address || undefined,
            parent1: extraData?.parent1 || undefined,
            parent2: extraData?.parent2 || undefined,
            years: {},
            latestFilePath: filePath,
          };
        }

        // Update entity info
        const entity = entityMap.entities[data.cui];

        // Keep the most complete entity name we find
        if (
          data.entityName &&
          (!entity.entityName ||
            entity.entityName === "Unknown" ||
            data.entityName.length > entity.entityName.length)
        ) {
          entity.entityName = data.entityName;
        }

        // Update sector type if available
        if (data.sectorType && !entity.sectorType) {
          entity.sectorType = data.sectorType;
        }

        // Add year and month to the entity's timeline
        if (!entity.years[year]) {
          entity.years[year] = [];
        }
        if (!entity.years[year].includes(month)) {
          entity.years[year].push(month);
        }

        // Process line items to extract classifications
        processLineItems(
          data.lineItems,
          data.cui,
          functionalMap,
          economicMap,
          fundingSourceMap
        );

        // Generate report data
        const reportDate = formatReportDate(data.reportingDate, year, month);
        const reportId = reportIdCounter++;

        const report: Report = {
          report_id: reportId,
          entity_cui: data.cui,
          report_date: reportDate,
          reporting_year: parseInt(year),
          reporting_period: month,
          import_timestamp: new Date().toISOString(),
          download_links: [],
          report_type: "",
          main_creditor_cui: "",
        };

        reportsData.reports.push(report);

        // Generate execution line items
        data.lineItems.forEach((item) => {
          // Only add line items that have required data
          if (item.functionalCode) {
            // Assign funding source ID if present
            let fundingSourceId: number | null = null;
            if (item.fundingSource) {
              if (!fundingSourceIds[item.fundingSource]) {
                // Assign a new ID if not seen before
                fundingSourceIds[item.fundingSource] =
                  Object.keys(fundingSourceIds).length + 1;
              }
              fundingSourceId = fundingSourceIds[item.fundingSource];
            }

            // Parse amount to decimal
            const amount = item.amount ? item.amount : 0;

            const lineItem: ExecutionLineItem = {
              line_item_id: lineItemIdCounter++,
              report_id: reportId,
              year: parseInt(year),
              funding_source_id: fundingSourceId,
              functional_code: item.functionalCode,
              economic_code: item.economicCode || null,
              account_category: item.accountCategory || "",
              amount: amount,
              program_code: null, // Not available in current data model
            };

            executionLineItemsData.lineItems.push(lineItem);
          }
        });
      } else {
        console.warn(`No CUI found in file ${filePath}, skipping...`);
        throw new Error(`No CUI found in file ${filePath}`);
      }
    } catch (error: any) {
      console.error(`Error processing file ${filePath}:`, error.message);
    }
  }

  // Update total counts
  entityMap.totalEntities = Object.keys(entityMap.entities).length;
  functionalMap.totalItems = Object.keys(functionalMap.items).length;
  economicMap.totalItems = Object.keys(economicMap.items).length;
  fundingSourceMap.totalItems = Object.keys(fundingSourceMap.items).length;
  reportsData.totalReports = reportsData.reports.length;
  executionLineItemsData.totalLineItems =
    executionLineItemsData.lineItems.length;

  // Convert Sets to arrays for JSON serialization
  const prepareMapForSerialization = (
    map: ClassificationMap
  ): SerializableClassificationMap => {
    const serializable: SerializableClassificationMap = {
      items: {},
      totalItems: map.totalItems,
      generatedAt: map.generatedAt,
    };

    for (const [code, item] of Object.entries(map.items)) {
      serializable.items[code] = {
        ...item,
        entities: Array.from(item.entities),
      };
    }

    return serializable;
  };

  // Write maps to JSON files
  await fs.writeJson(path.join(dataMapDir, "entity-map.json"), entityMap, {
    spaces: 2,
  });

  await fs.writeJson(
    path.join(dataMapDir, "functional-classifications.json"),
    prepareMapForSerialization(functionalMap),
    { spaces: 2 }
  );

  await fs.writeJson(
    path.join(dataMapDir, "economic-classifications.json"),
    prepareMapForSerialization(economicMap),
    { spaces: 2 }
  );

  await fs.writeJson(
    path.join(dataMapDir, "funding-sources.json"),
    prepareMapForSerialization(fundingSourceMap),
    { spaces: 2 }
  );

  // Write reports and execution line items data
  await fs.writeJson(path.join(dataMapDir, "reports.json"), reportsData, {
    spaces: 2,
  });

  // Create execution-line-items directory if it doesn't exist
  const executionLineItemsDir = path.join(dataMapDir, "execution-line-items");
  await fs.ensureDir(executionLineItemsDir);

  // For execution line items, check if the file might be too large
  if (executionLineItemsData.lineItems.length > 1000000) {
    // If too many line items, save in batches of 100,000
    const batchSize = 100000;
    const batches = Math.ceil(
      executionLineItemsData.lineItems.length / batchSize
    );

    for (let i = 0; i < batches; i++) {
      const start = i * batchSize;
      const end = Math.min(
        (i + 1) * batchSize,
        executionLineItemsData.lineItems.length
      );

      const batchData = {
        lineItems: executionLineItemsData.lineItems.slice(start, end),
        totalLineItems: end - start,
        generatedAt: executionLineItemsData.generatedAt,
        batchNumber: i + 1,
        totalBatches: batches,
      };

      await fs.writeJson(
        path.join(executionLineItemsDir, `execution-line-items-batch-${i + 1}.json`),
        batchData,
        { spaces: 2 }
      );
    }

    // Write a small metadata file
    await fs.writeJson(
      path.join(dataMapDir, "execution-line-items-metadata.json"),
      {
        totalLineItems: executionLineItemsData.totalLineItems,
        generatedAt: executionLineItemsData.generatedAt,
        totalBatches: batches,
        batchSize: batchSize,
      },
      { spaces: 2 }
    );
  } else {
    await fs.writeJson(
      path.join(dataMapDir, "execution-line-items.json"),
      executionLineItemsData,
      { spaces: 2 }
    );
  }

  // Print summary
  console.log(`\nData export generation completed!`);
  console.log(`Found ${entityMap.totalEntities} unique entities`);
  console.log(
    `Found ${functionalMap.totalItems} unique functional classifications`
  );
  console.log(
    `Found ${economicMap.totalItems} unique economic classifications`
  );
  console.log(`Found ${fundingSourceMap.totalItems} unique funding sources`);
  console.log(`Generated ${reportsData.totalReports} reports`);
  console.log(
    `Generated ${executionLineItemsData.totalLineItems} execution line items`
  );
  console.log(`\nOutput written to ${dataMapDir}/`);
}

/**
 * Helper function to format report date
 */
function formatReportDate(
  dateString: string | undefined,
  year: string,
  month: string
): string {
  if (dateString) {
    // Try to parse the date string
    try {
      // Handle DD-MON-YY format (e.g., 31-DEC-23)
      if (/^\d{1,2}-[A-Za-z]{3}-\d{2}$/.test(dateString)) {
        const parts = dateString.split("-");
        const day = parts[0].padStart(2, "0");
        const monthStr = parts[1].toUpperCase();
        const yearPart = parts[2];

        const monthMap: Record<string, string> = {
          JAN: "01",
          FEB: "02",
          MAR: "03",
          APR: "04",
          MAY: "05",
          JUN: "06",
          JUL: "07",
          AUG: "08",
          SEP: "09",
          OCT: "10",
          NOV: "11",
          DEC: "12",
        };

        if (monthMap[monthStr]) {
          const fullYear =
            parseInt(yearPart) < 70 ? "20" + yearPart : "19" + yearPart;
          return `${fullYear}-${monthMap[monthStr]}-${day}`;
        }
      }
    } catch (e) {
      // Fall back to using year/month from path
    }
  }

  // Default: use the last day of the month from file path
  const lastDayOfMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
  return `${year}-${month.padStart(2, "0")}-${lastDayOfMonth}`;
}

/**
 * Helper function to determine account category
 */
function determineAccountCategory(item: LineItem): string {
  // Default to 'ch' (expenses) unless we can determine it's income
  // This is a simplified logic; actual implementation would need more context
  if (
    item.functionalCode &&
    typeof item.functionalCode === "string" &&
    item.functionalCode.startsWith("1")
  ) {
    return "vn"; // Revenue codes often start with 1
  }
  return "ch"; // Default to expenses
}

/**
 * Process line items to extract and count classifications
 */
function processLineItems(
  lineItems: LineItem[],
  cui: string,
  functionalMap: ClassificationMap,
  economicMap: ClassificationMap,
  fundingSourceMap: ClassificationMap
): void {
  for (const item of lineItems) {
    // Process functional classification
    if (item.functionalCode && item.functionalName) {
      if (!functionalMap.items[item.functionalCode]) {
        functionalMap.items[item.functionalCode] = {
          code: item.functionalCode,
          name: item.functionalName,
          occurrences: 0,
          entities: new Set(),
        };
      }

      const funcItem = functionalMap.items[item.functionalCode];
      funcItem.occurrences++;
      funcItem.entities.add(cui);

      // Update name if new one is longer (potentially more detailed)
      if (item.functionalName.length > funcItem.name.length) {
        funcItem.name = item.functionalName;
      }
    }

    // Process economic classification
    if (item.economicCode && item.economicName) {
      if (!economicMap.items[item.economicCode]) {
        economicMap.items[item.economicCode] = {
          code: item.economicCode,
          name: item.economicName,
          occurrences: 0,
          entities: new Set(),
        };
      }

      const econItem = economicMap.items[item.economicCode];
      econItem.occurrences++;
      econItem.entities.add(cui);

      // Update name if new one is longer (potentially more detailed)
      if (item.economicName.length > econItem.name.length) {
        econItem.name = item.economicName;
      }
    }

    // Process funding source
    if (item.fundingSource) {
      if (!fundingSourceMap.items[item.fundingSource]) {
        fundingSourceMap.items[item.fundingSource] = {
          code: item.fundingSource,
          name: item.fundingSource, // Use code as name initially
          occurrences: 0,
          entities: new Set(),
        };
      }

      const fundingItem = fundingSourceMap.items[item.fundingSource];
      fundingItem.occurrences++;
      fundingItem.entities.add(cui);
    }
  }
}

// Run if executed directly
if (require.main === module) {
  generateDataExport()
    .then(() =>
      console.log("Data export generation process finished successfully.")
    )
    .catch((err) => {
      console.error("Critical error during data export generation:", err);
      process.exit(1);
    });
}


function getCuiToEntityMap(): Record<string, {address?: string, parent1?: string, parent2?: string}> {
  const entCsvPath = path.resolve(
    __dirname,
    "../../data-map/uat-raw/ent_pub_2025.csv"
  );
  const entCsvContent = fs.readFileSync(entCsvPath, "utf8");
  const entityRecords = parse(entCsvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter: ";",
  }) as EntityPubRecord[];

  // Create a map of CIF to entity record
  const cifToEntityMap: Record<string, {address?: string, parent1?: string, parent2?: string}> = {};
  entityRecords.forEach((record) => {
    cifToEntityMap[record.CIF] = {
      address: record.ADRESA,
      parent1: record.PARENT1,
      parent2: record.PARENT2,
    };
  });
  

  return cifToEntityMap;
}