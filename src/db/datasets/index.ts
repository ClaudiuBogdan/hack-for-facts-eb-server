import { z } from 'zod';

const axisDataTypeSchema = z.enum(['STRING', 'INTEGER', 'FLOAT', 'DATE']);
export type DatasetAxisType = z.infer<typeof axisDataTypeSchema>;

export const axisGranularitySchema = z.enum(['YEAR', 'QUARTER', 'MONTH', 'CATEGORY']);
export type DatasetAxisGranularity = z.infer<typeof axisGranularitySchema>;

export const datasetAxisSchema = z.object({
  name: z.string().min(1, { message: 'Axis name must be provided' }),
  type: axisDataTypeSchema,
  unit: z.string().min(1, { message: 'Axis unit must be provided' }),
  granularity: axisGranularitySchema.optional(),
});

export const datasetDataPointSchema = z.object({
  x: z.union([z.string(), z.number()]),
  y: z.number().finite({ message: 'Data point y-value must be a finite number' }),
});

const datasetBaseSchema = z.object({
  id: z.string().min(1, { message: 'Dataset id must be provided' }),
  name: z.string().min(1, { message: 'Dataset name must be provided' }),
  nameEn: z.string().optional(),
  title: z.string().min(1, { message: 'Dataset English title must be provided' }),
  titleEn: z.string().optional(),
  description: z.string().min(1, { message: 'Dataset description must be provided' }),
  descriptionEn: z
    .string()
    .optional(),
  sourceName: z.string().min(1).optional(),
  sourceNameEn: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  xAxis: datasetAxisSchema,
  yAxis: datasetAxisSchema,
  data: z.array(datasetDataPointSchema).nonempty({
    message: 'Dataset must include at least one data point',
  }),
});

const typeCompatibility: Record<DatasetAxisGranularity, Set<DatasetAxisType>> = {
  YEAR: new Set<DatasetAxisType>(['INTEGER']),
  QUARTER: new Set<DatasetAxisType>(['STRING']),
  MONTH: new Set<DatasetAxisType>(['DATE', 'STRING']),
  CATEGORY: new Set<DatasetAxisType>(['STRING', 'INTEGER', 'FLOAT']),
};

function inferGranularity(axis: z.infer<typeof datasetAxisSchema>): DatasetAxisGranularity {
  if (axis.granularity) {
    return axis.granularity;
  }
  switch (axis.type) {
    case 'INTEGER':
      return 'YEAR';
    case 'DATE':
      return 'MONTH';
    default:
      return 'CATEGORY';
  }
}

export const datasetSchema = datasetBaseSchema.superRefine((dataset, ctx) => {
  const granularity = inferGranularity(dataset.xAxis);

  if (!typeCompatibility[granularity].has(dataset.xAxis.type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['xAxis', 'type'],
      message: `Axis type "${dataset.xAxis.type}" is incompatible with granularity "${granularity}"`,
    });
  }

  if (!['FLOAT', 'INTEGER'].includes(dataset.yAxis.type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['yAxis', 'type'],
      message: 'yAxis.type must be FLOAT or INTEGER',
    });
  }

  const seenKeys = new Set<string>();
  let previousKey: string | null = null;

  const addDuplicateIssue = (index: number) =>
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['data', index, 'x'],
      message: 'Duplicate x-axis value detected',
    });

  const ensureAscending = (current: string) => {
    if (previousKey !== null && previousKey >= current) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['data'],
        message: 'Chronological series must be sorted in ascending order',
      });
    }
    previousKey = current;
  };

  dataset.data.forEach((point, index) => {
    let normalizedKey: string | null = null;

    switch (granularity) {
      case 'YEAR': {
        if (typeof point.x === 'number' && Number.isInteger(point.x)) {
          normalizedKey = point.x.toString();
          ensureAscending(normalizedKey);
        } else if (typeof point.x === 'string' && /^\d{4}$/.test(point.x)) {
          normalizedKey = point.x;
          ensureAscending(normalizedKey);
        } else {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['data', index, 'x'],
            message: 'Year values must be integers or YYYY-formatted strings',
          });
        }
        break;
      }
      case 'QUARTER': {
        if (typeof point.x !== 'string' || !/^(\d{4})-Q([1-4])$/.test(point.x)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['data', index, 'x'],
            message: 'Quarter values must match YYYY-QN format (e.g. "2024-Q1")',
          });
        } else {
          const [, year, quarter] = point.x.match(/^(\d{4})-Q([1-4])$/)!;
          normalizedKey = `${year}-Q${quarter}`;
          ensureAscending(`${year}-${quarter}`);
        }
        break;
      }
      case 'MONTH': {
        if (typeof point.x !== 'string' || !/^(\d{4})-(0[1-9]|1[0-2])$/.test(point.x)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['data', index, 'x'],
            message: 'Month values must match YYYY-MM format (e.g. "2024-01")',
          });
        } else {
          const [, year, month] = point.x.match(/^(\d{4})-(0[1-9]|1[0-2])$/)!;
          normalizedKey = `${year}-${month}`;
          ensureAscending(`${year}-${month}`);
        }
        break;
      }
      case 'CATEGORY': {
        if (typeof point.x === 'number') {
          normalizedKey = point.x.toString();
        } else if (typeof point.x === 'string') {
          const trimmed = point.x.trim();
          if (!trimmed) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['data', index, 'x'],
              message: 'Category values must not be empty',
            });
          } else {
            normalizedKey = trimmed;
          }
        } else {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['data', index, 'x'],
            message: 'Category values must be strings or numbers',
          });
        }
        break;
      }
      default:
        const neverKind: never = granularity;
        throw new Error(`Unsupported axis granularity ${(neverKind as string) ?? 'unknown'}`);
    }

    if (normalizedKey) {
      if (seenKeys.has(normalizedKey)) {
        addDuplicateIssue(index);
      } else {
        seenKeys.add(normalizedKey);
      }
    }
  });
});

export const datasetSummarySchema = datasetBaseSchema.pick({
  id: true,
  name: true,
  nameEn: true,
  title: true,
  titleEn: true,
  description: true,
  descriptionEn: true,
  sourceName: true,
  sourceNameEn: true,
  sourceUrl: true,
  xAxis: true,
  yAxis: true,
});

export type DatasetDataPoint = z.infer<typeof datasetDataPointSchema>;
export type Dataset = z.infer<typeof datasetSchema>;
export type DatasetSummary = z.infer<typeof datasetSummarySchema>;

export function parseDataset(sourceLabel: string, candidate: unknown): Dataset {
  const result = datasetSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid dataset payload in ${sourceLabel}: ${result.error.message}`);
  }
  return result.data;
}
