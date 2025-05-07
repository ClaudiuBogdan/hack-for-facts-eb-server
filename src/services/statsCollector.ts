import {
  ValidationStats,
  FieldStats,
  NormalizedData,
  ValidationResult,
} from "../types";
import { XmlValidationConfig } from "../validationConfig";

export class StatsCollector {
  private stats: ValidationStats;
  private fieldsToTrack: Set<string>;
  private maxExamples: number;

  constructor(config: XmlValidationConfig) {
    this.fieldsToTrack = new Set(config.fieldsToTrack);
    this.maxExamples = config.maxExampleValues;
    this.stats = {
      totalFiles: 0,
      parsedFiles: 0,
      validFiles: 0,
      invalidFiles: 0,
      parsingErrors: 0,
      missingEntityInfoCount: 0,
      invalidDateFormatCount: 0,
      errorsByFile: {},
      fieldsStats: {},
      formatDistribution: {},
    };
    this.initializeFieldStats();
  }

  private initializeFieldStats(): void {
    this.fieldsToTrack.forEach((field) => {
      this.stats.fieldsStats[field] = this.createEmptyFieldStat();
    });
  }

  private createEmptyFieldStat(): FieldStats {
    return {
      min: Number.MAX_SAFE_INTEGER,
      max: 0,
      total: 0,
      count: 0,
      examples: [],
    };
  }

  recordParsingAttempt(filePath: string): void {
    this.stats.totalFiles++;
  }

  recordParsingError(filePath: string, error: Error): void {
    this.stats.parsingErrors++;
    this.stats.errorsByFile[filePath] = [`Error parsing XML: ${error.message}`];
    if (this.stats.totalFiles % 100 === 0) this.logProgress();
  }

  recordExtractionError(filePath: string, errorMsg: string): void {
    // Count as parsed, but not valid (extraction failed)
    this.stats.parsedFiles++;
    this.stats.invalidFiles++; // Or a new category? Let's put in invalid for now.
    this.stats.errorsByFile[filePath] = [errorMsg];
    if (this.stats.totalFiles % 100 === 0) this.logProgress();
  }

  recordValidationResult(
    filePath: string,
    extractedData: NormalizedData,
    validationResult: ValidationResult
  ): void {
    this.stats.parsedFiles++;

    // Update format distribution even for invalid files, based on extraction attempt
    this.stats.formatDistribution[extractedData.formatId] =
      (this.stats.formatDistribution[extractedData.formatId] || 0) + 1;

    if (validationResult.isValid) {
      this.stats.validFiles++;
      this.updateFieldStats(extractedData); // Only update field stats for valid files
    } else {
      this.stats.invalidFiles++;
      this.stats.errorsByFile[filePath] = validationResult.errors;

      // Track specific common validation errors
      if (
        validationResult.errors.some((e) =>
          e.includes("Missing entity information")
        )
      ) {
        this.stats.missingEntityInfoCount++;
      }
      if (
        validationResult.errors.some((e) => e.includes("Invalid date format"))
      ) {
        this.stats.invalidDateFormatCount++;
      }
    }

    if (this.stats.totalFiles % 100 === 0) this.logProgress();
  }

  private updateFieldStats(data: NormalizedData): void {
    const fieldsToProcess: Record<string, string | undefined> = {
      cui: data.cui,
      entityName: data.entityName,
      sectorType: data.sectorType,
      // Add top-level fields as needed
    };

    // Process fields from line items
    for (const item of data.lineItems) {
      this.processFieldStat(
        "functionalCode",
        item.functionalCode,
        data.filePath
      );
      this.processFieldStat(
        "functionalName",
        item.functionalName,
        data.filePath
      );
      this.processFieldStat("economicCode", item.economicCode, data.filePath);
      this.processFieldStat("economicName", item.economicName, data.filePath);
      this.processFieldStat("fundingSource", item.fundingSource, data.filePath);
      this.processFieldStat("amount", item.amount, data.filePath);
    }

    // Process top-level fields
    for (const [field, value] of Object.entries(fieldsToProcess)) {
      this.processFieldStat(field, value, data.filePath);
    }
  }

  private processFieldStat(
    field: string,
    value: string | number | undefined,
    filePath: string
  ): void {
    if (
      !this.fieldsToTrack.has(field) ||
      value === undefined ||
      value === null ||
      value === ""
    )
      return;

    const stat = this.stats.fieldsStats[field] || this.createEmptyFieldStat(); // Ensure stat exists
    this.stats.fieldsStats[field] = stat; // Assign back if newly created

    const length = String(value).length; // Ensure value is string for length

    // Update min/max
    stat.min = Math.min(stat.min, length);
    stat.max = Math.max(stat.max, length);

    // Update totals for average calculation
    stat.total += length;
    stat.count++;

    // Store examples (simplified logic for managing examples)
    if (
      length > (stat.examples[0]?.value.length ?? -1) ||
      stat.examples.length < this.maxExamples
    ) {
      stat.examples.push({ value: String(value), file: filePath });
      stat.examples.sort((a, b) => b.value.length - a.value.length); // Keep sorted by length desc
      if (stat.examples.length > this.maxExamples) {
        stat.examples.pop(); // Remove the shortest if exceeding max
      }
    }
  }

  getStats(): ValidationStats {
    // Ensure min is 0 if no entries were counted
    for (const field in this.stats.fieldsStats) {
      if (this.stats.fieldsStats[field].count === 0) {
        this.stats.fieldsStats[field].min = 0;
      }
    }
    return { ...this.stats }; // Return a copy
  }

  logProgress(): void {
    console.log(
      `Processed ${this.stats.totalFiles} files: ` +
        `${this.stats.parsedFiles} parsed (${this.stats.validFiles} valid, ${this.stats.invalidFiles} invalid validation), ` +
        `${this.stats.parsingErrors} parsing errors.`
    );
  }
}
