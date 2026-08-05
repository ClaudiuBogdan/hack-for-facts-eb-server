import { buildSchema, parse, validate } from 'graphql'
import { describe, expect, it } from 'vitest'

import { baseTypeDefs } from '@/modules/shared/shell/graphql/typedefs.js'

const legacySearchDocument = parse(/* GraphQL */ `
  query LegacySearchEntities($q: String!, $year: Int) {
    searchEntities(q: $q, year: $year) {
      hits {
        id
        year
      }
    }
  }
`)

describe('global-search GraphQL rollout compatibility', () => {
  it('keeps the legacy year argument and hit field valid during the palette rollout', () => {
    const schema = buildSchema(baseTypeDefs)

    expect(validate(schema, legacySearchDocument).map((error) => error.message)).toEqual([])
  })
})
