#!/usr/bin/env node

import { runValidationProcess } from "../main";

// Simple command-line script to run the XML validation
runValidationProcess()
  .then(() => {
    console.log("XML validation process completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error running XML validation process:", error);
    process.exit(1);
  });
