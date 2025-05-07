# Database Schema

This directory contains the database schema and related scripts for the project.

## Schema Overview

The database is structured around several key tables:

- **UATs**: Contains information about Administrative Territorial Units (UATs)
- **Entities**: Contains information about reporting entities that may or may not be UATs themselves
- **Reports**: Stores metadata about imported reports
- **ExecutionLineItems**: The main fact table containing budget execution data
- **Dimension tables**: FunctionalClassifications, EconomicClassifications, FundingSources

## Entity-UAT Relationship

The system separates Entities from UATs:

1. UATs are stored in the `UATs` table with a unique identifier and their code (CIF/uat_cod)
2. Entities can be linked to UATs through the `uat_id` foreign key
3. Some entities are UATs themselves, while others are connected to UATs

## Data Import

### Importing UATs and Linking Entities

The system includes scripts for importing UATs from mapping files and updating entity relationships:

1. Generate the UAT JSON data file first:
   ```bash
   yarn generate-uat-json
   ```
   This will:
   - Read data from `data-map/uat_cif_pop_2021.csv` and `data-map/ent_pub_2025.csv`
   - Generate unique IDs for each UAT (using county-uat key format)
   - Create mappings between entity CIF and UAT
   - Output the data to `data-map/uat-data.json`

2. Import the UAT data into the database:
   ```bash
   yarn import-uats
   ```
   This will:
   - Read the generated JSON data file
   - Execute the SQL migration to insert UATs
   - Update entity-UAT relationships

### Data Sources

The UAT import process uses two main data sources:

1. `data-map/uat_cif_pop_2021.csv` - Population data for UATs including unique codes
2. `data-map/ent_pub_2025.csv` - Entity data with UAT relationships

## Development

When making changes to the database schema, follow these steps:

1. Update `schema.sql` with your changes
2. Add appropriate migration scripts in the `migrations` directory
3. Update the TypeScript models in `models.ts` 