import { z } from 'zod';
import { analyticsFilterSchema } from './analytics-filter';

export const alertOperatorEnum = z.enum(['gt', 'gte', 'lt', 'lte', 'eq']);

export const alertConditionSchema = z.object({
  operator: alertOperatorEnum,
  threshold: z.number(),
  unit: z.string().min(1).max(32),
});

export const alertConfigSchema = z.object({
  title: z.string().max(200, { message: 'Title must be 200 characters or fewer' }).optional(),
  description: z.string().max(1000, { message: 'Description must be 1000 characters or fewer' }).optional(),
  filter: analyticsFilterSchema.optional(),
  condition: alertConditionSchema.optional(),
});

export const alertParamsSchema = z.object({
  alertId: z.string().uuid(),
});

export type AlertCondition = z.infer<typeof alertConditionSchema>;
export type AlertFilter = z.infer<typeof analyticsFilterSchema>;
export type AlertConfig = z.infer<typeof alertConfigSchema>;

