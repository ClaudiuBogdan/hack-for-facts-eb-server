import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { createDatabaseError } from '@/modules/entity/core/errors.js';
import {
  createEntityLoaders,
  type Entity,
  type EntityProfile,
  type EntityProfileRepository,
} from '@/modules/entity/index.js';

import type { BudgetDbClient } from '@/infra/database/client.js';
import type { Loader, MercuriusContext, MercuriusLoaders } from 'mercurius';

function makeEntity(cui: string): Entity {
  return {
    cui,
    name: `Entity ${cui}`,
    entity_type: null,
    default_report_type: 'Executie bugetara detaliata',
    uat_id: null,
    is_uat: false,
    address: null,
    last_updated: null,
    main_creditor_1_cui: null,
    main_creditor_2_cui: null,
  };
}

function makeProfile(cui: string): EntityProfile {
  return {
    institution_type: 'agentie',
    website_url: `https://example-${cui}.ro`,
    official_email: `office-${cui}@example.ro`,
    phone_primary: '021-000-0000',
    address_raw: 'Str. Exemplu 1',
    address_locality: 'Bucuresti',
    county_code: 'B',
    county_name: 'Bucuresti',
    leader_name: 'Jane Doe',
    leader_title: 'Director',
    leader_party: null,
    scraped_at: '2026-03-26T10:00:00.000Z',
    extraction_confidence: 0.92,
  };
}

function makeContext(): MercuriusContext {
  return {
    reply: {
      log: {
        error: vi.fn(),
      },
    },
  } as unknown as MercuriusContext;
}

function getEntityProfileLoader(loaders: MercuriusLoaders): Loader<Entity> {
  const entityLoaders = loaders['Entity'];
  if (entityLoaders === undefined) {
    throw new Error('Entity loaders are not defined');
  }

  const profileLoader = entityLoaders['profile'];
  if (profileLoader === undefined) {
    throw new Error('Entity.profile loader is not defined');
  }

  const loader = (
    typeof profileLoader === 'function' ? profileLoader : profileLoader.loader
  ) as Loader<Entity>;

  return loader;
}

describe('createEntityLoaders', () => {
  it('batches entity profile lookups and returns sparse results positionally', async () => {
    const getByEntityCuis = vi.fn(async (_cuis: string[]) => {
      const map = new Map<string, EntityProfile>([['100', makeProfile('100')]]);
      return ok(map);
    });

    const entityProfileRepo: EntityProfileRepository = {
      getByEntityCui: vi.fn(),
      getByEntityCuis,
    };

    const loaders = createEntityLoaders({
      db: {} as BudgetDbClient,
      entityProfileRepo,
    });
    const profileLoader = getEntityProfileLoader(loaders);

    const result = await profileLoader(
      [
        { obj: makeEntity('100'), params: {} },
        { obj: makeEntity('200'), params: {} },
        { obj: makeEntity('100'), params: {} },
      ],
      makeContext()
    );

    expect(getByEntityCuis).toHaveBeenCalledWith(['100', '200']);
    expect(result).toEqual([makeProfile('100'), null, makeProfile('100')]);
  });

  it('logs and throws when the entity profile repository fails', async () => {
    const error = createDatabaseError('Entity profile getByEntityCuis failed');
    const logError = vi.fn();

    const entityProfileRepo: EntityProfileRepository = {
      getByEntityCui: vi.fn(),
      getByEntityCuis: vi.fn(async () => err(error)),
    };

    const loaders = createEntityLoaders({
      db: {} as BudgetDbClient,
      entityProfileRepo,
    });
    const profileLoader = getEntityProfileLoader(loaders);

    const context = {
      reply: {
        log: {
          error: logError,
        },
      },
    } as unknown as MercuriusContext;

    await expect(profileLoader([{ obj: makeEntity('100'), params: {} }], context)).rejects.toThrow(
      '[DatabaseError] Entity profile getByEntityCuis failed'
    );

    expect(logError).toHaveBeenCalledTimes(1);
  });
});
