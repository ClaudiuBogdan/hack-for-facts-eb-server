import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import countyMap from "./county-map";

// Define interfaces
interface UatPopRecord {
  judet: string;
  cod_siruta: string;
  localitate: string;
  pop: string;
  localitate_clean: string;
  judet_uat: string;
  uat_cod: string;
}

export interface EntityPubRecord {
  JUDET: string;
  CIF: string;
  ENTITATE: string;
  UAT: string;
  ADRESA: string;
  PARENT1?: string;
  PARENT2?: string;
}

interface UatRecord {
  id: number;
  uat_key: string;
  uat_code: string;
  name: string;
  county_code: string;
  county_name: string;
  population: number;
  siruta_code: string;
}

// For mapping entities to UATs
interface UatCodeMapping {
  [cif: string]: string; // Maps entity CIF to UAT ID
}

async function main() {
  try {
    // Read and parse uat_cif_pop_2021.csv
    console.log("Reading UAT population data...");
    const uatCsvPath = path.resolve(
      __dirname,
      "../../data-map/uat-raw/uat_cif_pop_2021.csv"
    );
    const uatCsvContent = fs.readFileSync(uatCsvPath, "utf8");
    const uatRecords = parse(uatCsvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as UatPopRecord[];

    // Read and parse ent_pub_2025.csv
    console.log("Reading entity publication data...");
    const entCsvPath = path.resolve(
      __dirname,
      "../../data-map/uat-raw/ent_pub_2025.csv"
    );
    const entCsvContent = fs.readFileSync(entCsvPath, "utf8");
    const entityRecords = parse(entCsvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter: ";",
    }) as EntityPubRecord[];

    // Create a map of UATs with county-uat key lowercase as unique ID
    const uats: Record<string, UatRecord> = {};
    const cifToUatMap: UatCodeMapping = {};
    const uatKeyToIdMap: Record<string, number> = {};
    const uatCodToUatMap: UatCodeMapping = {};

    // Process UAT population data
    console.log("Processing UAT data...");
    let uatIdCounter = 1;
    uatRecords.forEach((record) => {
      // Generate a unique ID using county code and localitate_clean
      const uatKey =
        `${record.judet_uat}-${record.localitate_clean}`.toLowerCase();

      uats[uatKey] = {
        id: uatIdCounter++,
        uat_key: uatKey,
        uat_code: record.uat_cod,
        name: record.localitate,
        county_code: record.judet_uat,
        county_name: record.judet,
        population: parseInt(record.pop, 10) || 0,
        siruta_code: record.cod_siruta,
      };

      // Add to the UAT code mapping
      uatCodToUatMap[record.uat_cod] = uatKey;
      uatKeyToIdMap[uatKey] = uatIdCounter - 1;
    });

    // Process entity data to create entity-to-UAT mappings
    console.log("Processing entity data for mappings...");

    let count = 0;
    entityRecords.forEach((entity) => {
      if (!entity.CIF) return; // UAT is not strictly required here for the new logic

      let uatIdForEntity: string | undefined = undefined;

      // Priority 1: Use PARENT1 if available and it maps to a known UAT ID
      if (entity.PARENT1 && uatCodToUatMap[entity.PARENT1]) {
        uatIdForEntity = uatCodToUatMap[entity.PARENT1];
      }

      if (entity.PARENT2 && uatCodToUatMap[entity.PARENT2]) {
        uatIdForEntity = uatCodToUatMap[entity.PARENT2];
      }


      // Priority 2: Existing logic - Check if the entity itself is a UAT (CIF matches a UAT code)
      if (!uatIdForEntity && uatCodToUatMap[entity.CIF]) {
        uatIdForEntity = uatCodToUatMap[entity.CIF];
      }

      // Priority 3: Existing logic - Try to find the UAT by matching name if UAT name is present
      if (!uatIdForEntity && entity.UAT) {
        // TODO: map county to county code
        const countyCode = countyMap.get(entity.JUDET.toLowerCase());
        const cleanUatName = entity.UAT.toLowerCase().trim().replace("comuna ", "");
        const possibleUatIdByName = `${countyCode}-${cleanUatName}`.toLowerCase();
        if (uats[possibleUatIdByName]) {
          uatIdForEntity = possibleUatIdByName;
        } else {
          count++;
          console.warn(`No UAT found for entity ${entity.ENTITATE} with CIF ${entity.CIF} ${count}`);
        }
      }

      // If we found a UAT ID through any of the methods, add to the CIF mapping
      if (uatIdForEntity) {
        cifToUatMap[entity.CIF] = uatIdForEntity;
      }

      // Also ensure UAT codes (CIFs) themselves are mapped to UAT IDs if not already processed
      // This handles cases where a UAT entity might not have PARENT1 or a clear UAT name link initially
      if (entity.CIF && uatCodToUatMap[entity.CIF] && !cifToUatMap[entity.CIF]) {
        cifToUatMap[entity.CIF] = uatCodToUatMap[entity.CIF];
      }
    });

    // Create the output file with UATs, CIF mapping, and UAT_COD mapping
    const outputData = {
      uats: Object.values(uats),
      cifToUatMap,
      uatCodToUatMap,
      uatKeyToIdMap,
    };

    // Write the output to a JSON file
    const outputPath = path.resolve(
      __dirname,
      "../../data-map/data/uat-data.json"
    );
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), "utf8");

    console.log(
      `Generated UAT data file with ${Object.keys(uats).length} UATs`
    );
    console.log(
      `Generated CIF to UAT mappings for ${Object.keys(cifToUatMap).length
      } entities`
    );
    console.log(
      `Generated UAT_COD to UAT mappings for ${Object.keys(uatCodToUatMap).length
      } UATs`
    );
    console.log(`Output written to: ${outputPath}`);
  } catch (error) {
    console.error("Error generating UAT JSON:", error);
    process.exit(1);
  }
}

main().catch(console.error);

