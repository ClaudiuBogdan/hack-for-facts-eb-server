export interface FieldStats {
  min: number;
  max: number;
  total: number;
  count: number;
  examples: Array<{ value: string; file: string }>;
}

export interface ValidationStats {
  totalFiles: number;
  parsedFiles: number; // Files successfully parsed
  validFiles: number; // Files passing validation after extraction
  invalidFiles: number; // Files failing validation after extraction
  parsingErrors: number; // Files failing XML parsing
  missingEntityInfoCount: number; // Specific validation failure count
  invalidDateFormatCount: number; // Specific validation failure count
  errorsByFile: Record<string, string[]>; // Store multiple errors per file
  fieldsStats: Record<string, FieldStats>;
  formatDistribution: Record<string, number>; // Track formats identified during extraction
}

// Represents the data extracted consistently, regardless of source XML structure
export interface NormalizedData {
  cui?: string;
  entityName?: string;
  sectorType?: string;
  address?: string;
  parent1?: string;
  parent2?: string;
  reportingDate?: string; // Extracted date string
  formatId: string; // Identifier for the detected format
  lineItems: LineItem[];
  // Store original file path for context
  filePath: string;
  year: string;
  month: string;
}

export interface LineItem {
  functionalCode?: string;
  functionalName?: string;
  economicCode?: string;
  accountCategory?: string;
  economicName?: string;
  fundingSource?: string;
  amount?: number; // Example: Extracting amount if present
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface ExtractionResult {
  data?: NormalizedData;
  error?: string; // Error during extraction itself
}
