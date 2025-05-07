import { XMLParser } from "fast-xml-parser";
import * as path from "path";
import {
  NormalizedData,
  LineItem,
  ValidationResult,
  ExtractionResult,
} from "../types";

// --- XML Parsing ---

const parser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: true,
  // Ensure all potentially repeating elements that might contain line items are arrays
  isArray: (name: string) =>
    ["G_1", "G_4", "G_6", "G_16", "G_17", "G_18"].includes(name),
});

export function parseXml(xmlData: string): any {
  // Consider adding try/catch here if you want to handle parsing errors specifically
  // For now, let the main loop handle it
  return parser.parse(xmlData);
}

// --- Data Extraction ---

// Helper to safely access nested properties
const getSafe = (obj: any, path: string, defaultValue: any = undefined) => {
  return path
    .split(".")
    .reduce(
      (acc, key) =>
        acc && acc[key] !== undefined && acc[key] !== null
          ? acc[key]
          : defaultValue,
      obj
    );
};

// --- Line Item Extraction Helpers ---
// These helpers should focus on extracting DETAILED line items (with codes)

function extractLineItemsFromG4G6(g1Entry: any): LineItem[] {
  const items: LineItem[] = [];
  const g4 = getSafe(g1Entry, "G_4"); // G_4 might be an object or array
  const g4Entries = Array.isArray(g4) ? g4 : g4 ? [g4] : []; // Handle both cases

  for (const g4Entry of g4Entries) {
    const g6Entries = getSafe(g4Entry, "G_6", []); // G_6 should be array based on isArray config
    for (const lineItem of g6Entries) {
      // Check for essential code indicating a detailed line item
      if (lineItem && lineItem.COD_FUNCTIONAL) {
        items.push({
          functionalCode: lineItem.COD_FUNCTIONAL,
          functionalName: lineItem.DENUMIRE_CF || "",
          economicCode: lineItem.COD_ECONOMIC || "",
          economicName: lineItem.DENUMIRE_CE || "",
          fundingSource: lineItem.SURSA_FINANTARE || "",
          accountCategory: determineAccountCategory(lineItem),
          amount: determineAmount(lineItem),
        });
      }
    }
  }
  return items;
}

function extractLineItemsFromG16G18(g1Entry: any): LineItem[] {
  const items: LineItem[] = [];
  const g16Entries = getSafe(g1Entry, "G_16", []); // G_16 should be array
  for (const g16Entry of g16Entries) {
    const g17Entries = getSafe(g16Entry, "G_17", []); // G_17 should be array
    for (const g17Entry of g17Entries) {
      const g18Entries = getSafe(g17Entry, "G_18", []); // G_18 should be array
      for (const lineItem of g18Entries) {
        // Skip summary totals explicitly when looking for detailed items
        const tipClasif = lineItem?.TIP_CLASIF;
        if (
          tipClasif === "TOTAL CHELTUIELI:" ||
          tipClasif === "TOTAL VENITURI:"
        )
          continue;

        // Check for essential code indicating a detailed line item
        if (lineItem && lineItem.COD_FUNCTIONAL) {
          items.push({
            functionalCode: lineItem.COD_FUNCTIONAL,
            functionalName: lineItem.DENUMIRE_CF || "",
            economicCode: lineItem.COD_ECONOMIC || "",
            economicName: lineItem.DENUMIRE_CE || "",
            fundingSource: lineItem.SURSA_FINANTARE || "",
            accountCategory: determineAccountCategory(lineItem),
            amount: determineAmount(lineItem),
          });
        }
      }
    }
  }
  return items;
}

function extractLineItemsFromFlatG1(g1Entry: any): LineItem[] {
  // Check for essential code indicating a detailed line item
  if (g1Entry && g1Entry.COD_FUNCTIONAL) {
    return [
      {
        functionalCode: g1Entry.COD_FUNCTIONAL,
        functionalName: g1Entry.DENUMIRE_CF || "",
        economicCode: g1Entry.COD_ECONOMIC || "",
        economicName: g1Entry.DENUMIRE_CE || "",
        fundingSource: g1Entry.SURSA_FINANTARE || "",
        accountCategory: determineAccountCategory(g1Entry),
        amount: determineAmount(g1Entry),
      },
    ];
  }
  return [];
}

function extractLineItemsFromDirectG4(dataDs: any): LineItem[] {
  const items: LineItem[] = [];
  const g4Entries = getSafe(dataDs, "G_4", []); // G_4 should be array
  for (const g4Entry of g4Entries) {
    // Check for essential code indicating a detailed line item
    if (g4Entry && g4Entry.COD_FUNCTIONAL) {
      items.push({
        functionalCode: g4Entry.COD_FUNCTIONAL,
        functionalName: g4Entry.DENUMIRE_CF || "",
        economicCode: g4Entry.COD_ECONOMIC || "",
        economicName: g4Entry.DENUMIRE_CE || "",
        fundingSource: g4Entry.SURSA_FINANTARE || "",
        accountCategory: determineAccountCategory(g4Entry),
        amount: determineAmount(g4Entry),
      });
    }
  }
  return items;
}

// Helper to check if a G1/G16/G17/G18 structure exists but contains ONLY total lines
function structureContainsOnlyTotalsG18(dataDs: any): boolean {
  const g1Entries = getSafe(dataDs, "G_1", []);
  if (g1Entries.length === 0) return false;

  let hasG18Structure = false;
  let hasOnlyTotalLines = true; // Assume true until a non-total is found

  for (const g1Entry of g1Entries) {
    const g16Entries = getSafe(g1Entry, "G_16", []);
    for (const g16Entry of g16Entries) {
      const g17Entries = getSafe(g16Entry, "G_17", []);
      for (const g17Entry of g17Entries) {
        const g18Entries = getSafe(g17Entry, "G_18", []);
        if (g18Entries.length > 0) {
          hasG18Structure = true; // G18 structure exists
          for (const lineItem of g18Entries) {
            if (!lineItem) continue; // Skip if item itself is null/undefined
            const tipClasif = lineItem.TIP_CLASIF;
            // If COD_FUNCTIONAL exists OR TIP_CLASIF is missing/not a known total -> it's not 'totals-only'
            if (
              lineItem.COD_FUNCTIONAL ||
              !(
                tipClasif === "TOTAL CHELTUIELI:" ||
                tipClasif === "TOTAL VENITURI:"
              )
            ) {
              hasOnlyTotalLines = false;
              break; // Found a non-total or unidentified line
            }
          }
        }
        if (!hasOnlyTotalLines) break;
      }
      if (!hasOnlyTotalLines) break;
    }
    if (!hasOnlyTotalLines) break;
  }
  // Return true only if the G18 structure was found AND only recognized total lines were encountered
  return hasG18Structure && hasOnlyTotalLines;
}

// --- Main Extraction Orchestrator ---
export function extractData(
  parsedData: any,
  filePath: string,
  year: string,
  month: string
): ExtractionResult {
  const dataDs = parsedData?.DATA_DS;
  if (!dataDs) {
    return { error: "Invalid structure: DATA_DS element missing" };
  }

  const normalized: Partial<NormalizedData> = {
    filePath,
    year,
    month,
    lineItems: [],
    formatId: "unknown",
  };

  // 1. Extract Entity Information (Try multiple locations)
  normalized.cui = getSafe(dataDs, "P_CUI");
  normalized.entityName =
    getSafe(dataDs, "G_3.NUME") || getSafe(dataDs, "P_DEN");
  normalized.sectorType = getSafe(dataDs, "G_2.TIP_SECTOR");
  normalized.reportingDate = getSafe(dataDs, "P_ZI"); // Extract date string

  // Fallback for entity name from G_1
  if (!normalized.entityName) {
    const g1EntriesFirst = getSafe(dataDs, "G_1.0"); // Check first G_1 entry only
    if (g1EntriesFirst?.NUME_EP) {
      normalized.entityName = g1EntriesFirst.NUME_EP;
    }
  }

  // Fallback for CUI from filename
  if (!normalized.cui) {
    const fileNameCui = path.basename(filePath, ".xml");
    if (/^\d+$/.test(fileNameCui)) {
      normalized.cui = fileNameCui;
    }
  }

  // 2. Extract DETAILED Line Items (Try different structures)
  let items: LineItem[] = [];
  let identifiedFormat = "unknown";
  let foundDetailedItems = false; // Flag to track if we found non-total items
  let structureChecked = false; // Track if we entered any structure check

  const g1Entries = getSafe(dataDs, "G_1", []); // G_1 should be array
  if (g1Entries.length > 0) {
    structureChecked = true; // We are processing G1
    for (const g1Entry of g1Entries) {
      // Try G4/G6 first within this G1
      items = extractLineItemsFromG4G6(g1Entry);
      if (items.length > 0) {
        identifiedFormat = "nested-g4-g6";
        foundDetailedItems = true;
        break;
      }

      // Then try G16/G18 within this G1
      items = extractLineItemsFromG16G18(g1Entry); // Skips totals
      if (items.length > 0) {
        identifiedFormat = "nested-g16-g18";
        foundDetailedItems = true;
        break;
      }

      // Then try flat G1 structure
      items = extractLineItemsFromFlatG1(g1Entry);
      if (items.length > 0) {
        identifiedFormat = "flat-g1";
        foundDetailedItems = true;
        break;
      }
    }
  }

  // Try Direct G4 if no detailed G1 items found
  if (!foundDetailedItems) {
    const directG4Items = extractLineItemsFromDirectG4(dataDs);
    if (directG4Items.length > 0) {
      structureChecked = true;
      items = directG4Items;
      identifiedFormat = "direct-g4";
      foundDetailedItems = true;
    }
  }

  // 3. Determine Final Format ID if NO detailed items were found
  if (!foundDetailedItems) {
    // Check for top-level total indicators first
    if (dataDs.TOTVEN !== undefined || dataDs.TOTCHELT !== undefined) {
      identifiedFormat = "totals-only";
    }
    // Check if a known structure (like G1/G16/G18) existed but only had totals
    else if (structureContainsOnlyTotalsG18(dataDs)) {
      identifiedFormat = "totals-only"; // Classify as totals-only for validation purposes
      // Optionally use a more specific ID if needed for stats:
      // identifiedFormat = "nested-g16-g18-totals-only";
    }
    // Add checks for other structures containing only totals if necessary...
    // else if (structureContainsOnlyTotalsDirectG4(dataDs)) { ... }

    // Fallback identification based on entity info presence if truly empty/unrecognized
    else {
      if (normalized.cui && normalized.entityName) {
        identifiedFormat = "entity-info-only"; // More specific than 'other'
      } else {
        identifiedFormat = "other-or-empty";
      }
    }
  }

  normalized.lineItems = items; // Assign the found detailed items (empty if none)
  normalized.formatId = identifiedFormat;

  return { data: normalized as NormalizedData };
}

// --- Data Validation ---

// Basic date format check (example)
function isValidDateFormat(dateString?: string): {
  valid: boolean;
  error?: string;
} {
  if (!dateString) return { valid: true }; // Not present is not invalid here

  try {
    // Handle DD-MON-YY format (e.g., 31-DEC-23)
    if (/^\d{1,2}-[A-Za-z]{3}-\d{2}$/.test(dateString)) {
      const parts = dateString.split("-");
      const day = parts[0];
      const monthStr = parts[1].toUpperCase();
      const yearPart = parts[2];

      if (parseInt(day) < 1 || parseInt(day) > 31)
        throw new Error("Invalid day value");

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
      if (!monthMap[monthStr]) {
        throw new Error(`Unknown month abbreviation "${monthStr}"`);
      }
      // Basic year check (assumes 20xx or 19xx based on value) - refine if needed
      // Could use Date object for better validation:
      // const fullYear = parseInt(yearPart) < 70 ? '20' + yearPart : '19' + yearPart; // Heuristic
      // const date = new Date(Date.UTC(parseInt(fullYear), parseInt(monthMap[monthStr]) - 1, parseInt(day)));
      // if (isNaN(date.getTime())) throw new Error("Date components do not form a valid date");
      // if (date.getUTCDate() !== parseInt(day)) throw new Error("Invalid day for the given month/year");
    }
    // Add other allowed formats here (e.g., YYYYMMDD)
    // else if (/^\d{8}$/.test(dateString)) { /* Validate YYYYMMDD */ }
    else {
      throw new Error("Unrecognized date format pattern");
    }
    return { valid: true };
  } catch (e: any) {
    return {
      valid: false,
      error: `Invalid date format: "${dateString}" - ${e.message}`,
    };
  }
}

export function validateExtractedData(data: NormalizedData): ValidationResult {
  const errors: string[] = [];

  // Check required fields
  if (!data.cui) {
    errors.push("Missing entity information: No CUI found");
  }
  // Add check for entityName? Depends on requirements
  // if (!data.entityName) {
  //   errors.push("Missing entity information: No entity name found");
  // }

  // Check if there are any DETAILED line items OR if it's a recognized "totals-only" format
  // The formatId check is crucial here.
  if (
    data.lineItems.length === 0 &&
    data.formatId !== "totals-only" &&
    !data.formatId.endsWith("-totals-only")
  ) {
    // Check base and specific totals format
    errors.push(
      "No detailed line items found and not classified as totals-only format"
    );
  }

  // Validate date format if present
  const dateValidation = isValidDateFormat(data.reportingDate);
  if (!dateValidation.valid && dateValidation.error) {
    errors.push(dateValidation.error);
  }

  // Add more validation rules as needed...
  // e.g., check numeric values in amounts, code formats, etc.

  return {
    isValid: errors.length === 0,
    errors: errors,
  };
}

function determineAccountCategory(lineItem: any): string {
  if (lineItem.CATEG_CONT) {
    return lineItem.CATEG_CONT;
  }
  if (lineItem.TIP_CLASIF === "Cheltuiala") {
    return "ch";
  }
  if (lineItem.TIP_CLASIF === "Venit") {
    return "vn";
  }
  throw new Error("Unknown account category");
}

function determineAmount(lineItem: any): number {
  if (lineItem.RULAJ_CH !== undefined) {
    return lineItem.RULAJ_CH;
  }
  if (lineItem.RULAJ_VN !== undefined) {
    return lineItem.RULAJ_VN;
  }
  if (lineItem.RULAJ_CH_VN !== undefined) {
    return lineItem.RULAJ_CH_VN;
  }
  if (lineItem.RULAJ !== undefined) {
    return lineItem.RULAJ;
  }
  throw new Error("Unknown amount");
}
