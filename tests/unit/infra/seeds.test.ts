import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { loadSeedData, InMemoryDatabaseQuery } from '../../fixtures/index.js';

describe('Seed Data Loader', () => {
  it('should load seed data from directory', () => {
    const seedDir = path.join(process.cwd(), 'src/infra/database/seeds/entities');
    const db = loadSeedData(seedDir);

    expect(db).toBeDefined();
    expect(db.entities.size).toBeGreaterThan(0);
    expect(db.functionalClassifications.size).toBeGreaterThan(0);
    expect(db.economicClassifications.size).toBeGreaterThan(0);
  });

  it('should create query helper and query entities', () => {
    const seedDir = path.join(process.cwd(), 'src/infra/database/seeds/entities');
    const db = loadSeedData(seedDir);
    const query = new InMemoryDatabaseQuery(db);

    const entities = query.getAllEntities();
    expect(entities.length).toBeGreaterThan(0);

    const firstEntity = entities[0];
    expect(firstEntity).toBeDefined();
    expect(firstEntity?.cui).toBeDefined();
    expect(firstEntity?.name).toBeDefined();

    // Query by CUI
    if (firstEntity !== undefined) {
      const entityByCui = query.getEntityByCui(firstEntity.cui);
      expect(entityByCui).toBeDefined();
      expect(entityByCui?.cui).toBe(firstEntity.cui);
    }
  });

  it('should query functional and economic classifications', () => {
    const seedDir = path.join(process.cwd(), 'src/infra/database/seeds/entities');
    const db = loadSeedData(seedDir);
    const query = new InMemoryDatabaseQuery(db);

    // Get first classification
    const firstFunctional = db.functionalClassifications.values().next().value;
    if (firstFunctional !== undefined) {
      const classification = query.getFunctionalClassification(firstFunctional.functional_code);
      expect(classification).toBeDefined();
      expect(classification?.functional_name).toBeDefined();
    }

    const firstEconomic = db.economicClassifications.values().next().value;
    if (firstEconomic !== undefined) {
      const classification = query.getEconomicClassification(firstEconomic.economic_code);
      expect(classification).toBeDefined();
      expect(classification?.economic_name).toBeDefined();
    }
  });

  it('should have funding sources and budget sectors', () => {
    const seedDir = path.join(process.cwd(), 'src/infra/database/seeds/entities');
    const db = loadSeedData(seedDir);
    const query = new InMemoryDatabaseQuery(db);

    expect(db.fundingSources.size).toBeGreaterThan(0);

    const firstSource = db.fundingSources.values().next().value;
    if (firstSource !== undefined) {
      const source = query.getFundingSource(firstSource.source_id);
      expect(source).toBeDefined();
      expect(source?.source_description).toBeDefined();

      const sourceByDesc = query.getFundingSourceByDescription(firstSource.source_description);
      expect(sourceByDesc).toBeDefined();
      expect(sourceByDesc?.source_id).toBe(firstSource.source_id);
    }
  });

  it('should load reports and line items', () => {
    const seedDir = path.join(process.cwd(), 'src/infra/database/seeds/entities');
    const db = loadSeedData(seedDir);
    const query = new InMemoryDatabaseQuery(db);

    expect(db.reports.size).toBeGreaterThan(0);
    expect(db.executionLineItems.length).toBeGreaterThan(0);

    const report = db.reports.values().next().value;
    expect(report).toBeDefined();
    if (report !== undefined) {
      const items = query.getLineItemsByReport(report.report_id);
      expect(items.length).toBeGreaterThan(0);
    }
  });
});
