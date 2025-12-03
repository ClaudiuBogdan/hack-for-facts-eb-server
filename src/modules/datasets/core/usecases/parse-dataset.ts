import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import type { DatasetValidationError } from '../errors.js';
import type {
  Dataset,
  DatasetFileDTO,
  DatasetAxesType,
  DatasetFrequency,
  DataPoint,
} from '../types.js';

const YEAR_RE = /^\d{4}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const QUARTER_RE = /^\d{4}-Q[1-4]$/;

const validateDate = (value: string, frequency?: DatasetFrequency): boolean => {
  switch (frequency) {
    case 'yearly':
      return YEAR_RE.test(value);
    case 'monthly':
      return MONTH_RE.test(value);
    case 'quarterly':
      return QUARTER_RE.test(value);
    default:
      return false;
  }
};

const validateX = (
  type: DatasetAxesType,
  frequency: DatasetFrequency | undefined,
  value: string
): Result<string, DatasetValidationError> => {
  if (type === 'date') {
    if (!validateDate(value, frequency)) {
      return err({
        type: 'InvalidFormat',
        message: `Expected ${frequency ?? 'frequency::unknown'} date for x-axis, got '${value}'`,
      });
    }
    return ok(value);
  }

  if (type === 'number') {
    try {
      const numeric = new Decimal(value);
      if (!numeric.isFinite()) {
        return err({
          type: 'InvalidDecimal',
          message: `Value '${value}' is not a valid numeric x-axis value`,
        });
      }
      return ok(numeric.toString());
    } catch {
      return err({
        type: 'InvalidDecimal',
        message: `Value '${value}' is not a valid numeric x-axis value`,
      });
    }
  }

  if (value.trim().length === 0) {
    return err({
      type: 'InvalidFormat',
      message: 'Category x-axis value cannot be empty',
    });
  }

  return ok(value);
};

export const parseDataset = (dto: DatasetFileDTO): Result<Dataset, DatasetValidationError> => {
  if (dto.metadata.units !== dto.axes.y.unit && dto.axes.y.unit !== undefined) {
    return err({
      type: 'UnitsMismatch',
      message: 'metadata.units and axes.y.unit must match',
      metadataUnit: dto.metadata.units,
      axisUnit: dto.axes.y.unit,
    });
  }

  const points: DataPoint[] = [];

  for (const point of dto.data) {
    const validatedX = validateX(dto.axes.x.type, dto.axes.x.frequency, point.x);
    if (validatedX.isErr()) {
      return err(validatedX.error);
    }

    try {
      const numericY = new Decimal(point.y);
      if (!numericY.isFinite()) {
        return err({
          type: 'InvalidDecimal',
          message: `Value '${point.y}' is not a valid y-axis number`,
        });
      }

      points.push({
        x: validatedX.value,
        y: numericY,
      });
    } catch {
      return err({
        type: 'InvalidDecimal',
        message: `Value '${point.y}' is not a valid y-axis number`,
      });
    }
  }

  return ok({
    id: dto.metadata.id,
    metadata: dto.metadata,
    i18n: dto.i18n,
    axes: dto.axes,
    points,
  });
};
