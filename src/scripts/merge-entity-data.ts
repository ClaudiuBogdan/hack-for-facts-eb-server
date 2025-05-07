import path from "path";
import fs from 'fs'
import { parse } from "csv-parse/sync";
import { EntityPubRecord } from "./generate-uat-json";

function getCuiToEntityMapVerified(): Record<string, EntityPubRecord> {
    const entCsvPath = path.resolve(
        __dirname,
        "../../data-map/uat-raw/ent_pub.csv"
    );
    const entCsvContent = fs.readFileSync(entCsvPath, "utf8");
    const entityRecords = parse(entCsvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter: ";",
    }) as EntityPubRecord[];

    // Create a map of CIF to entity record
    const cifToEntityMap: Record<string, EntityPubRecord> = {};
    entityRecords.forEach((record) => {
        cifToEntityMap[record.CIF] = record;
    });


    return cifToEntityMap;
}


function getCuiToEntityMapNew(): Record<string, EntityPubRecord> {
    const entCsvPath = path.resolve(
        __dirname,
        "../../data-map/uat-raw/entity2025.csv"
    );
    const entCsvContent = fs.readFileSync(entCsvPath, "utf8");
    const entityRecords = parse(entCsvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter: ";",
    }) as EntityPubRecord[];

    // Create a map of CIF to entity record
    const cifToEntityMap: Record<string, EntityPubRecord> = {};
    entityRecords.forEach((record) => {
        cifToEntityMap[record.CIF] = record;
    });


    return cifToEntityMap;
}


function mergeEntityData() {
    const cifToEntityMapVerified = getCuiToEntityMapVerified();
    const cifToEntityMapNew = getCuiToEntityMapNew();

    // Merge logic: start with verified, add new ones that are not in verified
    const mergedCifToEntityMap: Record<string, EntityPubRecord> = { ...cifToEntityMapVerified };

    for (const cif in cifToEntityMapNew) {
        // Use Object.prototype.hasOwnProperty.call for safer property check
        if (Object.prototype.hasOwnProperty.call(cifToEntityMapNew, cif)) {
            if (!Object.prototype.hasOwnProperty.call(mergedCifToEntityMap, cif)) {
                mergedCifToEntityMap[cif] = cifToEntityMapNew[cif];
            }
        }
    }

    const finalEntityList: EntityPubRecord[] = Object.values(mergedCifToEntityMap);

    const mergedCuiToEntityMapPath = path.resolve(
        __dirname,
        "../../data-map/uat-raw/entity2025-merged.csv"
    );

    if (finalEntityList.length === 0) {
        // If there's no data (e.g., both input files were empty or contained no data rows),
        // write an empty file. Headers cannot be derived from empty data.
        fs.writeFileSync(mergedCuiToEntityMapPath, "", "utf-8");
        console.log(`No data to merge, or input files were empty. Created empty file: ${mergedCuiToEntityMapPath}`);
        return; // Exit function
    }

    // Assume all records have the same structure.
    // Headers are derived from the keys of the first record.
    // This is consistent with how the CSVs were parsed (columns: true).
    const headers = Object.keys(finalEntityList[0]);
    
    // Construct CSV content
    // Header row, with columns joined by a semicolon
    const headerString = headers.join(';');
    
    // Data rows
    const rowStrings = finalEntityList.map(record => {
        return headers.map(header => {
            const value = record[header as keyof EntityPubRecord];
            // Convert value to string; null or undefined becomes an empty string.
            const stringValue = (value === null || value === undefined) ? "" : String(value);
            // Basic CSV value sanitization: if a value itself contains a double quote, it's typically escaped by doubling it (e.g., " becomes "").
            // This is a simplified CSV generation. For full RFC 4180 compliance (e.g., handling delimiters or newlines within fields),
            // a dedicated CSV stringification library would be more robust.
            return stringValue.replace(/"/g, '""'); 
        }).join(';'); // Join values in a row with semicolon
    });

    // Combine header and data rows, with each row on a new line
    const csvContent = [headerString, ...rowStrings].join('\n');

    fs.writeFileSync(mergedCuiToEntityMapPath, csvContent, 'utf-8');
    console.log(`Successfully merged data and wrote ${finalEntityList.length} records to ${mergedCuiToEntityMapPath}`);
}

mergeEntityData();