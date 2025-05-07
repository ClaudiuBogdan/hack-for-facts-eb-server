import * as fs from "fs-extra";
import { ValidationStats, FieldStats } from "../types";
import { XmlValidationConfig } from "../validationConfig";

interface ReportFieldStat extends FieldStats {
  average: number;
}

interface ReportData extends Omit<ValidationStats, "fieldsStats"> {
  fieldsStats: Record<string, ReportFieldStat>;
}

export async function generateReports(
  stats: ValidationStats,
  config: XmlValidationConfig
): Promise<void> {
  // 1. Prepare data for JSON report (calculate averages)
  const reportData: ReportData = {
    ...stats,
    fieldsStats: Object.entries(stats.fieldsStats).reduce(
      (acc, [field, stat]) => {
        acc[field] = {
          ...stat,
          // Handle count being potentially 0 after initialization fix
          average:
            stat.count > 0
              ? Math.round((stat.total / stat.count) * 100) / 100
              : 0,
          // Ensure min is 0 if count is 0
          min: stat.count > 0 ? stat.min : 0,
        };
        return acc;
      },
      {} as Record<string, ReportFieldStat>
    ),
  };

  // 2. Write JSON report
  await fs.writeJson(config.reportOutputFileJson, reportData, { spaces: 2 });
  console.log(`JSON report written to ${config.reportOutputFileJson}`);

  // 3. Write Field Lengths CSV
  const csvFieldLines: string[] = ["field,min,max,average,count"];
  for (const [field, stat] of Object.entries(reportData.fieldsStats)) {
    // Only include fields that were actually tracked and had data
    if (stat.count > 0 || config.fieldsToTrack.includes(field)) {
      csvFieldLines.push(
        `${field},${stat.min},${stat.max},${stat.average},${stat.count}`
      );
    }
  }
  if (csvFieldLines.length > 1) {
    await fs.writeFile(
      config.reportOutputFileCsvFields,
      csvFieldLines.join("\n")
    );
    console.log(
      `Field lengths CSV report written to ${config.reportOutputFileCsvFields}`
    );
  } else {
    console.log("No field data to write for CSV report.");
  }

  // 4. Write Error Log CSV
  const errorFiles = Object.entries(stats.errorsByFile);
  if (errorFiles.length > 0) {
    const csvErrorLines: string[] = ["File,Errors"];
    for (const [file, errors] of errorFiles) {
      // Join multiple errors with a semicolon, escape quotes within the error string
      const errorString = errors.join("; ").replace(/"/g, '""');
      csvErrorLines.push(`"${file}","${errorString}"`);
    }
    await fs.writeFile(
      config.reportOutputFileCsvErrors,
      csvErrorLines.join("\n")
    );
    console.log(`Error log CSV written to ${config.reportOutputFileCsvErrors}`);
  } else {
    console.log("No errors found to write to CSV error log.");
  }
}
