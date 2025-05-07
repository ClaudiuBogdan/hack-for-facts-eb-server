import fs from "fs/promises";
import path from "path";
import { ReportsFile } from "./seed/types";

/**
 * Script to fix duplicate reports by removing duplicate files
 *
 * This script will:
 * 1. Read the reports.json file
 * 2. Find all duplicates based on entity_cui and report_date
 * 3. Keep only the most recent report for each duplicate combination (based on report_id)
 * 4. Remove the files corresponding to the duplicates that will be discarded
 * 5. Save the fixed data back to reports.json
 */
async function fixDuplicateReports() {
  try {
    console.log("Fixing duplicate reports by removing duplicate files...");

    // Read reports data
    const dataDir = path.join(__dirname, "..", "..", "data-map");
    const reportsFilePath = path.join(dataDir, "data", "reports.json");

    const reportsDataRaw = await fs.readFile(reportsFilePath, "utf8");
    const reportsData: ReportsFile = JSON.parse(reportsDataRaw);

    console.log(`Loaded ${reportsData.reports.length} reports from file.`);

    // Create a map to track the latest report for each entity_cui + report_date combination
    const uniqueReports = new Map<string, (typeof reportsData.reports)[0]>();

    // Track reports to be removed
    const reportsToRemove: (typeof reportsData.reports)[0][] = [];

    // For summary statistics
    let successCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;

    // Sort reports by report_id (assuming higher report_id is more recent)
    const sortedReports = [...reportsData.reports].sort(
      (a, b) => b.report_id - a.report_id
    );

    // Process reports keeping only the most recent one for each combination
    for (const report of sortedReports) {
      const key = `${report.entity_cui}_${report.report_date}`;

      if (!uniqueReports.has(key)) {
        uniqueReports.set(key, report);
      } else {
        // If we already have a report for this combination, add this one to the removal list
        reportsToRemove.push(report);
      }
    }

    // Create new reports data with only unique entries
    const fixedReports: ReportsFile = {
      reports: Array.from(uniqueReports.values()),
    };

    console.log(`\nOriginal report count: ${reportsData.reports.length}`);
    console.log(`Fixed report count: ${fixedReports.reports.length}`);
    console.log(`Found ${reportsToRemove.length} duplicate reports to remove.`);

    // Remove duplicate files
    if (reportsToRemove.length > 0) {
      console.log("\nRemoving duplicate files:");

      for (const report of reportsToRemove) {
        if (report.file_source) {
          try {
            // Use the absolute path directly from file_source
            // The paths in file_source are already absolute
            const filePath = report.file_source;

            // Check if file exists before attempting to delete
            try {
              await fs.access(filePath);
              await fs.unlink(filePath);
              console.log(
                `  Removed: ${path.basename(filePath)} (${filePath})`
              );
              successCount++;
            } catch (err) {
              console.log(
                `  File not found: ${path.basename(filePath)} (${filePath})`
              );
              notFoundCount++;
            }
          } catch (err) {
            console.error(
              `  Error removing file for report ID ${report.report_id}:`,
              err
            );
            errorCount++;
          }
        } else {
          console.log(
            `  Report ID ${report.report_id} has no file_source (skipping)`
          );
        }
      }

      console.log(`\nRemoval summary:`);
      console.log(`  Successfully removed: ${successCount} files`);
      console.log(`  Files not found: ${notFoundCount}`);
      console.log(`  Errors: ${errorCount}`);
    }

    // Save the updated reports.json
    const backupPath = path.join(
      path.dirname(reportsFilePath),
      "reports.json.bak"
    );
    await fs.copyFile(reportsFilePath, backupPath);
    console.log(`\nOriginal reports.json backed up to ${backupPath}`);

    await fs.writeFile(
      reportsFilePath,
      JSON.stringify(fixedReports, null, 2),
      "utf8"
    );
    console.log("Updated reports.json with deduplicated data");

    console.log("\nDuplication fix complete:");
    console.log(
      `1. Updated reports.json to include only ${fixedReports.reports.length} unique reports`
    );
    console.log(`2. Original reports.json backed up to ${backupPath}`);

    if (notFoundCount > 0) {
      console.log(
        "\nNOTE: Some files could not be found. This could happen if:"
      );
      console.log("  - The files were already deleted in a previous run");
      console.log("  - The file_source paths in reports.json are incorrect");
      console.log("  - The files were moved or renamed");
    }

    console.log(
      "\nYou can now rerun the script to generate line items without duplication issues."
    );
  } catch (err) {
    console.error("Error fixing duplicate reports:", err);
  }
}

// Run the function
fixDuplicateReports().catch((err) => console.error("Unhandled error:", err));
