import { z } from "zod";

export const ChartTypeEnum = z.enum(['line', 'bar', 'area', 'bar-aggr', 'pie-aggr', 'treemap-aggr', 'sankey-aggr']);
export type ChartType = z.infer<typeof ChartTypeEnum>;

export const AnnotationTypeEnum = z.enum(['point', 'line', 'threshold', 'region']);
export type AnnotationType = z.infer<typeof AnnotationTypeEnum>;

export const DEFAULT_CHART_CONFIG = {
    chartType: 'line' as ChartType,
    color: '#0062ff',
    showDataLabels: false,
    showGridLines: true,
    showLegend: true,
    showRelativeValues: false,
    showTooltip: true,
    editAnnotations: true,
    showAnnotations: true,
};

export const DEFAULT_SERIES_CONFIG = {
    visible: true,
    yAxisId: 'left' as const,
};

export const DEFAULT_AXIS_CONFIG = {
    showTicks: true,
    showTickLabels: true,
    scale: 'linear',
    formatter: 'number',
};


export const DEFAULT_CHART = {
    id: crypto.randomUUID(),
    title: '',
    description: '',
    config: DEFAULT_CHART_CONFIG,
    series: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    annotations: [],
};