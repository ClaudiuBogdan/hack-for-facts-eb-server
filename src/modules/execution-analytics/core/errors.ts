import type { AppError, InfraError } from '@/common/types/errors.js';

export type AnalyticsError = InfraError | AppError;
