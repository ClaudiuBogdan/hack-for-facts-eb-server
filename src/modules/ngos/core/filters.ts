import type { CollectionFilterSpec, FilterInput } from '@/modules/shared/index.js';

export const ngoRegistryFilterSpec: CollectionFilterSpec = {
  collection: 'ngo_registry',
  sort: { default: 'sourceRowNumber', allowed: ['sourceRowNumber'] },
  fields: [
    {
      name: 'name',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'r', column: 'normalized_name' },
      description: 'Case/accent-insensitive organization name fragment; snapshot-scoped scan.',
    },
    {
      name: 'registryNumber',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'r', column: 'registry_number' },
    },
    { name: 'county', type: 'string', ops: ['eq'], column: { alias: 'r', column: 'county' } },
    {
      name: 'category',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'r', column: 'entity_kind' },
    },
    {
      name: 'status',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'r', column: 'source_registry_status' },
    },
    {
      name: 'publicUtility',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'r', column: 'source_reports_public_utility' },
    },
  ],
};

/** Matches the scraper's established NGO normalizeKey; all operators still go through the kernel. */
export const normalizeNgoFilters = (filter: FilterInput): FilterInput => {
  const name = filter['name'];
  const contains = name?.['contains'];
  if (typeof contains !== 'string') return filter;
  const normalized = contains
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return { ...filter, name: { ...name, contains: normalized } };
};
