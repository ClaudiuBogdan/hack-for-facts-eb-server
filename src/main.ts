import * as fs from "fs-extra";
import { xmlValidationConfig as config } from "./validationConfig";
import { findXmlFiles, getPathContext } from "./utils/fileFinder";
import {
  parseXml,
  extractData,
  validateExtractedData,
} from "./services/xmlProcessor";
import { StatsCollector } from "./services/statsCollector";
import { generateReports } from "./services/reporter";
import { ExtractionResult } from "./types";

async function runValidationProcess(): Promise<void> {
  console.log("Starting XML validation process...");

  const statsCollector = new StatsCollector(config);

  // 1. Find all XML files
  const xmlFiles = await findXmlFiles(config.dataDir);
  console.log(`Found ${xmlFiles.length} XML files to process.`);

  // 2. Process each file
  for (const filePath of xmlFiles) {
    statsCollector.recordParsingAttempt(filePath);
    let parsedXml: any;
    try {
      // 2a. Read and Parse XML
      const fileData = await fs.readFile(filePath, "utf8");
      parsedXml = parseXml(fileData);

      // 2b. Extract Data
      const { year, month } = getPathContext(filePath, config.dataDir);
      const extractionResult: ExtractionResult = extractData(
        parsedXml,
        filePath,
        year,
        month
      );

      if (extractionResult.error || !extractionResult.data) {
        statsCollector.recordExtractionError(
          filePath,
          extractionResult.error || "Unknown extraction error"
        );
        continue; // Skip validation if extraction failed
      }

      // 2c. Validate Extracted Data
      const validationResult = validateExtractedData(extractionResult.data);

      // 2d. Record Results
      statsCollector.recordValidationResult(
        filePath,
        extractionResult.data,
        validationResult
      );
    } catch (error: any) {
      // Handle parsing errors (or unexpected errors during processing)
      statsCollector.recordParsingError(filePath, error);
    }
  }

  // 3. Generate Reports
  console.log("\nGenerating reports...");
  const finalStats = statsCollector.getStats();
  await generateReports(finalStats, config);

  // 4. Print Final Summary
  console.log(`\nValidation completed!`);
  console.log(`Total files found: ${finalStats.totalFiles}`);
  console.log(`Files successfully parsed: ${finalStats.parsedFiles}`);
  console.log(`   - Valid files (post-extraction): ${finalStats.validFiles}`);
  console.log(
    `   - Invalid files (post-extraction): ${finalStats.invalidFiles}`
  );
  console.log(`Files with parsing errors: ${finalStats.parsingErrors}`);
  console.log(`Files missing CUI: ${finalStats.missingEntityInfoCount}`);
  console.log(
    `Files with invalid date format: ${finalStats.invalidDateFormatCount}`
  );
  console.log(`\nSee generated report files for full details:`);
  console.log(`  - ${config.reportOutputFileJson}`);
  console.log(`  - ${config.reportOutputFileCsvFields}`);
  if (finalStats.parsingErrors > 0 || finalStats.invalidFiles > 0) {
    console.log(`  - ${config.reportOutputFileCsvErrors}`);
  }
}

// Run if executed directly
if (require.main === module) {
  runValidationProcess()
    .then(() => console.log("\nValidation process finished successfully."))
    .catch((err) => {
      console.error("\nCritical error during validation process:", err);
      process.exit(1);
    });
}

export { runValidationProcess };
