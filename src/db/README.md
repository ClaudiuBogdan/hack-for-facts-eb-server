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

## Development

When making changes to the database schema, follow these steps:

1. Update `schema.sql` with your changes
2. Add appropriate migration scripts in the `migrations` directory
3. Update the TypeScript models in `models.ts` 