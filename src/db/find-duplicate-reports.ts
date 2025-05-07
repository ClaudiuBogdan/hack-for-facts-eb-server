import pool from "./connection";

/**
 * Script to find duplicate reports based on entity_cui and report_date combination
 *
 * The Reports table has a unique constraint on (entity_cui, report_date),
 * so this script will find all cases where there are duplicates in the source data
 * before they are inserted into the database.
 */
async function findDuplicateReports() {
  const client = await pool.connect();
  try {
    console.log("Finding duplicate reports in data files...");

    // Read all reports from the source JSON file
    const fs = require("fs");
    const path = require("path");
    const dataDir = path.join(__dirname, "..", "..", "data-map");
    const reportsFilePath = path.join(dataDir, "data", "reports.json");

    const reportsDataRaw = await fs.promises.readFile(reportsFilePath, "utf8");
    const reportsData = JSON.parse(reportsDataRaw);

    // Create a map to track occurrences of each entity_cui + report_date combination
    const combinationMap = new Map<
      string,
      {
        occurrences: number;
        reports: Array<{
          report_id: number;
          entity_cui: number;
          report_date: string;
          reporting_year: number;
          reporting_period: string;
          file_source: string;
        }>;
      }
    >();

    // Count occurrences of each combination
    for (const report of reportsData.reports) {
      const key = `${report.entity_cui}_${report.report_date}`;

      if (!combinationMap.has(key)) {
        combinationMap.set(key, {
          occurrences: 0,
          reports: [],
        });
      }

      const mapEntry = combinationMap.get(key)!;
      mapEntry.occurrences += 1;
      mapEntry.reports.push({
        report_id: report.report_id,
        entity_cui: report.entity_cui,
        report_date: report.report_date,
        reporting_year: report.reporting_year,
        reporting_period: report.reporting_period,
        file_source: report.file_source,
      });
    }

    // Filter and print duplicates
    let hasDuplicates = false;
    let duplicateCount = 0;

    console.log("\n=== Duplicate Report Entries ===\n");

    for (const [key, value] of combinationMap.entries()) {
      if (value.occurrences > 1) {
        hasDuplicates = true;
        duplicateCount++;

        const [entity_cui, report_date] = key.split("_");
        console.log(
          `Key (entity_cui, report_date)=(${entity_cui}, ${report_date}) has ${value.occurrences} occurrences:`
        );

        value.reports.forEach((report, index) => {
          console.log(
            `  ${index + 1}. Report ID: ${report.report_id}, Period: ${
              report.reporting_period
            }, Year: ${report.reporting_year}, File: ${report.file_source}`
          );
        });

        console.log(); // Empty line for better readability
      }
    }

    if (!hasDuplicates) {
      console.log("No duplicate reports found.");
    } else {
      console.log(`Found ${duplicateCount} duplicate combinations.`);
      console.log("\nTo fix these duplicates:");
      console.log(
        "1. Examine which report should be kept for each duplicate combination"
      );
      console.log(
        "2. Modify the reports.json file to remove or update the duplicates"
      );
      console.log("3. Re-run the seed script after fixing the duplicates");
    }
  } catch (err) {
    console.error("Error finding duplicate reports:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the function
findDuplicateReports().catch((err) => console.error("Unhandled error:", err));
