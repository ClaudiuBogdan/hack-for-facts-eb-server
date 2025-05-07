import * as path from "path";

export interface XmlValidationConfig {
  dataDir: string;
  fieldsToTrack: string[];
  reportOutputFileJson: string;
  reportOutputFileCsvFields: string;
  reportOutputFileCsvErrors: string;
  maxExampleValues: number;
}

export const xmlValidationConfig: XmlValidationConfig = {
  dataDir: path.resolve(process.cwd(), "./data"),
  fieldsToTrack: [
    "cui",
    "entityName",
    "sectorType",
    "fundingSource",
    "functionalCode",
    "functionalName",
    "economicCode",
    "economicName",
    "amount",
  ],
  reportOutputFileJson: "validation-report.json",
  reportOutputFileCsvFields: "field-lengths.csv",
  reportOutputFileCsvErrors: "validation-errors.csv",
  maxExampleValues: 5, // Max examples to store for field stats
};
