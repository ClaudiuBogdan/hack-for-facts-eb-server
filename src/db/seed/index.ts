import fs from "fs/promises";
import path from "path";
import { Pool } from "pg";
import {
  EconomicClassificationFile,
  EntityFile,
  FunctionalClassificationFile,
  FundingSourceFile,
  UATFile,
  ExecutionLineItemsFile,
  ReportsFile,
} from "./types";
import pool from "../connection";

const dataDir = path.join(__dirname, "..", "..", "..", "data-map");

const economicClassificationFilePath = path.join(
  dataDir,
  "data",
  "economic-classifications.json"
);
const entityFilePath = path.join(dataDir, "data", "entity-map.json");
const functionalClassificationFilePath = path.join(
  dataDir,
  "data",
  "functional-classifications.json"
);
const fundingSourcesFilePath = path.join(
  dataDir,
  "data",
  "funding-sources.json"
);
const reportsFilePath = path.join(dataDir, "data", "reports.json");
const uatFilePath = path.join(dataDir, "data", "uat-data.json");
const executionLineItemsBaseDirPath = path.join(
  dataDir,
  'data',
  "execution-line-items"
);

async function loadData() {
  // Configure the PostgreSQL connection; ensure DATABASE_URL is set
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    console.log("Transaction started.");

    // 1. Load UATs
    const uatDataRaw = await fs.readFile(uatFilePath, "utf8");
    const uatData: UATFile = JSON.parse(uatDataRaw);
    console.log(`Loaded ${uatData.uats.length} UAT entries.`);

    // We'll compute the "country_uat_id" as "county_code_\(uat_code\)"
    // and store a mapping from the computed official id to the actual db generated uat_id.
    const uatMapping = new Map<string, number>();
    for (const uat of uatData.uats) {
      await client.query(
        `INSERT INTO UATs (id, uat_key, uat_code, siruta_code, name, county_code, county_name, region, population)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          uat.id,
          uat.uat_key,
          uat.uat_code,
          uat.siruta_code,
          uat.name,
          uat.county_code,
          uat.county_name,
          "",
          uat.population,
        ]
      );
      uatMapping.set(uat.uat_key, uat.id);
    }
    console.log("UATs inserted.");

    // 2. Load Funding Sources
    const fundingDataRaw = await fs.readFile(fundingSourcesFilePath, "utf8");
    const fundingData: FundingSourceFile = JSON.parse(fundingDataRaw);
    for (const key in fundingData.items) {
      const item = fundingData.items[key];
      await client.query(
        `INSERT INTO FundingSources (source_description) VALUES ($1)`,
        [item.name]
      );
    }
    console.log("Funding sources inserted.");

    // 3. Load Functional Classifications
    const funcDataRaw = await fs.readFile(
      functionalClassificationFilePath,
      "utf8"
    );
    const funcData: FunctionalClassificationFile = JSON.parse(funcDataRaw);
    funcData.items["0"] = {
      code: 0,
      name: "No functional classification",
      occurrences: 0,
      entities: [],
    };
    for (const key in funcData.items) {
      const item = funcData.items[key];
      await client.query(
        `INSERT INTO FunctionalClassifications (functional_code, functional_name) VALUES ($1, $2)`,
        [item.code.toString(), item.name]
      );
    }
    console.log("Functional classifications inserted.");

    // 4. Load Economic Classifications
    const economicDataRaw = await fs.readFile(
      economicClassificationFilePath,
      "utf8"
    );
    const economicData: EconomicClassificationFile =
      JSON.parse(economicDataRaw);
    economicData.items["0"] = {
      code: 0,
      name: "No economic classification",
      occurrences: 0,
      entities: [],
    };
    for (const key in economicData.items) {
      const item = economicData.items[key];
      await client.query(
        `INSERT INTO EconomicClassifications (economic_code, economic_name) VALUES ($1, $2)`,
        [item.code.toString(), item.name]
      );
    }
    console.log("Economic classifications inserted.");

    // 5. Load Entities
    const entityDataRaw = await fs.readFile(entityFilePath, "utf8");
    const entityData: EntityFile = JSON.parse(entityDataRaw);
    // The UATFile also contains a "cifToUatMap" to map entity CUI to a UAT official id.
    for (const key in entityData.entities) {
      const entity = entityData.entities[key];
      // Try to determine the UAT association from cifToUatMap (if exists).
      const officialUatId = uatData.cifToUatMap[entity.cui.toString()];
      let dbUatId: number | null = null;
      if (officialUatId) {
        dbUatId = uatMapping.get(officialUatId) || null;
      }
      await client.query(
        `INSERT INTO Entities (cui, name, sector_type, uat_id, address)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          entity.cui.toString(),
          entity.entityName,
          entity.sectorType,
          dbUatId,
          "",
        ]
      );
    }
    console.log("Entities inserted.");

    // 6. Load Reports
    const reportsDataRaw = await fs.readFile(reportsFilePath, "utf8");
    const reportsData: ReportsFile = JSON.parse(reportsDataRaw);
    const reportIdToEntityCuiMap = new Map<number, string>();
    for (const rep of reportsData.reports) {
      await client.query(
        `INSERT INTO Reports (report_id, entity_cui, report_date, reporting_year, reporting_period, file_source, import_timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          rep.report_id,
          rep.entity_cui.toString(),
          rep.report_date,
          rep.reporting_year,
          rep.reporting_period,
          rep.file_source,
          rep.import_timestamp,
        ]
      );
      reportIdToEntityCuiMap.set(rep.report_id, rep.entity_cui.toString());
    }
    console.log("Reports inserted.");

    // 7. Load Execution Line Items (batch processing multiple files)
    const execFiles = await fs.readdir(executionLineItemsBaseDirPath);
    for (const fileName of execFiles) {
      const filePath = path.join(executionLineItemsBaseDirPath, fileName);
      const execDataRaw = await fs.readFile(filePath, "utf8");
      const execData: ExecutionLineItemsFile = JSON.parse(execDataRaw);

      // Prepare batch insert for efficiency.
      const valueStrings: string[] = [];
      const queryValues: any[] = [];
      let batchCount = 0;
      for (const item of execData.lineItems) {
        // We ignore the provided line_item_id as the database uses GENERATED BY DEFAULT (serial)
        const entityCui = reportIdToEntityCuiMap.get(item.report_id);
        if (!entityCui) {
          console.warn(`Could not find entity_cui for report_id: ${item.report_id}. Skipping line item.`);
          continue;
        }
        valueStrings.push(
          `($${queryValues.length + 1}, $${queryValues.length + 2}, $${
            queryValues.length + 3
          }, $${queryValues.length + 4}, $${queryValues.length + 5}, $${
            queryValues.length + 6
          }, $${queryValues.length + 7}, $${queryValues.length + 8}, $${queryValues.length + 9})`
        );
        queryValues.push(
          item.report_id,
          entityCui,
          item.funding_source_id,
          item.functional_code?.toString() || "0",
          item.economic_code?.toString() || "0",
          item.account_category,
          item.amount,
          item.program_code,
          item.year
        );
        batchCount++;

        // Execute batch every 1000 rows
        if (batchCount % 1000 === 0) {
          const insertQuery = `INSERT INTO ExecutionLineItems 
            (report_id, entity_cui, funding_source_id, functional_code, economic_code, account_category, amount, program_code, year)
            VALUES ${valueStrings.join(", ")}`;
          await client.query(insertQuery, queryValues);
          valueStrings.length = 0;
          queryValues.length = 0;
        }
      }
      // Insert any remaining rows in the batch.
      if (valueStrings.length > 0) {
        const insertQuery = `INSERT INTO ExecutionLineItems 
          (report_id, entity_cui, funding_source_id, functional_code, economic_code, account_category, amount, program_code, year)
          VALUES ${valueStrings.join(", ")}`;
        await client.query(insertQuery, queryValues);
      }
      console.log(`Execution line items from ${fileName} inserted.`);
    }

    await client.query("COMMIT");
    console.log("Data seeding completed successfully.");
  } catch (err) {
    console.error("Error during seeding:", err);
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
}

loadData().catch((err) => console.error("Unhandled error:", err));
