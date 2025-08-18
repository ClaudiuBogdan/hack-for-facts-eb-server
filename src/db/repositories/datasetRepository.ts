import { datasetsData } from '../datasets';
import Fuse from 'fuse.js';

export interface Dataset {
  id: string;
  name: string;
  description?: string;
  sourceName?: string;
  sourceUrl?: string;
  unit?: string;
  yearlyTrend: { year: number; value: number }[];
}

export interface DatasetFilter {
  search?: string;
  ids?: string[];
}

class DatasetRepository {
  private datasets: Dataset[] = datasetsData;
  private fuse: Fuse<Dataset>;

  constructor() {
    this.fuse = new Fuse(this.datasets, {
      keys: ['name', 'description'],
      ignoreLocation: true,
      isCaseSensitive: false,
      threshold: 0.3,
    });
  }

  private getFilteredDatasets(filter: DatasetFilter): Dataset[] {
    let filtered: Dataset[] = this.datasets;
    if (filter.ids && filter.ids.length > 0) {
      const idSet = new Set(filter.ids);
      filtered = filtered.filter(d => idSet.has(d.id));
    }

    if (filter.search) {
      // If there's a search term, we use Fuse on the already ID-filtered list
      const fuse = new Fuse(filtered, {
        keys: ['name', 'description'],
        threshold: 0.3,
      });
      return fuse.search(filter.search).map(result => result.item);
    }

    return filtered;
  }

  getAll(filter: DatasetFilter = {}, limit: number = 100, offset: number = 0): Dataset[] {
    const filtered = this.getFilteredDatasets(filter);
    return filtered.slice(offset, offset + limit);
  }

  count(filter: DatasetFilter = {}): number {
    return this.getFilteredDatasets(filter).length;
  }

  getByIds(ids: string[]): Dataset[] {
    return this.datasets.filter(d => ids.includes(d.id));
  }
}

export const datasetRepository = new DatasetRepository();
