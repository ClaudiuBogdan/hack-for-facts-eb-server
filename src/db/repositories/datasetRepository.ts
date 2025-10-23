import fs from 'fs';
import path from 'path';
import Fuse, { IFuseOptions } from 'fuse.js';
import { Dataset, DatasetSummary, datasetSchema } from '../datasets';
import { DATASETS_DIRECTORY_DEFAULT } from '../datasets/validation';

export interface DatasetFilter {
  search?: string;
  ids?: string[];
}

type DatasetCacheEntry = { dataset: Dataset; mtimeMs: number };

type DatasetFileEntry = {
  summary: DatasetSummary;
  filePath: string;
  mtimeMs: number;
};

const FUSE_OPTIONS: IFuseOptions<DatasetSummary> = {
  keys: [
    'name',
    'nameEn',
    'title',
    'titleEn',
    'description',
    'descriptionEn',
    'sourceName',
    'sourceNameEn',
    'sourceUrl',
  ],
  ignoreLocation: true,
  isCaseSensitive: false,
  threshold: 0.3,
};

class DatasetRepository {
  private readonly datasetDir: string;
  private readonly cacheTtlMs: number;

  private fuse: Fuse<DatasetSummary> | null = null;
  private summaries: DatasetSummary[] = [];
  private fileEntries: Map<string, DatasetFileEntry> = new Map();
  private cache: Map<string, DatasetCacheEntry> = new Map();
  private lastCatalogRefresh = 0;

  constructor(options: { datasetDirectory?: string; cacheTtlMs?: number } = {}) {
    this.datasetDir = options.datasetDirectory ?? DATASETS_DIRECTORY_DEFAULT;
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.refreshCatalog();
  }

  refreshCatalog(): void {
    this.fuse = null;
    this.summaries = [];
    this.fileEntries = new Map();
    this.lastCatalogRefresh = Date.now();
    const nextCache: Map<string, DatasetCacheEntry> = new Map();

    if (!fs.existsSync(this.datasetDir)) {
      this.cache = nextCache;
      return;
    }

    const datasetFiles = fs
      .readdirSync(this.datasetDir)
      .filter(fileName => fileName.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of datasetFiles) {
      const filePath = path.join(this.datasetDir, fileName);
      const stat = fs.statSync(filePath);
      let parsed: Dataset | null = null;

      const cached = this.cache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        parsed = cached.dataset;
        nextCache.set(filePath, cached);
      } else {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const candidate = JSON.parse(raw);
          const result = datasetSchema.safeParse(candidate);

          if (!result.success) {
            console.error(
              `[DatasetRepository] Validation failed for dataset file ${filePath}: ${result.error.message}`,
            );
            continue;
          }

          parsed = result.data;
          nextCache.set(filePath, { dataset: parsed, mtimeMs: stat.mtimeMs });
        } catch (error) {
          console.error(
            `[DatasetRepository] Failed to load dataset file ${filePath}:`,
            error,
          );
          continue;
        }
      }

      if (!parsed) {
        continue;
      }

      if (this.fileEntries.has(parsed.id)) {
        console.warn(
          `[DatasetRepository] Duplicate dataset id "${parsed.id}" encountered in filesystem. File ${filePath} ignored.`,
        );
        continue;
      }

      const summary: DatasetSummary = {
        id: parsed.id,
        name: parsed.name,
        nameEn: parsed.nameEn,
        title: parsed.title,
        titleEn: parsed.titleEn,
        description: parsed.description,
        descriptionEn: parsed.descriptionEn,
        sourceName: parsed.sourceName,
        sourceNameEn: parsed.sourceNameEn,
        sourceUrl: parsed.sourceUrl,
        xAxis: parsed.xAxis,
        yAxis: parsed.yAxis,
      };

      this.fileEntries.set(parsed.id, {
        summary,
        filePath,
        mtimeMs: stat.mtimeMs,
      });
      this.summaries.push(summary);
    }

    this.cache = nextCache;
    this.fuse = new Fuse(this.summaries, FUSE_OPTIONS);
  }

  private ensureCatalogFresh(): void {
    if (
      !this.fuse ||
      (this.cacheTtlMs > 0 && Date.now() - this.lastCatalogRefresh > this.cacheTtlMs)
    ) {
      this.refreshCatalog();
    }
  }

  private normalizeLang(lang?: string | null): 'en' | null {
    if (!lang) return null;
    const trimmed = lang.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed === 'en' || trimmed.startsWith('en-')) {
      return 'en';
    }
    return null;
  }

  private localizeSummary(summary: DatasetSummary, lang: 'en' | null): DatasetSummary {
    if (!lang) return summary;
    return {
      ...summary,
      name: summary.nameEn ?? summary.name,
      title: summary.titleEn ?? summary.title,
      description: summary.descriptionEn ?? summary.description,
      sourceName: summary.sourceNameEn ?? summary.sourceName,
    };
  }

  private localizeDataset(dataset: Dataset, lang: 'en' | null): Dataset {
    if (!lang) return dataset;
    return {
      ...dataset,
      name: dataset.nameEn ?? dataset.name,
      title: dataset.titleEn ?? dataset.title,
      description: dataset.descriptionEn ?? dataset.description,
      sourceName: dataset.sourceNameEn ?? dataset.sourceName,
    };
  }

  private getDataset(id: string, lang: 'en' | null): Dataset | null {
    this.ensureCatalogFresh();
    let entry = this.fileEntries.get(id);
    if (!entry) {
      return null;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(entry.filePath);
    } catch (error) {
      console.error(`[DatasetRepository] Dataset file missing for id "${id}"`, error);
      this.refreshCatalog();
      entry = this.fileEntries.get(id);
      if (!entry) {
        return null;
      }
      try {
        stat = fs.statSync(entry.filePath);
      } catch (statError) {
        console.error(
          `[DatasetRepository] Failed to stat dataset file ${entry.filePath}`,
          statError,
        );
        return null;
      }
    }

    if (stat.mtimeMs !== entry.mtimeMs) {
      this.refreshCatalog();
      entry = this.fileEntries.get(id);
      if (!entry) {
        return null;
      }
    }

    const cached = this.cache.get(entry.filePath);
    if (cached && cached.mtimeMs === entry.mtimeMs) {
      return this.localizeDataset(cached.dataset, lang);
    }

    try {
      const raw = fs.readFileSync(entry.filePath, 'utf-8');
      const candidate = JSON.parse(raw);
      const result = datasetSchema.safeParse(candidate);
      if (!result.success) {
        console.error(
          `[DatasetRepository] Validation failed for dataset file ${entry.filePath}: ${result.error.message}`,
        );
        return null;
      }

      this.cache.set(entry.filePath, { dataset: result.data, mtimeMs: entry.mtimeMs });
      return this.localizeDataset(result.data, lang);
    } catch (error) {
      console.error(
        `[DatasetRepository] Failed to load dataset file ${entry.filePath}:`,
        error,
      );
      return null;
    }
  }

  private getFilteredSummaries(filter: DatasetFilter, lang: 'en' | null): DatasetSummary[] {
    this.ensureCatalogFresh();

    let filtered = this.summaries;
    if (filter.ids && filter.ids.length > 0) {
      const idSet = new Set(filter.ids);
      filtered = filtered.filter(summary => idSet.has(summary.id));
    }

    const localized = lang ? filtered.map(summary => this.localizeSummary(summary, lang)) : filtered;

    if (filter.search && filter.search.trim().length > 0) {
      const fuse = new Fuse(localized, FUSE_OPTIONS);
      return fuse.search(filter.search).map(result => result.item);
    }

    return localized;
  }

  getAll(
    filter: DatasetFilter = {},
    limit: number = 100,
    offset: number = 0,
    lang?: 'ro' | 'en',
  ): Dataset[] {
    const normalizedLang = this.normalizeLang(lang);
    const filteredSummaries = this.getFilteredSummaries(filter, normalizedLang);
    const paginatedSummaries = filteredSummaries.slice(offset, offset + limit);

    const datasets: Dataset[] = [];
    for (const summary of paginatedSummaries) {
      const dataset = this.getDataset(summary.id, normalizedLang);
      if (dataset) {
        datasets.push(dataset);
      }
    }

    return datasets;
  }

  count(filter: DatasetFilter = {}, lang?: 'ro' | 'en'): number {
    const normalizedLang = this.normalizeLang(lang);
    return this.getFilteredSummaries(filter, normalizedLang).length;
  }

  getByIds(ids: string[], lang?: 'ro' | 'en'): Dataset[] {
    if (!ids || ids.length === 0) {
      return [];
    }

    const normalizedLang = this.normalizeLang(lang);
    const datasets: Dataset[] = [];
    for (const id of ids) {
      const dataset = this.getDataset(id, normalizedLang);
      if (dataset) {
        datasets.push(dataset);
      }
    }

    return datasets;
  }
}

export const datasetRepository = new DatasetRepository();
export type { Dataset } from '../datasets';
