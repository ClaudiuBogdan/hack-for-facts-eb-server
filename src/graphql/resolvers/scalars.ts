import { GraphQLScalarType, Kind } from 'graphql'
import { YEAR_MONTH_PERIOD, YEAR_PERIOD, YEAR_QUARTER_PERIOD } from '../../utils/reportPeriod'

function validatePeriod(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Period must be a string.')
  }

  if (!YEAR_PERIOD.test(value) && !YEAR_MONTH_PERIOD.test(value) && !YEAR_QUARTER_PERIOD.test(value)) {
    throw new Error('Period must be in YYYY, YYYY-MM, or YYYY-Q[1-4] format.')
  }

  return value
}

export const scalarResolvers = {
  PeriodDate: new GraphQLScalarType({
    name: 'PeriodDate',
    description: 'A string representing a Year (YYYY), Year-Month (YYYY-MM), or Year-Quarter (YYYY-Q[1-4])',
    parseValue: validatePeriod,
    serialize: validatePeriod,
    parseLiteral(ast) {
      if (ast.kind === Kind.STRING) {
        return validatePeriod(ast.value)
      }
      return null
    },
  }),
}


