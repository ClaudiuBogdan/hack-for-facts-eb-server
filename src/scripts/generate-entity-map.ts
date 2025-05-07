#!/usr/bin/env node

import { generateDataExport } from "../services/dataExportGenerator";

// CLI script to generate entity and classification maps
console.log("Data Export Generator");
console.log("------------------------");
console.log(
  "Generating entity maps, classification data, reports, and execution line items"
);

generateDataExport()
  .then(() => {
    console.log("\nAll data exports generated successfully!");
  })
  .catch((error: any) => {
    console.error("\nError generating data exports:", error.message);
    process.exit(1);
  });
