import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';
import { withCacheResult, CacheNamespace, type KeyBuilder } from '@/infra/cache/index.js';
import { setStatementTimeout } from '@/infra/database/query-builders/index.js';

import {
  createCampaignNotFoundError,
  createDatabaseError,
  type CampaignSubscriptionStatsError,
} from '../../core/errors.js';

import type { CampaignSubscriptionStatsReader } from '../../core/ports.js';
import type { CampaignSubscriptionStats } from '../../core/types.js';
import type { SilentCachePort } from '@/infra/cache/ports.js';
import type { BudgetDbClient, UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

const QUERY_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

interface CampaignTotalRow {
  total_users: string;
}

interface CampaignPerEntityRow {
  entity_cui: string;
  total_users: string;
}

interface CampaignUatMetadataRow {
  entity_cui: string;
  siruta_code: string | null;
  uat_name: string | null;
}

const SUPPORTED_CAMPAIGN_KEYS = new Set<string>([FUNKY_CAMPAIGN_KEY]);

function parseCount(value: string | number | bigint | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

class KyselyCampaignSubscriptionStatsRepo implements CampaignSubscriptionStatsReader {
  private readonly log: Logger;

  constructor(
    private readonly userDb: UserDbClient,
    private readonly budgetDb: BudgetDbClient,
    logger: Logger
  ) {
    this.log = logger.child({ repo: 'CampaignSubscriptionStatsRepo' });
  }

  async getByCampaignId(
    campaignId: string
  ): Promise<Result<CampaignSubscriptionStats, CampaignSubscriptionStatsError>> {
    if (!SUPPORTED_CAMPAIGN_KEYS.has(campaignId)) {
      return err(createCampaignNotFoundError(campaignId));
    }

    try {
      const { total, perEntityRows } = await this.userDb.transaction().execute(async (trx) => {
        await setStatementTimeout(trx, QUERY_TIMEOUT_MS);

        const totalResult = await sql<CampaignTotalRow>`
          SELECT total_users
          FROM v_public_debate_campaign_user_total
          WHERE campaign_key = ${campaignId}
        `.execute(trx);

        const perEntityResult = await sql<CampaignPerEntityRow>`
          SELECT entity_cui, total_users
          FROM v_public_debate_uat_user_counts
          WHERE campaign_key = ${campaignId}
          ORDER BY total_users DESC, entity_cui ASC
        `.execute(trx);

        return {
          total: parseCount(totalResult.rows[0]?.total_users),
          perEntityRows: perEntityResult.rows,
        };
      });

      if (perEntityRows.length === 0) {
        return ok({ total, perUat: [] });
      }

      const entityCuis = perEntityRows.map((row) => row.entity_cui);

      const metadataResult = await this.budgetDb.transaction().execute(async (trx) => {
        await setStatementTimeout(trx, QUERY_TIMEOUT_MS);

        return sql<CampaignUatMetadataRow>`
          SELECT
            e.cui AS entity_cui,
            u.siruta_code AS siruta_code,
            u.name AS uat_name
          FROM entities AS e
          LEFT JOIN uats AS u ON u.id = e.uat_id
          WHERE e.cui IN (${sql.join(entityCuis)})
            AND e.is_uat = TRUE
        `.execute(trx);
      });

      const metadataByEntityCui = new Map<string, CampaignUatMetadataRow>();
      for (const row of metadataResult.rows) {
        metadataByEntityCui.set(row.entity_cui, row);
      }

      const perUat = perEntityRows.flatMap((row) => {
        const metadata = metadataByEntityCui.get(row.entity_cui);

        if (metadata?.siruta_code == null || metadata.uat_name == null) {
          this.log.warn(
            {
              campaignId,
              entityCui: row.entity_cui,
            },
            'Skipping campaign subscription count row without resolvable UAT metadata'
          );
          return [];
        }

        return [
          {
            sirutaCode: metadata.siruta_code,
            uatName: metadata.uat_name,
            count: parseCount(row.total_users),
          },
        ];
      });

      return ok({
        total,
        perUat,
      });
    } catch (error) {
      this.log.error({ err: error, campaignId }, 'Failed to load campaign subscription stats');
      return err(createDatabaseError('Failed to load campaign subscription stats', error));
    }
  }
}

export interface CampaignSubscriptionStatsRepoOptions {
  userDb: UserDbClient;
  budgetDb: BudgetDbClient;
  logger: Logger;
  cache?: SilentCachePort;
  keyBuilder?: KeyBuilder;
}

export const makeCampaignSubscriptionStatsReader = (
  options: CampaignSubscriptionStatsRepoOptions
): CampaignSubscriptionStatsReader => {
  const repo = new KyselyCampaignSubscriptionStatsRepo(
    options.userDb,
    options.budgetDb,
    options.logger
  );

  if (options.cache === undefined || options.keyBuilder === undefined) {
    return repo;
  }

  const keyBuilder = options.keyBuilder;

  return {
    getByCampaignId: withCacheResult(
      repo.getByCampaignId.bind(repo),
      options.cache as SilentCachePort<CampaignSubscriptionStats>,
      {
        namespace: CacheNamespace.CAMPAIGN_SUBSCRIPTION_STATS,
        ttlMs: CACHE_TTL_MS,
        keyGenerator: ([campaignId]) =>
          keyBuilder.build(CacheNamespace.CAMPAIGN_SUBSCRIPTION_STATS, campaignId),
      }
    ),
  };
};
