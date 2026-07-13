export interface ProcurementPerformanceCase {
  readonly label: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly expectsInvalidInput?: boolean;
  readonly distinct?: {
    readonly grain: 'contract' | 'direct_acquisition';
    readonly key: 'supplier_cui' | 'authority_cui';
    readonly bucket: 'month' | 'quarter' | 'year';
    readonly authorityCui?: string;
    readonly supplierCui?: string;
  };
}

const seriesQuery = `query($scope:ProcurementAnalysisScopeInput!,$measure:ProcurementAnalysisMeasure!,$bucket:ProcurementSeriesBucket!){
  procurementSeries(scope:$scope,measure:$measure,bucket:$bucket){ grain points { bucket value } meta { buildId } }
}`;

const distinctCases = (
  label: string,
  scope: Readonly<Record<string, unknown>>,
  measure: 'distinctSuppliers' | 'distinctAuthorities',
  filters: { readonly authorityCui?: string; readonly supplierCui?: string }
): readonly ProcurementPerformanceCase[] =>
  (['month', 'quarter', 'year'] as const).map((bucket) => ({
    label: `${label}:${measure}:${bucket}`,
    query: seriesQuery,
    variables: { scope, measure, bucket },
    distinct: {
      grain: scope['grain'] as 'contract' | 'direct_acquisition',
      key: measure === 'distinctSuppliers' ? 'supplier_cui' : 'authority_cui',
      bucket,
      ...filters,
    },
  }));

const breakdownCase = (dimension: string): ProcurementPerformanceCase => ({
  label: `platform-breakdown:contract:${dimension}`,
  query: `query($scope:ProcurementAnalysisScopeInput!,$dimension:ProcurementBreakdownDimension!){
    procurementBreakdown(scope:$scope,dimension:$dimension){ grain buckets { kind key recordCount } meta { buildId } }
  }`,
  variables: { scope: { grain: 'contract' }, dimension },
});

export const buildProcurementPerformanceCorpus = (fixtures: {
  readonly authorityCui: string;
  readonly supplierCui: string;
}): readonly ProcurementPerformanceCase[] => {
  const { authorityCui, supplierCui } = fixtures;
  return [
    ...distinctCases('platform-contract', { grain: 'contract' }, 'distinctSuppliers', {}),
    ...distinctCases('platform-contract', { grain: 'contract' }, 'distinctAuthorities', {}),
    ...distinctCases(
      'authority-contract',
      { grain: 'contract', authorityCui },
      'distinctSuppliers',
      { authorityCui }
    ),
    ...distinctCases(
      'supplier-contract',
      { grain: 'contract', supplierCui },
      'distinctAuthorities',
      { supplierCui }
    ),
    ...distinctCases(
      'authority-da',
      { grain: 'direct_acquisition', authorityCui },
      'distinctSuppliers',
      { authorityCui }
    ),
    ...distinctCases(
      'supplier-da',
      { grain: 'direct_acquisition', supplierCui },
      'distinctAuthorities',
      { supplierCui }
    ),
    ...[
      'supplier',
      'authority',
      'cpvDivision',
      'cpvCode',
      'status',
      'procedureType',
      'buyerRegion',
    ].map(breakdownCase),
    {
      label: 'bounded-authority-stats',
      query: `query($scope:ProcurementAnalysisScopeInput!){ procurementStats(scope:$scope){ blocks { grain recordCount meta { buildId } } } }`,
      variables: { scope: { grain: 'contract', authorityCui } },
    },
    {
      label: 'bounded-authority-supplier-breakdown',
      query: `query($scope:ProcurementAnalysisScopeInput!){ procurementBreakdown(scope:$scope,dimension:supplier){ grain buckets { kind key recordCount } meta { buildId } } }`,
      variables: { scope: { grain: 'direct_acquisition', authorityCui } },
    },
    {
      label: 'rejected-unbounded-da-distinct',
      query: seriesQuery,
      variables: {
        scope: { grain: 'direct_acquisition' },
        measure: 'distinctSuppliers',
        bucket: 'month',
      },
      expectsInvalidInput: true,
    },
    {
      label: 'rejected-supplier-fixed-concentration',
      query: `query($scope:ProcurementAnalysisScopeInput!){ procurementConcentration(scope:$scope){ grain supplierCount } }`,
      variables: { scope: { grain: 'contract', supplierCui } },
      expectsInvalidInput: true,
    },
  ];
};
